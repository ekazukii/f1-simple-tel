import { useEffect, useMemo, useRef, useState } from 'react'
import '../App.css'
import sessionCatalog from '../data/sessionCatalog.json'
import type { OpenF1SessionData } from '../types'
import { fetchSession } from '../api/sessions'
import type { SessionCatalogEntry } from '../utils/sessionCatalog'
import { buildSessionOptions } from '../utils/sessionCatalog'
import RaceReplayCanvas from '../components/RaceReplayCanvas'
import type { ReplayPoint } from '../components/RaceReplayCanvas'

const SPEED_PRESETS = [0.1, 0.25, 0.5, 1, 2, 4, 10]

type StatusState = { loading: boolean; error: string | null }

type DriverSample = { x: number; y: number; time: number }

type DriverTimeline = {
  driver: number
  samples: DriverSample[]
}

export function RaceReplayer() {
  const sessionOptions = useMemo(() => buildSessionOptions(sessionCatalog as SessionCatalogEntry[]), [])
  const [selectedSession, setSelectedSession] = useState<string>(sessionOptions[0]?.value ?? '')
  const [session, setSession] = useState<OpenF1SessionData | null>(null)
  const [status, setStatus] = useState<StatusState>({ loading: false, error: null })
  const [speed, setSpeed] = useState<number>(1)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState<number>(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!selectedSession) {
      return
    }

    let cancelled = false
    setStatus({ loading: true, error: null })

    fetchSession(selectedSession)
      .then((data) => {
        if (cancelled) return
        setSession(data)
        setStatus({ loading: false, error: null })
      })
      .catch((error) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'Failed to load session'
        setStatus({ loading: false, error: message })
      })

    return () => {
      cancelled = true
    }
  }, [selectedSession])

  const timelines = useMemo(() => buildDriverTimelines(session), [session])
  const trackBounds = useMemo(() => computeBounds(timelines), [timelines])
  const playbackRange = useMemo(() => computePlaybackRange(timelines), [timelines])

  useEffect(() => {
    if (!playbackRange) {
      setCurrentTime(0)
      setIsPlaying(false)
      return
    }
    setCurrentTime(playbackRange.start)
    setIsPlaying(false)
  }, [playbackRange])

  useEffect(() => {
    if (!isPlaying || !playbackRange) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
      return
    }

    let lastTs = performance.now()

    const tick = (now: number) => {
      const delta = now - lastTs
      lastTs = now
      setCurrentTime((prev) => {
        const next = Math.min(prev + delta * speed, playbackRange.end)
        if (next >= playbackRange.end) {
          setIsPlaying(false)
          return playbackRange.end
        }
        return next
      })
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [isPlaying, speed, playbackRange])

  const replayPoints = useMemo<ReplayPoint[]>(() => {
    if (!playbackRange || !trackBounds) {
      return []
    }
    return timelines.map((timeline) => {
      const sample = getSampleAtTime(timeline.samples, currentTime)
      if (!sample) {
        return null
      }
      return {
        driver: timeline.driver,
        x: sample.x,
        y: sample.y,
        color: pickDriverColor(timeline.driver),
        label: `#${timeline.driver}`
      }
    }).filter((point): point is ReplayPoint => Boolean(point))
  }, [timelines, currentTime, trackBounds, playbackRange])

  const durationLabel = useMemo(() =>
    playbackRange ? formatDuration(currentTime - playbackRange.start) : '00:00.0',
  [currentTime, playbackRange])

  return (
    <main className="app race-replayer-page">
      <header className="toolbar">
        <div>
          <p className="eyebrow">Race Replayer</p>
          <h1>Live telemetry playback</h1>
        </div>
        <div className="control-stack">
          <div className="session-picker">
            <label htmlFor="replayer-session">Choose session</label>
            <select
              id="replayer-session"
              value={selectedSession}
              onChange={(event) => setSelectedSession(event.target.value)}
            >
              {sessionOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {status.error && <div className="status error">{status.error}</div>}
      {status.loading && <div className="status info">Loading telemetry…</div>}

      {session && trackBounds ? (
        <section className="race-replay-panel">
          <RaceReplayCanvas points={replayPoints} bounds={trackBounds} />
          <div className="race-replay-controls">
            <div className="playback-controls">
              <button
                type="button"
                className="pill"
                onClick={() => setIsPlaying((prev) => !prev)}
                disabled={!playbackRange}
              >
                {isPlaying ? 'Pause' : 'Play'}
              </button>
              <div className="playback-time">
                <strong>{durationLabel}</strong>
                {playbackRange && (
                  <small>
                    / {formatDuration(playbackRange.end - playbackRange.start)}
                  </small>
                )}
              </div>
            </div>
            <div className="speed-controls">
              <label htmlFor="speed-select">Speed</label>
              <select
                id="speed-select"
                value={speed}
                onChange={(event) => setSpeed(Number(event.target.value))}
              >
                {SPEED_PRESETS.map((preset) => (
                  <option value={preset} key={preset}>
                    {preset}×
                  </option>
                ))}
              </select>
            </div>
            {playbackRange && (
              <div className="timeline-slider">
                <input
                  type="range"
                  min={0}
                  max={playbackRange.end - playbackRange.start}
                  value={Math.max(0, currentTime - playbackRange.start)}
                  onChange={(event) => {
                    const next = playbackRange.start + Number(event.target.value)
                    setCurrentTime(next)
                  }}
                />
              </div>
            )}
          </div>
        </section>
      ) : (
        <div className="race-replayer__empty">
          <p className="muted">Select a session to start the replay.</p>
        </div>
      )}
    </main>
  )
}

function buildDriverTimelines(session: OpenF1SessionData | null): DriverTimeline[] {
  if (!session) {
    return []
  }

  const grouped = new Map<number, DriverSample[]>()

  session.telemetry?.forEach((sample) => {
    const x = toNumber(sample.x)
    const y = toNumber(sample.y)
    if (x == null || y == null) {
      return
    }
    const time = Date.parse(sample.sample_time)
    if (!Number.isFinite(time)) {
      return
    }
    const driver = Number(sample.driver_number)
    if (!Number.isFinite(driver)) {
      return
    }
    const bucket = grouped.get(driver) ?? []
    bucket.push({ x, y, time })
    grouped.set(driver, bucket)
  })

  return Array.from(grouped.entries()).map(([driver, samples]) => ({
    driver,
    samples: samples.sort((a, b) => a.time - b.time)
  }))
}

function computeBounds(timelines: DriverTimeline[]) {
  if (!timelines.length) {
    return null
  }
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  timelines.forEach((timeline) => {
    timeline.samples.forEach((sample) => {
      minX = Math.min(minX, sample.x)
      maxX = Math.max(maxX, sample.x)
      minY = Math.min(minY, sample.y)
      maxY = Math.max(maxY, sample.y)
    })
  })

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null
  }

  return { minX, maxX, minY, maxY }
}

function computePlaybackRange(timelines: DriverTimeline[]) {
  if (!timelines.length) {
    return null
  }

  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY

  timelines.forEach((timeline) => {
    if (timeline.samples.length) {
      start = Math.min(start, timeline.samples[0].time)
      end = Math.max(end, timeline.samples[timeline.samples.length - 1].time)
    }
  })

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null
  }

  return { start, end }
}

function getSampleAtTime(samples: DriverSample[], time: number) {
  let left = 0
  let right = samples.length - 1
  let best: DriverSample | null = null

  while (left <= right) {
    const mid = Math.floor((left + right) / 2)
    const candidate = samples[mid]
    if (candidate.time <= time) {
      best = candidate
      left = mid + 1
    } else {
      right = mid - 1
    }
  }

  return best
}

function pickDriverColor(driver: number) {
  const palette = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#3bc9db', '#4dabf7', '#b197fc', '#f783ac']
  return palette[driver % palette.length]
}

function toNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function formatDuration(ms: number) {
  const clamped = Math.max(0, ms)
  const minutes = Math.floor(clamped / 60000)
  const seconds = Math.floor((clamped % 60000) / 1000)
  const tenths = Math.floor((clamped % 1000) / 100)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`
}

export default RaceReplayer
