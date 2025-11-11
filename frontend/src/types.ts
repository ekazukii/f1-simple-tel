export interface SessionMeta {
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
  sessionInfo: SessionMeta;
  carData: Record<string, unknown>[];
  locations: LocationRecord[];
  pitStops: Record<string, unknown>[];
  raceControl: Record<string, unknown>[];
  stints: Record<string, unknown>[];
  laps: Record<string, unknown>[];
}

export interface LocationRecord extends Record<string, unknown> {
  x?: number;
  y?: number;
  z?: number;
  lat?: number;
  long?: number;
  lon?: number;
  latitude?: number;
  longitude?: number;
  driver_number?: number;
  date?: string;
}
