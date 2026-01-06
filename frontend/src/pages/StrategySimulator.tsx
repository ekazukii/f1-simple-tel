import { useEffect, useMemo, useRef, useState } from 'react'
import sharedStyles from '../styles/Shared.module.css'
import styles from '../styles/StrategySimulator.module.css'
import insightsStyles from '../styles/SessionInsights.module.css'
import { runStrategySimulation } from '../api/strategySimulation'
import type { StrategyComparisonEvent, StrategyComparisonInput, StrategyComparisonOutput, StrategyEntry } from '../types'
import { StintTimeline } from '../components/insights/StintTimeline'
import type { TimelineRow, StintSegment } from '../components/insights/types'
import { COMPOUND_COLORS as INSIGHTS_COMPOUND_COLORS } from '../components/insights/theme'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'

const cx = (...names: string[]) =>
  names
    .map((n) => styles[n] || sharedStyles[n] || insightsStyles[n])
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
const POINTS_BY_POSITION = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]

type StrategyStint = {
  compound: string
  pitMin: string
  pitMax: string
}

type TimelineSegment = {
  compound: string
  startLap: number
  endLap: number
  widthPct: number
  compact: boolean
}

type StrategyStats = {
  avgPos: number | null
  avgPoints: number | null
  wins: number
  podiums: number
  runs: number
}

type AutoStrategyPreview = {
  sequence: string
  avg_pit_laps: Array<number | null>
  probability: number
}

type LapTimeSeries = {
  driver_id: string | null
  laps: number[]
  driver: {
    A: Array<number | null>
    B: Array<number | null>
  }
  others: Array<number | null>
}

type PositionSeries = {
  driver_id: string | null
  laps: number[]
  A: Array<number | null>
  B: Array<number | null>
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

function entriesToStints(entries: StrategyEntry[] | null | undefined): StrategyStint[] | null {
  if (!entries || !entries.length) {
    return null
  }
  const stints: StrategyStint[] = []
  entries.forEach((entry, idx) => {
    if (entry.length === 2) {
      const compound = String(entry[1] ?? '').trim()
      stints.push({ compound, pitMin: '', pitMax: '' })
      return
    }
    if (entry.length === 3) {
      const compound = String(entry[2] ?? '').trim()
      stints.push({
        compound,
        pitMin: String(entry[0] ?? ''),
        pitMax: String(entry[1] ?? '')
      })
      return
    }
    if (idx === 0) {
      stints.push({ compound: 'MEDIUM', pitMin: '', pitMax: '' })
    }
  })
  return stints.length ? stints : null
}

function compoundClassName(compound: string) {
  const normalized = compound.trim().toUpperCase()
  if (!normalized || !COMPOUND_OPTIONS.includes(normalized)) {
    return 'compound-unknown'
  }
  return `compound-${normalized.toLowerCase()}`
}

function pointsForPosition(position: number) {
  if (!Number.isFinite(position)) {
    return 0
  }
  const idx = Math.round(position) - 1
  if (idx < 0 || idx >= POINTS_BY_POSITION.length) {
    return 0
  }
  return POINTS_BY_POSITION[idx]
}

function computeDriverStrategyStats(
  summaryRows: Array<Record<string, unknown>>,
  driverId: string,
  strategy: 'A' | 'B'
): StrategyStats {
  if (!driverId) {
    return { avgPos: null, avgPoints: null, wins: 0, podiums: 0, runs: 0 }
  }
  const rows = summaryRows.filter(
    (row) => row.driver_id === driverId && row.strategy === strategy
  )
  const positions = rows
    .map((row) => Number(row.finish_pos))
    .filter((value) => Number.isFinite(value))
  const runs = positions.length
  if (!runs) {
    return { avgPos: null, avgPoints: null, wins: 0, podiums: 0, runs: 0 }
  }
  const wins = positions.filter((pos) => pos === 1).length
  const podiums = positions.filter((pos) => pos <= 3).length
  const avgPos = positions.reduce((sum, value) => sum + value, 0) / runs
  const avgPoints = positions.reduce((sum, pos) => sum + pointsForPosition(pos), 0) / runs
  return { avgPos, avgPoints, wins, podiums, runs }
}

function buildLiveStrategyStats(
  avgFinish: Record<string, number>,
  wins: Record<string, number>,
  podiums: Record<string, number>,
  runs: number,
  label: 'A' | 'B'
): StrategyStats | null {
  if (!runs) {
    return null
  }
  const avgPos = Number.isFinite(avgFinish[label]) ? avgFinish[label] : null
  return {
    avgPos,
    avgPoints: null,
    wins: wins[label] ?? 0,
    podiums: podiums[label] ?? 0,
    runs
  }
}

function buildTimelineSegments(stints: StrategyStint[], raceLength: number): TimelineSegment[] {
  if (!stints.length || raceLength <= 0) {
    return []
  }

  const pitLaps: number[] = []
  let prevLap = 0
  for (let i = 1; i < stints.length; i += 1) {
    const minVal = Number(stints[i].pitMin)
    const maxVal = Number(stints[i].pitMax)
    let pitLap = Math.round((raceLength * i) / stints.length)
    if (Number.isFinite(minVal) && Number.isFinite(maxVal) && minVal <= maxVal) {
      pitLap = Math.round((minVal + maxVal) / 2)
    }
    pitLap = clampNumber(pitLap, prevLap + 1, raceLength - 1)
    pitLaps.push(pitLap)
    prevLap = pitLap
  }

  const bounds = [0, ...pitLaps, raceLength]
  return stints.map((stint, idx) => {
    const startLap = bounds[idx]
    const endLap = bounds[idx + 1]
    const span = Math.max(1, endLap - startLap)
    const widthPct = (span / raceLength) * 100
    return {
      compound: stint.compound || '—',
      startLap,
      endLap,
      widthPct,
      compact: widthPct < 10
    }
  })
}

function normalizeSequencePart(part: string) {
  const normalized = part.trim().toUpperCase()
  if (!normalized) {
    return ''
  }
  if (COMPOUND_OPTIONS.includes(normalized)) {
    return normalized
  }
  const map: Record<string, string> = {
    S: 'SOFT',
    M: 'MEDIUM',
    H: 'HARD',
    I: 'INTER',
    W: 'WET'
  }
  return map[normalized] ?? normalized
}

function parseStrategySequence(sequence: string) {
  return sequence
    .split('-')
    .map((part) => normalizeSequencePart(part))
    .filter(Boolean)
}

function buildStintSegmentsFromSequence(
  sequence: string[],
  avgPitLaps: Array<number | null>,
  raceLength: number,
  driver: number
): StintSegment[] {
  if (!sequence.length || raceLength <= 0) {
    return []
  }

  const stopCount = Math.max(sequence.length - 1, 0)
  const pitLaps: number[] = []
  for (let idx = 0; idx < stopCount; idx += 1) {
    const value = avgPitLaps[idx]
    const fallback = (raceLength * (idx + 1)) / (stopCount + 1)
    const rawLap = Number.isFinite(value) ? Number(value) : fallback
    pitLaps.push(Math.round(rawLap))
  }

  let prevEnd = 0
  const segments: StintSegment[] = []
  sequence.forEach((compound, idx) => {
    let endLap = raceLength
    if (idx < pitLaps.length) {
      endLap = clampNumber(pitLaps[idx], prevEnd + 1, raceLength - 1)
    }
    const startLap = prevEnd + 1
    segments.push({ start: startLap, end: endLap, compound, driver })
    prevEnd = endLap
  })

  if (segments.length) {
    segments[segments.length - 1].end = raceLength
  }

  return segments
}

function buildStintSegmentsFromStints(stints: StrategyStint[], raceLength: number, driver: number): StintSegment[] {
  if (!stints.length || raceLength <= 0) {
    return []
  }
  const pitLaps: number[] = []
  let prevLap = 0
  for (let i = 1; i < stints.length; i += 1) {
    const minVal = Number(stints[i].pitMin)
    const maxVal = Number(stints[i].pitMax)
    let pitLap = Math.round((raceLength * i) / stints.length)
    if (Number.isFinite(minVal) && Number.isFinite(maxVal) && minVal <= maxVal) {
      pitLap = Math.round((minVal + maxVal) / 2)
    }
    pitLap = clampNumber(pitLap, prevLap + 1, raceLength - 1)
    pitLaps.push(pitLap)
    prevLap = pitLap
  }

  let prevEnd = 0
  const segments: StintSegment[] = []
  stints.forEach((stint, idx) => {
    let endLap = raceLength
    if (idx < pitLaps.length) {
      endLap = pitLaps[idx]
    }
    const startLap = prevEnd + 1
    segments.push({
      start: startLap,
      end: endLap,
      compound: stint.compound || '—',
      driver
    })
    prevEnd = endLap
  })
  if (segments.length) {
    segments[segments.length - 1].end = raceLength
  }
  return segments
}

function LapTimeComparisonChart({ series }: { series: LapTimeSeries | null | undefined }) {
  if (!series || !series.laps.length) {
    return <p className={cx('muted')}>No lap time series available for this run.</p>
  }

  const laps = series.laps
  const data = laps.map((lap, idx) => ({
    lap,
    driverA: series.driver.A[idx] ?? null,
    driverB: series.driver.B[idx] ?? null,
    others: series.others[idx] ?? null
  }))

  const values = data
    .flatMap((row) => [row.driverA, row.driverB, row.others])
    .filter((value) => Number.isFinite(value)) as number[]
  if (!values.length) {
    return <p className={cx('muted')}>No lap time series available for this run.</p>
  }

  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const pad = (maxValue - minValue) * 0.08
  const domainMin = Math.max(0, minValue - pad)
  const domainMax = maxValue + pad

  return (
    <div style={{ width: '100%', height: 260 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 10, right: 18, left: 4, bottom: 0 }}>
          <CartesianGrid stroke="rgba(148, 163, 184, 0.25)" strokeDasharray="4 4" />
          <XAxis dataKey="lap" tick={{ fill: '#6b7280', fontSize: 11 }} />
          <YAxis
            domain={[domainMin, domainMax]}
            tick={{ fill: '#6b7280', fontSize: 11 }}
            tickFormatter={(value) => `${value.toFixed(1)}s`}
          />
          <Tooltip
            formatter={(value: number) => (Number.isFinite(value) ? `${value.toFixed(2)}s` : '—')}
            labelFormatter={(label) => `Lap ${label}`}
          />
          <Line type="monotone" dataKey="others" stroke="#6b7280" strokeWidth={2} dot={false} isAnimationActive={false} name="Other drivers" />
          <Line type="monotone" dataKey="driverA" stroke="#1d4ed8" strokeWidth={2.5} dot={false} isAnimationActive={false} name="Driver A" />
          <Line type="monotone" dataKey="driverB" stroke="#f97316" strokeWidth={2.5} dot={false} isAnimationActive={false} name="Driver B" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function PositionComparisonChart({ series }: { series: PositionSeries | null | undefined }) {
  if (!series || !series.laps.length) {
    return <p className={cx('muted')}>No position series available for this run.</p>
  }

  const data = series.laps.map((lap, idx) => ({
    lap,
    stratA: series.A[idx] ?? null,
    stratB: series.B[idx] ?? null
  }))

  const values = data
    .flatMap((row) => [row.stratA, row.stratB])
    .filter((value) => Number.isFinite(value)) as number[]
  if (!values.length) {
    return <p className={cx('muted')}>No position series available for this run.</p>
  }

  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)

  return (
    <div style={{ width: '100%', height: 240 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 10, right: 18, left: 4, bottom: 0 }}>
          <CartesianGrid stroke="rgba(148, 163, 184, 0.25)" strokeDasharray="4 4" />
          <XAxis dataKey="lap" tick={{ fill: '#6b7280', fontSize: 11 }} />
          <YAxis
            domain={[minValue, maxValue]}
            reversed
            tick={{ fill: '#6b7280', fontSize: 11 }}
            tickFormatter={(value) => `P${Math.round(value)}`}
          />
          <Tooltip
            formatter={(value: number) => (Number.isFinite(value) ? `P${value.toFixed(1)}` : '—')}
            labelFormatter={(label) => `Lap ${label}`}
          />
          <Line type="monotone" dataKey="stratA" stroke="#1d4ed8" strokeWidth={2.5} dot={false} isAnimationActive={false} name="Strategy A" />
          <Line type="monotone" dataKey="stratB" stroke="#f97316" strokeWidth={2.5} dot={false} isAnimationActive={false} name="Strategy B" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
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
  const [seedInput, setSeedInput] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [controlledDriver, setControlledDriver] = useState('')
  const [showSetup, setShowSetup] = useState(true)
  const [strategyAErrors, setStrategyAErrors] = useState<Record<number, string>>({})
  const [strategyBErrors, setStrategyBErrors] = useState<Record<number, string>>({})
  const [liveStrategyA, setLiveStrategyA] = useState<StrategyStint[] | null>(null)
  const [liveStrategyB, setLiveStrategyB] = useState<StrategyStint[] | null>(null)
  const [autoStrategies, setAutoStrategies] = useState<AutoStrategyPreview[]>([])

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentRun, setCurrentRun] = useState(0)
  const [wins, setWins] = useState<Record<string, number>>({})
  const [podiums, setPodiums] = useState<Record<string, number>>({})
  const [avgFinish, setAvgFinish] = useState<Record<string, number>>({})
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
      if (Number.isFinite(event.run)) {
        setCurrentRun(event.run)
      }
      const matchesDriver = !event.driver_id || event.driver_id === controlledDriver
      if (matchesDriver) {
        if (event.wins) {
          setWins(event.wins)
        }
        if (event.podiums) {
          setPodiums(event.podiums)
        }
        if (event.avg_finish) {
          setAvgFinish(event.avg_finish)
        }
      }
    } else if (event.event === 'strategy_preview') {
      if (event.driver_id && event.driver_id !== controlledDriver) {
        return
      }
      const stints = entriesToStints(event.entries)
      if (!stints) {
        return
      }
      if (event.strategy === 'A') {
        setLiveStrategyA(stints)
      } else {
        setLiveStrategyB(stints)
      }
    } else if (event.event === 'auto_strategies') {
      if (event.strategy === 'A') {
        setAutoStrategies(event.strategies)
      }
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
      setShowSetup(false)
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
    const timeline = buildTimelineSegments(stints, raceLength)

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
            Add pit stop
          </button>
          <button
            type="button"
            className={cx('chip-button')}
            onClick={() => removeStint(stints, setStints, setErrors)}
            disabled={stints.length <= 2}
          >
            Remove last stop
          </button>
        </div>
        <div className={cx('stint-list')}>
          {stints.map((stint, idx) => (
            <div key={`${label}-stint-${idx}`}>
              <div className={cx('stint-row', rowErrors[idx] ? 'stint-error' : '')}>
                <span className={cx('stint-label')}>
                  {idx === 0 ? 'Starting tyres' : `Pit stop ${idx}`}
                </span>
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
                  <span className={cx('muted')}>Start lap 0</span>
                ) : (
                  <div className={cx('pit-window')}>
                    <span className={cx('pit-window__label')}>Pit window (lap from-to)</span>
                    <div className={cx('pit-window__inputs')}>
                      <input
                        type="number"
                        aria-label="Pit window from lap"
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
                        aria-label="Pit window to lap"
                        value={stint.pitMax}
                        onChange={(event) =>
                          updateStintField(stints, setStints, setErrors, idx, 'pitMax', event.target.value)
                        }
                        min={2}
                        max={raceLength - 1}
                      />
                    </div>
                  </div>
                )}
              </div>
              {rowErrors[idx] && <div className={cx('error-text')}>{rowErrors[idx]}</div>}
            </div>
          ))}
        </div>
        <div className={cx('strategy-preview')}>
          <div className={cx('strategy-timeline')} role="presentation">
            {timeline.map((segment, idx) => (
              <div
                key={`${label}-segment-${idx}`}
                className={cx('timeline-segment', compoundClassName(segment.compound))}
                style={{ width: `${segment.widthPct}%` }}
                data-compact={segment.compact}
                title={`${segment.compound} ${segment.startLap}-${segment.endLap}`}
              >
                <span>{segment.compound}</span>
              </div>
            ))}
          </div>
          <span className={cx('muted')}>
            Pit windows: {pitWindows || '—'}
          </span>
        </div>
      </div>
    )
  }

  const renderStrategySummary = (
    label: string,
    stints: StrategyStint[],
    stats: StrategyStats | null
  ) => {
    const stopCount = Math.max(0, stints.length - 1)
    const pitWindows = stints
      .slice(1)
      .map((stint) => (stint.pitMin && stint.pitMax ? `${stint.pitMin}-${stint.pitMax}` : '—'))
      .join(', ')
    const timeline = buildTimelineSegments(stints, raceLength)

    return (
      <div className={cx('strategy-card', 'strategy-card--summary')}>
        <div className={cx('strategy-header')}>
          <strong>{label}</strong>
          <span className={cx('muted')}>
            {stopCount} stop{stopCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className={cx('strategy-preview')}>
          <div className={cx('strategy-timeline')} role="presentation">
            {timeline.map((segment, idx) => (
              <div
                key={`${label}-summary-${idx}`}
                className={cx('timeline-segment', compoundClassName(segment.compound))}
                style={{ width: `${segment.widthPct}%` }}
                data-compact={segment.compact}
                title={`${segment.compound} ${segment.startLap}-${segment.endLap}`}
              >
                <span>{segment.compound}</span>
              </div>
            ))}
          </div>
          <span className={cx('muted')}>Pit windows: {pitWindows || '—'}</span>
          {stats && stats.runs ? (
            <div className={cx('strategy-stats')}>
              <span>
                Avg pos {stats.avgPos != null ? stats.avgPos.toFixed(2) : '—'}
                {stats.avgPoints != null ? ` (${stats.avgPoints.toFixed(1)} pts)` : ''}
              </span>
              <span>Wins {stats.wins}</span>
              <span>Podiums {stats.podiums}</span>
            </div>
          ) : (
            <span className={cx('muted')}>No stats available yet.</span>
          )}
        </div>
      </div>
    )
  }

  const runSimulation = async () => {
    setError(null)
    setResult(null)
    setLogLines([])
    setWins({})
    setPodiums({})
    setAvgFinish({})
    setProgress(0)
    setCurrentRun(0)
    setLiveStrategyA(null)
    setLiveStrategyB(null)
    setAutoStrategies([])
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
        stream_progress: true,
        ...(seedInput.trim() ? { seed: Number(seedInput) } : {})
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
    setShowSetup(false)
    setRunning(true)

    try {
      const output = await runStrategySimulation(payload, {
        signal: controller.signal,
        onEvent: handleEvent
      })
      setResult(output)
      setShowSetup(false)
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Simulation failed.')
        setShowSetup(true)
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const stopSimulation = () => {
    abortRef.current?.abort()
    setRunning(false)
    setShowSetup(true)
  }

  const resetSimulationView = () => {
    stopSimulation()
    setResult(null)
    setError(null)
    setLogLines([])
    setProgress(0)
    setWins({})
    setPodiums({})
    setAvgFinish({})
    setCurrentRun(0)
    setLiveStrategyA(null)
    setLiveStrategyB(null)
    setAutoStrategies([])
    setStrategyAErrors({})
    setStrategyBErrors({})
    setShowSetup(true)
  }

  const summaryStrategyA = liveStrategyA ?? strategyAStints
  const summaryStrategyB = liveStrategyB ?? strategyBStints
  const liveStatsA = buildLiveStrategyStats(avgFinish, wins, podiums, currentRun, 'A')
  const liveStatsB = buildLiveStrategyStats(avgFinish, wins, podiums, currentRun, 'B')
  const lapTimeSeries = result?.strategy_comparison.lap_time_series ?? null
  const positionSeries = result?.strategy_comparison.position_series ?? null
  const driverLabel = controlledDriver ? `${controlledDriver} - Strat` : 'Driver - Strat'
  const strategyTimelineRows = useMemo(() => {
    const rows: TimelineRow[] = []
    const sessionDate = `${year}-01-01`
    autoStrategies.slice(0, 3).forEach((strat, idx) => {
      const sequence = parseStrategySequence(strat.sequence)
      if (!sequence.length) {
        return
      }
      const segments = buildStintSegmentsFromSequence(sequence, strat.avg_pit_laps ?? [], raceLength, idx + 1)
      if (!segments.length) {
        return
      }
      const probLabel = Number.isFinite(strat.probability) ? ` · ${strat.probability}%` : ''
      rows.push({
        driver: idx + 1,
        stints: segments,
        sessionDate,
        label: `AI ${idx + 1}${probLabel}`
      })
    })
    const userBase = rows.length + 1
    const userSegmentsA = buildStintSegmentsFromStints(summaryStrategyA, raceLength, userBase)
    if (userSegmentsA.length) {
      rows.push({
        driver: userBase,
        stints: userSegmentsA,
        sessionDate,
        label: 'Strategy A'
      })
    }
    const userSegmentsB = buildStintSegmentsFromStints(summaryStrategyB, raceLength, userBase + 1)
    if (userSegmentsB.length) {
      rows.push({
        driver: userBase + 1,
        stints: userSegmentsB,
        sessionDate,
        label: 'Strategy B'
      })
    }
    return rows
  }, [autoStrategies, summaryStrategyA, summaryStrategyB, raceLength, year])

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

      {showSetup ? (
        <>
          <section className={cx('panel')}>
            <div className={cx('panel-title')}>
              <strong>Simulation setup</strong>
              <span className={cx('muted')}>Race settings and engine controls.</span>
            </div>
            <div className={cx('form-grid', 'form-grid--compact')}>
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
            </div>
            <button
              type="button"
              className={cx('advanced-toggle')}
              onClick={() => setShowAdvanced((prev) => !prev)}
            >
              {showAdvanced ? 'Hide advanced options' : 'Show advanced options'}
            </button>
            {showAdvanced && (
              <div className={cx('form-grid', 'form-grid--advanced')}>
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
                <div className={cx('field')}>
                  <label>Seed (optional)</label>
                  <input
                    type="number"
                    placeholder="random"
                    value={seedInput}
                    onChange={(event) => setSeedInput(event.target.value)}
                  />
                </div>
                <div className={cx('field')}>
                  <label>Simulation runs</label>
                  <div className={cx('pill')}>{NUM_RUNS} runs · update every {UPDATE_EVERY}</div>
                </div>
              </div>
            )}
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
        </>
      ) : (
        <>
          {!result ? (
            <section className={cx('panel')}>
              <div className={cx('panel-title')}>
                <strong>Live simulation results</strong>
                <span className={cx('muted')}>Circuit, strategy summary, and progress updates.</span>
              </div>
              <div className={cx('summary-meta')}>
                <span className={cx('pill')}>
                  {formatCircuitLabel(circuitId)} ({circuitId}) · {year}
                </span>
                <span className={cx('pill')}>{raceLength} laps</span>
                <span className={cx('pill')}>Driver: {controlledDriver || '—'}</span>
              </div>
              <div className={cx('strategy-grid')}>
                {renderStrategySummary(
                  'Strategy A',
                  summaryStrategyA,
                  liveStatsA
                )}
                {renderStrategySummary(
                  'Strategy B',
                  summaryStrategyB,
                  liveStatsB
                )}
              </div>
              <div className={cx('row')}>
                <button className={cx('button', 'ghost')} onClick={stopSimulation} disabled={!running}>
                  Stop simulation
                </button>
                {running && (
                  <span className={cx('muted')}>
                    {Math.round(progress * 100)}% complete
                  </span>
                )}
              </div>
              {running && (
                <div className={cx('progress')}>
                  <span style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
            </section>
          ) : (
            <>
              <section className={cx('panel')}>
                <div className={cx('panel-header')}>
                  <div className={cx('panel-title')}>
                    <strong>Simulation summary</strong>
                    <span className={cx('muted')}>Circuit, year, and strategy overview.</span>
                  </div>
                  <button className={cx('button')} onClick={resetSimulationView}>
                    Create new simulation
                  </button>
                </div>
                <div className={cx('summary-meta')}>
                  <span className={cx('pill')}>
                    {formatCircuitLabel(circuitId)} ({circuitId}) · {year}
                  </span>
                  <span className={cx('pill')}>{raceLength} laps</span>
                  <span className={cx('pill')}>Driver: {controlledDriver || '—'}</span>
                </div>
                <div className={cx('strategy-grid')}>
                  {renderStrategySummary(
                    'Strategy A',
                    summaryStrategyA,
                    computeDriverStrategyStats(
                      result.strategy_comparison.summary_comp_df ?? [],
                      controlledDriver,
                      'A'
                    )
                  )}
                  {renderStrategySummary(
                    'Strategy B',
                    summaryStrategyB,
                    computeDriverStrategyStats(
                      result.strategy_comparison.summary_comp_df ?? [],
                      controlledDriver,
                      'B'
                    )
                  )}
                </div>
              </section>

              <section className={cx('panel')}>
                <div className={cx('panel-title')}>
                  <strong>Lap time comparison</strong>
                  <span className={cx('muted')}>Average lap time by lap for the controlled driver and the field.</span>
                </div>
                <div className={cx('compound-legend')}>
                  <span className={cx('legend-item')}>
                    <span className={cx('legend-swatch')} style={{ backgroundColor: '#1d4ed8' }} />
                    {driverLabel} A
                  </span>
                  <span className={cx('legend-item')}>
                    <span className={cx('legend-swatch')} style={{ backgroundColor: '#f97316' }} />
                    {driverLabel} B
                  </span>
                  <span className={cx('legend-item')}>
                    <span className={cx('legend-swatch')} style={{ backgroundColor: '#6b7280' }} />
                    Other drivers (A+B)
                  </span>
                </div>
                <LapTimeComparisonChart series={lapTimeSeries} />
              </section>

              <section className={cx('panel')}>
                <div className={cx('panel-title')}>
                  <strong>Position comparison</strong>
                  <span className={cx('muted')}>Average position per lap for the controlled driver.</span>
                </div>
                <div className={cx('compound-legend')}>
                  <span className={cx('legend-item')}>
                    <span className={cx('legend-swatch')} style={{ backgroundColor: '#1d4ed8' }} />
                    {driverLabel} A
                  </span>
                  <span className={cx('legend-item')}>
                    <span className={cx('legend-swatch')} style={{ backgroundColor: '#f97316' }} />
                    {driverLabel} B
                  </span>
                </div>
                <PositionComparisonChart series={positionSeries} />
              </section>

              <section className={cx('panel')}>
                <div className={cx('panel-title')}>
                  <strong>Strategy timelines</strong>
                  <span className={cx('muted')}>Top AI strategies and your A/B strategies.</span>
                </div>
                <div className={cx('compound-legend')}>
                  {Object.entries(INSIGHTS_COMPOUND_COLORS).map(([compound, color]) => (
                    <span key={compound} className={cx('legend-item')}>
                      <span className={cx('legend-swatch')} style={{ backgroundColor: color }} />
                      {compound}
                    </span>
                  ))}
                </div>
                <StintTimeline rows={strategyTimelineRows} maxLap={raceLength} />
              </section>

              <section className={cx('panel')}>
                <div className={cx('panel-title')}>
                  <strong>Strategy comparison results</strong>
                  <span className={cx('muted')}>Summary table from the latest run.</span>
                </div>
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
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}

export default StrategySimulator
