import type { Migration } from "./types";

const migration: Migration = {
  id: "008_add_session_status",
  up: async (sql) => {
    await sql`
      ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS data_status TEXT NOT NULL DEFAULT 'none'
    `;

    await sql`
      ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS last_refreshed TIMESTAMPTZ
    `;

    await sql`
      ALTER TABLE sessions
      DROP CONSTRAINT IF EXISTS sessions_data_status_check
    `;

    await sql`
      ALTER TABLE sessions
      ADD CONSTRAINT sessions_data_status_check
      CHECK (data_status IN ('none', 'no_telemetry', 'with_telemetry'))
    `;

    await sql`
      UPDATE sessions s
      SET data_status = 'with_telemetry'
      WHERE EXISTS (
        SELECT 1
        FROM telemetry_samples t
        WHERE t.session_key = s.session_key
        LIMIT 1
      )
    `;

    await sql`
      UPDATE sessions
      SET data_status = 'no_telemetry'
      WHERE data_status = 'none'
    `;

    await sql`
      UPDATE sessions
      SET last_refreshed = COALESCE(last_refreshed, NOW())
      WHERE last_refreshed IS NULL
    `;
  },
};

export default migration;
