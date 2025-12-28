import { useMemo, useRef, useState } from 'react'
import sharedStyles from '../styles/Shared.module.css'
import styles from '../styles/StrategySimulator.module.css'
import { runStrategySimulation } from '../api/strategySimulation'
import type { StrategyComparisonEvent, StrategyComparisonInput, StrategyComparisonOutput } from '../types'

const cx = (...names: string[]) =>
  names
    .map((n) => styles[n] || sharedStyles[n])
    .filter(Boolean)
    .join(' ')

const DEFAULT_STRATEGY = JSON.stringify(
  [
    [0, 'SOFT'],
    [13, 16, 'MEDIUM'],
    [36, 39, 'MEDIUM']
  ],
  null,
  2
)

const DEFAULT_DRIVER_STRATEGY = JSON.stringify(
  {
    LEC: [
      [0, 'SOFT'],
      [17, 'MEDIUM'],
      [36, 39, 'MEDIUM']
    ]
  },
  null,
  2
)

function parseJson<T>(value: string, label: string): T {
  if (!value.trim()) {
    throw new Error(`${label} is required.`)
  }
  try {
    return JSON.parse(value) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON'
    throw new Error(`${label} must be valid JSON. ${message}`)
  }
}

function parseOptionalJson<T>(value: string, fallback: T): T {
  if (!value.trim()) {
    return fallback
  }
  return JSON.parse(value) as T
}

function parseNumberList(value: string): number[] {
  if (!value.trim()) {
    return []
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry)) as number[]
}

function formatValue(value: unknown, column: string) {
  if (typeof value === 'number') {
    if (column.includes('wins') || column.includes('podiums') || column.includes('dnf') || column.includes('sc_laps')) {
      return Math.round(value)
    }
    return value.toFixed(2)
  }
  return value ?? '-'
}

function StrategySimulator() {
  const [strategyAGlobal, setStrategyAGlobal] = useState(DEFAULT_STRATEGY)
  const [strategyBGlobal, setStrategyBGlobal] = useState(DEFAULT_STRATEGY)
  const [strategyADriver, setStrategyADriver] = useState('')
  const [strategyBDriver, setStrategyBDriver] = useState(DEFAULT_DRIVER_STRATEGY)
  const [numRuns, setNumRuns] = useState('2000')
  const [raceLength, setRaceLength] = useState('53')
  const [updateEvery, setUpdateEvery] = useState('20')
  const [circuitId, setCircuitId] = useState('monza')
  const [year, setYear] = useState('2023')
  const [grid, setGrid] = useState('VER, LEC, HAM, RUS, GAS, HUL')
  const [safetyCarLaps, setSafetyCarLaps] = useState('17, 18')
  const [rainLaps, setRainLaps] = useState('')
  const [noiseScale, setNoiseScale] = useState('0.5')

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [wins, setWins] = useState<Record<string, number>>({})
  const [logLines, setLogLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StrategyComparisonOutput | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  const summaryRows = result?.strategy_comparison.avg_finish ?? []
  const columns = useMemo(() => {
    const defaultCols = [
      'driver_id',
      'A',
      'B',
      'delta_B_minus_A',
      'wins_A',
      'wins_B',
      'podiums_A',
      'podiums_B',
      'dnf_A',
      'dnf_B',
      'pit_loss_A',
      'pit_loss_B'
    ]
    if (!summaryRows.length) {
      return defaultCols
    }
    const keys = new Set<string>()
    summaryRows.forEach((row) => {
      Object.keys(row).forEach((key) => keys.add(key))
    })
    return defaultCols.filter((key) => keys.has(key))
  }, [summaryRows])

  const handleEvent = (event: StrategyComparisonEvent) => {
    if (event.event === 'progress') {
      setProgress(event.total_runs ? event.run / event.total_runs : 0)
      if (event.wins) {
        setWins(event.wins)
      }
    } else if (event.event === 'result') {
      setResult(event.data)
    } else if (event.event === 'error') {
      setError(event.message)
    } else if (event.event === 'stderr' || event.event === 'log') {
      setLogLines((prev) => [event.message, ...prev].slice(0, 40))
    }
  }

  const runSimulation = async () => {
    setError(null)
    setResult(null)
    setLogLines([])
    setWins({})
    setProgress(0)

    let strategyA: StrategyComparisonInput['strategy']['strategy_a_global']
    let strategyB: StrategyComparisonInput['strategy']['strategy_b_global']
    let driversA: StrategyComparisonInput['strategy']['strategy_a_driver']
    let driversB: StrategyComparisonInput['strategy']['strategy_b_driver']

    try {
      strategyA = parseJson(strategyAGlobal, 'Strategy A')
      strategyB = parseJson(strategyBGlobal, 'Strategy B')
      driversA = parseOptionalJson(strategyADriver, {})
      driversB = parseOptionalJson(strategyBDriver, {})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid strategy JSON.')
      return
    }

    const payload: StrategyComparisonInput = {
      options: {
        noise_scale: Number(noiseScale) || 0.5,
        stream_progress: true
      },
      strategy: {
        strategy_a_global: strategyA,
        strategy_b_global: strategyB,
        strategy_a_driver: driversA,
        strategy_b_driver: driversB,
        num_runs_compare: Number(numRuns) || 2000,
        race_length: Number(raceLength) || 53,
        update_every: Number(updateEvery) || 20,
        circuit_id: circuitId.trim() || undefined,
        year: Number(year) || undefined,
        grid: grid
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
        safety_car_laps: (() => {
          const laps = parseNumberList(safetyCarLaps)
          return laps.length ? laps : null
        })(),
        rain_laps: (() => {
          const laps = parseNumberList(rainLaps)
          return laps.length ? laps : null
        })()
      }
    }

    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)

    try {
      const output = await runStrategySimulation(payload, {
        signal: controller.signal,
        onEvent: handleEvent
      })
      setResult(output)
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Simulation failed.')
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const stopSimulation = () => {
    abortRef.current?.abort()
    setRunning(false)
  }

  return (
    <div className={cx('app')}>
      <section className={cx('toolbar')}>
        <div>
          <p className={cx('eyebrow')}>Strategy lab</p>
          <h1>Monte Carlo Strategy Simulator</h1>
          <p className={cx('lead')}>
            Configure strategy A/B, run the Monte Carlo engine, and compare outcomes in real time.
          </p>
        </div>
      </section>

      <section className={cx('panel')}>
        <div className={cx('panel-title')}>
          <strong>Simulation setup</strong>
          <span className={cx('muted')}>Race settings and engine controls.</span>
        </div>
        <div className={cx('form-grid')}>
          <div className={cx('field')}>
            <label>Number of runs</label>
            <input value={numRuns} onChange={(event) => setNumRuns(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Race length</label>
            <input value={raceLength} onChange={(event) => setRaceLength(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Update every</label>
            <input value={updateEvery} onChange={(event) => setUpdateEvery(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Noise scale</label>
            <input value={noiseScale} onChange={(event) => setNoiseScale(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Circuit ID</label>
            <input value={circuitId} onChange={(event) => setCircuitId(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Year</label>
            <input value={year} onChange={(event) => setYear(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Grid (comma-separated)</label>
            <input value={grid} onChange={(event) => setGrid(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Safety car laps</label>
            <input value={safetyCarLaps} onChange={(event) => setSafetyCarLaps(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Rain laps</label>
            <input value={rainLaps} onChange={(event) => setRainLaps(event.target.value)} />
          </div>
        </div>
        <div className={cx('row')}>
          <button className={cx('button')} onClick={runSimulation} disabled={running}>
            {running ? 'Running...' : 'Run Simulation'}
          </button>
          <button className={cx('button', 'ghost')} onClick={stopSimulation} disabled={!running}>
            Stop
          </button>
          {Object.keys(wins).length > 0 && (
            <span className={cx('pill')}>Wins A: {wins.A ?? 0} · Wins B: {wins.B ?? 0}</span>
          )}
        </div>
        <div className={cx('progress')}>
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        {error && <div className={cx('status', 'error')}>{error}</div>}
      </section>

      <section className={cx('panel')}>
        <div className={cx('panel-title')}>
          <strong>Strategy definitions</strong>
          <span className={cx('muted')}>Paste JSON arrays/objects for global strategy and per-driver overrides.</span>
        </div>
        <div className={cx('form-grid')}>
          <div className={cx('field')}>
            <label>Strategy A (global)</label>
            <textarea value={strategyAGlobal} onChange={(event) => setStrategyAGlobal(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Strategy B (global)</label>
            <textarea value={strategyBGlobal} onChange={(event) => setStrategyBGlobal(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Strategy A (per-driver overrides)</label>
            <textarea value={strategyADriver} onChange={(event) => setStrategyADriver(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Strategy B (per-driver overrides)</label>
            <textarea value={strategyBDriver} onChange={(event) => setStrategyBDriver(event.target.value)} />
          </div>
        </div>
      </section>

      <section className={cx('panel')}>
        <div className={cx('panel-title')}>
          <strong>Live logs</strong>
          <span className={cx('muted')}>Streaming updates from the simulation CLI.</span>
        </div>
        <div className={cx('log')}>
          {logLines.length ? (
            logLines.map((line, idx) => <div key={`${line}-${idx}`}>{line}</div>)
          ) : (
            <div className={cx('muted')}>No logs yet.</div>
          )}
        </div>
      </section>

      <section className={cx('panel')}>
        <div className={cx('panel-title')}>
          <strong>Strategy comparison results</strong>
          <span className={cx('muted')}>Summary table from the latest run.</span>
        </div>
        {result ? (
          <div className={cx('table-wrapper')}>
            <table className={cx('table')}>
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col}>{col.replace(/_/g, ' ')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summaryRows.map((row) => (
                  <tr key={String(row.driver_id ?? Math.random())}>
                    {columns.map((col) => (
                      <td key={col}>{formatValue(row[col], col)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={cx('muted')}>Run a simulation to populate the results table.</p>
        )}
      </section>
    </div>
  )
}

export default StrategySimulator
