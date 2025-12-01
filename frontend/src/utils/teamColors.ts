const TEAM_COLORS: Record<string, string> = {
  ferrari: '#dc0000',
  mclaren: '#ff8700',
  mercedes: '#00d2be',
  'red bull': '#1e41ff',
  'aston martin': '#006f62',
  alpine: '#0090ff',
  williams: '#005aff',
  haas: '#b6babd',
  sauber: '#900000',
  'stake sauber': '#90e0ef',
  rb: '#2b4562'
}

const DEFAULT_COLOR = '#ffffff'

const DRIVER_TEAM: Record<number, string> = {
  1: 'Red Bull',
  11: 'Red Bull',
  4: 'McLaren',
  81: 'McLaren',
  16: 'Ferrari',
  55: 'Ferrari',
  44: 'Mercedes',
  63: 'Mercedes',
  14: 'Aston Martin',
  18: 'Aston Martin',
  22: 'RB',
  30: 'RB',
  23: 'Williams',
  43: 'Williams',
  10: 'Alpine',
  12: 'Alpine',
  2: 'Haas',
  20: 'Haas',
  24: 'Sauber',
  77: 'Sauber'
}

export function getTeamColor(team: string | null | undefined) {
  if (!team) {
    return DEFAULT_COLOR
  }
  const normalized = team.trim().toLowerCase()
  return TEAM_COLORS[normalized] ?? DEFAULT_COLOR
}

export function registerTeamColor(team: string, color: string) {
  if (!team.trim()) {
    return
  }
  TEAM_COLORS[team.trim().toLowerCase()] = color
}

export function getDriverColor(driverNumber: number | null | undefined) {
  if (!Number.isFinite(driverNumber)) {
    return DEFAULT_COLOR
  }
  const team = DRIVER_TEAM[Number(driverNumber)]
  return getTeamColor(team)
}
