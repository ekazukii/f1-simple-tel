import { getCompoundColor, formatDriver, formatDriverName } from './shared';
import type { TimelineRow } from './types';

export function StintTimeline({ rows, maxLap }: { rows: TimelineRow[]; maxLap: number }) {
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
