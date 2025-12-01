import type { Migration } from "./types";

const migration: Migration = {
  id: "003_expand_meetings",
  up: async (sql) => {
    await sql`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS country_key INTEGER`;
    await sql`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS gmt_offset TEXT`;
  },
};

export default migration;
