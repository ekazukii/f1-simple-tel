import type { OpenF1SessionData } from '../types'

const BACKEND_BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4000').replace(/\/$/, '')

interface FetchSessionOptions {
  sampleSeconds?: number | null
}

export async function fetchSession(
  sessionKey: string,
  options: FetchSessionOptions = {}
): Promise<OpenF1SessionData> {
  const params = new URLSearchParams()
  if (options.sampleSeconds && options.sampleSeconds > 0) {
    params.set('sample', String(options.sampleSeconds))
  }
  const url = `${BACKEND_BASE_URL}/session/${encodeURIComponent(sessionKey)}${params.size ? `?${params.toString()}` : ''}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Backend request failed with status ${response.status}`)
  }
  return (await response.json()) as OpenF1SessionData
}
