import type { Migration } from "./types";

const migration: Migration = {
  id: "001_initial_schema",
  up: async (sql) => {
    await sql`CREATE EXTENSION IF NOT EXISTS timescaledb`;

    await sql`
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
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key INTEGER PRIMARY KEY,
        meeting_key INTEGER NOT NULL REFERENCES meetings(meeting_key),
        session_type TEXT NOT NULL,
        session_name TEXT NOT NULL,
        date_start TIMESTAMPTZ NOT NULL,
        date_end TIMESTAMPTZ NOT NULL
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS session_aliases (
        alias TEXT PRIMARY KEY,
        session_key INTEGER NOT NULL REFERENCES sessions(session_key)
      )
    `;

    await sql`
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
    `;

    await sql`
      SELECT create_hypertable(
        'telemetry_samples',
        'sample_time',
        chunk_time_interval => INTERVAL '5 minutes',
        if_not_exists => TRUE
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS telemetry_samples_lookup
        ON telemetry_samples (session_key, driver_number, sample_time DESC)
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS pit_stops (
        session_key INTEGER NOT NULL REFERENCES sessions(session_key),
        driver_number SMALLINT NOT NULL,
        lap_number INTEGER NOT NULL,
        stop_time TIMESTAMPTZ NOT NULL,
        pit_duration NUMERIC(6, 3),
        meeting_key INTEGER NOT NULL REFERENCES meetings(meeting_key),
        PRIMARY KEY (session_key, driver_number, stop_time)
      )
    `;

    await sql`
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
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS race_control_events_lookup
        ON race_control_events (session_key, event_time DESC)
    `;

    await sql`
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
    `;

    await sql`
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
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS session_cache (
        session_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  },
};

export default migration;
