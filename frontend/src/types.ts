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
  meeting_name: string | null;
  meeting_official_name: string | null;
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

export interface TelemetrySliceSample extends Record<string, unknown> {
  driver_number: number;
  sample_time: string;
  lap_number: number | null;
  speed: number | null;
  brake: number | null;
  rpm: number | null;
  n_gear: number | null;
  throttle: number | null;
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
  dataState: 'none' | 'no_telemetry' | 'with_telemetry';
  lastRefreshed: string | null;
  sessionInfo: SessionMeta;
  telemetry: TelemetrySample[];
  pitStops: PitStopRecord[];
  raceControl: RaceControlRecord[];
  stints: StintRecord[];
  laps: LapRecord[];
  weather: WeatherSample[];
}

export interface WeatherSample {
  recorded_at: string;
  air_temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  rainfall: number | null;
  track_temperature: number | null;
  wind_direction: number | null;
  wind_speed: number | null;
}

export type StrategyEntry = [number, string] | [number, number, string];

export interface StrategyComparisonInput {
  paths?: {
    base_dir?: string;
    bundle_path?: string;
    data_path?: string;
    overtake_path?: string;
    dnf_path?: string;
    safety_path?: string;
  };
  options?: {
    seed?: number;
    noise_scale?: number;
    stream_progress?: boolean;
  };
  strategy: {
    strategy_a_global: StrategyEntry[] | null;
    strategy_b_global: StrategyEntry[] | null;
    strategy_a_driver?: Record<string, StrategyEntry[]>;
    strategy_b_driver?: Record<string, StrategyEntry[]>;
    num_runs_compare?: number;
    race_length?: number;
    update_every?: number;
    grid?: string[];
    circuit_id?: string;
    year?: number;
    safety_car_laps?: number[] | null;
    rain_laps?: number[] | null;
  };
}

export interface StrategyComparisonOutput {
  meta: Record<string, unknown>;
  strategy_comparison: {
    summary_comp_df: Array<Record<string, unknown>>;
    avg_finish: Array<Record<string, unknown>>;
    lap_time_series?: {
      driver_id: string | null;
      laps: number[];
      driver: {
        A: Array<number | null>;
        B: Array<number | null>;
      };
      others: Array<number | null>;
    } | null;
    position_series?: {
      driver_id: string | null;
      laps: number[];
      A: Array<number | null>;
      B: Array<number | null>;
    } | null;
  };
}

export type StrategyComparisonEvent =
  | { event: 'start'; mode: 'strategy_comparison'; total_runs: number }
  | {
      event: 'progress';
      run: number;
      total_runs: number;
      driver_id?: string | null;
      wins?: Record<string, number>;
      podiums?: Record<string, number>;
      avg_finish?: Record<string, number>;
    }
  | { event: 'result'; data: StrategyComparisonOutput }
  | {
      event: 'strategy_preview';
      strategy: 'A' | 'B';
      driver_id?: string | null;
      entries: StrategyEntry[];
      circuit_id?: string;
      year?: number;
      race_length?: number;
    }
  | {
      event: 'auto_strategies';
      strategy: 'A' | 'B';
      circuit_id: string;
      year: number;
      strategies: Array<{
        sequence: string;
        avg_pit_laps: Array<number | null>;
        probability: number;
      }>;
    }
  | { event: 'stderr'; message: string }
  | { event: 'error'; message: string }
  | { event: 'log'; message: string };
