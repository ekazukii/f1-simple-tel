import Koa from "koa";
import Router from "@koa/router";
import { db, initializeDatabase } from "./database";

const DEFAULT_PORT = 4000;

const parsedPort = Number(process.env.PORT);
const PORT =
  Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

interface SessionMeta {
  circuit_key: number | null;
  circuit_short_name: string | null;
  country_code: string | null;
  country_key: number | null;
  country_name: string | null;
  date_end: string | null;
  date_start: string | null;
  gmt_offset: string | null;
  location: string | null;
  meeting_key: number;
  session_key: number;
  session_name: string | null;
  session_type: string | null;
  year: number | null;
}

interface TelemetrySample {
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
}

interface PitStopRow {
  driver_number: number;
  lap_number: number;
  stop_time: string;
  pit_duration: number | null;
}

interface RaceControlRow {
  driver_number: number | null;
  lap_number: number | null;
  category: string | null;
  flag: string | null;
  scope: string | null;
  sector: string | null;
  message: string | null;
  event_time: string;
}

interface StintRow {
  driver_number: number;
  stint_number: number;
  lap_start: number | null;
  lap_end: number | null;
  compound: string | null;
  tyre_age_at_start: number | null;
}

interface LapRow {
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
}

interface SessionResponse {
  sessionKey: string;
  sessionInfo: SessionMeta;
  telemetry: TelemetrySample[];
  pitStops: PitStopRow[];
  raceControl: RaceControlRow[];
  stints: StintRow[];
  laps: LapRow[];
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

const app = new Koa();
const router = new Router();

app.use(async (ctx, next) => {
  const startedAt = Date.now();
  console.log(`[HTTP] start ${ctx.method} ${ctx.url}`);

  try {
    await next();
  } catch (error) {
    console.error("Unhandled error", error);
    ctx.status = 500;
    ctx.body = { error: "Internal server error" };
  } finally {
    const duration = Date.now() - startedAt;
    console.log(
      `[HTTP] ${ctx.method} ${ctx.url} -> ${ctx.status} (${duration}ms)`
    );
  }
});

app.use(async (ctx, next) => {
  ctx.set("Access-Control-Allow-Origin", "*");
  ctx.set(
    "Access-Control-Allow-Headers",
    ctx.get("Access-Control-Request-Headers") || "*"
  );
  ctx.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

  if (ctx.method === "OPTIONS") {
    ctx.status = 204;
    return;
  }

  await next();
});

router.get("/session/:key", async (ctx) => {
  const sessionKey = ctx.params.key?.trim();
  const sampleSecondsRaw = ctx.query.sampleSeconds ?? ctx.query.sample ?? ctx.query.s;
  const parsedSample = Number(sampleSecondsRaw);
  const sampleSeconds = Number.isFinite(parsedSample) && parsedSample > 0 ? parsedSample : null;

  if (!sessionKey) {
    ctx.status = 400;
    ctx.body = { error: "Session key is required" };
    return;
  }

  try {
    console.log(`[DB] Querying session ${sessionKey}`);
    const data = await getSessionData(sessionKey, sampleSeconds);
    ctx.body = data;
    console.log(`[DB] Finish querying session ${sessionKey}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[HTTP] Failed to load session ${sessionKey}:`, error);
    if (error instanceof NotFoundError) {
      ctx.status = 404;
      ctx.body = { error: message };
    } else {
      ctx.status = 502;
      ctx.body = { error: "Failed to fetch session data", detail: message };
    }
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend API listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database", error);
    process.exit(1);
  });

export default app;

async function getSessionData(
  requestKey: string,
  sampleSeconds: number | null
): Promise<SessionResponse> {
  const resolved = await resolveSessionKey(requestKey);
  if (!resolved) {
    throw new NotFoundError(`Session ${requestKey} not found`);
  }
  return loadSessionFromDatabase(
    resolved.numericKey,
    resolved.alias ?? requestKey,
    sampleSeconds
  );
}

async function resolveSessionKey(
  identifier: string
): Promise<{ numericKey: number; alias?: string } | null> {
  if (!identifier) {
    return null;
  }

  const aliasRows = (await db`
    SELECT session_key FROM session_aliases WHERE alias = ${identifier} LIMIT 1
  `) as Array<{ session_key: number }>;

  if (aliasRows.length) {
    return { numericKey: aliasRows[0].session_key, alias: identifier };
  }

  const numeric = Number(identifier);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const sessionRows = (await db`
    SELECT session_key FROM sessions WHERE session_key = ${numeric} LIMIT 1
  `) as Array<{ session_key: number }>;

  if (!sessionRows.length) {
    return null;
  }

  return { numericKey: sessionRows[0].session_key };
}

async function loadSessionFromDatabase(
  sessionKey: number,
  requestKey: string,
  sampleSeconds: number | null
): Promise<SessionResponse> {
  let infoRows: Array<Record<string, unknown>> = [];
  try {
    infoRows = (await db`
      SELECT
        s.session_key,
        s.session_type,
        s.session_name,
        s.date_start,
        s.date_end,
        m.meeting_key,
        m.location,
        m.country_name,
        m.country_code,
        m.country_key,
        m.circuit_key,
        m.circuit_short_name,
        m.gmt_offset,
        m.year
      FROM sessions s
      JOIN meetings m ON m.meeting_key = s.meeting_key
      WHERE s.session_key = ${sessionKey}
      LIMIT 1
    `) as Array<Record<string, unknown>>;
  } catch (error) {
    console.error(
      `[DB] Failed to load session metadata for ${sessionKey}`,
      error
    );
    throw new Error("Failed to read data");
  }

  if (!infoRows.length) {
    throw new NotFoundError(`Session ${sessionKey} not found`);
  }

  const aliasRows = (await db`
    SELECT alias FROM session_aliases WHERE session_key = ${sessionKey} LIMIT 1
  `) as Array<{ alias: string }>;

  const sessionInfo = mapSessionInfo(infoRows[0]);
  const telemetry = await fetchTelemetry(sessionKey, sampleSeconds);
  const pitStops = await fetchPitStops(sessionKey);
  const raceControl = await fetchRaceControl(sessionKey);
  const stints = await fetchStints(sessionKey);
  const laps = await fetchLaps(sessionKey);

  return {
    sessionKey: aliasRows[0]?.alias ?? requestKey ?? String(sessionKey),
    sessionInfo,
    telemetry,
    pitStops,
    raceControl,
    stints,
    laps,
  };
}

async function fetchTelemetry(
  sessionKey: number,
  sampleSeconds: number | null
): Promise<TelemetrySample[]> {
  const rows = sampleSeconds
    ? ((await db`
        SELECT
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
        FROM (
          SELECT DISTINCT ON (driver_number, time_bucket(${sampleSeconds} * INTERVAL '1 second', sample_time))
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
          FROM telemetry_samples
          WHERE session_key = ${sessionKey}
          ORDER BY driver_number,
            time_bucket(${sampleSeconds} * INTERVAL '1 second', sample_time),
            sample_time DESC
        ) AS bucketed
        ORDER BY driver_number, sample_time
      `) as Array<Record<string, unknown>>)
    : ((await db`
        SELECT
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
        FROM telemetry_samples
        WHERE session_key = ${sessionKey}
        ORDER BY driver_number, sample_time
      `) as Array<Record<string, unknown>>);

  return rows.map((row) => ({
    driver_number: toNumber(row.driver_number) ?? 0,
    sample_time: toIso(row.sample_time),
    lap_number: toNumber(row.lap_number),
    drs: toNullableNumber(row.drs),
    speed: toNullableNumber(row.speed),
    brake: toNullableNumber(row.brake),
    rpm: toNullableNumber(row.rpm),
    n_gear: toNullableNumber(row.n_gear),
    throttle: toNullableNumber(row.throttle),
    x: toNullableNumber(row.x),
    y: toNullableNumber(row.y),
    z: toNullableNumber(row.z),
    latitude: toNullableNumber(row.latitude),
    longitude: toNullableNumber(row.longitude),
  }));
}

async function fetchPitStops(sessionKey: number): Promise<PitStopRow[]> {
  const rows = (await db`
    SELECT driver_number, lap_number, stop_time, pit_duration
    FROM pit_stops
    WHERE session_key = ${sessionKey}
    ORDER BY stop_time
  `) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    driver_number: toNumber(row.driver_number) ?? 0,
    lap_number: toNumber(row.lap_number) ?? 0,
    stop_time: toIso(row.stop_time),
    pit_duration: toNullableNumber(row.pit_duration),
  }));
}

async function fetchRaceControl(sessionKey: number): Promise<RaceControlRow[]> {
  const rows = (await db`
    SELECT
      driver_number,
      lap_number,
      category,
      flag,
      scope,
      sector,
      message,
      event_time
    FROM race_control_events
    WHERE session_key = ${sessionKey}
    ORDER BY event_time
  `) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    driver_number: toNumber(row.driver_number),
    lap_number: toNumber(row.lap_number),
    category: row.category?.toString() ?? null,
    flag: nullableString(row.flag),
    scope: nullableString(row.scope),
    sector: nullableString(row.sector),
    message: nullableString(row.message),
    event_time: toIso(row.event_time),
  }));
}

async function fetchStints(sessionKey: number): Promise<StintRow[]> {
  const rows = (await db`
    SELECT
      driver_number,
      stint_number,
      lap_start,
      lap_end,
      compound,
      tyre_age_at_start
    FROM stints
    WHERE session_key = ${sessionKey}
    ORDER BY driver_number, stint_number
  `) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    driver_number: toNumber(row.driver_number) ?? 0,
    stint_number: toNumber(row.stint_number) ?? 0,
    lap_start: toNullableNumber(row.lap_start),
    lap_end: toNullableNumber(row.lap_end),
    compound: nullableString(row.compound),
    tyre_age_at_start: toNullableNumber(row.tyre_age_at_start),
  }));
}

async function fetchLaps(sessionKey: number): Promise<LapRow[]> {
  const rows = (await db`
    SELECT
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
      array_to_json(segments_sector_1) AS segments_sector_1,
      array_to_json(segments_sector_2) AS segments_sector_2,
      array_to_json(segments_sector_3) AS segments_sector_3
    FROM laps
    WHERE session_key = ${sessionKey}
    ORDER BY driver_number, lap_number
  `) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    driver_number: toNumber(row.driver_number) ?? 0,
    lap_number: toNumber(row.lap_number) ?? 0,
    date_start: toIsoNullable(row.date_start),
    lap_duration: toNullableNumber(row.lap_duration),
    duration_sector_1: toNullableNumber(row.duration_sector_1),
    duration_sector_2: toNullableNumber(row.duration_sector_2),
    duration_sector_3: toNullableNumber(row.duration_sector_3),
    i1_speed: toNullableNumber(row.i1_speed),
    i2_speed: toNullableNumber(row.i2_speed),
    st_speed: toNullableNumber(row.st_speed),
    is_pit_out_lap: Boolean(row.is_pit_out_lap),
    segments_sector_1: toNumberArray(row.segments_sector_1),
    segments_sector_2: toNumberArray(row.segments_sector_2),
    segments_sector_3: toNumberArray(row.segments_sector_3),
  }));
}

function mapSessionInfo(row: Record<string, unknown>): SessionMeta {
  return {
    circuit_key: toNumber(row.circuit_key),
    circuit_short_name: nullableString(row.circuit_short_name),
    country_code: nullableString(row.country_code),
    country_key: toNumber(row.country_key),
    country_name: nullableString(row.country_name),
    date_end: toIsoNullable(row.date_end),
    date_start: toIsoNullable(row.date_start),
    gmt_offset: nullableString(row.gmt_offset),
    location: nullableString(row.location),
    meeting_key: toNumber(row.meeting_key) ?? 0,
    session_key: toNumber(row.session_key) ?? 0,
    session_name: nullableString(row.session_name),
    session_type: nullableString(row.session_type),
    year: toNumber(row.year),
  };
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function toNullableNumber(value: unknown): number | null {
  return toNumber(value);
}

function nullableString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const str = String(value).trim();
  return str.length ? str : null;
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = toIsoNullable(value);
  if (!parsed) {
    return new Date().toISOString();
  }
  return parsed;
}

function toIsoNullable(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function toNumberArray(value: unknown): Array<number | null> | null {
  if (value == null) {
    return null;
  }
  let arrayValue: unknown = value;
  if (!Array.isArray(arrayValue) && typeof arrayValue === "string") {
    try {
      arrayValue = JSON.parse(arrayValue);
    } catch (error) {
      console.warn("Failed to parse segment array", value, error);
      return null;
    }
  }
  if (!Array.isArray(arrayValue)) {
    return null;
  }
  return arrayValue.map((entry) => toNullableNumber(entry));
}
