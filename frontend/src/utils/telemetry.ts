import type { OpenF1SessionData, TelemetrySample } from '../types';

export interface LapDetail {
  lap_number: number;
  start: string;
  end: string | null;
}

export interface TyreUsageMatrix {
  drivers: number[];
  lapNumbers: number[];
  usage: Record<number, (string | null)[]>;
}

export function deriveLapOptions(
  sessions: Record<string, OpenF1SessionData>,
  selectedSessions: string[],
  preferredDriver: number | null,
  driverMin = 1,
  driverMax = 99
) {
  for (const key of selectedSessions) {
    const session = sessions[key];
    if (!session) {
      continue;
    }

    const priorities = buildDriverPriorityList(preferredDriver, driverMin, driverMax);
    const activeDriver = findDriverWithTelemetry(session.telemetry ?? [], priorities);
    const lapDetails = buildLapDetails(
      session.laps ?? [],
      activeDriver,
      session.sessionInfo?.date_start,
      session.sessionInfo?.date_end
    );

    if (lapDetails.length) {
      return lapDetails.map((lap) => lap.lap_number);
    }
  }

  return [];
}

export function buildDriverPriorityList(
  preferredDriver: number | null,
  driverMin = 1,
  driverMax = 99
) {
  const priorities: number[] = [];
  const seen = new Set<number>();

  const normalized = normalizeDriverNumber(preferredDriver);
  if (
    normalized &&
    normalized >= driverMin &&
    normalized <= driverMax
  ) {
    priorities.push(normalized);
    seen.add(normalized);
  }

  for (let driver = driverMin; driver <= driverMax; driver += 1) {
    if (!seen.has(driver)) {
      priorities.push(driver);
      seen.add(driver);
    }
  }

  return priorities;
}

export function normalizeDriverNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

export function findDriverWithTelemetry(telemetry: TelemetrySample[], priorities: number[]) {
  const driversWithData = new Set<number>();
  telemetry.forEach((record) => {
    const driver = normalizeDriverNumber(record.driver_number);
    if (driver != null) {
      driversWithData.add(driver);
    }
  });

  for (const driver of priorities) {
    if (driversWithData.has(driver)) {
      return driver;
    }
  }

  return priorities[0] ?? null;
}

export function filterTelemetryByDriver(telemetry: TelemetrySample[], driver: number | null) {
  if (!driver) {
    return [];
  }

  return telemetry.filter((record) => normalizeDriverNumber(record.driver_number) === driver);
}

export function buildLapDetails(
  laps: Record<string, unknown>[],
  driver: number | null,
  sessionStart?: string,
  sessionEnd?: string
): LapDetail[] {
  if (!driver || !laps.length) {
    return [];
  }

  const sorted = laps
    .map((lap) => ({
      lap_number: Number(lap.lap_number),
      driver_number: normalizeDriverNumber(lap.driver_number),
      start: typeof lap.date_start === 'string' ? lap.date_start : null,
      duration: typeof lap.lap_duration === 'number' ? lap.lap_duration : null
    }))
    .filter((lap) => lap.driver_number === driver && Number.isFinite(lap.lap_number))
    .sort((a, b) => (a.lap_number as number) - (b.lap_number as number));

  if (!sorted.length) {
    return [];
  }

  const fallbackStartMs = parseTime(sessionStart);
  const fallbackEndMs = parseTime(sessionEnd);
  const result: LapDetail[] = [];
  let previousEndMs = fallbackStartMs;

  sorted.forEach((lap, index) => {
    const startMs = parseTime(lap.start) ?? previousEndMs;
    if (startMs == null) {
      return;
    }

    const nextStartMs = parseTime(sorted[index + 1]?.start);
    let endMs = nextStartMs;

    if (endMs == null && typeof lap.duration === 'number' && Number.isFinite(lap.duration)) {
      endMs = startMs + lap.duration * 1000;
    }

    if (endMs == null) {
      endMs = fallbackEndMs;
    }

    result.push({
      lap_number: lap.lap_number as number,
      start: new Date(startMs).toISOString(),
      end: endMs ? new Date(endMs).toISOString() : null
    });

    previousEndMs = endMs ?? startMs;
  });

  return result;
}

export function selectRecordsForView<T extends Record<string, unknown>>(
  records: T[],
  lapRange: LapDetail | null,
  limit: number
) {
  if (!lapRange) {
    return records.slice(0, limit);
  }

  const targetLap = Number(lapRange.lap_number);
  if (Number.isFinite(targetLap)) {
    const lapFiltered = records.filter((record) => {
      const lapNumber = normalizeDriverNumber((record as Record<string, unknown>).lap_number);
      return lapNumber === targetLap;
    });
    if (lapFiltered.length) {
      return lapFiltered.slice(0, limit);
    }
  }

  const startMs = parseTime(lapRange.start) ?? Number.NEGATIVE_INFINITY;
  const endMs = lapRange.end ? parseTime(lapRange.end) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;

  return records.filter((record) => {
    const timestamp = getRecordTimestamp(record);
    return timestamp != null && timestamp >= startMs && timestamp < endMs;
  });
}

export function parseTime(value?: string | null) {
  if (!value) {
    return null;
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function buildTyreUsageMatrix(
  stints: Record<string, unknown>[],
  laps: Record<string, unknown>[]
): TyreUsageMatrix | null {
  if (!stints.length && !laps.length) {
    return null;
  }

  const lapNumbers = computeLapNumbers(laps, stints);
  const drivers = computeDriverList(stints, laps);

  if (!lapNumbers.length || !drivers.length) {
    return null;
  }

  const usage: Record<number, (string | null)[]> = {};
  const lapIndex = new Map(lapNumbers.map((lap, index) => [lap, index]));

  drivers.forEach((driver) => {
    usage[driver] = Array(lapNumbers.length).fill(null);
  });

  stints.forEach((stint) => {
    const driver = normalizeDriverNumber(stint.driver_number);
    if (driver == null || !usage[driver]) {
      return;
    }

    const start = Number(stint.lap_start) || Number(stint.lap_number);
    const end = Number(stint.lap_end) || start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return;
    }

    const compound = typeof stint.compound === 'string' ? stint.compound.toUpperCase() : null;
    if (!compound) {
      return;
    }

    for (let lap = start; lap <= end; lap += 1) {
      const idx = lapIndex.get(lap);
      if (idx != null) {
        usage[driver][idx] = compound;
      }
    }
  });

  return { drivers, lapNumbers, usage };
}

function computeLapNumbers(
  laps: Record<string, unknown>[],
  stints: Record<string, unknown>[]
) {
  const lapSet = new Set<number>();
  laps.forEach((lap) => {
    const lapNumber = Number(lap.lap_number);
    if (Number.isFinite(lapNumber) && lapNumber > 0) {
      lapSet.add(lapNumber);
    }
  });

  if (!lapSet.size) {
    let maxLap = 0;
    stints.forEach((stint) => {
      const lapEnd = Number(stint.lap_end) || Number(stint.lap_start);
      if (Number.isFinite(lapEnd)) {
        maxLap = Math.max(maxLap, lapEnd);
      }
    });

    return maxLap > 0 ? Array.from({ length: maxLap }, (_, index) => index + 1) : [];
  }

  return Array.from(lapSet).sort((a, b) => a - b);
}

function computeDriverList(
  stints: Record<string, unknown>[],
  laps: Record<string, unknown>[]
) {
  const driverSet = new Set<number>();

  [...stints, ...laps].forEach((entry) => {
    const driver = normalizeDriverNumber(entry.driver_number);
    if (driver != null) {
      driverSet.add(driver);
    }
  });

  return Array.from(driverSet).sort((a, b) => a - b);
}

function getRecordTimestamp(record: Record<string, unknown>) {
  const raw =
    (typeof record.sample_time === 'string' && record.sample_time) ||
    (typeof record.date === 'string' && record.date) ||
    (typeof record.timestamp === 'string' && record.timestamp) ||
    (typeof record.time === 'string' && record.time);

  if (!raw) {
    return null;
  }

  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}
