import type { Migration } from "./types";

const migration: Migration = {
  id: "006_expand_telemetry_chunks",
  up: async (sql) => {
    await sql`SELECT set_chunk_time_interval('telemetry_samples', INTERVAL '1 day')`;
  },
};

export default migration;
