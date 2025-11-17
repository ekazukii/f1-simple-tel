import { getDriverByNumber, getDriverByNumberOnDate } from '../../utils/drivers';
import { COMPOUND_COLORS, loggedUnknownCompounds } from './theme';

export function formatSeconds(seconds: number) {
  if (!Number.isFinite(seconds)) {
    return '—';
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(3).padStart(6, '0')}`;
}

export function formatDriver(driver: number, sessionDate: string) {
  const info = getDriverByNumberOnDate(driver, sessionDate) ?? getDriverByNumber(driver);
  if (!info) {
    return `#${driver}`;
  }
  return `#${driver} · ${info.firstName} ${info.lastName}`;
}

export function formatDriverName(driver: number, sessionDate: string) {
  const info = getDriverByNumberOnDate(driver, sessionDate) ?? getDriverByNumber(driver);
  if (!info) {
    return '';
  }
  return `${info.firstName} ${info.lastName}`;
}

export function getCompoundColor(compound: string) {
  const normalized = compound === 'UNKOWN' ? 'UNKNOWN' : compound;
  const color = COMPOUND_COLORS[normalized];
  if (color) {
    return color;
  }

  if (!loggedUnknownCompounds.has(normalized)) {
    loggedUnknownCompounds.add(normalized);
    console.warn('Unknown tyre compound in stint timeline', compound);
  }

  return '#8a90a6';
}
