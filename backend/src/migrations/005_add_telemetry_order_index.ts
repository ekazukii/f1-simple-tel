import type { Migration } from "./types";

const migration: Migration = {
  id: "005_add_telemetry_order_index",
  up: async (sql) => {
    await sql`
      CREATE INDEX IF NOT EXISTS telemetry_samples_session_driver_time
      ON telemetry_samples (session_key, driver_number, sample_time)
    `;
  },
};

export default migration;
