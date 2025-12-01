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

export interface TelemetrySample extends Record<string, unknown> {
  driver_number: number;
  sample_time: string;
  lap_number: number | null;
  drs: number | null;
  speed: number | null;
  brake: number | null;
  rpm: number | null;
  n_gear: number | null;
  throttle: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface PitStopRecord extends Record<string, unknown> {
  driver_number: number;
  lap_number: number;
  stop_time: string;
  pit_duration: number | null;
}

export interface RaceControlRecord extends Record<string, unknown> {
  driver_number: number | null;
  lap_number: number | null;
  category: string | null;
  flag: string | null;
  scope: string | null;
  sector: string | null;
  message: string | null;
  event_time: string;
}

export interface StintRecord extends Record<string, unknown> {
  driver_number: number;
  stint_number: number;
  lap_start: number | null;
  lap_end: number | null;
  compound: string | null;
  tyre_age_at_start: number | null;
}

export interface LapRecord extends Record<string, unknown> {
  driver_number: number;
  lap_number: number;
  date_start: string | null;
  lap_duration: number | null;
  duration_sector_1: number | null;
  duration_sector_2: number | null;
  duration_sector_3: number | null;
  i1_speed: number | null;
  i2_speed: number | null;
  st_speed: number | null;
  is_pit_out_lap: boolean;
  segments_sector_1: Array<number | null> | null;
  segments_sector_2: Array<number | null> | null;
  segments_sector_3: Array<number | null> | null;
}

export interface OpenF1SessionData {
  sessionKey: string;
  sessionInfo: SessionMeta;
  telemetry: TelemetrySample[];
  pitStops: PitStopRecord[];
  raceControl: RaceControlRecord[];
  stints: StintRecord[];
  laps: LapRecord[];
}
