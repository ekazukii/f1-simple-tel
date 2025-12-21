import { formatDriver } from './shared';
import sharedStyles from '../../styles/Shared.module.css';
import styles from '../../styles/SessionInsights.module.css';

const cx = (...names: string[]) =>
  names
    .map((n) => styles[n] || sharedStyles[n])
    .filter(Boolean)
    .join(' ');

interface PitEntry {
  driver: number;
  duration: number;
  lap: number;
}

interface Props {
  pits: PitEntry[];
  totalPits: number;
  sessionDate: string;
}

export function PitLaneLeaderboardCard({ pits, totalPits, sessionDate }: Props) {
  return (
    <div className={cx('insights-card')}>
      <div className={cx('insights-card-head')}>
        <h4>Pit lane leaderboard</h4>
        <p className={cx('muted')}>Shortest stationary times</p>
      </div>
      {pits.length ? (
        <ol className={cx('pit-list')}>
          {pits.map((pit) => (
            <li key={`${pit.driver}-${pit.lap}`}>
              <span className={cx('pit-driver')}>{formatDriver(pit.driver, sessionDate)}</span>
              <span className={cx('pit-duration')}>{pit.duration.toFixed(1)}s</span>
              <span className={cx('pit-lap')}>Lap {pit.lap}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className={cx('muted')}>No pit data available.</p>
      )}
      <p className={cx('muted', 'small')}>Total pit stops: {totalPits}</p>
    </div>
  );
}
