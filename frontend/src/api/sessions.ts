import type { OpenF1SessionData } from '../types'

const BACKEND_BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4000').replace(/\/$/, '')

interface FetchSessionOptions {
  sampleSeconds?: number | null
  signal?: AbortSignal
  onProgress?: (update: {
    progress: number | null
    receivedBytes: number
    totalBytes: number | null
  }) => void
}

export async function fetchSession(
  sessionKey: string,
  options: FetchSessionOptions = {}
): Promise<OpenF1SessionData> {
  const { sampleSeconds, onProgress, signal } = options
  const params = new URLSearchParams()
  if (sampleSeconds && sampleSeconds > 0) {
    params.set('sample', String(sampleSeconds))
  }
  const url = `${BACKEND_BASE_URL}/session/${encodeURIComponent(sessionKey)}${params.size ? `?${params.toString()}` : ''}`
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Backend request failed with status ${response.status}`)
  }
  const totalHeader = response.headers.get('Content-Length')
  const totalBytes = totalHeader ? Number(totalHeader) : null

  if (!response.body || typeof response.body.getReader !== 'function') {
    const data = (await response.json()) as OpenF1SessionData
    onProgress?.({ progress: 1, receivedBytes: totalBytes ?? 0, totalBytes })
    return data
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value) {
      received += value.length
      if (totalBytes && totalBytes > 0) {
        onProgress?.({ progress: Math.min(received / totalBytes, 1), receivedBytes: received, totalBytes })
      } else {
        onProgress?.({ progress: null, receivedBytes: received, totalBytes: null })
      }
      text += decoder.decode(value, { stream: true })
    }
  }

  text += decoder.decode()
  const payload = JSON.parse(text) as OpenF1SessionData
  onProgress?.({ progress: 1, receivedBytes: totalBytes ?? received, totalBytes })
  return payload
}
