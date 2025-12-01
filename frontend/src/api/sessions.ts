import type { OpenF1SessionData } from '../types'

const BACKEND_BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4000').replace(/\/$/, '')

export async function fetchSession(sessionKey: string): Promise<OpenF1SessionData> {
  const response = await fetch(`${BACKEND_BASE_URL}/session/${encodeURIComponent(sessionKey)}`)
  if (!response.ok) {
    throw new Error(`Backend request failed with status ${response.status}`)
  }
  return (await response.json()) as OpenF1SessionData
}
