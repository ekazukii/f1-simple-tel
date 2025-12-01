import type { Sql } from "postgres";

export interface Migration {
  id: string;
  up: (sql: Sql) => Promise<void>;
}
