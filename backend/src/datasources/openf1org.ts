import axios, { AxiosError } from "axios";

const OPENF1_BASE_URL = "https://api.openf1.org/v1";
const TIME_SLICE_COUNT = 30;

const client = axios.create({
  baseURL: OPENF1_BASE_URL,
  timeout: 15000,
});

type ApiRecord = Record<string, unknown>;

export interface OpenF1SessionMeta extends ApiRecord {
  circuit_key: number;
  circuit_short_name: string;
  country_code: string;
  country_key: number;
  country_name: string;
  date_end: string;
  date_start: string;
  gmt_offset: string;
  location: string;
  meeting_key: number;
  session_key: number;
  session_name: string;
  session_type: string;
  year: number;
}

export interface OpenF1SessionData {
  sessionKey: string;
  sessionInfo: OpenF1SessionMeta;
  carData: ApiRecord[];
  locations: ApiRecord[];
  pitStops: ApiRecord[];
  raceControl: ApiRecord[];
  stints: ApiRecord[];
  laps: ApiRecord[];
}

async function fetchCollection<T extends ApiRecord>(
  endpoint: string,
  params: Record<string, string | number>,
  maxAttempts = 5
): Promise<T[]> {
  const path = `/${endpoint.replace(/^\/+/, "")}`;
  const fullUrl = buildFullUrl(path, params);
  console.log(`[OpenF1] GET ${fullUrl}`);

  let attempt = 0;
  let lastError: AxiosError | null = null;

  while (attempt < maxAttempts) {
    try {
      const response = await client.get<T[]>(path, { params });
      const status = response.status;
      const length = Array.isArray(response.data)
        ? response.data.length
        : "unknown";
      console.log(`[OpenF1] GET ${fullUrl} -> ${status} (${length} rows)`);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      lastError = axiosError;
      const status = axiosError?.response?.status ?? "ERR";
      const shouldRetry =
        status === 429 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        status === "ERR";

      attempt += 1;
      const message =
        axiosError?.message ??
        (error instanceof Error
          ? error.message
          : "Unknown error while contacting openf1.org");

      if (!shouldRetry || attempt >= maxAttempts) {
        console.error(
          `[OpenF1] GET ${fullUrl} -> ${status} FAILED after ${attempt} attempts: ${message}`
        );
        throw new Error(`Failed to fetch ${endpoint}: ${message}`);
      }

      const backoffBase = 500; // ms
      const delay = Math.min(8000, backoffBase * 2 ** (attempt - 1));
      const jitter = Math.random() * 250;
      console.warn(
        `[OpenF1] ${status} for ${fullUrl} (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(
          delay + jitter
        )}ms`
      );
      await sleep(delay + jitter);
    }
  }

  throw new Error(
    `Failed to fetch ${endpoint}: ${lastError?.message ?? "Unknown error"}`
  );
}

function buildFullUrl(path: string, params: Record<string, string | number>) {
  const base = OPENF1_BASE_URL.replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

async function fetchSessionMetadata(
  sessionKey: string
): Promise<OpenF1SessionMeta> {
  const sessions = await fetchCollection<OpenF1SessionMeta>("sessions", {
    session_key: sessionKey,
  });

  if (!sessions.length) {
    throw new Error(`No session metadata found for session_key=${sessionKey}`);
  }

  return sessions[0];
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTimeSlicedSeries(
  endpoint: string,
  sessionKey: string,
  slices: Array<{ from: string; to: string }>
): Promise<ApiRecord[]> {
  const combined: ApiRecord[] = [];

  for (const slice of slices) {
    const data = await fetchCollection<ApiRecord>(endpoint, {
      session_key: sessionKey,
      "date>": slice.from,
      "date<": slice.to,
    });

    await sleep(200);

    if (data.length > 0) {
      combined.push(...data);
    }
  }

  return combined;
}

export async function fetchOpenF1Session(
  sessionKey: string
): Promise<OpenF1SessionData> {
  const sessionInfo = await fetchSessionMetadata(sessionKey);
  const slices = createTimeSlices(
    sessionInfo.date_start,
    sessionInfo.date_end,
    TIME_SLICE_COUNT
  );

  const carData = await fetchTimeSlicedSeries("car_data", sessionKey, slices);
  const locations = await fetchTimeSlicedSeries("location", sessionKey, slices);

  const [pitStops, raceControl, stints, laps] = await Promise.all([
    fetchCollection<ApiRecord>("pit", { session_key: sessionKey }),
    fetchCollection<ApiRecord>("race_control", { session_key: sessionKey }),
    fetchCollection<ApiRecord>("stints", { session_key: sessionKey }),
    fetchCollection<ApiRecord>("laps", { session_key: sessionKey }),
  ]);

  return {
    sessionKey,
    sessionInfo,
    carData,
    locations,
    pitStops,
    raceControl,
    stints,
    laps,
  };
}

function createTimeSlices(
  dateStart: string,
  dateEnd: string,
  sliceCount: number
) {
  const startMs = Date.parse(dateStart);
  const endMs = Date.parse(dateEnd);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error(
      `Invalid session date range: start=${dateStart} end=${dateEnd}`
    );
  }

  if (endMs <= startMs) {
    const iso = new Date(startMs).toISOString();
    return [{ from: iso, to: iso }];
  }

  const buckets = Math.max(1, sliceCount);
  const delta = (endMs - startMs) / buckets;
  const slices: Array<{ from: string; to: string }> = [];

  for (let i = 0; i < buckets; i += 1) {
    const fromMs = startMs + delta * i;
    const toMs = i === buckets - 1 ? endMs : startMs + delta * (i + 1);

    slices.push({
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    });
  }

  return slices;
}
