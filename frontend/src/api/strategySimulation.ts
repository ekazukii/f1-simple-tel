import type {
  StrategyComparisonEvent,
  StrategyComparisonInput,
  StrategyComparisonOutput
} from '../types'

const BACKEND_BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4000').replace(/\/$/, '')

interface StrategySimulationOptions {
  signal?: AbortSignal
  onEvent?: (event: StrategyComparisonEvent) => void
}

export async function runStrategySimulation(
  payload: StrategyComparisonInput,
  options: StrategySimulationOptions = {}
): Promise<StrategyComparisonOutput> {
  const response = await fetch(`${BACKEND_BASE_URL}/simulation/strategy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal
  })

  if (!response.ok) {
    throw new Error(`Simulation request failed with status ${response.status}`)
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const data = (await response.json()) as StrategyComparisonOutput
    options.onEvent?.({ event: 'result', data })
    return data
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: StrategyComparisonOutput | null = null

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value) {
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (rawLine) {
          try {
            const event = JSON.parse(rawLine) as StrategyComparisonEvent
            options.onEvent?.(event)
            if (event.event === 'result') {
              result = event.data
            }
          } catch {
            options.onEvent?.({ event: 'log', message: rawLine })
          }
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim()) as StrategyComparisonEvent
      options.onEvent?.(event)
      if (event.event === 'result') {
        result = event.data
      }
    } catch {
      options.onEvent?.({ event: 'log', message: buffer.trim() })
    }
  }

  if (!result) {
    throw new Error('Simulation completed without a result payload.')
  }

  return result
}
