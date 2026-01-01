import { useEffect, useMemo, useRef, useState } from 'react'
import sharedStyles from '../styles/Shared.module.css'
import styles from '../styles/StrategySimulator.module.css'
import { runStrategySimulation } from '../api/strategySimulation'
import type { StrategyComparisonEvent, StrategyComparisonInput, StrategyComparisonOutput, StrategyEntry } from '../types'

const cx = (...names: string[]) =>
  names
    .map((n) => styles[n] || sharedStyles[n])
    .filter(Boolean)
    .join(' ')

const UPDATE_EVERY = 10
const NUM_RUNS = 50
const YEAR_OPTIONS = Array.from({ length: 8 }, (_, idx) => String(2018 + idx))

const CIRCUITS = [
  { id: 'austin', laps: 56 },
  { id: 'baku', laps: 51 },
  { id: 'barcelona', laps: 66 },
  { id: 'budapest', laps: 70 },
  { id: 'hockenheim', laps: 64 },
  { id: 'imola', laps: 63 },
  { id: 'istanbul', laps: 58 },
  { id: 'jeddah', laps: 50 },
  { id: 'las_vegas', laps: 50 },
  { id: 'le_castellet', laps: 53 },
  { id: 'lusail', laps: 57 },
  { id: 'melbourne', laps: 57 },
  { id: 'mexico_city', laps: 71 },
  { id: 'miami', laps: 57 },
  { id: 'monaco', laps: 78 },
  { id: 'montr\u00e9al', laps: 70 },
  { id: 'monza', laps: 53 },
  { id: 'mugello', laps: 59 },
  { id: 'n\u00fcrburgring', laps: 60 },
  { id: 'portim\u00e3o', laps: 66 },
  { id: 'sakhir', laps: 57 },
  { id: 'shanghai', laps: 56 },
  { id: 'silverstone', laps: 52 },
  { id: 'singapore', laps: 62 },
  { id: 'sochi', laps: 53 },
  { id: 'spa_francorchamps', laps: 44 },
  { id: 'spielberg', laps: 70 },
  { id: 'suzuka', laps: 53 },
  { id: 's\u00e3o_paulo', laps: 71 },
  { id: 'yas_marina', laps: 58 },
  { id: 'zandvoort', laps: 72 }
]

const COMPOUND_OPTIONS = ['SOFT', 'MEDIUM', 'HARD', 'INTER', 'WET']
const DEFAULT_ONE_STOP_COMPOUNDS = ['MEDIUM', 'HARD']
const DEFAULT_TWO_STOP_COMPOUNDS = ['SOFT', 'MEDIUM', 'MEDIUM']
const DEFAULT_CIRCUIT_ID = 'monaco'
const DEFAULT_RACE_LENGTH = CIRCUITS.find((circuit) => circuit.id === DEFAULT_CIRCUIT_ID)?.laps ?? 53

type StrategyStint = {
  compound: string
  pitMin: string
  pitMax: string
}

const formatCircuitLabel = (value: string) =>
  value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

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

function parseGridDrivers(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function pitWindowSize(stopCount: number) {
  return stopCount <= 1 ? 5 : 3
}

function computePitWindow(avgLap: number, windowSize: number, raceLength: number, prevMax: number) {
  const half = Math.floor(windowSize / 2)
  let minLap = avgLap - half
  let maxLap = minLap + windowSize - 1

  minLap = clampNumber(minLap, 2, raceLength - 1)
  maxLap = clampNumber(maxLap, 2, raceLength - 1)
  if (minLap <= prevMax) {
    minLap = prevMax + 1
    maxLap = minLap + windowSize - 1
    if (maxLap > raceLength - 1) {
      maxLap = raceLength - 1
      minLap = Math.max(prevMax + 1, maxLap - windowSize + 1)
    }
  }

  return { minLap, maxLap }
}

function buildPresetStints(stopCount: number, raceLength: number, compounds: string[]) {
  const windowSize = pitWindowSize(stopCount)
  const stints: StrategyStint[] = []
  const stintCount = stopCount + 1
  let prevMax = 1

  for (let i = 0; i < stintCount; i += 1) {
    const compound = compounds[i] ?? 'MEDIUM'
    if (i === 0) {
      stints.push({ compound, pitMin: '', pitMax: '' })
      continue
    }
    const avgLap = Math.round((raceLength * i) / stintCount)
    const { minLap, maxLap } = computePitWindow(avgLap, windowSize, raceLength, prevMax)

    stints.push({
      compound,
      pitMin: String(minLap),
      pitMax: String(maxLap)
    })
    prevMax = maxLap
  }

  return stints
}

function buildStrategyEntries(stints: StrategyStint[], raceLength: number) {
  const errors: string[] = []
  const rowErrors: Record<number, string> = {}
  const entries: StrategyEntry[] = []

  if (!stints.length) {
    errors.push('Strategy must include at least one stint.')
    return { entries: null, errors, rowErrors }
  }

  const firstCompound = stints[0].compound.trim()
  if (!firstCompound) {
    rowErrors[0] = 'Select a compound.'
  }
  entries.push([0, firstCompound || 'MEDIUM'])

  let prevMax = 1
  for (let i = 1; i < stints.length; i += 1) {
    const stint = stints[i]
    const compound = stint.compound.trim()
    if (!compound) {
      rowErrors[i] = 'Select a compound.'
      continue
    }
    const minVal = Number(stint.pitMin)
    const maxVal = Number(stint.pitMax)
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
      rowErrors[i] = 'Enter a pit window.'
      continue
    }
    if (minVal < 2 || maxVal > raceLength - 1 || minVal > maxVal) {
      rowErrors[i] = 'Pit window out of range.'
      continue
    }
    if (minVal <= prevMax) {
      rowErrors[i] = 'Pit window overlaps previous stop.'
      continue
    }
    entries.push([minVal, maxVal, compound])
    prevMax = maxVal
  }

  if (Object.keys(rowErrors).length) {
    errors.push('Fix highlighted strategy fields.')
    return { entries: null, errors, rowErrors }
  }

  return { entries, errors, rowErrors }
}

function compoundClassName(compound: string) {
  const key = compound.trim().toLowerCase()
  return key ? `compound-${key}` : 'compound-unknown'
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
  const [strategyAStints, setStrategyAStints] = useState(() =>
    buildPresetStints(1, DEFAULT_RACE_LENGTH, DEFAULT_ONE_STOP_COMPOUNDS)
  )
  const [strategyBStints, setStrategyBStints] = useState(() =>
    buildPresetStints(2, DEFAULT_RACE_LENGTH, DEFAULT_TWO_STOP_COMPOUNDS)
  )
  const [circuitId, setCircuitId] = useState('monaco')
  const [year, setYear] = useState('2025')
  const [grid, setGrid] = useState('VER, LEC, HAM, RUS, GAS, HUL')
  const [safetyCarLaps, setSafetyCarLaps] = useState('17, 18')
  const [rainLaps, setRainLaps] = useState('')
  const [controlledDriver, setControlledDriver] = useState('')
  const [strategyAErrors, setStrategyAErrors] = useState<Record<number, string>>({})
  const [strategyBErrors, setStrategyBErrors] = useState<Record<number, string>>({})

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [wins, setWins] = useState<Record<string, number>>({})
  const [logLines, setLogLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StrategyComparisonOutput | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const gridDrivers = useMemo(() => parseGridDrivers(grid), [grid])
  const raceLength = useMemo(() => {
    const match = CIRCUITS.find((circuit) => circuit.id === circuitId)
    return match?.laps ?? 53
  }, [circuitId])

  useEffect(() => {
    if (!gridDrivers.length) {
      setControlledDriver('')
      return
    }
    if (!controlledDriver || !gridDrivers.includes(controlledDriver)) {
      setControlledDriver(gridDrivers[0])
    }
  }, [controlledDriver, gridDrivers])

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

  const updateStints = (
    next: StrategyStint[],
    setStints: (value: StrategyStint[]) => void,
    setErrors: (value: Record<number, string>) => void
  ) => {
    setStints(next)
    setErrors({})
  }

  const updateStintField = (
    stints: StrategyStint[],
    setStints: (value: StrategyStint[]) => void,
    setErrors: (value: Record<number, string>) => void,
    index: number,
    field: keyof StrategyStint,
    value: string
  ) => {
    const next = stints.map((stint, idx) => (idx === index ? { ...stint, [field]: value } : stint))
    updateStints(next, setStints, setErrors)
  }

  const addStint = (
    stints: StrategyStint[],
    setStints: (value: StrategyStint[]) => void,
    setErrors: (value: Record<number, string>) => void
  ) => {
    const nextStopCount = stints.length
    const windowSize = pitWindowSize(nextStopCount)
    const avgLap = Math.round((raceLength * nextStopCount) / (nextStopCount + 1))
    const lastPit = stints[stints.length - 1]
    const prevMax = Number(lastPit?.pitMax) || 1
    const { minLap, maxLap } = computePitWindow(avgLap, windowSize, raceLength, prevMax)
    const next = [
      ...stints,
      {
        compound: 'MEDIUM',
        pitMin: String(minLap),
        pitMax: String(maxLap)
      }
    ]
    updateStints(next, setStints, setErrors)
  }

  const removeStint = (
    stints: StrategyStint[],
    setStints: (value: StrategyStint[]) => void,
    setErrors: (value: Record<number, string>) => void
  ) => {
    if (stints.length <= 2) {
      return
    }
    updateStints(stints.slice(0, -1), setStints, setErrors)
  }

  const handleEvent = (event: StrategyComparisonEvent) => {
    if (event.event === 'progress') {
      setProgress(event.total_runs ? event.run / event.total_runs : 0)
      if (event.wins) {
        setWins(event.wins)
      }
    } else if (event.event === 'auto_strategies') {
      const items = event.strategies
        .map((strat) => {
          const pits = strat.avg_pit_laps?.length ? `[${strat.avg_pit_laps.join(', ')}]` : '[]'
          return `${strat.sequence} pits ${pits} prob ${strat.probability}%`
        })
        .join(' | ')
      const header = `Auto strategies ${event.strategy} (${event.circuit_id} ${event.year}): ${items}`
      setLogLines((prev) => [header, ...prev].slice(0, 40))
    } else if (event.event === 'result') {
      setResult(event.data)
    } else if (event.event === 'error') {
      setError(event.message)
    } else if (event.event === 'stderr' || event.event === 'log') {
      setLogLines((prev) => [event.message, ...prev].slice(0, 40))
    }
  }

  const renderStrategyPanel = (
    label: string,
    stints: StrategyStint[],
    setStints: (value: StrategyStint[]) => void,
    rowErrors: Record<number, string>,
    setErrors: (value: Record<number, string>) => void
  ) => {
    const stopCount = Math.max(0, stints.length - 1)
    const pitWindows = stints
      .slice(1)
      .map((stint) => (stint.pitMin && stint.pitMax ? `${stint.pitMin}-${stint.pitMax}` : '—'))
      .join(', ')

    return (
      <div className={cx('strategy-card')}>
        <div className={cx('strategy-header')}>
          <strong>{label}</strong>
          <span className={cx('muted')}>
            {stopCount} stop{stopCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className={cx('strategy-actions')}>
          <button
            type="button"
            className={cx('chip-button')}
            onClick={() => updateStints(buildPresetStints(1, raceLength, DEFAULT_ONE_STOP_COMPOUNDS), setStints, setErrors)}
          >
            One-stop
          </button>
          <button
            type="button"
            className={cx('chip-button')}
            onClick={() => updateStints(buildPresetStints(2, raceLength, DEFAULT_TWO_STOP_COMPOUNDS), setStints, setErrors)}
          >
            Two-stop
          </button>
          <button
            type="button"
            className={cx('chip-button')}
            onClick={() => addStint(stints, setStints, setErrors)}
          >
            Add stint
          </button>
          <button
            type="button"
            className={cx('chip-button')}
            onClick={() => removeStint(stints, setStints, setErrors)}
            disabled={stints.length <= 2}
          >
            Remove last
          </button>
        </div>
        <div className={cx('stint-list')}>
          {stints.map((stint, idx) => (
            <div key={`${label}-stint-${idx}`}>
              <div className={cx('stint-row', rowErrors[idx] ? 'stint-error' : '')}>
                <span className={cx('stint-label')}>Stint {idx + 1}</span>
                <select
                  value={stint.compound}
                  onChange={(event) =>
                    updateStintField(stints, setStints, setErrors, idx, 'compound', event.target.value)
                  }
                >
                  {COMPOUND_OPTIONS.map((compound) => (
                    <option key={compound} value={compound}>
                      {compound}
                    </option>
                  ))}
                </select>
                {idx === 0 ? (
                  <span className={cx('muted')}>Start</span>
                ) : (
                  <div className={cx('pit-window')}>
                    <input
                      type="number"
                      value={stint.pitMin}
                      onChange={(event) =>
                        updateStintField(stints, setStints, setErrors, idx, 'pitMin', event.target.value)
                      }
                      min={2}
                      max={raceLength - 1}
                    />
                    <span className={cx('muted')}>to</span>
                    <input
                      type="number"
                      value={stint.pitMax}
                      onChange={(event) =>
                        updateStintField(stints, setStints, setErrors, idx, 'pitMax', event.target.value)
                      }
                      min={2}
                      max={raceLength - 1}
                    />
                  </div>
                )}
              </div>
              {rowErrors[idx] && <div className={cx('error-text')}>{rowErrors[idx]}</div>}
            </div>
          ))}
        </div>
        <div className={cx('strategy-preview')}>
          <div className={cx('compound-preview')}>
            {stints.map((stint, idx) => (
              <span key={`${label}-chip-${idx}`} className={cx('compound-chip', compoundClassName(stint.compound))}>
                {stint.compound || '—'}
              </span>
            ))}
          </div>
          <span className={cx('muted')}>
            Pit windows: {pitWindows || '—'}
          </span>
        </div>
      </div>
    )
  }

  const runSimulation = async () => {
    setError(null)
    setResult(null)
    setLogLines([])
    setWins({})
    setProgress(0)
    setStrategyAErrors({})
    setStrategyBErrors({})

    const driverId = controlledDriver.trim()
    if (!driverId) {
      setError('Select a controlled driver from the grid.')
      return
    }
    if (!gridDrivers.includes(driverId)) {
      setError('Controlled driver must be part of the grid.')
      return
    }

    const strategyAResult = buildStrategyEntries(strategyAStints, raceLength)
    const strategyBResult = buildStrategyEntries(strategyBStints, raceLength)
    if (strategyAResult.entries == null || strategyBResult.entries == null) {
      setStrategyAErrors(strategyAResult.rowErrors)
      setStrategyBErrors(strategyBResult.rowErrors)
      setError(
        [...strategyAResult.errors, ...strategyBResult.errors].filter(Boolean).join(' ') ||
          'Invalid strategy configuration.'
      )
      return
    }

    const payload: StrategyComparisonInput = {
      options: {
        stream_progress: true
      },
      strategy: {
        strategy_a_global: null,
        strategy_b_global: null,
        strategy_a_driver: { [driverId]: strategyAResult.entries },
        strategy_b_driver: { [driverId]: strategyBResult.entries },
        race_length: raceLength,
        circuit_id: circuitId.trim() || undefined,
        year: Number(year) || undefined,
        grid: gridDrivers,
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
            <label>Circuit ID</label>
            <select value={circuitId} onChange={(event) => setCircuitId(event.target.value)}>
              {CIRCUITS.map((circuit) => (
                <option key={circuit.id} value={circuit.id}>
                  {formatCircuitLabel(circuit.id)}
                </option>
              ))}
            </select>
            <small className={cx('muted')}>Race length: {raceLength} laps</small>
          </div>
          <div className={cx('field')}>
            <label>Year</label>
            <select value={year} onChange={(event) => setYear(event.target.value)}>
              {YEAR_OPTIONS.map((yearOption) => (
                <option key={yearOption} value={yearOption}>
                  {yearOption}
                </option>
              ))}
            </select>
          </div>
          <div className={cx('field')}>
            <label>Grid (comma-separated)</label>
            <input value={grid} onChange={(event) => setGrid(event.target.value)} />
          </div>
          <div className={cx('field')}>
            <label>Simulation runs</label>
            <div className={cx('pill')}>{NUM_RUNS} runs · update every {UPDATE_EVERY}</div>
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
          <strong>Driver strategy comparison</strong>
          <span className={cx('muted')}>Pick one driver to control and define Strategy A/B.</span>
        </div>
        <div className={cx('form-grid')}>
          <div className={cx('field')}>
            <label>Controlled driver</label>
            <select
              value={controlledDriver}
              onChange={(event) => setControlledDriver(event.target.value)}
              disabled={!gridDrivers.length}
            >
              {gridDrivers.map((driver) => (
                <option key={driver} value={driver}>
                  {driver}
                </option>
              ))}
            </select>
            <small className={cx('muted')}>Only this driver uses A/B strategies; everyone else is auto.</small>
          </div>
          <div className={cx('field')}>
            <label>Copy strategies</label>
            <div className={cx('row')}>
              <button
                type="button"
                className={cx('button', 'ghost')}
                onClick={() => updateStints(strategyAStints, setStrategyBStints, setStrategyBErrors)}
              >
                Copy A → B
              </button>
              <button
                type="button"
                className={cx('button', 'ghost')}
                onClick={() => updateStints(strategyBStints, setStrategyAStints, setStrategyAErrors)}
              >
                Copy B → A
              </button>
            </div>
          </div>
        </div>
        <div className={cx('strategy-grid')}>
          {renderStrategyPanel('Strategy A', strategyAStints, setStrategyAStints, strategyAErrors, setStrategyAErrors)}
          {renderStrategyPanel('Strategy B', strategyBStints, setStrategyBStints, strategyBErrors, setStrategyBErrors)}
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
