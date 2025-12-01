import type { Migration } from "./types";

const migration: Migration = {
  id: "004_add_telemetry_lap_number",
  up: async (sql) => {
    await sql`ALTER TABLE telemetry_samples ADD COLUMN IF NOT EXISTS lap_number INTEGER`;
  },
};

export default migration;
