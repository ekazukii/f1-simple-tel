import { getCompoundColor } from './shared';
import type { LapCompoundPoint } from './types';
import sharedStyles from '../../styles/Shared.module.css';
import styles from '../../styles/SessionInsights.module.css';

const cx = (...names: string[]) =>
  names
    .map((n) => styles[n] || sharedStyles[n])
    .filter(Boolean)
    .join(' ');

export function LapDegradationChart({ points, maxLap }: { points: LapCompoundPoint[]; maxLap: number }) {
  if (!points.length) {
    return <p className={cx('muted')}>No lap data available for this driver.</p>;
  }

  const width = 920;
  const height = 220;
  const padding = 28;
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;

  const sorted = [...points].sort((a, b) => a.lap - b.lap);
  const durations = sorted.map((lap) => lap.duration).sort((a, b) => a - b);
  if (!durations.length) {
    return <p className={cx('muted')}>No lap data available for this driver.</p>;
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
    <svg className={cx('degradation-chart')} width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Lap time degradation chart">
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
