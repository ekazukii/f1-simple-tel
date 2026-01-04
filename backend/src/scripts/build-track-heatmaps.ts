import { promises as fs } from "fs";
import path from "path";
import { db } from "../database";

const SESSIONS_PER_CIRCUIT = Number(process.env.HEATMAP_SESSIONS ?? 5);
const MIN_LAP_SAMPLES = Number(process.env.TRACK_MIN_LAP_SAMPLES ?? 800);
const CANDIDATE_LAPS = Number(process.env.TRACK_CANDIDATES ?? 12);
const MIN_ASPECT_RATIO = Number(process.env.TRACK_MIN_ASPECT ?? 0.08);
const MAX_GAP_MULT = Number(process.env.TRACK_MAX_GAP_MULT ?? 12);
const MIN_PATH_MULT = Number(process.env.TRACK_MIN_PATH_MULT ?? 2.0);
const MIN_SIMPLIFIED_POINTS = Number(process.env.TRACK_MIN_SIMPLIFIED_POINTS ?? 60);
const SIMPLIFY_EPS = Number(process.env.TRACK_SIMPLIFY_EPS ?? 0.0015);
const SIMPLIFY_MULT = Number(process.env.TRACK_SIMPLIFY_MULT ?? 3);
const STROKE_SCALE = Number(process.env.TRACK_STROKE_SCALE ?? 0.003);
const OUT_DIR = path.resolve(process.cwd(), "assets", "track_heatmaps");

type CircuitSession = {
  circuit_key: number;
  circuit_short_name: string;
  session_key: number;
  date_start: string;
};

type Point = { x: number; y: number };

type ReferenceLap = {
  session_key: number;
  driver_number: number;
  lap_number: number;
  sample_count: number;
};

type PathStats = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  aspectRatio: number;
  pathLength: number;
  medianSpacing: number;
  maxSpacing: number;
};

function dedupePoints(points: Point[]) {
  const cleaned: Point[] = [];
  let last: Point | null = null;
  points.forEach((point) => {
    if (!last || point.x !== last.x || point.y !== last.y) {
      cleaned.push(point);
      last = point;
    }
  });
  return cleaned;
}

function simplifyPath(points: Point[], epsilon: number) {
  if (points.length < 3) {
    return points;
  }

  const rdp = (start: number, end: number, out: boolean[]) => {
    let maxDistance = 0;
    let index = start;
    const a = points[start];
    const b = points[end];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy || 1;

    for (let i = start + 1; i < end; i += 1) {
      const p = points[i];
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
      const projX = a.x + t * dx;
      const projY = a.y + t * dy;
      const dist = Math.hypot(p.x - projX, p.y - projY);
      if (dist > maxDistance) {
        maxDistance = dist;
        index = i;
      }
    }

    if (maxDistance > epsilon) {
      out[index] = true;
      rdp(start, index, out);
      rdp(index, end, out);
    }
  };

  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  rdp(0, points.length - 1, keep);
  return points.filter((_, idx) => keep[idx]);
}

function computePathStats(points: Point[]): PathStats | null {
  if (points.length < 2) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const distances: number[] = [];
  let pathLength = 0;

  points.forEach((point, index) => {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);

    if (index > 0) {
      const prev = points[index - 1];
      const dist = Math.hypot(point.x - prev.x, point.y - prev.y);
      if (dist > 0) {
        distances.push(dist);
        pathLength += dist;
      }
    }
  });

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null;
  }

  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  const maxDim = Math.max(width, height) || 1;
  const aspectRatio = Math.min(width, height) / maxDim;
  distances.sort((a, b) => a - b);
  const medianSpacing = distances.length
    ? distances[Math.floor(distances.length / 2)]
    : 0;
  const maxSpacing = distances.length ? distances[distances.length - 1] : 0;

  return {
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
    aspectRatio,
    pathLength,
    medianSpacing,
    maxSpacing
  };
}

function buildSvg(points: Point[], circuitKey: number, circuitLabel: string) {
  const cleaned = dedupePoints(points);
  const stats = computePathStats(cleaned);
  if (!stats) {
    return null;
  }

  const { minX, minY, width, height, medianSpacing } = stats;
  const maxDim = Math.max(width, height);
  const spacingEps =
    medianSpacing > 0 ? medianSpacing * SIMPLIFY_MULT : SIMPLIFY_EPS * maxDim;
  const epsilon = Math.min(SIMPLIFY_EPS * maxDim, spacingEps);
  const simplified = simplifyPath(cleaned, epsilon);
  const finalPath = simplified.length < MIN_SIMPLIFIED_POINTS ? cleaned : simplified;
  if (finalPath.length < 2) {
    return null;
  }

  const strokeWidth = Math.max(1, maxDim * STROKE_SCALE);
  const d = finalPath
    .map((point, index) =>
      `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
    )
    .join(" ");

  const viewBox = `${minX.toFixed(2)} ${minY.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">`,
    `<title>Circuit ${circuitLabel} (${circuitKey})</title>`,
    `<g>`,
    `<path d="${d}" fill="none" stroke="#1d4ed8" stroke-width="${strokeWidth.toFixed(
      2
    )}" stroke-linecap="round" stroke-linejoin="round" opacity="0.25" />`,
    `</g>`,
    `</svg>`
  ].join("");

  return svg;
}

async function fetchCircuitSessions() {
  return (await db`
    SELECT s.session_key, s.date_start, m.circuit_key, m.circuit_short_name
    FROM sessions s
    JOIN meetings m ON m.meeting_key = s.meeting_key
    WHERE UPPER(s.session_type) = 'RACE'
  `) as CircuitSession[];
}

async function fetchReferenceLapCandidates(sessionKeys: number[], limit: number) {
  if (!sessionKeys.length) {
    return [];
  }
  const sessionKeyArray = `{${sessionKeys
    .map((key) => Number(key))
    .filter((key) => Number.isFinite(key))
    .join(",")}}`;
  const rows = (await db`
    WITH pit_laps AS (
      SELECT session_key, driver_number, lap_number
      FROM pit_stops
      WHERE session_key = ANY(${sessionKeyArray}::int4[])
    )
    SELECT t.session_key, t.driver_number, t.lap_number, COUNT(*) AS sample_count
    FROM telemetry_samples t
    WHERE t.session_key = ANY(${sessionKeyArray}::int4[])
      AND t.x IS NOT NULL
      AND t.y IS NOT NULL
      AND t.lap_number IS NOT NULL
      AND t.lap_number > 0
      AND NOT EXISTS (
        SELECT 1
        FROM pit_laps p
        WHERE p.session_key = t.session_key
          AND p.driver_number = t.driver_number
          AND (p.lap_number = t.lap_number OR p.lap_number + 1 = t.lap_number)
      )
    GROUP BY t.session_key, t.driver_number, t.lap_number
    ORDER BY sample_count DESC
    LIMIT ${limit}
  `) as Array<ReferenceLap & { sample_count: number | string }>;

  return rows.map((row) => ({
    session_key: Number(row.session_key),
    driver_number: Number(row.driver_number),
    lap_number: Number(row.lap_number),
    sample_count: Number(row.sample_count)
  }));
}

async function fetchLapPoints(sessionKey: number, driverNumber: number, lapNumber: number) {
  const rows = (await db`
    SELECT x, y
    FROM telemetry_samples
    WHERE session_key = ${sessionKey}
      AND driver_number = ${driverNumber}
      AND lap_number = ${lapNumber}
      AND x IS NOT NULL
      AND y IS NOT NULL
    ORDER BY sample_time ASC
  `) as Array<{ x: number; y: number }>;

  return rows
    .map((row) => ({
      x: Number(row.x),
      y: Number(row.y)
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

async function selectBestLap(candidates: ReferenceLap[]) {
  let best:
    | {
        lap: ReferenceLap;
        points: Point[];
        stats: PathStats;
        score: number;
      }
    | undefined;

  for (const candidate of candidates) {
    if (candidate.sample_count < MIN_LAP_SAMPLES) {
      continue;
    }
    const points = await fetchLapPoints(
      candidate.session_key,
      candidate.driver_number,
      candidate.lap_number
    );
    if (points.length < MIN_LAP_SAMPLES) {
      continue;
    }

    const cleaned = dedupePoints(points);
    const stats = computePathStats(cleaned);
    if (!stats) {
      continue;
    }

    if (stats.aspectRatio < MIN_ASPECT_RATIO) {
      continue;
    }
    if (stats.medianSpacing > 0 && stats.maxSpacing > stats.medianSpacing * MAX_GAP_MULT) {
      continue;
    }
    if (stats.pathLength < Math.max(stats.width, stats.height) * MIN_PATH_MULT) {
      continue;
    }

    const score = stats.pathLength * stats.aspectRatio;
    if (!best || score > best.score) {
      best = {
        lap: candidate,
        points: cleaned,
        stats,
        score
      };
    }
  }

  if (best) {
    return best;
  }

  if (!candidates.length) {
    return null;
  }

  const fallback = candidates[0];
  const fallbackPoints = await fetchLapPoints(
    fallback.session_key,
    fallback.driver_number,
    fallback.lap_number
  );
  const fallbackCleaned = dedupePoints(fallbackPoints);
  const fallbackStats = computePathStats(fallbackCleaned);
  if (!fallbackStats) {
    return null;
  }

  return {
    lap: fallback,
    points: fallbackCleaned,
    stats: fallbackStats,
    score: 0
  };
}

async function ensureOutputDir() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function main() {
  await ensureOutputDir();
  const sessions = await fetchCircuitSessions();
  const byCircuit = new Map<number, CircuitSession[]>();

  sessions.forEach((row) => {
    if (!Number.isFinite(row.circuit_key)) {
      return;
    }
    const bucket = byCircuit.get(row.circuit_key) ?? [];
    bucket.push(row);
    byCircuit.set(row.circuit_key, bucket);
  });

  for (const [circuitKey, circuitSessions] of byCircuit.entries()) {
    const sorted = [...circuitSessions].sort(
      (a, b) => new Date(b.date_start).getTime() - new Date(a.date_start).getTime()
    );
    const selected = sorted.slice(0, SESSIONS_PER_CIRCUIT);
    const sessionKeys = selected.map((row) => row.session_key);
    const label = selected[0]?.circuit_short_name ?? "unknown";

    console.log(
      `[TRACK] Circuit ${circuitKey} (${label}) using sessions ${sessionKeys.join(", ")}`
    );

    const candidates = await fetchReferenceLapCandidates(sessionKeys, CANDIDATE_LAPS);
    if (!candidates.length) {
      console.log(`[TRACK] Skipping ${circuitKey} (${label}) - no reference laps found`);
      continue;
    }

    const selection = await selectBestLap(candidates);
    if (!selection) {
      console.log(`[TRACK] Skipping ${circuitKey} (${label}) - no usable lap data`);
      continue;
    }

    const { lap, points, stats, score } = selection;
    const usedFallback = score === 0 && candidates.length > 0;
    console.log(
      `[TRACK] Reference lap session ${lap.session_key} driver ${lap.driver_number} lap ${lap.lap_number} samples ${lap.sample_count} ratio ${stats.aspectRatio.toFixed(
        2
      )} length ${stats.pathLength.toFixed(1)}${usedFallback ? " (fallback)" : ""}`
    );

    const svg = buildSvg(points, circuitKey, label);
    if (!svg) {
      console.log(`[TRACK] Skipping ${circuitKey} (${label}) - no SVG data`);
      continue;
    }

    const filePath = path.join(OUT_DIR, `circuit_${circuitKey}.svg`);
    await fs.writeFile(filePath, svg, "utf-8");
    console.log(`[TRACK] Wrote ${filePath}`);
  }

  await db.end({ timeout: 5 });
}

main().catch((error) => {
  console.error("[TRACK] Failed to build heatmaps", error);
  process.exit(1);
});
