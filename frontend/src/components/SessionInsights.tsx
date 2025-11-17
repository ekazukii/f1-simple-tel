import { useMemo } from 'react';
import type { OpenF1SessionData } from '../types';
import { normalizeDriverNumber } from '../utils/telemetry';
import { getDriverByNumber, getDriverByNumberOnDate } from '../utils/drivers';

interface Props {
  session: OpenF1SessionData;
  activeDriver: number | null;
}

interface LapSample {
  lap: number;
  duration: number;
  driver: number;
}

interface StintSegment {
  start: number;
  end: number;
  compound: string;
  driver: number;
}

interface LapCompoundPoint {
  lap: number;
  duration: number;
  compound: string;
}

const COMPOUND_COLORS: Record<string, string> = {
  SOFT: '#ff4d4d',
  MEDIUM: '#f6c343',
  HARD: '#f9f9f9',
  INTERMEDIATE: '#4cd37b',
  WET: '#57a7ff',
  UNKNOWN: '#8a90a6'
};

const loggedUnknownCompounds = new Set<string>();

export function SessionInsights({ session, activeDriver }: Props) {
  const sessionDate = session.sessionInfo?.date_start ?? session.sessionInfo?.date_end ?? new Date().toISOString();
  const lapSamples = useMemo(() => buildLapSamples(session.laps ?? []), [session.laps]);
  const maxLap = useMemo(() => computeMaxLap(lapSamples, session.stints ?? []), [lapSamples, session.stints]);
  const fastestLap = useMemo(() => pickFastestLap(lapSamples), [lapSamples]);
  const pitLeaderboard = useMemo(() => buildPitLeaderboard(session.pitStops ?? []), [session.pitStops]);
  const stintTimeline = useMemo(
    () => buildStintTimeline(session.stints ?? [], maxLap || 1, sessionDate),
    [session.stints, maxLap, sessionDate]
  );
  const lapCompoundSeries = useMemo(() => {
    const driver = activeDriver ?? lapSamples[0]?.driver ?? null;
    return buildLapCompoundSeries(session.laps ?? [], session.stints ?? [], driver);
  }, [session.laps, session.stints, activeDriver, lapSamples]);
  const activeLapSeries = useMemo(
    () => lapSamples.filter((lap) => (activeDriver ? lap.driver === activeDriver : true)),
    [lapSamples, activeDriver]
  );
  const activeLapStats = useMemo(() => computeLapStats(activeLapSeries), [activeLapSeries]);
  const driverCount = useMemo(() => {
    const drivers = new Set<number>();
    lapSamples.forEach((lap) => drivers.add(lap.driver));
    (session.stints ?? []).forEach((stint) => {
      const driver = normalizeDriverNumber(stint.driver_number);
      if (driver != null) {
        drivers.add(driver);
      }
    });
    return drivers.size;
  }, [lapSamples, session.stints]);

  const meta = session.sessionInfo;

  return (
    <section className="insights-panel">
      <div className="insights-header">
        <h3>Race insights</h3>
        <p className="muted">
          Auto-generated from cached telemetry for {meta?.session_name ?? 'session'} · {meta?.location ?? 'unknown location'}
        </p>
      </div>

      <div className="insights-grid">
        <div className="insights-card">
          <h4>Headlines</h4>
          <ul className="headline-list">
            <li>
              <strong>{fastestLap ? formatSeconds(fastestLap.duration) : '—'}</strong> fastest lap
              {fastestLap ? ` (${formatDriver(fastestLap.driver, sessionDate)} lap ${fastestLap.lap})` : ''}
            </li>
            <li>
              <strong>{maxLap || '—'}</strong> laps recorded · <strong>{driverCount || '—'}</strong> drivers with data
            </li>
            <li>
              <strong>{pitLeaderboard.totalPits}</strong> pit stops captured · quickest box time {pitLeaderboard.quickestText}
            </li>
          </ul>
        </div>

        <div className="insights-card">
          <div className="insights-card-head">
            <h4>Pit lane leaderboard</h4>
            <p className="muted">Shortest stationary times</p>
          </div>
          {pitLeaderboard.items.length ? (
            <ol className="pit-list">
              {pitLeaderboard.items.map((pit) => (
                <li key={`${pit.driver}-${pit.lap}`}>
                  <span className="pit-driver">{formatDriver(pit.driver, sessionDate)}</span>
                  <span className="pit-duration">{pit.duration.toFixed(1)}s</span>
                  <span className="pit-lap">Lap {pit.lap}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No pit data available.</p>
          )}
        </div>

        <div className="insights-card full-span">
          <div className="insights-card-head">
            <div>
              <h4>Lap pace & tyre fade</h4>
              <p className="muted">Lap time per lap with stint compound bands</p>
            </div>
          </div>
          {lapCompoundSeries.length ? (
            <LapDegradationChart points={lapCompoundSeries} maxLap={maxLap || lapCompoundSeries.at(-1)?.lap || 1} />
          ) : (
            <p className="muted">No lap data available for this driver.</p>
          )}
        </div>

        <div className="insights-card full-span">
          <div className="insights-card-head">
            <h4>Stint timeline</h4>
            <p className="muted">Tyre compounds and lap ranges</p>
            <div className="compound-legend">
              {Object.entries(COMPOUND_COLORS).map(([compound, color]) => (
                <span key={compound} className="legend-item">
                  <span className="legend-swatch" style={{ backgroundColor: color }} />
                  {compound}
                </span>
              ))}
            </div>
          </div>
          <StintTimeline rows={stintTimeline} maxLap={maxLap || 1} />
        </div>
      </div>
    </section>
  );
}

function buildLapSamples(laps: Record<string, unknown>[]) {
  const samples: LapSample[] = [];
  laps.forEach((lap) => {
    const driver = normalizeDriverNumber(lap.driver_number);
    const lapNumber = Number(lap.lap_number);
    const duration = Number(lap.lap_duration);

    if (!driver || !Number.isFinite(lapNumber) || lapNumber <= 0) {
      return;
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    samples.push({ driver, lap: lapNumber, duration });
  });
  return samples;
}

function computeMaxLap(laps: LapSample[], stints: Record<string, unknown>[]) {
  const lapMax = laps.reduce((max, lap) => Math.max(max, lap.lap), 0);
  const stintMax = stints.reduce((max, stint) => {
    const end = Number(stint.lap_end) || Number(stint.lap_start) || Number(stint.lap_number);
    return Number.isFinite(end) ? Math.max(max, end) : max;
  }, 0);
  return Math.max(lapMax, stintMax);
}

function pickFastestLap(laps: LapSample[]) {
  return laps.reduce<LapSample | null>((best, lap) => {
    if (!best || lap.duration < best.duration) {
      return lap;
    }
    return best;
  }, null);
}

function buildPitLeaderboard(pitStops: Record<string, unknown>[]) {
  const pits = pitStops
    .map((pit) => ({
      driver: normalizeDriverNumber(pit.driver_number),
      duration: Number(pit.pit_duration),
      lap: Number(pit.lap_number)
    }))
    .filter((pit) => pit.driver && Number.isFinite(pit.duration) && pit.duration > 0)
    .sort((a, b) => a.duration - b.duration);

  return {
    items: pits.slice(0, 6),
    totalPits: pits.length,
    quickestText: pits.length ? `${pits[0].duration.toFixed(1)}s (#${pits[0].driver})` : '—'
  };
}

function buildLapCompoundSeries(
  laps: Record<string, unknown>[],
  stints: Record<string, unknown>[],
  driver: number | null
): LapCompoundPoint[] {
  if (!driver || !laps.length || !stints.length) {
    return [];
  }

  const stintLookup = new Map<number, string>();
  stints.forEach((stint) => {
    const stintDriver = normalizeDriverNumber(stint.driver_number);
    if (stintDriver !== driver) return;
    const start = Number(stint.lap_start) || Number(stint.lap_number);
    const end = Number(stint.lap_end) || start;
    const compound = typeof stint.compound === 'string' ? stint.compound.toUpperCase() : 'UNKNOWN';
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    for (let lap = Math.max(1, start); lap <= Math.max(start, end); lap += 1) {
      stintLookup.set(lap, compound);
    }
  });

  return laps
    .map((lap) => ({
      driver: normalizeDriverNumber(lap.driver_number),
      lap: Number(lap.lap_number),
      duration: Number(lap.lap_duration)
    }))
    .filter((lap) => lap.driver === driver && Number.isFinite(lap.lap) && lap.lap > 0 && Number.isFinite(lap.duration) && lap.duration > 0)
    .sort((a, b) => a.lap - b.lap)
    .map((lap) => ({
      lap: lap.lap,
      duration: lap.duration,
      compound: stintLookup.get(lap.lap) ?? 'UNKNOWN'
    }));
}

interface TimelineRow {
  driver: number;
  stints: StintSegment[];
  sessionDate: string;
}

function buildStintTimeline(stints: Record<string, unknown>[], maxLap: number, sessionDate: string): TimelineRow[] {
  if (!stints.length) {
    return [];
  }

  const byDriver = new Map<number, StintSegment[]>();

  stints.forEach((stint) => {
    const driver = normalizeDriverNumber(stint.driver_number);
    const start = Number(stint.lap_start) || Number(stint.lap_number);
    const end = Number(stint.lap_end) || start;
    const compound = typeof stint.compound === 'string' ? stint.compound.toUpperCase() : 'UNKNOWN';

    if (!driver || !Number.isFinite(start) || !Number.isFinite(end)) {
      return;
    }

    const safeStart = Math.max(1, Math.min(start, maxLap));
    const safeEnd = Math.max(safeStart, Math.min(end, maxLap));
    const segment: StintSegment = { driver, start: safeStart, end: safeEnd, compound };
    const list = byDriver.get(driver) ?? [];
    list.push(segment);
    byDriver.set(driver, list);
  });

  return Array.from(byDriver.entries())
    .sort(([a], [b]) => a - b)
    .map(([driver, segments]) => ({
      driver,
      stints: segments.sort((a, b) => a.start - b.start),
      sessionDate
    }));
}

function computeLapStats(laps: LapSample[]) {
  if (!laps.length) {
    return { fastest: null, averageText: '—', count: 0 };
  }

  const fastest = pickFastestLap(laps);
  const average = laps.reduce((sum, lap) => sum + lap.duration, 0) / laps.length;
  return {
    fastest,
    averageText: `${average.toFixed(3)}s`,
    count: laps.length
  };
}

function formatSeconds(seconds: number) {
  if (!Number.isFinite(seconds)) {
    return '—';
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(3).padStart(6, '0')}`;
}

function getCompoundColor(compound: string) {
  const normalized = compound === 'UNKOWN' ? 'UNKNOWN' : compound;
  const color = COMPOUND_COLORS[normalized];
  if (color) {
    return color;
  }

  if (!loggedUnknownCompounds.has(normalized)) {
    loggedUnknownCompounds.add(normalized);
    // Temporary quick fix to surface unexpected compound values
    console.warn('Unknown tyre compound in stint timeline', compound);
  }

  return '#8a90a6';
}

function LapDegradationChart({ points, maxLap }: { points: LapCompoundPoint[]; maxLap: number }) {
  if (!points.length) {
    return <p className="muted">No lap data available for this driver.</p>;
  }

  const width = 920;
  const height = 220;
  const padding = 28;
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;

  const sorted = [...points].sort((a, b) => a.lap - b.lap);
  const durations = sorted.map((lap) => lap.duration).sort((a, b) => a - b);
  if (!durations.length) {
    return <p className="muted">No lap data available for this driver.</p>;
  }
  const minDuration = durations[0];
  const maxDuration = durations[durations.length - 1];
  const mid = Math.floor(durations.length / 2);
  const median = durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];
  const safeMaxLap = Math.max(1, maxLap);
  const lowerBound = Math.max(0.1, median - 2);
  const upperBound = Math.max(lowerBound + 0.1, median + 3);
  const span = upperBound - lowerBound;

  const scaleX = (lap: number) => padding + ((lap - 1) / Math.max(1, safeMaxLap - 1)) * usableWidth;

  const scaleY = (duration: number) => {
    const clamped = Math.min(Math.max(duration, lowerBound), upperBound);
    const ratio = (clamped - lowerBound) / span;
    return padding + (1 - ratio) * usableHeight;
  };

  const bandHeight = usableHeight;
  const bandY = padding;
  const lapWidth = usableWidth / safeMaxLap;

  const path = sorted
    .map((lap, index) => `${index === 0 ? 'M' : 'L'}${scaleX(lap.lap).toFixed(2)},${scaleY(lap.duration).toFixed(2)}`)
    .join(' ');

  return (
    <svg className="degradation-chart" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Lap time degradation chart">
      {sorted.map((lap) => {
        const color = getCompoundColor(lap.compound);
        return (
          <rect
            key={`band-${lap.lap}`}
            x={scaleX(lap.lap) - lapWidth / 2}
            y={bandY}
            width={lapWidth}
            height={bandHeight}
            fill={color}
            opacity={0.14}
          />
        );
      })}
      <path d={path} fill="none" stroke="#f6c343" strokeWidth={2} strokeLinecap="round" />
      {sorted.map((lap) => (
        <g key={`pt-${lap.lap}`}>
          <circle
            cx={scaleX(lap.lap)}
            cy={scaleY(lap.duration)}
            r={3.2}
            fill="#1b223d"
            stroke="#f6c343"
            strokeWidth={1.4}
          />
          <title>
            {`Lap ${lap.lap}: ${lap.duration.toFixed(3)}s · ${lap.compound}`}
          </title>
        </g>
      ))}
      <g fill="#9ea7c8" fontSize="11">
        <text x={padding} y={padding - 6}>Lap time (linear, clipped to median -2s / +3s)</text>
        <text x={width - padding - 60} y={height - 8}>Lap →</text>
        <text x={padding} y={height - 8}>{`Median: ${median.toFixed(3)}s · Clip: [${(median - 2).toFixed(3)}s, ${(median + 3).toFixed(3)}s] · Actual min/max: ${minDuration.toFixed(3)}s / ${maxDuration.toFixed(3)}s`}</text>
      </g>
    </svg>
  );
}

function LapSparkline({ points, maxLap, height = 120 }: { points: LapSample[]; maxLap: number; height?: number }) {
  if (!points.length) {
    return <div className="sparkline empty">No lap times yet.</div>;
  }

  const sorted = [...points].sort((a, b) => a.lap - b.lap);
  const minDuration = sorted.reduce((acc, lap) => Math.min(acc, lap.duration), Number.POSITIVE_INFINITY);
  const maxDuration = sorted.reduce((acc, lap) => Math.max(acc, lap.duration), 0);
  const viewWidth = 420;
  const padding = 16;
  const usableWidth = viewWidth - padding * 2;
  const usableHeight = height - padding * 2;

  const path = sorted
    .map((lap, index) => {
      const xRatio = Math.max(0, Math.min(1, (lap.lap - 1) / Math.max(1, maxLap - 1)));
      const yRatio = maxDuration === minDuration ? 0.5 : (lap.duration - minDuration) / (maxDuration - minDuration);
      const x = padding + xRatio * usableWidth;
      const y = padding + (1 - yRatio) * usableHeight;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const fastest = pickFastestLap(sorted);
  const fastestX = fastest
    ? padding + (Math.max(0, Math.min(1, (fastest.lap - 1) / Math.max(1, maxLap - 1)))) * usableWidth
    : null;
  const fastestY = fastest
    ? padding +
      (1 - (maxDuration === minDuration ? 0.5 : (fastest.duration - minDuration) / (maxDuration - minDuration))) * usableHeight
    : null;

  return (
    <svg className="sparkline" role="img" aria-label="Lap pace sparkline" width="100%" height={height} viewBox={`0 0 ${viewWidth} ${height}`}>
      <defs>
        <linearGradient id="paceGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#5ddcff" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#4563ff" stopOpacity="0.1" />
        </linearGradient>
      </defs>
      <path d={`${path} L ${padding + usableWidth},${height - padding} L ${padding},${height - padding} Z`} fill="url(#paceGradient)" opacity="0.35" />
      <path d={path} fill="none" stroke="#7ad7ff" strokeWidth={2} strokeLinecap="round" />
      {fastest && fastestX != null && fastestY != null && (
        <circle cx={fastestX} cy={fastestY} r={5} fill="#f6c343" stroke="#0d101c" strokeWidth={1.5} />
      )}
    </svg>
  );
}

function StintTimeline({ rows, maxLap }: { rows: TimelineRow[]; maxLap: number }) {
  if (!rows.length) {
    return <p className="muted">No stint data available.</p>;
  }

  const safeMaxLap = Math.max(1, maxLap);

  return (
    <div className="stint-timeline">
      {rows.map((row) => (
        <div key={row.driver} className="stint-row">
          <div className="stint-driver" title={formatDriver(row.driver, row.sessionDate)}>
            <span className="stint-driver-number">#{row.driver}</span>
            <span className="stint-driver-name">{formatDriverName(row.driver, row.sessionDate)}</span>
          </div>
          <div className="stint-bar-track" aria-label={`Stints for driver ${row.driver}`}>
            {row.stints.map((stint, index) => {
              const startPct = ((stint.start - 1) / safeMaxLap) * 100;
              const widthPct = ((stint.end - stint.start + 1) / safeMaxLap) * 100;
              const color = getCompoundColor(stint.compound);
              const driverLabel = formatDriver(stint.driver, row.sessionDate);
              return (
                <div
                  key={`${stint.driver}-${stint.start}-${index}`}
                  className="stint-segment"
                  style={{ left: `${startPct}%`, width: `${widthPct}%`, backgroundColor: color, borderColor: color }}
                  title={`${driverLabel} \u00b7 ${stint.compound} · laps ${stint.start}-${stint.end}`}
                />
              );
            })}
          </div>
        </div>
      ))}
      <div className="stint-scale">
        <span>Lap 1</span>
        <span>Lap {safeMaxLap}</span>
      </div>
    </div>
  );
}

function formatDriver(driver: number, sessionDate: string) {
  const info = getDriverByNumberOnDate(driver, sessionDate) ?? getDriverByNumber(driver);
  if (!info) {
    return `#${driver}`;
  }
  return `#${driver} · ${info.firstName} ${info.lastName}`;
}

function formatDriverName(driver: number, sessionDate: string) {
  const info = getDriverByNumberOnDate(driver, sessionDate) ?? getDriverByNumber(driver);
  if (!info) {
    return '';
  }
  return `${info.firstName} ${info.lastName}`;
}
