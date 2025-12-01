import type { Migration } from "./types";

const migration: Migration = {
  id: "007_expand_pit_duration",
  up: async (sql) => {
    await sql`
      ALTER TABLE pit_stops
      ALTER COLUMN pit_duration TYPE NUMERIC(8, 3)
    `;
  },
};

export default migration;
