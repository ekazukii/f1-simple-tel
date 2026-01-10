import type { TelemetrySliceSample } from '../types'

const BACKEND_BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4000').replace(/\/$/, '')

interface FetchTelemetrySliceOptions {
  drivers: number[]
  lap: number
  sampleSeconds?: number | null
  signal?: AbortSignal
}

interface TelemetrySliceResponse {
  sessionKey: string
  lapNumber: number
  drivers: number[]
  sampleSeconds: number | null
  telemetry: TelemetrySliceSample[]
}

export async function fetchTelemetrySlice(
  sessionKey: string,
  options: FetchTelemetrySliceOptions
): Promise<TelemetrySliceResponse> {
  const { drivers, lap, sampleSeconds, signal } = options
  const params = new URLSearchParams()
  params.set('drivers', drivers.join(','))
  params.set('lap', String(lap))
  if (sampleSeconds && sampleSeconds > 0) {
    params.set('sample', String(sampleSeconds))
  }
  const url = `${BACKEND_BASE_URL}/session/${encodeURIComponent(sessionKey)}/telemetry?${params.toString()}`
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Backend request failed with status ${response.status}`)
  }
  return (await response.json()) as TelemetrySliceResponse
}
