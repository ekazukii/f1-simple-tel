import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { TelemetryCanvas } from './components/TelemetryCanvas';
import { SessionInsights } from './components/SessionInsights';
import { DriverCompare } from './components/DriverCompare';
import type { OpenF1SessionData } from './types';
import {
  attachSpeedToLocations,
  buildDriverPriorityList,
  buildLapDetails,
  deriveLapOptions,
  filterCarDataByDriver,
  filterLocationsByDriver,
  findDriverWithLocations,
  selectRecordsForView
} from './utils/telemetry';

const SESSION_OPTIONS = [
  { label: 'Latest', value: 'latest', description: 'Most recent session available from the backend cache' }
];

const BACKEND_BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const MAX_DRIVER_POINTS = 1000;
const DRIVER_MIN = 1;
const DRIVER_MAX = 99;

type SessionState = Record<string, OpenF1SessionData>;

type StatusState = { loading: boolean; error: string | null };

function App() {
  const [selectedSessions, setSelectedSessions] = useState<string[]>(['latest']);
  const [sessions, setSessions] = useState<SessionState>({});
  const [status, setStatus] = useState<StatusState>({ loading: false, error: null });
  const [preferredDriver, setPreferredDriver] = useState<number | null>(1);
  const [selectedLap, setSelectedLap] = useState<number | null>(null);
  const pendingSignature = useRef<string | null>(null);
  const completedSignature = useRef<string | null>(null);

  useEffect(() => {
    let isCancelled = false;
    const signature = selectedSessions.join('|');

    async function loadSessions() {
      if (!signature) {
        setSessions({});
        setStatus({ loading: false, error: null });
        pendingSignature.current = null;
        completedSignature.current = null;
        return;
      }

      if (completedSignature.current === signature) {
        setStatus((prev) => ({ ...prev, loading: false }));
        return;
      }

      if (pendingSignature.current === signature) {
        return;
      }

      pendingSignature.current = signature;
      setStatus({ loading: true, error: null });

      try {
        const results = await Promise.all(
          selectedSessions.map(async (sessionKey) => {
            const data = await fetchSession(sessionKey);
            return [sessionKey, data] as const;
          })
        );

        if (isCancelled) {
          return;
        }

        setSessions(Object.fromEntries(results));
        setStatus({ loading: false, error: null });
        completedSignature.current = signature;
      } catch (error) {
        if (isCancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Failed to fetch session data';
        setStatus({ loading: false, error: message });
      } finally {
        if (!isCancelled && pendingSignature.current === signature) {
          pendingSignature.current = null;
        }
      }
    }

    loadSessions();

    return () => {
      isCancelled = true;
      if (pendingSignature.current === signature) {
        pendingSignature.current = null;
      }
    };
  }, [selectedSessions]);

  const lapOptions = useMemo(
    () => deriveLapOptions(sessions, selectedSessions, preferredDriver, DRIVER_MIN, DRIVER_MAX),
    [sessions, selectedSessions, preferredDriver]
  );

  useEffect(() => {
    if (!lapOptions.length) {
      setSelectedLap(null);
      return;
    }

    if (selectedLap == null || !lapOptions.includes(selectedLap)) {
      setSelectedLap(lapOptions[0]);
    }
  }, [lapOptions, selectedLap]);

  const handleSessionChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const values = Array.from(event.target.selectedOptions).map((option) => option.value);
    setSelectedSessions(values);
  };

  const handleDriverChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    if (value === '') {
      setPreferredDriver(null);
      return;
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return;
    }

    const clamped = Math.max(DRIVER_MIN, Math.min(DRIVER_MAX, Math.round(numeric)));
    setPreferredDriver(clamped);
  };

  const handleLapChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setSelectedLap(value === '' ? null : Number(value));
  };

  const renderedSessions = useMemo(
    () =>
      selectedSessions.map((key) => {
        const data = sessions[key];
        return (
          <SessionPanel
            key={key}
            sessionKey={key}
            data={data}
            loading={status.loading && !data}
            preferredDriver={preferredDriver}
            selectedLap={selectedLap}
          />
        );
      }),
    [selectedSessions, sessions, status.loading, preferredDriver, selectedLap]
  );

  return (
    <main className="app">
      <header className="toolbar">
        <div>
          <p className="eyebrow">Formula 1 telemetry</p>
          <h1>Session explorer</h1>
        </div>
        <div className="control-stack">
          <div className="session-picker">
            <label htmlFor="session-select">Choose sessions</label>
            <select id="session-select" multiple value={selectedSessions} onChange={handleSessionChange}>
              {SESSION_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>Hold Cmd/Ctrl to select multiple sessions. Currently only “Latest” is available.</small>
          </div>
          <div className="driver-picker">
            <label htmlFor="driver-input">Driver number</label>
            <input
              id="driver-input"
              type="number"
              min={DRIVER_MIN}
              max={DRIVER_MAX}
              value={preferredDriver ?? ''}
              onChange={handleDriverChange}
            />
            <small>Prefer this driver’s telemetry. Falls back automatically.</small>
          </div>
          <div className="lap-picker">
            <label htmlFor="lap-select">Lap</label>
            <select id="lap-select" value={selectedLap ?? ''} onChange={handleLapChange} disabled={!lapOptions.length}>
              {lapOptions.map((lap) => (
                <option value={lap} key={lap}>
                  Lap {lap}
                </option>
              ))}
            </select>
            <small>Shows only the selected lap’s telemetry when available.</small>
          </div>
        </div>
      </header>

      {status.error && <div className="status error">{status.error}</div>}
      {status.loading && <div className="status info">Loading session data…</div>}

      <div className="session-grid">{renderedSessions}</div>
    </main>
  );
}

interface SessionPanelProps {
  sessionKey: string;
  data?: OpenF1SessionData;
  loading?: boolean;
  preferredDriver: number | null;
  selectedLap: number | null;
}

function SessionPanel({ sessionKey, data, loading, preferredDriver, selectedLap }: SessionPanelProps) {
  if (!data) {
    return (
      <section className="session-panel">
        <header>
          <h2>Session {sessionKey}</h2>
          {loading ? <p className="muted">Loading telemetry…</p> : <p className="muted">No data available.</p>}
        </header>
      </section>
    );
  }

  const { sessionInfo } = data;
  const driverPriorities = useMemo(
    () => buildDriverPriorityList(preferredDriver, DRIVER_MIN, DRIVER_MAX),
    [preferredDriver]
  );
  const activeDriver = useMemo(() => findDriverWithLocations(data.locations ?? [], driverPriorities), [data.locations, driverPriorities]);
  const driverLocations = useMemo(
    () => filterLocationsByDriver(data.locations ?? [], activeDriver),
    [data.locations, activeDriver]
  );
  const driverCarData = useMemo(
    () => filterCarDataByDriver(data.carData ?? [], activeDriver),
    [data.carData, activeDriver]
  );
  const lapDetails = useMemo(
    () => buildLapDetails(data.laps ?? [], activeDriver, sessionInfo?.date_start, sessionInfo?.date_end),
    [data.laps, activeDriver, sessionInfo?.date_start, sessionInfo?.date_end]
  );
  const effectiveLapNumber = useMemo(() => {
    if (!lapDetails.length) {
      return null;
    }
    if (selectedLap && lapDetails.some((lap) => lap.lap_number === selectedLap)) {
      return selectedLap;
    }
    return lapDetails[0].lap_number;
  }, [lapDetails, selectedLap]);
  const lapRange = useMemo(
    () => lapDetails.find((lap) => lap.lap_number === effectiveLapNumber) ?? null,
    [lapDetails, effectiveLapNumber]
  );

  const displayedLocations = useMemo(() => {
    if (!driverLocations.length) {
      return [];
    }

    const filteredLocations = selectRecordsForView(driverLocations, lapRange, MAX_DRIVER_POINTS);
    const filteredCarData = selectRecordsForView(driverCarData, lapRange, MAX_DRIVER_POINTS);

    return attachSpeedToLocations(filteredLocations, filteredCarData);
  }, [driverLocations, driverCarData, lapRange]);

  const startDate = formatDate(sessionInfo?.date_start);
  const endDate = formatDate(sessionInfo?.date_end);

  return (
    <section className="session-panel">
      <header>
        <h2>
          {sessionInfo?.session_name ?? 'Session'} <span className="muted">#{sessionInfo?.session_key ?? sessionKey}</span>
        </h2>
        <p className="muted">
          {sessionInfo?.location ?? '—'} · {sessionInfo?.country_name ?? ''}
        </p>
        <p className="muted">
          {startDate} — {endDate}
        </p>
        {lapRange && (
          <p className="muted">
            Showing lap {effectiveLapNumber} ({formatDate(lapRange.start)} → {lapRange.end ? formatDate(lapRange.end) : 'end of session'})
          </p>
        )}
      </header>

      <TelemetryCanvas points={displayedLocations} />
      <DriverCompare session={data} selectedLap={effectiveLapNumber} preferredDriver={preferredDriver} />
      <SessionInsights session={data} activeDriver={activeDriver} />
    </section>
  );
}

async function fetchSession(sessionKey: string): Promise<OpenF1SessionData> {
  const response = await fetch(`${BACKEND_BASE_URL}/session/${encodeURIComponent(sessionKey)}`);
  if (!response.ok) {
    throw new Error(`Backend request failed with status ${response.status}`);
  }
  return (await response.json()) as OpenF1SessionData;
}

function formatDate(value?: string | null) {
  if (!value) {
    return 'Unknown time';
  }

  try {
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value));
  } catch (error) {
    return value;
  }
}

export default App;
