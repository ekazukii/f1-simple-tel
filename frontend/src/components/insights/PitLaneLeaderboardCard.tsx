import { formatDriver } from './shared';

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
    <div className="insights-card">
      <div className="insights-card-head">
        <h4>Pit lane leaderboard</h4>
        <p className="muted">Shortest stationary times</p>
      </div>
      {pits.length ? (
        <ol className="pit-list">
          {pits.map((pit) => (
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
      <p className="muted small">Total pit stops: {totalPits}</p>
    </div>
  );
}
