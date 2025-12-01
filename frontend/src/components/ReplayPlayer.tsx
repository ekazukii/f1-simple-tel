import { useEffect, useMemo, useRef, useState } from 'react'

export type ReplayEventType = 'safety-car' | 'virtual-safety-car' | 'green' | 'red'

export interface ReplayEvent {
  id: string
  time: number
  label: string
  type: ReplayEventType
}

interface ReplayPlayerProps {
  range: { start: number; end: number }
  currentTime: number
  onTimeChange: (time: number) => void
  speed: number
  speedOptions: number[]
  onSpeedChange: (speed: number) => void
  events: ReplayEvent[]
  isPlaying: boolean
  onTogglePlay: () => void
}

export default function ReplayPlayer({
  range,
  currentTime,
  onTimeChange,
  speed,
  speedOptions,
  onSpeedChange,
  events,
  isPlaying,
  onTogglePlay
}: ReplayPlayerProps) {
  const duration = Math.max(0, range.end - range.start)
  const relativeTime = clamp(currentTime - range.start, 0, duration)
  const progress = duration > 0 ? (relativeTime / duration) * 100 : 0

  const decoratedEvents = useMemo(() => {
    if (!duration) {
      return []
    }
    return events
      .filter((event) => event.time >= range.start && event.time <= range.end)
      .sort((a, b) => a.time - b.time)
      .map((event) => ({
        ...event,
        position: clamp(((event.time - range.start) / duration) * 100, 0, 100),
        alignment: event.type === 'safety-car' || event.type === 'virtual-safety-car' ? 'top' : 'bottom'
      }))
  }, [events, duration, range.end, range.start])

  const selectRef = useRef<HTMLDivElement>(null)
  const [speedDropdownOpen, setSpeedDropdownOpen] = useState(false)

  useEffect(() => {
    if (!speedDropdownOpen) {
      return
    }
    const handle = (event: MouseEvent) => {
      if (selectRef.current?.contains(event.target as Node)) {
        return
      }
      setSpeedDropdownOpen(false)
    }
    document.addEventListener('pointerdown', handle)
    return () => {
      document.removeEventListener('pointerdown', handle)
    }
  }, [speedDropdownOpen])

  const handleSpeedChange = (nextSpeed: number) => {
    onSpeedChange(nextSpeed)
    setSpeedDropdownOpen(false)
  }

  const handleTimeChange = (nextRelative: number) => {
    const next = clamp(nextRelative, 0, duration)
    onTimeChange(range.start + next)
  }

  return (
    <div className="replay-player">
      <div className="replay-player__scrubber">
        <button
          type="button"
          className="replay-player__play"
          onClick={onTogglePlay}
          disabled={!duration}
          aria-label={isPlaying ? 'Pause replay' : 'Play replay'}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="replay-player__timeline">
          <div className="replay-player__track" aria-hidden="true">
            <div className="replay-player__track-line" />
            <div className="replay-player__progress" style={{ width: `${progress}%` }} />
            <div className="replay-player__thumb" style={{ left: `${progress}%` }} />
            {decoratedEvents.map((event) => (
              <div
                key={event.id}
                className={`replay-player__event replay-player__event--${event.type} replay-player__event--${event.alignment}`}
                style={{ left: `${event.position}%` }}
              >
                <span className="replay-player__event-marker" />
                <span className="replay-player__event-label">{event.label}</span>
              </div>
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={16}
            value={relativeTime}
            onChange={(event) => handleTimeChange(Number(event.target.value))}
            className="replay-player__range-input"
            aria-label="Replay position"
            disabled={!duration}
          />
        </div>
        <div className="replay-player__speed" ref={selectRef}>
          <button
            type="button"
            className={`replay-player__speed-button${speedDropdownOpen ? ' is-open' : ''}`}
            onClick={() => setSpeedDropdownOpen((open) => !open)}
          >
            {speed}
            <span className="replay-player__speed-unit">×</span>
            <span aria-hidden className="replay-player__speed-caret" />
          </button>
          {speedDropdownOpen && (
            <ul className="replay-player__speed-options">
              {speedOptions.map((option) => (
                <li key={option}>
                  <button
                    type="button"
                    className={`replay-player__speed-option${option === speed ? ' is-active' : ''}`}
                    onClick={() => handleSpeedChange(option)}
                  >
                    {option}×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function clamp(value: number, min: number, max: number) {
  if (value < min) return min
  if (value > max) return max
  return value
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M6 4l14 8-14 8z" fill="currentColor" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor" />
    </svg>
  )
}
