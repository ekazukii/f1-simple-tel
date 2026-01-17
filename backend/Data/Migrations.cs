namespace Backend.Data;

public static class Migrations
{
    public static readonly IReadOnlyList<Migration> All = new[]
    {
        new Migration(
            "001_initial_schema",
            new[]
            {
                "CREATE EXTENSION IF NOT EXISTS timescaledb;",
                """
                CREATE TABLE IF NOT EXISTS meetings (
                  meeting_key INTEGER PRIMARY KEY,
                  location TEXT NOT NULL,
                  country_name TEXT NOT NULL,
                  country_code TEXT NOT NULL,
                  country_key INTEGER,
                  gmt_offset TEXT,
                  circuit_key INTEGER,
                  circuit_short_name TEXT,
                  year SMALLINT NOT NULL
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS sessions (
                  session_key INTEGER PRIMARY KEY,
                  meeting_key INTEGER NOT NULL REFERENCES meetings(meeting_key),
                  session_type TEXT NOT NULL,
                  session_name TEXT NOT NULL,
                  date_start TIMESTAMPTZ NOT NULL,
                  date_end TIMESTAMPTZ NOT NULL
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS session_aliases (
                  alias TEXT PRIMARY KEY,
                  session_key INTEGER NOT NULL REFERENCES sessions(session_key)
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS telemetry_samples (
                  session_key INTEGER NOT NULL REFERENCES sessions(session_key),
                  meeting_key INTEGER NOT NULL REFERENCES meetings(meeting_key),
                  driver_number SMALLINT NOT NULL,
                  sample_time TIMESTAMPTZ NOT NULL,
                  lap_number INTEGER,
                  drs SMALLINT,
                  speed SMALLINT,
                  brake SMALLINT,
                  rpm INTEGER,
                  n_gear SMALLINT,
                  throttle SMALLINT,
                  x INTEGER,
                  y INTEGER,
                  z INTEGER,
                  latitude DOUBLE PRECISION,
                  longitude DOUBLE PRECISION,
                  PRIMARY KEY (session_key, driver_number, sample_time)
                )
                """,
                """
                SELECT create_hypertable(
                  'telemetry_samples',
                  'sample_time',
                  chunk_time_interval => INTERVAL '5 minutes',
                  if_not_exists => TRUE
                )
                """,
                """
                CREATE INDEX IF NOT EXISTS telemetry_samples_lookup
                  ON telemetry_samples (session_key, driver_number, sample_time DESC)
                """,
                """
                CREATE TABLE IF NOT EXISTS pit_stops (
                  session_key INTEGER NOT NULL REFERENCES sessions(session_key),
                  driver_number SMALLINT NOT NULL,
                  lap_number INTEGER NOT NULL,
                  stop_time TIMESTAMPTZ NOT NULL,
                  pit_duration NUMERIC(6, 3),
                  meeting_key INTEGER NOT NULL REFERENCES meetings(meeting_key),
                  PRIMARY KEY (session_key, driver_number, stop_time)
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS race_control_events (
                  id BIGSERIAL PRIMARY KEY,
                  session_key INTEGER NOT NULL REFERENCES sessions(session_key),
                  meeting_key INTEGER NOT NULL REFERENCES meetings(meeting_key),
                  event_time TIMESTAMPTZ NOT NULL,
                  lap_number INTEGER,
                  driver_number SMALLINT,
                  category TEXT NOT NULL,
                  flag TEXT,
                  scope TEXT,
                  sector TEXT,
                  message TEXT
                )
                """,
                """
                CREATE INDEX IF NOT EXISTS race_control_events_lookup
                  ON race_control_events (session_key, event_time DESC)
                """,
                """
                CREATE TABLE IF NOT EXISTS stints (
                  session_key INTEGER NOT NULL REFERENCES sessions(session_key),
                  driver_number SMALLINT NOT NULL,
                  stint_number SMALLINT NOT NULL,
                  lap_start INTEGER,
                  lap_end INTEGER,
                  compound TEXT,
                  tyre_age_at_start SMALLINT,
                  meeting_key INTEGER NOT NULL REFERENCES meetings(meeting_key),
                  PRIMARY KEY (session_key, driver_number, stint_number)
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS laps (
                  session_key INTEGER NOT NULL REFERENCES sessions(session_key),
                  driver_number SMALLINT NOT NULL,
                  lap_number INTEGER NOT NULL,
                  meeting_key INTEGER NOT NULL REFERENCES meetings(meeting_key),
                  date_start TIMESTAMPTZ,
                  lap_duration DOUBLE PRECISION,
                  duration_sector_1 DOUBLE PRECISION,
                  duration_sector_2 DOUBLE PRECISION,
                  duration_sector_3 DOUBLE PRECISION,
                  i1_speed SMALLINT,
                  i2_speed SMALLINT,
                  st_speed SMALLINT,
                  is_pit_out_lap BOOLEAN,
                  segments_sector_1 INTEGER[],
                  segments_sector_2 INTEGER[],
                  segments_sector_3 INTEGER[],
                  PRIMARY KEY (session_key, driver_number, lap_number)
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS session_cache (
                  session_key TEXT PRIMARY KEY,
                  payload JSONB NOT NULL,
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            }),
        new Migration("002_drop_session_cache", new[] { "DROP TABLE IF EXISTS session_cache;" }),
        new Migration(
            "003_expand_meetings",
            new[]
            {
                "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS country_key INTEGER;",
                "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS gmt_offset TEXT;"
            }),
        new Migration(
            "004_add_telemetry_lap_number",
            new[] { "ALTER TABLE telemetry_samples ADD COLUMN IF NOT EXISTS lap_number INTEGER;" }),
        new Migration(
            "005_add_telemetry_order_index",
            new[]
            {
                """
                CREATE INDEX IF NOT EXISTS telemetry_samples_session_driver_time
                ON telemetry_samples (session_key, driver_number, sample_time)
                """
            }),
        new Migration(
            "006_expand_telemetry_chunks",
            new[]
            {
                "SELECT set_chunk_time_interval('telemetry_samples', INTERVAL '1 day');"
            }),
        new Migration(
            "007_expand_pit_duration",
            new[]
            {
                """
                ALTER TABLE pit_stops
                ALTER COLUMN pit_duration TYPE NUMERIC(8, 3)
                """
            }),
        new Migration(
            "008_add_session_status",
            new[]
            {
                """
                ALTER TABLE sessions
                ADD COLUMN IF NOT EXISTS data_status TEXT NOT NULL DEFAULT 'none'
                """,
                """
                ALTER TABLE sessions
                ADD COLUMN IF NOT EXISTS last_refreshed TIMESTAMPTZ
                """,
                "ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_data_status_check;",
                """
                ALTER TABLE sessions
                ADD CONSTRAINT sessions_data_status_check
                CHECK (data_status IN ('none', 'no_telemetry', 'with_telemetry'))
                """,
                """
                UPDATE sessions s
                SET data_status = 'with_telemetry'
                WHERE EXISTS (
                  SELECT 1
                  FROM telemetry_samples t
                  WHERE t.session_key = s.session_key
                  LIMIT 1
                )
                """,
                """
                UPDATE sessions
                SET data_status = 'no_telemetry'
                WHERE data_status = 'none'
                """,
                """
                UPDATE sessions
                SET last_refreshed = COALESCE(last_refreshed, NOW())
                WHERE last_refreshed IS NULL
                """
            }),
        new Migration(
            "009_add_meeting_names",
            new[]
            {
                "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_name TEXT;",
                "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_official_name TEXT;"
            }),
        new Migration(
            "010_create_team_radio",
            new[]
            {
                """
                CREATE TABLE IF NOT EXISTS team_radios (
                  session_key INTEGER NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
                  driver_number SMALLINT NOT NULL,
                  recorded_at TIMESTAMPTZ NOT NULL,
                  recording_url TEXT NOT NULL,
                  transcript TEXT,
                  PRIMARY KEY (session_key, driver_number, recorded_at)
                )
                """,
                """
                CREATE INDEX IF NOT EXISTS team_radios_session_lookup
                  ON team_radios (session_key, recorded_at)
                """
            }),
        new Migration(
            "011_create_weather_samples",
            new[]
            {
                """
                CREATE TABLE IF NOT EXISTS weather_samples (
                  session_key INTEGER NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
                  recorded_at TIMESTAMPTZ NOT NULL,
                  air_temperature DOUBLE PRECISION,
                  humidity DOUBLE PRECISION,
                  pressure DOUBLE PRECISION,
                  rainfall DOUBLE PRECISION,
                  track_temperature DOUBLE PRECISION,
                  wind_direction DOUBLE PRECISION,
                  wind_speed DOUBLE PRECISION,
                  PRIMARY KEY (session_key, recorded_at)
                )
                """,
                """
                CREATE INDEX IF NOT EXISTS weather_samples_session_idx
                  ON weather_samples (session_key, recorded_at)
                """
            })
    };
}
