const BACKEND_BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4000').replace(/\/$/, '')

export async function fetchTrackLayout(circuitKey: number | string): Promise<string | null> {
  const url = `${BACKEND_BASE_URL}/track-layout/${encodeURIComponent(String(circuitKey))}`
  const response = await fetch(url)
  if (!response.ok) {
    return null
  }
  return await response.text()
}
