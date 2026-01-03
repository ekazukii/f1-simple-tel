export interface SessionCatalogEntry {
  meeting_key: number
  session_key: number
  location: string
  date_start: string
  date_end: string
  session_type: string
  session_name: string
  country_key: number
  country_code: string
  country_name: string
  circuit_key: number
  circuit_short_name: string
  gmt_offset: string
  year: number
}

export function buildSessionOptions(catalog: SessionCatalogEntry[]) {
  const currentYear = new Date().getFullYear()
  const raceSessions = catalog.filter((entry) => {
    const type = String(entry.session_type || '').toUpperCase()
    return type === 'RACE' || type === 'SPRINT'
  })
  const years = raceSessions
    .map((entry) => entry.year)
    .filter((year): year is number => typeof year === 'number')
  const latestYear = years.length ? Math.max(...years) : currentYear
  const targetYear = years.includes(currentYear) ? currentYear : latestYear

  return raceSessions
    .filter((entry) => entry.year === targetYear)
    .sort((a, b) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime())
    .map((entry) => ({
      value: String(entry.session_key),
      label: `${entry.circuit_short_name} - ${entry.session_name}`
    }))
}
