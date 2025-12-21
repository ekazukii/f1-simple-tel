import { StintTimeline } from './StintTimeline';
import type { TimelineRow } from './types';
import sharedStyles from '../../styles/Shared.module.css';
import styles from '../../styles/SessionInsights.module.css';

const cx = (...names: string[]) =>
  names
    .map((n) => styles[n] || sharedStyles[n])
    .filter(Boolean)
    .join(' ');

interface Props {
  rows: TimelineRow[];
  maxLap: number;
}

export function StintTimelineCard({ rows, maxLap }: Props) {
  return (
    <div className={cx('insights-card', 'full-span')}>
      <div className={cx('insights-card-head')}>
        <h4>Stint timeline</h4>
        <p className={cx('muted')}>Tyre compounds and lap ranges</p>
      </div>
      <StintTimeline rows={rows} maxLap={maxLap} />
    </div>
  );
}
