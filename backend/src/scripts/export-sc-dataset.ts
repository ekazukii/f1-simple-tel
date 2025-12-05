import fs from "fs";
import path from "path";
import process from "process";
import { initializeDatabase, db } from "../database";

type SessionRecord = {
  session_key: number;
  meeting_key: number;
  session_type: string;
  session_name: string;
  date_start: string;
  date_end: string;
  year: number;
  circuit_short_name: string | null;
  meeting_name: string | null;
};

type LapRecordRow = {
  driver_number: number;
  lap_number: number;
  date_start: string | null;
  lap_duration: number | null;
};

type PitStopRow = {
  lap_number: number;
};

type StintRecord = {
  driver_number: number;
  lap_start: number | null;
  lap_end: number | null;
  tyre_age_at_start: number | null;
};

type RaceControlRow = {
  event_time: string;
  message: string | null;
  flag: string | null;
};

type WeatherRow = {
  recorded_at: string;
  air_temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  rainfall: number | null;
  track_temperature: number | null;
  wind_direction: number | null;
  wind_speed: number | null;
};

const STREET_CIRCUITS = new Set([
  "MONACO",
  "BAKU",
  "JEDDAH",
  "SINGAPORE",
  "MIAMI",
  "LAS_VEGAS",
  "MELBOURNE",
  "MONTREAL",
]);

interface CliOptions {
  outputPath: string;
  years: number[];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await initializeDatabase();

  const sessions = (await db`
    SELECT
      s.session_key,
      s.meeting_key,
      s.session_type,
      s.session_name,
      s.date_start,
      s.date_end,
      m.year,
      m.circuit_short_name,
      m.meeting_name
    FROM sessions s
    JOIN meetings m ON m.meeting_key = s.meeting_key
    WHERE s.session_type IN ('Race','Sprint')
      AND m.year BETWEEN 2023 AND 2025
    ORDER BY m.year, s.date_start
  `) as SessionRecord[];

  const filteredSessions = sessions.filter((session) =>
    options.years.includes(session.year)
  );

  if (!filteredSessions.length) {
    console.error("[Export] No sessions found for requested years");
    process.exit(1);
  }

  const outputFile = path.resolve(options.outputPath);
  await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
  const stream = fs.createWriteStream(outputFile, { encoding: "utf-8" });
  stream.write(
    [
      "race_id",
      "year",
      "circuit_id",
      "is_street_circuit",
      "lap_number",
      "total_laps",
      "status_sc_active",
      "status_vsc_active",
      "num_cars_running",
      "min_gap_between_any_cars",
      "num_pairs_gap_lt_1s",
      "num_pitstops_last_1_lap",
      "avg_tyre_age_laps",
      "air_temperature",
      "humidity",
      "pressure",
      "rainfall",
      "track_temperature",
      "wind_speed",
      "label_sc_next_lap",
    ]
      .map(csvEscape)
      .join(",") + "\n"
  );

  for (const session of filteredSessions) {
    console.log(`\n[Export] Processing session ${session.session_key}`);
    const data = await loadSessionData(session.session_key);
    const rows = await buildLapRows(session, data);
    rows.forEach((row) => stream.write(row + "\n"));
  }

  stream.end();
  await new Promise((resolve) => stream.once("close", resolve));
  console.log(`[Export] CSV written to ${outputFile}`);
}

async function loadSessionData(sessionKey: number) {
  const laps = (await db`
    SELECT driver_number, lap_number, date_start, lap_duration
    FROM laps
    WHERE session_key = ${sessionKey}
  `) as LapRecordRow[];

  const pitStops = (await db`
    SELECT lap_number
    FROM pit_stops
    WHERE session_key = ${sessionKey}
  `) as PitStopRow[];

  const stints = (await db`
    SELECT driver_number, lap_start, lap_end, tyre_age_at_start
    FROM stints
    WHERE session_key = ${sessionKey}
  `) as StintRecord[];

  const raceControl = (await db`
    SELECT event_time, message, flag
    FROM race_control_events
    WHERE session_key = ${sessionKey}
    ORDER BY event_time
  `) as RaceControlRow[];

  const weather = (await db`
    SELECT
      recorded_at,
      air_temperature,
      humidity,
      pressure,
      rainfall,
      track_temperature,
      wind_direction,
      wind_speed
    FROM weather_samples
    WHERE session_key = ${sessionKey}
    ORDER BY recorded_at
  `) as WeatherRow[];

  return { laps, pitStops, stints, raceControl, weather };
}

async function buildLapRows(
  session: SessionRecord,
  data: Awaited<ReturnType<typeof loadSessionData>>
) {
  const totalLaps = Math.max(
    ...data.laps.map((lap) => Number(lap.lap_number) || 0),
    0
  );
  if (!totalLaps) {
    return [];
  }

  const lapEntries = new Map<number, LapEntry[]>();
  const maxLapByDriver = new Map<number, number>();

  data.laps.forEach((lap) => {
    const lapNum = Number(lap.lap_number);
    if (!Number.isFinite(lapNum) || lapNum <= 0) return;
    const driver = lap.driver_number;
    const finish = computeLapFinish(lap);
    if (!lapEntries.has(lapNum)) {
      lapEntries.set(lapNum, []);
    }
    lapEntries.get(lapNum)!.push({ driver, finish });
    const prevMax = maxLapByDriver.get(driver) ?? 0;
    if (lapNum > prevMax) {
      maxLapByDriver.set(driver, lapNum);
    }
  });

  const pitStopsByLap = new Map<number, number>();
  data.pitStops.forEach((stop) => {
    const lap = Number(stop.lap_number);
    if (!Number.isFinite(lap)) return;
    pitStopsByLap.set(lap, (pitStopsByLap.get(lap) ?? 0) + 1);
  });

  const stintsByDriver = new Map<number, StintInfo[]>();
  data.stints.forEach((stint) => {
    const driver = stint.driver_number;
    if (!stintsByDriver.has(driver)) {
      stintsByDriver.set(driver, []);
    }
    const lapStart = Number(stint.lap_start ?? 0) || 1;
    const lapEnd = Number(stint.lap_end ?? 0) || totalLaps;
    stintsByDriver.get(driver)!.push({
      start: lapStart,
      end: lapEnd,
      ageStart: stint.tyre_age_at_start ?? 0,
    });
  });
  stintsByDriver.forEach((list) => list.sort((a, b) => a.start - b.start));

  const raceEndMs = Date.parse(session.date_end);
  const scData = buildSafetyData(data.raceControl, raceEndMs);
  const weatherTimeline = data.weather.map((sample) => ({
    time: Date.parse(sample.recorded_at),
    values: sample,
  }));

  const rows: string[] = [];
  const lapEndTimes = new Map<number, number>();
  let lastMinGap: number | null = null;
  let lastAvgTyre: number | null = null;
  for (let lap = 1; lap <= totalLaps; lap += 1) {
    const entries = lapEntries.get(lap) ?? [];
    entries.sort((a, b) => a.finish - b.finish);
    const leaderFinish = entries[0]?.finish ?? lapEndTimes.get(lap - 1) ?? Date.parse(session.date_start);
    lapEndTimes.set(lap, leaderFinish);

    const numCarsRunning = countCarsRunning(maxLapByDriver, lap);
    const { minGap, pairsLt1s } = computeGapStats(entries);
    const pitCount = pitStopsByLap.get(lap) ?? 0;
    const avgTyreAge = computeAverageTyreAge(stintsByDriver, lap, numCarsRunning);
    const minGapValue = minGap ?? lastMinGap;
    const avgTyreValue = avgTyreAge ?? lastAvgTyre;
    const weatherSample = pickWeatherSample(weatherTimeline, leaderFinish);
    const scActive = isTimeInIntervals(leaderFinish, scData.scIntervals) ? 1 : 0;
    const vscActive = isTimeInIntervals(leaderFinish, scData.vscIntervals) ? 1 : 0;
    const nextLabel = computeNextScLabel(lap, lapEndTimes, totalLaps, scData.scDeployTimes, raceEndMs);

    const raceId = buildRaceId(session);
    const circuitId = (session.circuit_short_name ?? session.meeting_name ?? String(session.meeting_key)).replace(/\s+/g, "_").toUpperCase();
    const streetFlag = STREET_CIRCUITS.has((session.circuit_short_name ?? "").toUpperCase()) ? 1 : 0;

    const row = [
      raceId,
      session.year,
      circuitId,
      streetFlag,
      lap,
      totalLaps,
      scActive,
      vscActive,
      numCarsRunning,
      formatNumber(minGapValue),
      pairsLt1s,
      pitCount,
      formatNumber(avgTyreValue),
      formatNumber(weatherSample?.air_temperature),
      formatNumber(weatherSample?.humidity),
      formatNumber(weatherSample?.pressure),
      formatNumber(weatherSample?.rainfall),
      formatNumber(weatherSample?.track_temperature),
      formatNumber(weatherSample?.wind_speed),
      nextLabel,
    ]
      .map(csvEscape)
      .join(",");
    rows.push(row);

    if (minGapValue !== null) {
      lastMinGap = minGapValue;
    }
    if (avgTyreValue !== null) {
      lastAvgTyre = avgTyreValue;
    }
  }
  return rows;
}

type LapEntry = { driver: number; finish: number };

type StintInfo = { start: number; end: number; ageStart: number };

type SafetyData = {
  scIntervals: Array<{ start: number; end: number }>;
  vscIntervals: Array<{ start: number; end: number }>;
  scDeployTimes: number[];
};

function computeLapFinish(lap: LapRecordRow) {
  const startMs = lap.date_start ? Date.parse(lap.date_start) : NaN;
  const durationMs = (lap.lap_duration ?? 0) * 1000;
  if (Number.isFinite(startMs)) {
    return startMs + durationMs;
  }
  return Date.now();
}

function countCarsRunning(maxLapByDriver: Map<number, number>, lap: number) {
  let count = 0;
  maxLapByDriver.forEach((maxLap) => {
    if (maxLap >= lap) {
      count += 1;
    }
  });
  return count;
}

function computeGapStats(entries: LapEntry[]) {
  if (entries.length < 2) {
    return { minGap: null, pairsLt1s: 0 };
  }
  let minGap: number | null = null;
  let pairsLt1s = 0;
  for (let i = 1; i < entries.length; i += 1) {
    const gap = (entries[i].finish - entries[i - 1].finish) / 1000;
    if (gap < 0) continue;
    if (minGap === null || gap < minGap) {
      minGap = gap;
    }
    if (gap < 1) {
      pairsLt1s += 1;
    }
  }
  return { minGap, pairsLt1s };
}

function computeAverageTyreAge(
  stintsByDriver: Map<number, StintInfo[]>,
  lap: number,
  numCarsRunning: number
) {
  if (!numCarsRunning) return null;
  let sum = 0;
  let count = 0;
  stintsByDriver.forEach((stints, driver) => {
    const stint = stints.find((s) => lap >= s.start && lap <= (s.end || lap));
    if (!stint) return;
    const age = stint.ageStart + (lap - stint.start + 1);
    if (Number.isFinite(age)) {
      sum += age;
      count += 1;
    }
  });
  if (!count) return null;
  return sum / count;
}

function pickWeatherSample(
  samples: Array<{ time: number; values: WeatherRow }>,
  targetTime: number
) {
  if (!samples.length) {
    return null;
  }
  let picked = samples[0].values;
  for (const sample of samples) {
    if (sample.time <= targetTime) {
      picked = sample.values;
    } else {
      break;
    }
  }
  return picked;
}

function buildSafetyData(
  events: RaceControlRow[],
  sessionEndMs: number
): SafetyData {
  const scIntervals: Array<{ start: number; end: number }> = [];
  const vscIntervals: Array<{ start: number; end: number }> = [];
  const scDeployTimes: number[] = [];

  let scStart: number | null = null;
  let vscStart: number | null = null;

  events.forEach((event) => {
    const time = Date.parse(event.event_time);
    const kind = classifyRaceControlEvent(event);
    if (kind === "sc_start") {
      if (scStart === null) {
        scStart = time;
        scDeployTimes.push(time);
      }
    } else if (kind === "sc_end" && scStart !== null) {
      scIntervals.push({ start: scStart, end: time });
      scStart = null;
    } else if (kind === "vsc_start") {
      if (vscStart === null) {
        vscStart = time;
      }
    } else if (kind === "vsc_end" && vscStart !== null) {
      vscIntervals.push({ start: vscStart, end: time });
      vscStart = null;
    }
  });
