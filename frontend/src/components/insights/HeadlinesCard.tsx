import type { LapSample } from './types';
import { formatDriver, formatSeconds } from './shared';

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
          <strong>{totalPits}</strong> pit stops captured · quickest box time {quickestPitText}
        </li>
      </ul>
    </div>
  );
}
