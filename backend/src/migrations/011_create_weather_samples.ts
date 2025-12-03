import type { Migration } from "./types";

const migration: Migration = {
  id: "011_create_weather_samples",
  up: async (sql) => {
    await sql`
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
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS weather_samples_session_idx
        ON weather_samples (session_key, recorded_at)
    `;
  },
};

export default migration;
