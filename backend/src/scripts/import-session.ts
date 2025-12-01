import path from "path";
import { promises as fs } from "fs";
import { gunzip } from "zlib";
import { promisify } from "util";
import process from "process";
import { initializeDatabase, db } from "../database";
import { OpenF1SessionData, fetchOpenF1Session } from "../datasources/openf1org";

const gunzipAsync = promisify(gunzip);
const BATCH_SIZE = 1000;

type TelemetryRow = {
  session_key: number;
  meeting_key: number;
  driver_number: number;
  sample_time: string;
  lap_number: number | null;
  drs: number | null;
  speed: number | null;
  brake: number | null;
  rpm: number | null;
  n_gear: number | null;
  throttle: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  latitude: number | null;
  longitude: number | null;
};

type PitStopRow = {
  session_key: number;
  meeting_key: number;
  driver_number: number;
  lap_number: number;
  stop_time: string;
  pit_duration: number | null;
};

type RaceControlRow = {
  session_key: number;
  meeting_key: number;
  event_time: string;
  lap_number: number | null;
  driver_number: number | null;
  category: string;
  flag: string | null;
  scope: string | null;
  sector: string | null;
  message: string | null;
};

type StintRow = {
  session_key: number;
  meeting_key: number;
  driver_number: number;
  stint_number: number;
  lap_start: number | null;
  lap_end: number | null;
  compound: string | null;
  tyre_age_at_start: number | null;
};

type LapRow = {
  session_key: number;
  meeting_key: number;
  driver_number: number;
  lap_number: number;
  date_start: string | null;
  lap_duration: number | null;
  duration_sector_1: number | null;
  duration_sector_2: number | null;
  duration_sector_3: number | null;
  i1_speed: number | null;
  i2_speed: number | null;
  st_speed: number | null;
  is_pit_out_lap: boolean;
  segments_sector_1: Array<number | null> | null;
  segments_sector_2: Array<number | null> | null;
  segments_sector_3: Array<number | null> | null;
};

const TELEMETRY_COLUMNS: (keyof TelemetryRow & string)[] = [
  "session_key",
  "meeting_key",
  "driver_number",
  "sample_time",
  "lap_number",
  "drs",
  "speed",
  "brake",
  "rpm",
  "n_gear",
  "throttle",
  "x",
  "y",
  "z",
  "latitude",
  "longitude",
];

const PIT_COLUMNS: (keyof PitStopRow & string)[] = [
  "session_key",
  "meeting_key",
  "driver_number",
  "lap_number",
  "stop_time",
  "pit_duration",
];

const RACE_CONTROL_COLUMNS: (keyof RaceControlRow & string)[] = [
  "session_key",
  "meeting_key",
  "event_time",
  "lap_number",
  "driver_number",
  "category",
  "flag",
  "scope",
  "sector",
  "message",
];

const STINT_COLUMNS: (keyof StintRow & string)[] = [
  "session_key",
  "meeting_key",
  "driver_number",
  "stint_number",
  "lap_start",
  "lap_end",
  "compound",
  "tyre_age_at_start",
];

const LAP_COLUMNS: (keyof LapRow & string)[] = [
  "session_key",
  "meeting_key",
  "driver_number",
  "lap_number",
  "date_start",
  "lap_duration",
  "duration_sector_1",
  "duration_sector_2",
  "duration_sector_3",
  "i1_speed",
  "i2_speed",
  "st_speed",
  "is_pit_out_lap",
  "segments_sector_1",
  "segments_sector_2",
  "segments_sector_3",
];

type ImportSource =
  | { kind: "file"; path: string }
  | { kind: "session"; sessionKey: string };

async function main() {
  const source = await resolveSource(process.argv.slice(2));
  let sessionData: OpenF1SessionData;

  if (source.kind === "file") {
    console.log(`[Import] Reading session from file ${source.path}`);
    sessionData = await readSessionFromFile(source.path);
  } else {
    console.log(`[Import] Fetching session ${source.sessionKey} from openf1.org`);
    sessionData = await fetchOpenF1Session(source.sessionKey);
  }

  await initializeDatabase();
  await importSession(sessionData);

  console.log(
    `Imported session ${sessionData.sessionInfo.session_key} (${sessionData.sessionInfo.session_name})`
  );
}

main().catch((error) => {
  console.error("Failed to import session", error);
  process.exit(1);
});

async function resolveSource(args: string[]): Promise<ImportSource> {
  if (!args.length) {
    printUsage();
  }

  const [first, second] = args;
  if (isFlag(first, "session")) {
    if (!second) {
      printUsage();
    }
    return { kind: "session", sessionKey: second };
  }

  if (isFlag(first, "file")) {
    if (!second) {
      printUsage();
    }
    return { kind: "file", path: path.resolve(process.cwd(), second) };
  }

  const candidatePath = path.resolve(process.cwd(), first);
  if (await pathExists(candidatePath)) {
    return { kind: "file", path: candidatePath };
  }

  return { kind: "session", sessionKey: first };
}

function isFlag(value: string | undefined, name: string) {
  if (!value) {
    return false;
  }
  return value === `--${name}` || value === `-${name[0]}`;
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function printUsage(): never {
  console.error(
    "Usage: bun run import-session -- [--file <path>|--session <session_key>|<path>]"
  );
  process.exit(1);
}

async function readSessionFromFile(filePath: string): Promise<OpenF1SessionData> {
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".zip" || ext === ".gz") {
    const unzipped = await gunzipAsync(buffer);
    return JSON.parse(unzipped.toString("utf-8"));
  }

  return JSON.parse(buffer.toString("utf-8"));
}

async function importSession(data: OpenF1SessionData) {
  const alias = data.sessionKey?.trim();
  const info = data.sessionInfo;
  const sessionKey = info.session_key;
  const meetingKey = info.meeting_key;

  const carData = data.carData ?? [];
  const driverStartTimes = computeDriverStartTimes(carData);
  const telemetryRows = mergeTelemetry(
    carData,
    data.locations ?? [],
    data.laps ?? [],
    sessionKey,
    meetingKey,
    driverStartTimes
  );
  console.log(`[Import] telemetry rows: ${telemetryRows.length}`);

  const pitRows: PitStopRow[] = (data.pitStops ?? [])
    .map((pit) => {
      const stop_time = parseDate(pit.date);
      const driver_number = toNumber(pit.driver_number);
      const lap_number = toNumber(pit.lap_number);
      if (!stop_time || driver_number == null || lap_number == null) {
        return null;
      }
      return {
        session_key: sessionKey,
        meeting_key: meetingKey,
        driver_number,
        lap_number,
        stop_time,
        pit_duration: toNumber(pit.pit_duration),
      };
    })
    .filter((row): row is PitStopRow => row !== null);

  const raceControlRows: RaceControlRow[] = (data.raceControl ?? [])
    .map((event) => {
      const event_time = parseDate(event.date);
      if (!event_time) {
        return null;
      }
      return {
        session_key: sessionKey,
        meeting_key: meetingKey,
        event_time,
        lap_number: toNumber(event.lap_number),
        driver_number: toNumber(event.driver_number),
        category: String(event.category ?? ""),
        flag: nullableString(event.flag),
        scope: nullableString(event.scope),
        sector: nullableString(event.sector),
        message: nullableString(event.message),
      };
    })
    .filter((row): row is RaceControlRow => row !== null);

  const stintRows: StintRow[] = (data.stints ?? [])
    .map((stint) => {
      const driver_number = toNumber(stint.driver_number);
      const stint_number = toNumber(stint.stint_number);
      if (driver_number == null || stint_number == null) {
        return null;
      }
      return {
        session_key: sessionKey,
        meeting_key: meetingKey,
        driver_number,
        stint_number,
        lap_start: toNumber(stint.lap_start),
        lap_end: toNumber(stint.lap_end),
        compound: nullableString(stint.compound),
        tyre_age_at_start: toNumber(stint.tyre_age_at_start),
      };
    })
    .filter((row): row is StintRow => row !== null);

  const lapRows: LapRow[] = (data.laps ?? [])
    .map((lap) => {
      const driver_number = toNumber(lap.driver_number);
      const lap_number = toNumber(lap.lap_number);
      if (driver_number == null || lap_number == null) {
        return null;
      }
      return {
        session_key: sessionKey,
        meeting_key: meetingKey,
        driver_number,
        lap_number,
        date_start: parseDate(lap.date_start),
        lap_duration: toNumber(lap.lap_duration),
        duration_sector_1: toNumber(lap.duration_sector_1),
        duration_sector_2: toNumber(lap.duration_sector_2),
        duration_sector_3: toNumber(lap.duration_sector_3),
        i1_speed: toNumber(lap.i1_speed),
        i2_speed: toNumber(lap.i2_speed),
        st_speed: toNumber(lap.st_speed),
        is_pit_out_lap: Boolean(lap.is_pit_out_lap ?? false),
        segments_sector_1: normalizeSegmentArray(lap.segments_sector_1),
        segments_sector_2: normalizeSegmentArray(lap.segments_sector_2),
        segments_sector_3: normalizeSegmentArray(lap.segments_sector_3),
      };
    })
    .filter((row): row is LapRow => row !== null);

  await db.begin(async (tx) => {
    await tx`
      INSERT INTO meetings ${tx({
        meeting_key: meetingKey,
        location: info.location,
        country_name: info.country_name,
        country_code: info.country_code,
        gmt_offset: info.gmt_offset,
        circuit_key: info.circuit_key,
        circuit_short_name: info.circuit_short_name,
        year: info.year,
      })}
      ON CONFLICT (meeting_key) DO UPDATE SET
        location = EXCLUDED.location,
        country_name = EXCLUDED.country_name,
        country_code = EXCLUDED.country_code,
        gmt_offset = EXCLUDED.gmt_offset,
        circuit_key = EXCLUDED.circuit_key,
        circuit_short_name = EXCLUDED.circuit_short_name,
        year = EXCLUDED.year
    `;

    await tx`
      INSERT INTO sessions ${tx({
        session_key: sessionKey,
        meeting_key: meetingKey,
        session_type: info.session_type,
        session_name: info.session_name,
        date_start: info.date_start,
        date_end: info.date_end,
      })}
      ON CONFLICT (session_key) DO UPDATE SET
        meeting_key = EXCLUDED.meeting_key,
        session_type = EXCLUDED.session_type,
        session_name = EXCLUDED.session_name,
        date_start = EXCLUDED.date_start,
        date_end = EXCLUDED.date_end
    `;

    if (alias) {
      await tx`
        INSERT INTO session_aliases ${tx({ alias, session_key: sessionKey })}
        ON CONFLICT (alias) DO UPDATE SET session_key = EXCLUDED.session_key
      `;
    }

    await tx`DELETE FROM telemetry_samples WHERE session_key = ${sessionKey}`;
    await tx`DELETE FROM pit_stops WHERE session_key = ${sessionKey}`;
    await tx`DELETE FROM race_control_events WHERE session_key = ${sessionKey}`;
    await tx`DELETE FROM stints WHERE session_key = ${sessionKey}`;
    await tx`DELETE FROM laps WHERE session_key = ${sessionKey}`;

    if (telemetryRows.length) {
      await insertTelemetry(tx, telemetryRows);
    }
    if (pitRows.length) {
      await insertPitStops(tx, pitRows);
    }
    if (raceControlRows.length) {
      await insertRaceControl(tx, raceControlRows);
    }
    if (stintRows.length) {
      await insertStints(tx, stintRows);
    }
    if (lapRows.length) {
      await insertLaps(tx, lapRows);
    }

  });
}

function mergeTelemetry(
  carData: Array<Record<string, unknown>>,
  locations: Array<Record<string, unknown>>,
  laps: Array<Record<string, unknown>>,
  sessionKey: number,
  meetingKey: number,
  driverStartTimes: Map<number, number>
): TelemetryRow[] {
  const lapTimelines = buildLapTimelines(laps, driverStartTimes);
  const lapPointers = new Map<number, number>();
  const carByDriver = groupByDriver(toTimedEntries(carData));
  const locByDriver = groupByDriver(toTimedEntries(locations));
  const merged: TelemetryRow[] = [];

  for (const [driver, carEntries] of carByDriver) {
    const locationEntries = locByDriver.get(driver) ?? [];
    if (!carEntries.length || !locationEntries.length) {
      continue;
    }

    let locIndex = 0;
    for (const car of carEntries) {
      while (
        locIndex + 1 < locationEntries.length &&
        Math.abs(locationEntries[locIndex + 1].timestamp - car.timestamp) <=
          Math.abs(locationEntries[locIndex].timestamp - car.timestamp)
      ) {
        locIndex += 1;
      }

      const location = locationEntries[locIndex];
      if (!location) {
        break;
      }

      const lap_number = resolveLapNumber(
        lapTimelines,
        lapPointers,
        driver,
        car.timestamp
      );

      merged.push({
        session_key: sessionKey,
        meeting_key: meetingKey,
        driver_number: driver,
        sample_time: new Date(car.timestamp).toISOString(),
        lap_number,
        drs: toNumber(car.record.drs),
        speed: toNumber(car.record.speed),
        brake: toNumber(car.record.brake),
        rpm: toNumber(car.record.rpm),
        n_gear: toNumber(car.record.n_gear),
        throttle: toNumber(car.record.throttle),
        x: toNumber(location.record.x),
        y: toNumber(location.record.y),
        z: toNumber(location.record.z),
        latitude: toNumber(location.record.latitude ?? location.record.lat),
        longitude: toNumber(
          location.record.longitude ?? location.record.long ?? location.record.lon
        ),
      });
    }
  }

  return merged;
}

function groupByDriver(entries: Array<{ timestamp: number; record: Record<string, unknown> }>) {
  const grouped = new Map<number, typeof entries>();
  entries.forEach((entry) => {
    const driver = toNumber(entry.record.driver_number);
    if (driver == null) return;
    const bucket = grouped.get(driver) ?? [];
    bucket.push(entry);
    grouped.set(driver, bucket);
  });
  grouped.forEach((bucket) => bucket.sort((a, b) => a.timestamp - b.timestamp));
  return grouped;
}

type LapTimeline = { start: number; end: number; lap: number }[];

function buildLapTimelines(
  laps: Array<Record<string, unknown>>,
  driverStartTimes: Map<number, number>
) {
  const timelines = new Map<number, LapTimeline>();

  laps.forEach((lap) => {
    const driver = toNumber(lap.driver_number);
    const lapNumber = toNumber(lap.lap_number);
    const startMs = parseDateMs(lap.date_start);
    if (driver == null || lapNumber == null) {
      return;
    }
    const durationSec = toNumber(lap.lap_duration);
    const timeline = timelines.get(driver) ?? [];
    const isFirstLap = timeline.length === 0;
    const fallbackStart = isFirstLap
      ? driverStartTimes.get(driver) ?? 0
      : timeline[timeline.length - 1]?.end ?? driverStartTimes.get(driver) ?? 0;
    const effectiveStart = startMs ?? fallbackStart;
    const endMs = startMs != null && durationSec != null ? startMs + durationSec * 1000 : null;
    timeline.push({
      start: effectiveStart,
      end: endMs ?? Number.POSITIVE_INFINITY,
      lap: lapNumber,
    });
    timelines.set(driver, timeline);
  });

  timelines.forEach((timeline) => {
    timeline.sort((a, b) => a.start - b.start);
    for (let i = 0; i < timeline.length; i += 1) {
      const nextStart = timeline[i + 1]?.start ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(timeline[i].start)) {
        timeline[i].start = i === 0 ? 0 : timeline[i - 1].end;
      }
      if (!Number.isFinite(timeline[i].end) || timeline[i].end <= timeline[i].start) {
        timeline[i].end = nextStart;
      }
    }
  });

  return timelines;
}

function computeDriverStartTimes(carData: Array<Record<string, unknown>>) {
  const starts = new Map<number, number>();
  carData.forEach((record) => {
    const driver = toNumber(record.driver_number);
    if (driver == null) {
      return;
    }
    const ts = parseDateMs(record.date);
    if (ts == null) {
      return;
    }
    const existing = starts.get(driver);
    if (existing == null || ts < existing) {
      starts.set(driver, ts);
    }
  });
  return starts;
}

function resolveLapNumber(
  timelines: Map<number, LapTimeline>,
  pointers: Map<number, number>,
  driver: number,
  timestamp: number
) {
  const timeline = timelines.get(driver);
  if (!timeline || !timeline.length) {
    return null;
  }
  let index = pointers.get(driver) ?? 0;
  while (index + 1 < timeline.length && timestamp >= timeline[index + 1].start) {
    index += 1;
  }
  while (index < timeline.length && timestamp > timeline[index].end) {
    index += 1;
  }
  if (index >= timeline.length) {
    index = timeline.length - 1;
  }
  pointers.set(driver, index);
  return timeline[index]?.lap ?? null;
}

function toTimedEntries(records: Array<Record<string, unknown>>) {
  return (
    records
      .map((record) => {
        const rawDate =
          (record.date as string) ??
          (record.time as string) ??
          (record.timestamp as string);
        const timestamp = Date.parse(rawDate ?? "");
        if (!Number.isFinite(timestamp)) {
          return null;
        }
        return { timestamp, record };
      })
      .filter(Boolean) as Array<{ timestamp: number; record: Record<string, unknown> }>
  ).sort((a, b) => a.timestamp - b.timestamp);
}

function parseDate(value: unknown): string | null {
  if (!value) {
    return null;
  }
  const ts = Date.parse(String(value));
  if (!Number.isFinite(ts)) {
    return null;
  }
  return new Date(ts).toISOString();
}

function parseDateMs(value: unknown) {
  const iso = parseDate(value);
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const str = String(value).trim();
  return str.length ? str : null;
}

function normalizeSegmentArray(
  value: unknown
): Array<number | null> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((entry) => toNumber(entry));
}

function formatIntArray(values: Array<number | null> | null) {
  if (!values) {
    return null;
  }
  const body = values
    .map((value) => (value === null || value === undefined ? "NULL" : String(value)))
    .join(",");
  return `{${body}}`;
}

async function insertTelemetry(tx: typeof db, rows: TelemetryRow[]) {
  for (const chunk of chunkArray(rows, BATCH_SIZE)) {
    const values = chunk.map((row) =>
      TELEMETRY_COLUMNS.map((column) => {
        const key = column as keyof TelemetryRow;
        const value = row[key];
        return value ?? null;
      })
    );
    await tx`
      INSERT INTO telemetry_samples (
        session_key,
        meeting_key,
        driver_number,
        sample_time,
        lap_number,
        drs,
        speed,
        brake,
        rpm,
        n_gear,
        throttle,
        x,
        y,
        z,
        latitude,
        longitude
      )
      VALUES ${tx(values)}
      ON CONFLICT (session_key, driver_number, sample_time) DO UPDATE SET
        drs = EXCLUDED.drs,
        speed = EXCLUDED.speed,
        brake = EXCLUDED.brake,
        rpm = EXCLUDED.rpm,
        n_gear = EXCLUDED.n_gear,
        throttle = EXCLUDED.throttle,
        x = EXCLUDED.x,
        y = EXCLUDED.y,
        z = EXCLUDED.z,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude
    `;
  }
}

async function insertPitStops(tx: typeof db, rows: PitStopRow[]) {
  for (const row of rows) {
    await tx`
      INSERT INTO pit_stops (
        session_key,
        meeting_key,
        driver_number,
        lap_number,
        stop_time,
        pit_duration
      )
      VALUES (
        ${row.session_key},
        ${row.meeting_key},
        ${row.driver_number},
        ${row.lap_number},
        ${row.stop_time}::timestamptz,
        ${row.pit_duration}
      )
      ON CONFLICT (session_key, driver_number, stop_time) DO UPDATE SET
        lap_number = EXCLUDED.lap_number,
        pit_duration = EXCLUDED.pit_duration
    `;
  }
}

async function insertRaceControl(tx: typeof db, rows: RaceControlRow[]) {
  for (const row of rows) {
    await tx`
      INSERT INTO race_control_events (
        session_key,
        meeting_key,
        event_time,
        lap_number,
        driver_number,
        category,
        flag,
        scope,
        sector,
        message
      )
      VALUES (
        ${row.session_key},
        ${row.meeting_key},
        ${row.event_time}::timestamptz,
        ${row.lap_number},
        ${row.driver_number},
        ${row.category},
        ${row.flag},
        ${row.scope},
        ${row.sector},
        ${row.message}
      )
    `;
  }
}

async function insertStints(tx: typeof db, rows: StintRow[]) {
  for (const row of rows) {
    await tx`
      INSERT INTO stints (
        session_key,
        meeting_key,
        driver_number,
        stint_number,
        lap_start,
        lap_end,
        compound,
        tyre_age_at_start
      )
      VALUES (
        ${row.session_key},
        ${row.meeting_key},
        ${row.driver_number},
        ${row.stint_number},
        ${row.lap_start},
        ${row.lap_end},
        ${row.compound},
        ${row.tyre_age_at_start}
      )
      ON CONFLICT (session_key, driver_number, stint_number) DO UPDATE SET
        lap_start = EXCLUDED.lap_start,
        lap_end = EXCLUDED.lap_end,
        compound = EXCLUDED.compound,
        tyre_age_at_start = EXCLUDED.tyre_age_at_start
    `;
  }
}

async function insertLaps(tx: typeof db, rows: LapRow[]) {
  for (const row of rows) {
    await tx`
      INSERT INTO laps (
        session_key,
        meeting_key,
        driver_number,
        lap_number,
        date_start,
        lap_duration,
        duration_sector_1,
        duration_sector_2,
        duration_sector_3,
        i1_speed,
        i2_speed,
        st_speed,
        is_pit_out_lap,
        segments_sector_1,
        segments_sector_2,
        segments_sector_3
      )
      VALUES (
        ${row.session_key},
        ${row.meeting_key},
        ${row.driver_number},
        ${row.lap_number},
        ${row.date_start}::timestamptz,
        ${row.lap_duration},
        ${row.duration_sector_1},
        ${row.duration_sector_2},
        ${row.duration_sector_3},
        ${row.i1_speed},
        ${row.i2_speed},
        ${row.st_speed},
        ${row.is_pit_out_lap},
        ${formatIntArray(row.segments_sector_1)}::int[],
        ${formatIntArray(row.segments_sector_2)}::int[],
        ${formatIntArray(row.segments_sector_3)}::int[]
      )
      ON CONFLICT (session_key, driver_number, lap_number) DO UPDATE SET
        lap_duration = EXCLUDED.lap_duration,
        duration_sector_1 = EXCLUDED.duration_sector_1,
        duration_sector_2 = EXCLUDED.duration_sector_2,
        duration_sector_3 = EXCLUDED.duration_sector_3,
        date_start = EXCLUDED.date_start,
        i1_speed = EXCLUDED.i1_speed,
        i2_speed = EXCLUDED.i2_speed,
        st_speed = EXCLUDED.st_speed,
        is_pit_out_lap = EXCLUDED.is_pit_out_lap,
        segments_sector_1 = EXCLUDED.segments_sector_1,
        segments_sector_2 = EXCLUDED.segments_sector_2,
        segments_sector_3 = EXCLUDED.segments_sector_3
    `;
  }
}

function chunkArray<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}
