import { useMemo } from 'react';
import type { TyreUsageMatrix } from '../utils/telemetry';

interface Props {
  matrix: TyreUsageMatrix | null;
}

const COMPOUND_COLORS: Record<string, string> = {
  SOFT: '#ff4d4d',
  MEDIUM: '#f6c343',
  HARD: '#f9f9f9'
};

export function TyreUsageTable({ matrix }: Props) {
  const hasData = Boolean(matrix && matrix.drivers.length && matrix.lapNumbers.length);

  const viewModel = useMemo(() => {
    if (!matrix) {
      return null;
    }
    return matrix;
  }, [matrix]);

  if (!hasData || !viewModel) {
    return null;
  }

  return (
    <div className="tyre-table-wrapper">
      <table className="tyre-table">
        <thead>
          <tr>
            <th>Driver</th>
            {viewModel.lapNumbers.map((lap) => (
              <th key={lap}>L{lap}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {viewModel.drivers.map((driver) => (
            <tr key={driver}>
              <th># {driver}</th>
              {viewModel.lapNumbers.map((lap, index) => {
                const compound = viewModel.usage[driver]?.[index]?.toUpperCase();
                const color = compound ? COMPOUND_COLORS[compound] ?? '#cccccc' : 'transparent';
                return (
                  <td key={`${driver}-${lap}`}>
                    <span
                      className="tyre-cell"
                      style={{ backgroundColor: color, borderColor: color === 'transparent' ? '#2e3560' : color }}
                      title={compound ? `${compound} lap ${lap}` : `No data lap ${lap}`}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
