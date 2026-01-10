import { promises as fs } from "fs";
import path from "path";
import { db } from "../database";

const OUT_DIR = path.resolve(process.cwd(), "assets", "track_speed_maps");
const CANVAS_WIDTH = Number(process.env.TRACK_SPEED_WIDTH ?? 900);
const CANVAS_HEIGHT = Number(process.env.TRACK_SPEED_HEIGHT ?? 500);
const CANVAS_PADDING = Number(process.env.TRACK_SPEED_PADDING ?? 24);
const MAX_POINTS = Number(process.env.TRACK_SPEED_MAX_POINTS ?? 1000);
const SAMPLE_SECONDS = Number(process.env.TRACK_SPEED_SAMPLE_SECONDS ?? 1);

type TelemetryRow = {
  driver_number: number | string | null;
  lap_number: number | string | null;
  sample_time: string;
  speed: number | string | null;
  x: number | string | null;
  y: number | string | null;
  latitude: number | string | null;
  longitude: number | string | null;
};

type TrackPoint = {
  x: number;
  y: number;
  speed?: number;
};

type SessionRow = {
  session_key: number;
  session_name: string | null;
  circuit_short_name: string | null;
  year: number | null;
};

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pickPosition(row: TelemetryRow) {
  const x = toNumber(row.x);
  const y = toNumber(row.y);
  if (x != null && y != null) {
    return { x, y };
  }
  const lon = toNumber(row.longitude);
  const lat = toNumber(row.latitude);
  if (lon != null && lat != null) {
    return { x: lon, y: lat };
  }
  return null;
}

async function fileExists(candidate: string) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function fetchRaceSessions() {
  return (await db`
    SELECT s.session_key, s.session_name, m.circuit_short_name, m.year
    FROM sessions s
    JOIN meetings m ON m.meeting_key = s.meeting_key
    WHERE UPPER(s.session_type) = 'RACE'
    ORDER BY s.date_start
  `) as SessionRow[];
}

async function fetchTelemetry(sessionKey: number) {
  if (SAMPLE_SECONDS > 0) {
    return (await db`
      SELECT
        driver_number,
        lap_number,
        sample_time,
        speed,
        x,
        y,
        latitude,
        longitude
      FROM (
        SELECT
          driver_number,
          lap_number,
          sample_time,
          speed,
          x,
          y,
          latitude,
          longitude,
          ROW_NUMBER() OVER (
            PARTITION BY driver_number,
              time_bucket(${SAMPLE_SECONDS} * INTERVAL '1 second', sample_time)
            ORDER BY sample_time DESC
          ) AS row_rank
        FROM telemetry_samples
        WHERE session_key = ${sessionKey}
          AND lap_number IS NOT NULL
          AND lap_number > 0
      ) AS ranked
      WHERE row_rank = 1
      ORDER BY driver_number, lap_number, sample_time
    `) as TelemetryRow[];
  }

  return (await db`
    SELECT
      driver_number,
      lap_number,
      sample_time,
      speed,
      x,
      y,
      latitude,
      longitude
    FROM telemetry_samples
    WHERE session_key = ${sessionKey}
      AND lap_number IS NOT NULL
      AND lap_number > 0
    ORDER BY driver_number, lap_number, sample_time
  `) as TelemetryRow[];
}

function getBounds(points: TrackPoint[]) {
  return points.reduce(
    (acc, point) => ({
      minX: Math.min(acc.minX, point.x),
      maxX: Math.max(acc.maxX, point.x),
      minY: Math.min(acc.minY, point.y),
      maxY: Math.max(acc.maxY, point.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    }
  );
}

function getSpeedBounds(points: TrackPoint[]) {
  const bounds = points.reduce(
    (acc, point) => {
      if (typeof point.speed === "number" && Number.isFinite(point.speed)) {
        return {
          min: Math.min(acc.min, point.speed),
          max: Math.max(acc.max, point.speed),
          hasData: true,
        };
      }
      return acc;
    },
    { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, hasData: false }
  );

  if (!bounds.hasData) {
    return { min: 0, max: 0 };
  }

  return { min: bounds.min, max: bounds.max };
}

function speedToColor(ratio: number) {
  const clamped = Math.min(1, Math.max(0, ratio));
  const hue = (1 - clamped) * 240;
  return `hsl(${hue}, 90%, 55%)`;
}

function getSpeedColor(speed: number | undefined, bounds: { min: number; max: number }) {
  if (typeof speed === "number" && Number.isFinite(speed) && bounds.max > bounds.min) {
    const clamped = Math.max(bounds.min, Math.min(bounds.max, speed));
    const ratio = (clamped - bounds.min) / (bounds.max - bounds.min || 1);
    return speedToColor(ratio);
  }

  if (typeof speed === "number" && Number.isFinite(speed)) {
    return speedToColor(0.5);
  }

  return "#0f172a";
}

function buildSvg(points: TrackPoint[], label: string) {
  if (points.length < 2) {
    return null;
  }

  const bounds = getBounds(points);
  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY)) {
    return null;
  }

  const speedBounds = getSpeedBounds(points);
  const scaleX = (value: number) =>
    CANVAS_PADDING +
    ((value - bounds.minX) / (bounds.maxX - bounds.minX || 1)) *
      (CANVAS_WIDTH - CANVAS_PADDING * 2);
  const scaleY = (value: number) =>
    CANVAS_PADDING +
    ((value - bounds.minY) / (bounds.maxY - bounds.minY || 1)) *
      (CANVAS_HEIGHT - CANVAS_PADDING * 2);

  const segments: Array<{ color: string; d: string }> = [];
  let lastPoint: { x: number; y: number } | null = null;
  let currentColor: string | null = null;
  let currentPath: string[] = [];

  points.forEach((point) => {
    const px = scaleX(point.x);
    const py = scaleY(point.y);
    const color = getSpeedColor(point.speed, speedBounds);

    if (color !== currentColor) {
      if (currentPath.length) {
        segments.push({ color: currentColor ?? color, d: currentPath.join(" ") });
      }
      currentColor = color;
      currentPath = [];
      if (lastPoint) {
        currentPath.push(`M ${lastPoint.x.toFixed(2)} ${lastPoint.y.toFixed(2)}`);
        currentPath.push(`L ${px.toFixed(2)} ${py.toFixed(2)}`);
      } else {
        currentPath.push(`M ${px.toFixed(2)} ${py.toFixed(2)}`);
      }
    } else {
      if (!currentPath.length) {
        currentPath.push(`M ${px.toFixed(2)} ${py.toFixed(2)}`);
      } else {
        currentPath.push(`L ${px.toFixed(2)} ${py.toFixed(2)}`);
      }
    }

    lastPoint = { x: px, y: py };
  });

  if (currentPath.length) {
    segments.push({ color: currentColor ?? "#0f172a", d: currentPath.join(" ") });
  }

  const header = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}" preserveAspectRatio="xMidYMid meet">`;
  const title = `<title>${label}</title>`;
  const background = `<rect width="100%" height="100%" fill="#f8fafc" />`;
  const paths = segments
    .map(
      (segment) =>
        `<path d="${segment.d}" fill="none" stroke="${segment.color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />`
    )
    .join("");
  const footer = `</svg>`;

  return [header, title, background, paths, footer].join("");
}

async function writeSvgFile(
  sessionKey: number,
  driverNumber: number,
  lapNumber: number,
  svg: string,
  force: boolean
) {
  const sessionDir = path.join(OUT_DIR, String(sessionKey));
  const driverDir = path.join(sessionDir, `driver_${driverNumber}`);
  await fs.mkdir(driverDir, { recursive: true });
  const filePath = path.join(driverDir, `lap_${lapNumber}.svg`);

  if (!force && (await fileExists(filePath))) {
    return false;
  }

  await fs.writeFile(filePath, svg, "utf-8");
  return true;
}

async function buildForSession(
  session: SessionRow,
  force: boolean
) {
  const rows = await fetchTelemetry(session.session_key);
  if (!rows.length) {
    console.log(`[TRACK SPEED] No telemetry for session ${session.session_key}`);
    return;
  }

  let currentDriver: number | null = null;
  let currentLap: number | null = null;
  let points: TrackPoint[] = [];
  let sampleCount = 0;

  const flush = async () => {
    if (currentDriver == null || currentLap == null || points.length < 2) {
      points = [];
      sampleCount = 0;
      return;
    }

    const label = `Session ${session.session_key} driver ${currentDriver} lap ${currentLap}`;
    const svg = buildSvg(points, label);
    if (!svg) {
      points = [];
      sampleCount = 0;
      return;
    }

    const written = await writeSvgFile(
      session.session_key,
      currentDriver,
      currentLap,
      svg,
      force
    );
    if (written) {
      console.log(
        `[TRACK SPEED] Wrote ${session.session_key} driver ${currentDriver} lap ${currentLap}`
      );
    }

    points = [];
    sampleCount = 0;
  };

  for (const row of rows) {
    const driverNumber = toNumber(row.driver_number);
    const lapNumber = toNumber(row.lap_number);
    if (driverNumber == null || lapNumber == null) {
      continue;
    }

    const isNewLap =
      currentDriver == null ||
      currentLap == null ||
      driverNumber !== currentDriver ||
      lapNumber !== currentLap;

    if (isNewLap) {
      await flush();
      currentDriver = driverNumber;
      currentLap = lapNumber;
    }

    if (sampleCount >= MAX_POINTS) {
      continue;
    }

    const position = pickPosition(row);
    if (!position) {
      continue;
    }

    const speed = toNumber(row.speed);
    points.push({ x: position.x, y: position.y, speed: speed ?? undefined });
    sampleCount += 1;
  }

  await flush();
}

function parseArgs(args: string[]) {
  let force = false;
  const sessions: number[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--session" || arg === "-s") {
      const raw = args[i + 1];
      if (raw) {
        raw
          .split(",")
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
          .forEach((value) => sessions.push(value));
      }
      i += 1;
    }
  }

  return { force, sessions };
}

async function main() {
  const { force, sessions } = parseArgs(process.argv.slice(2));
  await fs.mkdir(OUT_DIR, { recursive: true });

  const sessionRows = await fetchRaceSessions();
  const targets = sessions.length
    ? sessionRows.filter((session) => sessions.includes(session.session_key))
    : sessionRows;

  if (!targets.length) {
    console.log("[TRACK SPEED] No race sessions found");
    return;
  }

  for (const session of targets) {
    const label = session.circuit_short_name ?? "Unknown circuit";
    const year = session.year ? ` ${session.year}` : "";
    console.log(
      `[TRACK SPEED] Session ${session.session_key} (${label}${year})`
    );
    await buildForSession(session, force);
  }
}

main().catch((error) => {
  console.error("[TRACK SPEED] Failed to build speed maps", error);
  process.exit(1);
});
