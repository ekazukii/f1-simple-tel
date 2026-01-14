import type { SqlClient } from "../types/sql";

export interface Migration {
  id: string;
  up: (sql: SqlClient) => Promise<void>;
}
