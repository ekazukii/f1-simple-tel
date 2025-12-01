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
  return catalog
    .filter((entry) => {
      const type = String(entry.session_type || '').toUpperCase()
      return entry.year === currentYear && (type === 'RACE' || type === 'SPRINT')
    })
    .sort((a, b) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime())
    .map((entry) => ({
      value: String(entry.session_key),
      label: `${entry.circuit_short_name} - ${entry.session_name}`
    }))
}
