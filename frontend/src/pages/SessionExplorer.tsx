import { useEffect, useMemo, useRef, useState } from 'react';
import Select, { type SingleValue, type StylesConfig } from 'react-select';
import sharedStyles from '../styles/Shared.module.css';
import styles from '../styles/SessionExplorer.module.css';
import { TelemetryCanvas } from '../components/TelemetryCanvas';
import { SessionInsights } from '../components/SessionInsights';
import { DriverCompare } from '../components/DriverCompare';
import type { OpenF1SessionData } from '../types';
import { fetchSession } from '../api/sessions';
import {
  buildDriverPriorityList,
  buildLapDetails,
  deriveLapOptions,
  filterTelemetryByDriver,
  findDriverWithTelemetry,
  normalizeDriverNumber,
  selectRecordsForView
} from '../utils/telemetry';
import { getDriverHistory } from '../utils/drivers';
import sessionCatalog from '../data/sessionCatalog.json';
import type { SessionCatalogEntry } from '../utils/sessionCatalog';
import { buildSessionOptions } from '../utils/sessionCatalog';
const MAX_DRIVER_POINTS = 1000;
const DRIVER_MIN = 1;
const DRIVER_MAX = 99;
const cx = (...names: string[]) =>
  names
    .map((n) => styles[n] || sharedStyles[n])
    .filter(Boolean)
    .join(' ');

interface DriverOption {
  value: number;
  label: string;
}

type SessionState = Record<string, OpenF1SessionData>;

type StatusState = { loading: boolean; error: string | null };

function SessionExplorer() {
  const sessionOptions = useMemo(() => buildSessionOptions(sessionCatalog as SessionCatalogEntry[]), []);
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionState>({});
  const [status, setStatus] = useState<StatusState>({ loading: false, error: null });
  const [preferredDriver, setPreferredDriver] = useState<number | null>(1);
  const [selectedLap, setSelectedLap] = useState<number | null>(null);
  const pendingSignature = useRef<string | null>(null);
  const completedSignature = useRef<string | null>(null);

  const driverOptions = useMemo<DriverOption[]>(() => {
    const sessionDrivers = new Set<number>();
    selectedSessions.forEach((key) => {
      const session = sessions[key];
      if (!session) return;
      [...(session.telemetry ?? []), ...(session.laps ?? []), ...(session.stints ?? [])].forEach((record) => {
        const driver = normalizeDriverNumber((record as Record<string, unknown>).driver_number);
        if (driver != null) sessionDrivers.add(driver);
      });
    });

    const latestByNumber = new Map<number, { number: number; label: string; startYear: number }>();
    const history = getDriverHistory();

    history.forEach((entry) => {
      if (sessionDrivers.size && !sessionDrivers.has(entry.number)) {
        return;
      }

      const existing = latestByNumber.get(entry.number);
      if (!existing || entry.startYear > existing.startYear) {
        latestByNumber.set(entry.number, {
          number: entry.number,
          label: `#${entry.number} — ${entry.firstName} ${entry.lastName}`,
          startYear: entry.startYear
        });
      }
    });

    if (sessionDrivers.size) {
      sessionDrivers.forEach((driver) => {
        if (!latestByNumber.has(driver)) {
          latestByNumber.set(driver, {
            number: driver,
            label: `#${driver}`,
            startYear: 0
          });
        }
      });
    }

    return Array.from(latestByNumber.values())
      .sort((a, b) => a.number - b.number)
      .map(({ number, label }) => ({ value: number, label }));
  }, [sessions, selectedSessions]);

  const driverSelectStyles = useMemo<StylesConfig<DriverOption, false>>(
    () => ({
      control: (base, state) => ({
        ...base,
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        borderColor: state.isFocused ? '#4563ff' : '#2e3560',
        boxShadow: state.isFocused ? '0 0 0 2px rgba(69, 99, 255, 0.2)' : 'none',
        minHeight: 42,
        color: '#e7eaf4',
        borderRadius: 12
      }),
      menu: (base) => ({
        ...base,
        backgroundColor: 'rgba(8, 11, 25, 0.95)',
        border: '1px solid #2e3560',
        boxShadow: '0 12px 30px rgba(0, 0, 0, 0.35)',
        color: '#e7eaf4',
        marginTop: 4,
        borderRadius: 12,
        overflow: 'hidden'
      }),
      option: (base, state) => ({
        ...base,
        backgroundColor: state.isSelected ? '#4563ff' : state.isFocused ? '#182040' : 'transparent',
        color: state.isSelected ? '#fff' : '#e7eaf4',
        cursor: 'pointer'
      }),
      singleValue: (base) => ({ ...base, color: '#e7eaf4' }),
      input: (base) => ({ ...base, color: '#e7eaf4' }),
      placeholder: (base) => ({ ...base, color: '#9ea7c8' }),
      dropdownIndicator: (base, state) => ({
        ...base,
        color: state.isFocused ? '#ffffff' : '#9ea7c8'
      }),
      clearIndicator: (base, state) => ({
        ...base,
        color: state.isFocused ? '#ffffff' : '#9ea7c8'
      }),
      indicatorSeparator: (base) => ({ ...base, backgroundColor: '#1d2033' }),
      valueContainer: (base) => ({ ...base, padding: '4px 10px' })
    }),
    []
  );

  useEffect(() => {
    if (!selectedSessions.length && sessionOptions.length) {
      setSelectedSessions([sessionOptions[0].value]);
    }
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
            const data = await fetchSession(sessionKey, { sampleSeconds: 1 });
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
  }, [selectedSessions, sessionOptions]);

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

  const handleLapChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setSelectedLap(value === '' ? null : Number(value));
  };

  const handleDriverSelect = (option: SingleValue<DriverOption>) => {
    setPreferredDriver(option ? option.value : null);
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
    <main className={cx('app')}>
      <header className={cx('toolbar')}>
        <div>
          <p className={cx('eyebrow')}>Formula 1 telemetry</p>
          <h1>Session explorer</h1>
        </div>
        <div className={cx('control-stack')}>
          <div className={cx('session-picker')}>
            <label htmlFor="session-select">Choose sessions</label>
            <select id="session-select" multiple value={selectedSessions} onChange={handleSessionChange}>
              {sessionOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>Hold Cmd/Ctrl to select multiple sessions.</small>
          </div>
          <div className={cx('driver-picker')}>
            <label htmlFor="driver-input">Driver number</label>
            <Select
              inputId="driver-input"
              classNamePrefix="driver-select"
              className={cx('driver-select-container')}
              options={driverOptions}
              isClearable
              placeholder="Search driver by number or name"
              value={driverOptions.find((opt) => opt.value === preferredDriver) ?? null}
              onChange={handleDriverSelect}
              menuPlacement="auto"
              styles={driverSelectStyles}
            />
            <small>Prefer this driver’s telemetry. Type to search or pick from the list.</small>
          </div>
          <div className={cx('lap-picker')}>
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

      {status.error && <div className={cx('status', 'error')}>{status.error}</div>}
      {status.loading && <div className={cx('status', 'info')}>Loading session data…</div>}

      <div className={cx('session-grid')}>{renderedSessions}</div>
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
      <section className={cx('session-panel')}>
        <header>
          <h2>Session {sessionKey}</h2>
          {loading ? <p className={cx('muted')}>Loading telemetry…</p> : <p className={cx('muted')}>No data available.</p>}
        </header>
      </section>
    );
  }

  const { sessionInfo } = data;
  const driverPriorities = useMemo(
    () => buildDriverPriorityList(preferredDriver, DRIVER_MIN, DRIVER_MAX),
    [preferredDriver]
  );
  const activeDriver = useMemo(
    () => findDriverWithTelemetry(data.telemetry ?? [], driverPriorities),
    [data.telemetry, driverPriorities]
  );
  const driverTelemetry = useMemo(
    () => filterTelemetryByDriver(data.telemetry ?? [], activeDriver),
    [data.telemetry, activeDriver]
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

  const displayedTelemetry = useMemo(() => {
    if (!driverTelemetry.length) {
      return [];
    }

    const slice = selectRecordsForView(driverTelemetry, lapRange, MAX_DRIVER_POINTS);
    if (slice.length) {
      const first = slice[0];
      const last = slice[slice.length - 1];
      const middle = slice[Math.floor(slice.length / 2)];
      // eslint-disable-next-line no-console
      console.log('[Telemetry]', sessionKey, 'driver', activeDriver, {
        first,
        middle,
        last
      });
    }
    return slice;
  }, [driverTelemetry, lapRange, sessionKey, activeDriver]);

  const startDate = formatDate(sessionInfo?.date_start);
  const endDate = formatDate(sessionInfo?.date_end);

  return (
    <section className={cx('session-panel')}>
      <header>
        <h2>
          {sessionInfo?.session_name ?? 'Session'} <span className={cx('muted')}>#{sessionInfo?.session_key ?? sessionKey}</span>
        </h2>
        <p className={cx('muted')}>
          {sessionInfo?.location ?? '—'} · {sessionInfo?.country_name ?? ''}
        </p>
        <p className={cx('muted')}>
          {startDate} — {endDate}
        </p>
        {lapRange && (
          <p className={cx('muted')}>
            Showing lap {effectiveLapNumber} ({formatDate(lapRange.start)} → {lapRange.end ? formatDate(lapRange.end) : 'end of session'})
          </p>
        )}
      </header>

      <TelemetryCanvas points={displayedTelemetry} />
      <DriverCompare session={data} selectedLap={effectiveLapNumber} preferredDriver={preferredDriver} />
      <SessionInsights session={data} activeDriver={activeDriver} />
    </section>
  );
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

export default SessionExplorer;
