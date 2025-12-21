import { LapDegradationChart } from './LapPaceFadeChart';
import type { LapCompoundPoint } from './types';
import sharedStyles from '../../styles/Shared.module.css';
import styles from '../../styles/SessionInsights.module.css';

const cx = (...names: string[]) =>
  names
    .map((n) => styles[n] || sharedStyles[n])
    .filter(Boolean)
    .join(' ');

interface Props {
  points: LapCompoundPoint[];
  maxLap: number;
}

export function LapPaceFadeCard({ points, maxLap }: Props) {
  return (
    <div className={cx('insights-card', 'full-span')}>
      <div className={cx('insights-card-head')}>
        <div>
          <h4>Lap pace & tyre fade</h4>
          <p className={cx('muted')}>Lap time per lap with stint compound bands</p>
        </div>
      </div>
      {points.length ? (
        <LapDegradationChart points={points} maxLap={maxLap} />
      ) : (
        <p className={cx('muted')}>No lap data available for this driver.</p>
      )}
    </div>
  );
}
