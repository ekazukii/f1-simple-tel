import type { Migration } from "./types";

const migration: Migration = {
  id: "009_add_meeting_names",
  up: async (sql) => {
    await sql`
      ALTER TABLE meetings
      ADD COLUMN IF NOT EXISTS meeting_name TEXT
    `;

    await sql`
      ALTER TABLE meetings
      ADD COLUMN IF NOT EXISTS meeting_official_name TEXT
    `;
  },
};

export default migration;
