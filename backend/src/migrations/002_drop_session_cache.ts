import type { Migration } from "./types";

const migration: Migration = {
  id: "002_drop_session_cache",
  up: async (sql) => {
    await sql`DROP TABLE IF EXISTS session_cache`;
  },
};

export default migration;
