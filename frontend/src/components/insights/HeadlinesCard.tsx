import type { LapSample } from './types';
import { formatDriver, formatSeconds } from './shared';
import styles from '../../styles/SessionInsights.module.css';

const cx = (...names: string[]) => names.map((n) => styles[n]).filter(Boolean).join(' ');

interface Props {
  fastestLap: LapSample | null;
  maxLap: number;
  driverCount: number;
  sessionDate: string;
  totalPits: number;
  quickestPitText: string;
}

export function HeadlinesCard({
  fastestLap,
  maxLap,
  driverCount,
  sessionDate,
  totalPits,
  quickestPitText
}: Props) {
  return (
    <div className={cx('insights-card')}>
      <h4>Headlines</h4>
      <ul className={cx('headline-list')}>
        <li>
          <strong>{fastestLap ? formatSeconds(fastestLap.duration) : '—'}</strong> fastest lap
          {fastestLap ? ` (${formatDriver(fastestLap.driver, sessionDate)} lap ${fastestLap.lap})` : ''}
        </li>
        <li>
          <strong>{maxLap || '—'}</strong> laps recorded · <strong>{driverCount || '—'}</strong> drivers with data
        </li>
        <li>
          <strong>{totalPits}</strong> pit stops captured · quickest box time {quickestPitText}
        </li>
      </ul>
    </div>
  );
}
