import { useMemo, useState, type ReactNode } from 'react';
import sharedStyles from '../styles/Shared.module.css';
import styles from '../styles/DriverCompare.module.css';
import type { OpenF1SessionData } from '../types';
import {
  buildLapDetails,
  filterTelemetryByDriver,
  normalizeDriverNumber,
  selectRecordsForView,
  type LapDetail
} from '../utils/telemetry';
import { getDriverByNumber, getDriverByNumberOnDate } from '../utils/drivers';

interface Props {
  session: OpenF1SessionData;
  selectedLap: number | null;
  preferredDriver: number | null;
}

const cx = (...names: string[]) =>
  names
    .map((n) => styles[n] || sharedStyles[n])
    .filter(Boolean)
    .join(' ');

interface SamplePoint {
  t: number; // seconds since lap start
  progress: number; // 0..1
  speed: number;
  throttle: number;
  brake: number;
  rpm: number;
  gear: number | null;
}

interface ResampledPoint {
  progress: number;
  speedA: number;
  speedB: number;
  throttleA: number;
  throttleB: number;
  brakeA: number;
  brakeB: number;
  rpmA: number;
  rpmB: number;
  gearA: number | null;
  gearB: number | null;
}

interface BrakingSnapshot {
  progress: number;
  brakeLead: 'A' | 'B';
  brakeA: number;
  brakeB: number;
  rpmA: number;
  rpmB: number;
  gearA: number | null;
  gearB: number | null;
}

interface SegmentDelta {
  index: number;
  durationA: number | null;
  durationB: number | null;
  delta: number | null; // B - A (positive means B slower)
}

const SERIES_POINTS = 140;

export function DriverCompare({ session, selectedLap, preferredDriver }: Props) {
  const drivers = useMemo(() => deriveDrivers(session), [session]);
  const defaultA = preferredDriver && drivers.has(preferredDriver) ? preferredDriver : Array.from(drivers)[0];
  const defaultB = Array.from(drivers).find((d) => d !== defaultA) ?? defaultA;
  const [driverA, setDriverA] = useState<number | null>(defaultA ?? null);
  const [driverB, setDriverB] = useState<number | null>(defaultB ?? null);
  const sessionDate = session.sessionInfo?.date_start ?? session.sessionInfo?.date_end ?? new Date().toISOString();

  const lapRangeA = useMemo(() => pickLapRange(session, driverA, selectedLap), [session, driverA, selectedLap]);
  const lapRangeB = useMemo(() => pickLapRange(session, driverB, selectedLap), [session, driverB, selectedLap]);
  const lapNumber = selectedLap ?? lapRangeA?.lap ?? lapRangeB?.lap ?? null;

  const seriesA = useMemo(
    () => buildSeries(session, driverA, lapRangeA, SERIES_POINTS),
    [session, driverA, lapRangeA]
  );
  const seriesB = useMemo(
    () => buildSeries(session, driverB, lapRangeB, SERIES_POINTS),
    [session, driverB, lapRangeB]
  );

  const mergedSeries = useMemo(() => mergeSeries(seriesA, seriesB), [seriesA, seriesB]);
  const braking = useMemo(() => buildBrakingSnapshots(mergedSeries), [mergedSeries]);
  const segmentDeltas = useMemo(
    () => buildSegmentDeltas(session.laps ?? [], driverA, driverB, lapNumber),
    [session.laps, driverA, driverB, lapNumber]
  );

  const maxSpeed = useMemo(
    () =>
      mergedSeries.reduce(
        (max, pt) => Math.max(max, pt.speedA || 0, pt.speedB || 0),
        0
      ) || 1,
    [mergedSeries]
  );

  const lapLabel = selectedLap ?? lapRangeA?.lap ?? lapRangeB?.lap ?? 'n/a';

  const formatDriverLabel = (driver: number) => {
    const info = getDriverByNumberOnDate(driver, sessionDate) ?? getDriverByNumber(driver);
    if (!info) {
      return `#${driver}`;
    }
    return `#${driver} · ${info.firstName} ${info.lastName} (${info.nationality})`;
  };

  return (
    <section className={cx('compare-panel')}>
      <div className={cx('compare-head')}>
        <div>
          <h3>Driver vs driver</h3>
          <p className={cx('muted')}>Lap {lapLabel} telemetry overlay (speed, throttle, brake)</p>
        </div>
        <div className={cx('compare-pickers')}>
          <label>
            Driver A
            <select value={driverA ?? ''} onChange={(e) => setDriverA(toNumberOrNull(e.target.value))}>
              {Array.from(drivers).map((driver) => (
                <option key={`A-${driver}`} value={driver}>
                  {formatDriverLabel(driver)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Driver B
            <select value={driverB ?? ''} onChange={(e) => setDriverB(toNumberOrNull(e.target.value))}>
              {Array.from(drivers).map((driver) => (
                <option key={`B-${driver}`} value={driver}>
                  {formatDriverLabel(driver)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {!mergedSeries.length ? (
        <p className={cx('muted')}>No overlapping telemetry found for the selected lap.</p>
      ) : (
        <>
          <SegmentHeatmap segments={segmentDeltas} lap={lapLabel} />
          <TelemetryChart points={mergedSeries} maxSpeed={maxSpeed} />
          <BrakingTable snapshots={braking} />
        </>
      )}
    </section>
  );
}

function deriveDrivers(session: OpenF1SessionData) {
  const drivers = new Set<number>();
  (session.telemetry ?? []).forEach((record) => {
    const driver = normalizeDriverNumber(record.driver_number);
    if (driver != null) {
      drivers.add(driver);
    }
  });
  (session.laps ?? []).forEach((record) => {
    const driver = normalizeDriverNumber(record.driver_number);
    if (driver != null) {
      drivers.add(driver);
    }
  });
  return drivers;
}

function pickLapRange(session: OpenF1SessionData, driver: number | null, selectedLap: number | null) {
  if (!driver) return null;
  const laps = buildLapDetails(session.laps ?? [], driver, session.sessionInfo?.date_start, session.sessionInfo?.date_end);
  if (!laps.length) return null;

  if (selectedLap) {
    const exact = laps.find((lap) => lap.lap_number === selectedLap);
    if (exact) return { ...exact, lap: selectedLap } as LapDetail & { lap: number };
  }

  const first = laps[0];
  return { ...first, lap: first.lap_number } as LapDetail & { lap: number };
}

function buildSeries(
  session: OpenF1SessionData,
  driver: number | null,
  lapRange: (LapDetail & { lap: number }) | null,
  targetPoints: number
): SamplePoint[] {
  if (!driver || !lapRange) {
    return [];
  }

  const telemetry = filterTelemetryByDriver(session.telemetry ?? [], driver);
  const lapSamples = selectRecordsForView(telemetry, lapRange, 6000);
  if (!lapSamples.length) {
    return [];
  }

  const startMs = getTimestamp(lapSamples[0]);
  const endMs = getTimestamp(lapSamples[lapSamples.length - 1]);
  if (startMs == null || endMs == null || endMs <= startMs) {
    return [];
  }

  const durationSec = (endMs - startMs) / 1000;

  const raw: SamplePoint[] = lapSamples
    .map((sample) => {
      const ts = getTimestamp(sample);
      if (ts == null) return null;
      return {
        t: (ts - startMs) / 1000,
        progress: (ts - startMs) / (endMs - startMs),
        speed: toNumber(sample.speed),
        throttle: toPercent(sample.throttle),
        brake: toPercent(sample.brake),
        rpm: toNumber(sample.rpm),
        gear: toInt(sample.n_gear)
      } satisfies SamplePoint;
    })
    .filter(Boolean) as SamplePoint[];

  if (!raw.length || durationSec <= 0) {
    return [];
  }

  return resample(raw, targetPoints);
}

function resample(series: SamplePoint[], targetPoints: number): SamplePoint[] {
  if (series.length <= 2) return series;
  const last = series[series.length - 1];
  const duration = Math.max(last.t, 0.0001);
  const result: SamplePoint[] = [];

  let idx = 0;
  for (let i = 0; i < targetPoints; i += 1) {
    const targetT = (i / Math.max(1, targetPoints - 1)) * duration;
    while (idx + 1 < series.length && series[idx + 1].t < targetT) {
      idx += 1;
    }
    const a = series[idx];
    const b = series[Math.min(idx + 1, series.length - 1)];
    const span = Math.max(b.t - a.t, 0.0001);
    const ratio = Math.min(Math.max((targetT - a.t) / span, 0), 1);

    const lerp = (x: number, y: number) => x + (y - x) * ratio;
    result.push({
      t: targetT,
      progress: targetT / duration,
      speed: lerp(a.speed, b.speed),
      throttle: lerp(a.throttle, b.throttle),
      brake: lerp(a.brake, b.brake),
      rpm: lerp(a.rpm, b.rpm),
      gear: ratio < 0.5 ? a.gear : b.gear
    });
  }

  return result;
}

function mergeSeries(a: SamplePoint[], b: SamplePoint[]): ResampledPoint[] {
  const length = Math.min(a.length, b.length);
  const merged: ResampledPoint[] = [];
  for (let i = 0; i < length; i += 1) {
    merged.push({
      progress: (a[i].progress + b[i].progress) / 2,
      speedA: a[i].speed,
      speedB: b[i].speed,
      throttleA: a[i].throttle,
      throttleB: b[i].throttle,
      brakeA: a[i].brake,
      brakeB: b[i].brake,
      rpmA: a[i].rpm,
      rpmB: b[i].rpm,
      gearA: a[i].gear,
      gearB: b[i].gear
    });
  }
  return merged;
}

function buildBrakingSnapshots(series: ResampledPoint[]): BrakingSnapshot[] {
  if (!series.length) return [];
  const candidates = series
    .map((point) => ({
      point,
      priority: Math.max(point.brakeA, point.brakeB)
    }))
    .filter((entry) => entry.priority > 5)
    .sort((a, b) => b.priority - a.priority);

  const snapshots: BrakingSnapshot[] = [];
  candidates.forEach(({ point }) => {
    const isSeparate = snapshots.every((snap) => Math.abs(snap.progress - point.progress) > 0.03);
    if (!isSeparate) return;

    const brakeLead = point.brakeA >= point.brakeB ? 'A' : 'B';
    snapshots.push({
      progress: point.progress,
      brakeLead,
      brakeA: point.brakeA,
      brakeB: point.brakeB,
      rpmA: point.rpmA,
      rpmB: point.rpmB,
      gearA: point.gearA,
      gearB: point.gearB
    });
  });

  return snapshots.slice(0, 4);
}

function buildSegmentDeltas(
  laps: Record<string, unknown>[],
  driverA: number | null,
  driverB: number | null,
  lapNumber: number | null
): SegmentDelta[] {
  if (!driverA || !driverB || !lapNumber) {
    return [];
  }

  const segmentsA = buildLapSegments(laps, driverA, lapNumber);
  const segmentsB = buildLapSegments(laps, driverB, lapNumber);
  const length = Math.max(segmentsA.length, segmentsB.length);
  const result: SegmentDelta[] = [];

  for (let i = 0; i < length; i += 1) {
    const a = segmentsA[i] ?? null;
    const b = segmentsB[i] ?? null;
    const delta = a != null && b != null ? b - a : null;
    result.push({ index: i + 1, durationA: a, durationB: b, delta });
  }

  return result;
}

function buildLapSegments(laps: Record<string, unknown>[], driver: number | null, lapNumber: number | null) {
  if (!driver || !lapNumber) {
    return [] as number[];
  }

  const candidate = laps.find(
    (lap) => normalizeDriverNumber(lap.driver_number) === driver && Number(lap.lap_number) === lapNumber
  );

  if (!candidate) {
    return [] as number[];
  }

  const sectors = ['segments_sector_1', 'segments_sector_2', 'segments_sector_3'] as const;
  const segments: number[] = [];

  sectors.forEach((key) => {
    const values = Array.isArray((candidate as Record<string, unknown>)[key])
      ? ((candidate as Record<string, unknown>)[key] as unknown[])
      : [];
    values.forEach((value) => {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) {
        segments.push(numeric);
      } else {
        segments.push(NaN);
      }
    });
  });

  return segments;
}

function TelemetryChart({ points, maxSpeed }: { points: ResampledPoint[]; maxSpeed: number }) {
  const width = 700;
  const height = 240;
  const padding = 16;
  const speedHeight = 150;
  const throttleBase = height - 30;
  const throttleHeight = 50;

  const toX = (progress: number) => padding + progress * (width - padding * 2);
  const toSpeedY = (speed: number) => padding + (1 - speed / Math.max(maxSpeed, 1)) * speedHeight;
  const toThrottleY = (pct: number) => throttleBase - (pct / 100) * throttleHeight;

  const speedPathA = buildPath(points, (p) => [toX(p.progress), toSpeedY(p.speedA)]);
  const speedPathB = buildPath(points, (p) => [toX(p.progress), toSpeedY(p.speedB)]);
  const throttlePathA = buildPath(points, (p) => [toX(p.progress), toThrottleY(p.throttleA)]);
  const throttlePathB = buildPath(points, (p) => [toX(p.progress), toThrottleY(p.throttleB)]);
  const brakePathA = buildPath(points, (p) => [toX(p.progress), toThrottleY(Math.min(p.brakeA, 100))]);
  const brakePathB = buildPath(points, (p) => [toX(p.progress), toThrottleY(Math.min(p.brakeB, 100))]);

  return (
    <div className={cx('compare-chart-wrapper')}>
      <svg className={cx('compare-chart')} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Driver overlay chart">
        {buildDeltaBands(points, toX, height, padding)}

        <path d={speedPathA} fill="none" stroke="#7ad7ff" strokeWidth={2.2} strokeLinecap="round" />
        <path d={speedPathB} fill="none" stroke="#f6c343" strokeWidth={2.2} strokeLinecap="round" />

        <path d={throttlePathA} fill="none" stroke="rgba(122, 215, 255, 0.8)" strokeWidth={1.2} strokeDasharray="5 4" />
        <path d={throttlePathB} fill="none" stroke="rgba(246, 195, 67, 0.8)" strokeWidth={1.2} strokeDasharray="5 4" />

        <path d={brakePathA} fill="none" stroke="rgba(255, 99, 132, 0.8)" strokeWidth={1.4} strokeLinecap="round" />
        <path d={brakePathB} fill="none" stroke="rgba(255, 140, 70, 0.8)" strokeWidth={1.4} strokeLinecap="round" />

        <g className={cx('compare-axis')}>
          <text x={padding} y={padding + 12} fill="#9ea7c8" fontSize="11">Speed (km/h)</text>
          <text x={padding} y={throttleBase - throttleHeight - 4} fill="#9ea7c8" fontSize="11">Throttle / Brake (%)</text>
        </g>
      </svg>
      <div className={cx('compare-legend')}>
        <span className={cx('legend-item')}><span className={cx('legend-swatch')} style={{ backgroundColor: '#7ad7ff' }} />Driver A speed</span>
        <span className={cx('legend-item')}><span className={cx('legend-swatch')} style={{ backgroundColor: '#f6c343' }} />Driver B speed</span>
        <span className={cx('legend-item')}><span className={cx('legend-swatch')} style={{ backgroundColor: '#ff6384' }} />Brake</span>
        <span className={cx('legend-item')}><span className={cx('legend-swatch')} style={{ backgroundColor: '#7ad7ff', opacity: 0.6 }} />Throttle</span>
      </div>
    </div>
  );
}

function buildDeltaBands(
  points: ResampledPoint[],
  toX: (progress: number) => number,
  height: number,
  padding: number
) {
  if (!points.length) return null;
  const bands: ReactNode[] = [];
  const baseY = height - padding;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const delta = (p1.speedA + p2.speedA) / 2 - (p1.speedB + p2.speedB) / 2;
    if (Math.abs(delta) < 0.1) continue;
    const x1 = toX(p1.progress);
    const x2 = toX(p2.progress);
    const color = delta >= 0 ? 'rgba(90, 199, 255, 0.08)' : 'rgba(246, 99, 132, 0.08)';
    bands.push(
      <rect key={`band-${i}`} x={x1} y={padding} width={Math.max(0, x2 - x1)} height={baseY - padding} fill={color} />
    );
  }
  return <g className={cx('delta-bands')}>{bands}</g>;
}

function SegmentHeatmap({ segments, lap }: { segments: SegmentDelta[]; lap: number | string }) {
  if (!segments.length) {
    return <p className={cx('muted', 'small')}>No segment timing available for lap {lap}.</p>;
  }

  const valid = segments.filter((seg) => Number.isFinite(seg.durationA) || Number.isFinite(seg.durationB));
  if (!valid.length) {
    return <p className={cx('muted', 'small')}>No segment timing available for lap {lap}.</p>;
  }

  const maxDuration = valid.reduce((max, seg) => {
    const duration = Math.max(seg.durationA ?? 0, seg.durationB ?? 0);
    return Math.max(max, duration);
  }, 0);

  return (
    <div className={cx('segment-heatmap')}>
      <div className={cx('segment-legend')}>
        <span className={cx('legend-item')}><span className={cx('legend-swatch')} style={{ backgroundColor: 'rgba(90, 199, 255, 0.35)' }} />Driver A faster</span>
        <span className={cx('legend-item')}><span className={cx('legend-swatch')} style={{ backgroundColor: 'rgba(246, 99, 132, 0.35)' }} />Driver B faster</span>
      </div>
      <div className={cx('segment-grid')}>
        {segments.map((seg) => {
          const hasA = Number.isFinite(seg.durationA ?? NaN);
          const hasB = Number.isFinite(seg.durationB ?? NaN);
          const base = hasA || hasB ? Math.max(seg.durationA ?? 0, seg.durationB ?? 0) : 0;
          const widthPct = maxDuration ? (base / maxDuration) * 100 : 0;
          let color = 'rgba(255, 255, 255, 0.04)';
          if (seg.delta != null) {
            color = seg.delta > 0 ? 'rgba(246, 99, 132, 0.25)' : 'rgba(90, 199, 255, 0.25)';
          }
          const labelA = hasA ? `${Math.round(seg.durationA!)} ms` : '—';
          const labelB = hasB ? `${Math.round(seg.durationB!)} ms` : '—';
          const deltaLabel = seg.delta != null ? (seg.delta > 0 ? `+${seg.delta.toFixed(0)} ms` : `${seg.delta.toFixed(0)} ms`) : '—';

          return (
            <div
              key={seg.index}
              className={cx('segment-cell')}
              title={`Segment ${seg.index} · A: ${labelA} · B: ${labelB} · Δ: ${deltaLabel}`}
            >
              <div className={cx('segment-bar')} style={{ width: `${Math.max(12, widthPct)}%`, backgroundColor: color }} />
              <div className={cx('segment-label')}>{seg.index}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildPath(points: ResampledPoint[], accessor: (p: ResampledPoint) => [number, number]) {
  if (!points.length) return '';
  return points
    .map((pt, idx) => {
      const [x, y] = accessor(pt);
      return `${idx === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

function BrakingTable({ snapshots }: { snapshots: BrakingSnapshot[] }) {
  if (!snapshots.length) {
    return <p className={cx('muted', 'small')}>No heavy braking zones detected on this lap.</p>;
  }

  return (
    <div className={cx('brake-table-wrapper')}>
      <table className={cx('brake-table')}>
        <thead>
          <tr>
            <th>Lap %</th>
            <th>Lead</th>
            <th>Brake A</th>
            <th>Gear/RPM A</th>
            <th>Brake B</th>
            <th>Gear/RPM B</th>
          </tr>
        </thead>
        <tbody>
          {snapshots.map((snap, idx) => (
            <tr key={`brake-${idx}`}>
              <td>{Math.round(snap.progress * 100)}%</td>
              <td>
                <span className={`${cx('pill')} ${cx(snap.brakeLead === 'A' ? 'pill-a' : 'pill-b')}`}>
                  {snap.brakeLead === 'A' ? 'Driver A' : 'Driver B'}
                </span>
              </td>
              <td>{snap.brakeA.toFixed(0)}%</td>
              <td>
                {snap.gearA ?? '—'} / {formatRpm(snap.rpmA)}
              </td>
              <td>{snap.brakeB.toFixed(0)}%</td>
              <td>
                {snap.gearB ?? '—'} / {formatRpm(snap.rpmB)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function toNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toInt(value: unknown) {
  const numeric = toNumber(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function toPercent(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric <= 1) return numeric * 100;
  return Math.min(100, Math.max(0, numeric));
}

function getTimestamp(record: Record<string, unknown>) {
  const raw =
    (typeof record.sample_time === 'string' && record.sample_time) ||
    (typeof record.date === 'string' && record.date) ||
    (typeof record.timestamp === 'string' && record.timestamp) ||
    (typeof record.time === 'string' && record.time);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function toNumberOrNull(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatRpm(value: number) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(0);
}
