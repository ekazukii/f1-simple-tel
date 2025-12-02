import { useEffect, useMemo, useRef, useState } from "react";
import "../App.css";
import sessionCatalog from "../data/sessionCatalog.json";
import type { OpenF1SessionData, RaceControlRecord } from "../types";
import { fetchSession } from "../api/sessions";
import type { SessionCatalogEntry } from "../utils/sessionCatalog";
import { buildSessionOptions } from "../utils/sessionCatalog";
import RaceReplayCanvas from "../components/RaceReplayCanvas";
import type { ReplayPoint } from "../components/RaceReplayCanvas";
import ReplayPlayer, { type ReplayEvent } from "../components/ReplayPlayer";
import { getDriverColor } from "../utils/teamColors";
import { getDriverByNumberOnDate } from "../utils/drivers";

const SPEED_PRESETS = [0.1, 0.25, 0.5, 1, 2, 4, 10];

type StatusState = { loading: boolean; error: string | null };

type DriverSample = { x: number; y: number; time: number };

type DriverTimeline = {
  driver: number;
  samples: DriverSample[];
};

type DownloadProgress = {
  progress: number | null;
  receivedBytes: number;
  totalBytes: number | null;
};

export function RaceReplayer() {
  const sessionOptions = useMemo(
    () => buildSessionOptions(sessionCatalog as SessionCatalogEntry[]),
    []
  );
  const [selectedSession, setSelectedSession] = useState<string>(
    sessionOptions[0]?.value ?? ""
  );
  const [session, setSession] = useState<OpenF1SessionData | null>(null);
  const [status, setStatus] = useState<StatusState>({
    loading: false,
    error: null,
  });
  const [speed, setSpeed] = useState<number>(4);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(
    null
  );
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    setStatus({ loading: true, error: null });
    setSession(null);
    setDownloadProgress({ progress: 0, receivedBytes: 0, totalBytes: null });

    fetchSession(selectedSession, {
      signal: abortController.signal,
      onProgress: (update) => {
        if (!cancelled) {
          setDownloadProgress(update);
        }
      },
    })
      .then((data) => {
        if (cancelled) return;
        setSession(data);
        setStatus({ loading: false, error: null });
      })
      .catch((error) => {
        if (cancelled || abortController.signal.aborted) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Failed to load session";
        setStatus({ loading: false, error: message });
      })
      .finally(() => {
        if (!cancelled && !abortController.signal.aborted) {
          setDownloadProgress(null);
        }
      });

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [selectedSession]);

  const timelines = useMemo(() => buildDriverTimelines(session), [session]);
  const trackBounds = useMemo(() => computeBounds(timelines), [timelines]);
  const playbackRange = useMemo(
    () => computePlaybackRange(timelines),
    [timelines]
  );
  const raceEvents = useMemo<ReplayEvent[]>(
    () => buildRaceEvents(session, playbackRange),
    [session, playbackRange]
  );
  const lastGreenEventTime = useMemo(() => {
    const greenEvents = raceEvents.filter((event) => event.type === "green");
    if (!greenEvents.length) {
      return null;
    }
    return greenEvents[greenEvents.length - 1].time;
  }, [raceEvents]);

  useEffect(() => {
    if (!playbackRange) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        setIsPlaying((prev) => !prev);
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        setCurrentTime((prev) => Math.min(prev + 30000, playbackRange.end));
      } else if (event.code === "ArrowLeft") {
        event.preventDefault();
        setCurrentTime((prev) => Math.max(prev - 30000, playbackRange.start));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playbackRange]);

  useEffect(() => {
    if (!playbackRange) {
      setCurrentTime(0);
      setIsPlaying(false);
      return;
    }
    const targetTime = lastGreenEventTime ?? playbackRange.start;
    setCurrentTime(targetTime);
    setIsPlaying(false);
  }, [playbackRange, lastGreenEventTime]);

  useEffect(() => {
    if (!isPlaying || !playbackRange) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      return;
    }

    let lastTs = performance.now();

    const tick = (now: number) => {
      const delta = now - lastTs;
      lastTs = now;
      setCurrentTime((prev) => {
        const next = Math.min(prev + delta * speed, playbackRange.end);
        if (next >= playbackRange.end) {
          setIsPlaying(false);
          return playbackRange.end;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [isPlaying, speed, playbackRange]);

  const replayPoints = useMemo<ReplayPoint[]>(() => {
    if (!playbackRange || !trackBounds) {
      return [];
    }
    return timelines
      .map((timeline) => {
        const sample = getSampleAtTime(timeline.samples, currentTime);
        if (!sample) {
          return null;
        }
        return {
          driver: timeline.driver,
          x: sample.x,
          y: sample.y,
          color: getDriverColor(timeline.driver),
          label: buildDriverLabel(
            timeline.driver,
            session?.sessionInfo?.date_start
          ),
        };
      })
      .filter((point): point is ReplayPoint => Boolean(point));
  }, [
    timelines,
    currentTime,
    trackBounds,
    playbackRange,
    session?.sessionInfo?.date_start,
  ]);

  const durationLabel = useMemo(
    () =>
      playbackRange
        ? formatDuration(currentTime - playbackRange.start)
        : "00:00.0",
    [currentTime, playbackRange]
  );

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
      {session && trackBounds ? (
        <section className="race-replay-panel">
          <RaceReplayCanvas points={replayPoints} bounds={trackBounds} />
          <div className="race-replay-controls">
            <div className="playback-controls">
              <div className="playback-time">
                <strong>{durationLabel}</strong>
                {playbackRange && (
                  <small>
                    / {formatDuration(playbackRange.end - playbackRange.start)}
                  </small>
                )}
              </div>
            </div>
            {playbackRange && (
              <ReplayPlayer
                range={playbackRange}
                currentTime={currentTime}
                onTimeChange={setCurrentTime}
                speed={speed}
                speedOptions={SPEED_PRESETS}
                onSpeedChange={setSpeed}
                events={raceEvents}
                isPlaying={isPlaying}
                onTogglePlay={() => setIsPlaying((prev) => !prev)}
              />
            )}
          </div>
        </section>
      ) : status.loading ? (
        <section className="race-replay-panel">
          <div className="race-replay-canvas race-replay-canvas--loading">
            <div
              className={`race-replay-progress${
                downloadProgress?.progress == null ? " is-indeterminate" : ""
              }`}
              aria-label="Downloading telemetry"
            >
              <div
                className={`race-replay-progress__bar${
                  downloadProgress?.progress == null ? " is-indeterminate" : ""
                }`}
                style={
                  downloadProgress?.progress != null
                    ? { width: `${Math.max(downloadProgress.progress * 100, 1)}%` }
                    : undefined
                }
              />
            </div>
            <p className="muted">
              {downloadProgress?.totalBytes
                ? `Downloading ${formatBytes(downloadProgress.receivedBytes)} / ${formatBytes(downloadProgress.totalBytes)}`
                : downloadProgress
                ? `Downloaded ${formatBytes(downloadProgress.receivedBytes)}`
                : "Preparing download…"}
            </p>
          </div>
        </section>
      ) : (
        <div className="race-replayer__empty">
          <p className="muted">Select a session to start the replay.</p>
        </div>
      )}
    </main>
  );
}

function buildDriverTimelines(
  session: OpenF1SessionData | null
): DriverTimeline[] {
  if (!session) {
    return [];
  }

  const grouped = new Map<number, DriverSample[]>();

  session.telemetry?.forEach((sample) => {
    const x = toNumber(sample.x);
    const y = toNumber(sample.y);
    if (x == null || y == null) {
      return;
    }
    const time = Date.parse(sample.sample_time);
    if (!Number.isFinite(time)) {
      return;
    }
    const driver = Number(sample.driver_number);
    if (!Number.isFinite(driver)) {
      return;
    }
    const bucket = grouped.get(driver) ?? [];
    bucket.push({ x, y, time });
    grouped.set(driver, bucket);
  });

  return Array.from(grouped.entries()).map(([driver, samples]) => ({
    driver,
    samples: samples.sort((a, b) => a.time - b.time),
  }));
}

function computeBounds(timelines: DriverTimeline[]) {
  if (!timelines.length) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  timelines.forEach((timeline) => {
    timeline.samples.forEach((sample) => {
      minX = Math.min(minX, sample.x);
      maxX = Math.max(maxX, sample.x);
      minY = Math.min(minY, sample.y);
      maxY = Math.max(maxY, sample.y);
    });
  });

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null;
  }

  return { minX, maxX, minY, maxY };
}

function computePlaybackRange(timelines: DriverTimeline[]) {
  if (!timelines.length) {
    return null;
  }

  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;

  timelines.forEach((timeline) => {
    if (timeline.samples.length) {
      start = Math.min(start, timeline.samples[0].time);
      end = Math.max(end, timeline.samples[timeline.samples.length - 1].time);
    }
  });

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  return { start, end };
}

function getSampleAtTime(samples: DriverSample[], time: number) {
  let left = 0;
  let right = samples.length - 1;
  let best: DriverSample | null = null;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const candidate = samples[mid];
    if (candidate.time <= time) {
      best = candidate;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return best;
}

function toNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatDuration(ms: number) {
  const clamped = Math.max(0, ms);
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const tenths = Math.floor((clamped % 1000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}.${tenths}`;
}

function buildDriverLabel(driver: number, sessionDate?: string | null) {
  const info = sessionDate
    ? getDriverByNumberOnDate(driver, sessionDate)
    : getDriverByNumberOnDate(driver, new Date());
  if (!info) {
    return `#${driver}`;
  }
  return `#${driver} ${info.firstName} ${info.lastName}`;
}

function buildRaceEvents(
  session: OpenF1SessionData | null,
  playbackRange: { start: number; end: number } | null
): ReplayEvent[] {
  if (!session || !playbackRange) {
    return [];
  }
  const duration = playbackRange.end - playbackRange.start;
  if (duration <= 0) {
    return [];
  }

  return session.raceControl
    .map((record, index) => {
      const type = classifyRaceControlEvent(record);
      if (!type) {
        return null;
      }
      const time = Date.parse(record.event_time);
      if (!Number.isFinite(time)) {
        return null;
      }
      if (time < playbackRange.start || time > playbackRange.end) {
        return null;
      }
      return {
        id: `${type}-${time}-${index}`,
        time,
        label: buildRaceEventLabel(type, record),
        type,
      };
    })
    .filter((event): event is ReplayEvent => Boolean(event))
    .sort((a, b) => a.time - b.time);
}

function classifyRaceControlEvent(
  record: RaceControlRecord
): ReplayEvent["type"] | null {
  const flag = normalizeRaceControlValue(record.flag);
  const message = normalizeRaceControlValue(record.message);

  if (flag === "GREEN" || message.includes("GREEN FLAG")) {
    return "green";
  }
  if (flag === "RED" || message.includes("RED FLAG")) {
    return "red";
  }
  if (message.includes("VIRTUAL SAFETY CAR") && message.includes("DEPLOYED")) {
    return "virtual-safety-car";
  }
  if (message.includes("SAFETY CAR") && message.includes("DEPLOYED")) {
    return "safety-car";
  }
  return null;
}

function buildRaceEventLabel(
  type: ReplayEvent["type"],
  record: RaceControlRecord
) {
  const lap =
    typeof record.lap_number === "number" && Number.isFinite(record.lap_number)
      ? ` (Lap ${record.lap_number})`
      : "";
  switch (type) {
    case "safety-car":
      return `Safety Car${lap}`;
    case "virtual-safety-car":
      return `Virtual Safety Car${lap}`;
    case "red":
      return `Red Flag${lap}`;
    default:
      return `Green Flag${lap}`;
  }
}

function normalizeRaceControlValue(value: string | null | undefined) {
  return value ? value.toUpperCase() : "";
}

function formatBytes(bytes: number | null) {
  if (!bytes || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export default RaceReplayer;
