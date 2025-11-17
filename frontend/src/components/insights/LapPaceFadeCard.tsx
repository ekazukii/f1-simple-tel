import { LapDegradationChart } from './LapPaceFadeChart';
import type { LapCompoundPoint } from './types';

interface Props {
  points: LapCompoundPoint[];
  maxLap: number;
}

export function LapPaceFadeCard({ points, maxLap }: Props) {
  return (
    <div className="insights-card full-span">
      <div className="insights-card-head">
        <div>
          <h4>Lap pace & tyre fade</h4>
          <p className="muted">Lap time per lap with stint compound bands</p>
        </div>
      </div>
      {points.length ? (
        <LapDegradationChart points={points} maxLap={maxLap} />
      ) : (
        <p className="muted">No lap data available for this driver.</p>
      )}
    </div>
  );
}
