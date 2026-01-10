import Koa from "koa";
import { randomInt } from "node:crypto";
import Router from "@koa/router";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { db, initializeDatabase } from "./database";

const DEFAULT_PORT = 4000;
const STRATEGY_NUM_RUNS = 10;
const STRATEGY_UPDATE_EVERY = 2;
const STRATEGY_NOISE_SCALE = 0.5;

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
  meeting_name: string | null;
  meeting_official_name: string | null;
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
  dataState: SessionDataState;
  lastRefreshed: string | null;
  sessionInfo: SessionMeta;
  telemetry: TelemetrySample[];
  pitStops: PitStopRow[];
  raceControl: RaceControlRow[];
  stints: StintRow[];
  laps: LapRow[];
  weather: WeatherSampleRow[];
}

type SessionDataState = "none" | "no_telemetry" | "with_telemetry";

interface WeatherSampleRow {
  recorded_at: string;
  air_temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  rainfall: number | null;
  track_temperature: number | null;
  wind_direction: number | null;
  wind_speed: number | null;
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
  const sampleSecondsRaw =
    ctx.query.sampleSeconds ?? ctx.query.sample ?? ctx.query.s;
  const parsedSample = Number(sampleSecondsRaw);
  const sampleSeconds =
    Number.isFinite(parsedSample) && parsedSample > 0 ? parsedSample : null;

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

router.get("/track-layout/:circuitKey", async (ctx) => {
  const rawKey = ctx.params.circuitKey?.trim();
  if (!rawKey || !/^\d+$/.test(rawKey)) {
    ctx.status = 400;
    ctx.body = { error: "Circuit key must be a numeric identifier" };
    return;
  }

  const fileExists = async (candidate: string) => {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      return false;
    }
  };

  const cwd = process.cwd();
  const candidateDirs = [
    path.join(cwd, "assets", "track_heatmaps"),
    path.join(cwd, "backend", "assets", "track_heatmaps"),
    path.join(path.resolve(cwd, ".."), "backend", "assets", "track_heatmaps"),
  ];
  const fileName = `circuit_${rawKey}.svg`;
  let filePath: string | null = null;

  for (const dir of candidateDirs) {
    const candidate = path.join(dir, fileName);
    if (await fileExists(candidate)) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath) {
    ctx.status = 404;
    ctx.body = { error: "Track layout not found" };
    return;
  }

  try {
    const svg = await fs.readFile(filePath, "utf-8");
    ctx.type = "image/svg+xml";
    ctx.body = svg;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    ctx.status = 500;
    ctx.body = { error: "Failed to read track layout", detail: message };
  }
});

router.get("/track-speed/:sessionKey/:driver/:lap", async (ctx) => {
  const rawSession = ctx.params.sessionKey?.trim();
  const rawDriver = ctx.params.driver?.trim();
  const rawLap = ctx.params.lap?.trim();

  if (!rawSession || !rawDriver || !rawLap) {
    ctx.status = 400;
    ctx.body = { error: "Session, driver, and lap are required" };
    return;
  }

  const resolved = await resolveSessionKey(rawSession);
  if (!resolved) {
    ctx.status = 404;
    ctx.body = { error: "Session not found" };
    return;
  }

  const driverNumber = Number(rawDriver);
  const lapNumber = Number(rawLap);
  if (!Number.isFinite(driverNumber) || !Number.isFinite(lapNumber)) {
    ctx.status = 400;
    ctx.body = { error: "Driver and lap must be numeric identifiers" };
    return;
  }

  const fileExists = async (candidate: string) => {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      return false;
    }
  };

  const sessionKey = resolved.numericKey;
  const cwd = process.cwd();
  const driverDir = `driver_${driverNumber}`;
  const candidateDirs = [
    path.join(cwd, "assets", "track_speed_maps", String(sessionKey), driverDir),
    path.join(
      cwd,
      "backend",
      "assets",
      "track_speed_maps",
      String(sessionKey),
      driverDir
    ),
    path.join(
      path.resolve(cwd, ".."),
      "backend",
      "assets",
      "track_speed_maps",
      String(sessionKey),
      driverDir
    ),
  ];
  const fileName = `lap_${lapNumber}.svg`;
  let filePath: string | null = null;

  for (const dir of candidateDirs) {
    const candidate = path.join(dir, fileName);
    if (await fileExists(candidate)) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath) {
    ctx.status = 404;
    ctx.body = { error: "Track speed map not found" };
    return;
  }

  try {
    const svg = await fs.readFile(filePath, "utf-8");
    ctx.type = "image/svg+xml";
    ctx.body = svg;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    ctx.status = 500;
    ctx.body = { error: "Failed to read track speed map", detail: message };
  }
});

router.post("/simulation/strategy", async (ctx) => {
  let body: unknown;
  try {
    body = await readJsonBody(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    ctx.status = 400;
    ctx.body = { error: "Invalid JSON payload", detail: message };
    return;
  }
  if (!body || typeof body !== "object") {
    ctx.status = 400;
    ctx.body = { error: "Invalid JSON payload" };
    return;
  }

  const payload = body as {
    paths?: Record<string, string>;
    options?: Record<string, unknown>;
    strategy?: Record<string, unknown>;
  };

  if (!payload.strategy) {
    ctx.status = 400;
    ctx.body = { error: "Missing strategy configuration" };
    return;
  }

  const fileExists = async (candidate: string) => {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      return false;
    }
  };

  const cwd = process.cwd();
  const repoRoot =
    process.env.F1STUFF_ROOT ??
    ((await fileExists(path.join(cwd, "models")))
      ? cwd
      : path.resolve(cwd, ".."));
  const modelsDir = path.join(repoRoot, "models");

  const resolveModelPath = async (fileName: string) => {
    const primary = path.join(modelsDir, fileName);
    if (await fileExists(primary)) {
      return primary;
    }
    const nested = path.join(modelsDir, "models", fileName);
    if (await fileExists(nested)) {
      return nested;
    }
    return primary;
  };

  const paths = { ...(payload.paths ?? {}) };
  if (!paths.base_dir) {
    paths.base_dir = repoRoot;
  }
  paths.bundle_path ??= await resolveModelPath("laptime_model_bundle.joblib");
  paths.data_path ??= await resolveModelPath("fastf1_lap_dataset.csv");
  paths.overtake_path ??= await resolveModelPath("overtaking_model.joblib");
  paths.dnf_path ??= await resolveModelPath("dnf_model.joblib");
  paths.safety_path ??= await resolveModelPath("safety_car_model.joblib");

  const incomingOptions = payload.options ?? {};
  const rawSeed = incomingOptions.seed;
  let seed: number | undefined;
  if (typeof rawSeed === "number" && Number.isFinite(rawSeed)) {
    seed = Math.trunc(rawSeed);
  } else if (typeof rawSeed === "string" && rawSeed.trim()) {
    const parsed = Number(rawSeed);
    if (Number.isFinite(parsed)) {
      seed = Math.trunc(parsed);
    }
  }
  if (seed == null) {
    seed = randomInt(0, 1_000_000_000);
  }
  const incomingStrategy = payload.strategy ?? {};
  const options = {
    ...incomingOptions,
    noise_scale: STRATEGY_NOISE_SCALE,
    seed,
  };
  const strategy = {
    ...incomingStrategy,
    num_runs_compare: STRATEGY_NUM_RUNS,
    update_every: STRATEGY_UPDATE_EVERY,
  };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "f1sim-"));
  const inputPath = path.join(tempDir, "input.json");
  const outputPath = path.join(tempDir, "output.json");
  const inputPayload = {
    paths,
    options,
    strategy,
  };
  await fs.writeFile(inputPath, JSON.stringify(inputPayload, null, 2), "utf-8");

  const scriptPath = path.join(modelsDir, "montecarlo_sim.py");
  const pythonBin = process.env.PYTHON_BIN ?? "python3";
  const child = spawn(
    pythonBin,
    [scriptPath, "--strategy", "--input", inputPath, "--output", outputPath],
    { cwd: repoRoot }
  );

  ctx.respond = false;
  ctx.res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const sendLine = (line: string) => {
    if (!line.trim()) {
      return;
    }
    ctx.res.write(line.endsWith("\n") ? line : `${line}\n`);
  };

  let stdoutBuffer = "";

  const cleanup = async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  const handleProcessError = (message: string) => {
    sendLine(JSON.stringify({ event: "error", message }));
    ctx.res.end();
    void cleanup();
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    let index = stdoutBuffer.indexOf("\n");
    while (index !== -1) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      sendLine(line);
      index = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message) {
      console.error("[SIM] stderr:", message);
      sendLine(JSON.stringify({ event: "stderr", message }));
    }
  });

  child.on("error", (error) => {
    console.error("[SIM] spawn error:", error);
    handleProcessError(error.message);
  });

  child.on("close", async (code) => {
    if (stdoutBuffer.trim()) {
      sendLine(stdoutBuffer.trim());
    }
    if (code !== 0) {
      handleProcessError(
        `Simulation failed with exit code ${code ?? "unknown"}`
      );
      return;
    }
    try {
      const outputText = await fs.readFile(outputPath, "utf-8");
      const outputData = JSON.parse(outputText);
      sendLine(JSON.stringify({ event: "result", data: outputData }));
      ctx.res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      handleProcessError(`Failed to read output: ${message}`);
    } finally {
      await cleanup();
    }
  });

  ctx.req.on("close", () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    void cleanup();
  });
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

async function readJsonBody(ctx: Koa.Context): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let body = "";
    ctx.req.setEncoding("utf-8");
    ctx.req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        reject(new Error("Payload too large"));
        ctx.req.destroy();
      }
    });
    ctx.req.on("end", () => {
      if (!body.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    ctx.req.on("error", (error) => reject(error));
  });
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
        s.data_status,
        s.last_refreshed,
        m.meeting_key,
        m.meeting_name,
        m.meeting_official_name,
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
  const dataState = mapSessionDataState(infoRows[0].data_status);
  const lastRefreshed = toIsoNullable(infoRows[0].last_refreshed);
  const telemetry = await fetchTelemetry(sessionKey, sampleSeconds);
  const pitStops = await fetchPitStops(sessionKey);
  const raceControl = await fetchRaceControl(sessionKey);
  const stints = await fetchStints(sessionKey);
  const laps = await fetchLaps(sessionKey);
  const weather = await fetchWeatherSamples(sessionKey);

  return {
    sessionKey: aliasRows[0]?.alias ?? requestKey ?? String(sessionKey),
    dataState,
    lastRefreshed,
    sessionInfo,
    telemetry,
    pitStops,
    raceControl,
    stints,
    laps,
    weather,
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
            longitude,
            ROW_NUMBER() OVER (
              PARTITION BY driver_number,
                time_bucket(${sampleSeconds} * INTERVAL '1 second', sample_time)
              ORDER BY sample_time DESC
            ) AS row_rank
          FROM telemetry_samples
          WHERE session_key = ${sessionKey}
        ) AS ranked
        WHERE row_rank = 1
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

async function fetchWeatherSamples(
  sessionKey: number
): Promise<WeatherSampleRow[]> {
  const rows = (await db`
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
  `) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    recorded_at: toIso(row.recorded_at) ?? new Date().toISOString(),
    air_temperature: toNullableNumber(row.air_temperature),
    humidity: toNullableNumber(row.humidity),
    pressure: toNullableNumber(row.pressure),
    rainfall: toNullableNumber(row.rainfall),
    track_temperature: toNullableNumber(row.track_temperature),
    wind_direction: toNullableNumber(row.wind_direction),
    wind_speed: toNullableNumber(row.wind_speed),
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
    meeting_name: nullableString(row.meeting_name),
    meeting_official_name: nullableString(row.meeting_official_name),
    session_key: toNumber(row.session_key) ?? 0,
    session_name: nullableString(row.session_name),
    session_type: nullableString(row.session_type),
    year: toNumber(row.year),
  };
}

function mapSessionDataState(value: unknown): SessionDataState {
  if (value === "no_telemetry" || value === "with_telemetry") {
    return value;
  }
  return "none";
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
