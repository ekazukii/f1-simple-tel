import { StintTimeline } from './StintTimeline';
import type { TimelineRow } from './types';

interface Props {
  rows: TimelineRow[];
  maxLap: number;
}

export function StintTimelineCard({ rows, maxLap }: Props) {
  return (
    <div className="insights-card full-span">
      <div className="insights-card-head">
        <h4>Stint timeline</h4>
        <p className="muted">Tyre compounds and lap ranges</p>
      </div>
      <StintTimeline rows={rows} maxLap={maxLap} />
    </div>
  );
}
