import type { Migration } from "./types";

const migration: Migration = {
  id: "010_create_team_radio",
  up: async (sql) => {
    await sql`
      CREATE TABLE IF NOT EXISTS team_radios (
        session_key INTEGER NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
        driver_number SMALLINT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        recording_url TEXT NOT NULL,
        transcript TEXT,
        PRIMARY KEY (session_key, driver_number, recorded_at)
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS team_radios_session_lookup
        ON team_radios (session_key, recorded_at)
    `;
  },
};

export default migration;
