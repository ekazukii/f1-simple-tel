import postgres from "postgres";
import { migrations } from "./migrations";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL environment variable is required to connect to TimescaleDB"
  );
}

export const db = postgres(databaseUrl, {
  prepare: false,
});

export async function initializeDatabase() {
  await db`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await runMigrations();
}

async function runMigrations() {
  const appliedRows = (await db`SELECT id FROM schema_migrations`) as Array<{
    id: string;
  }>;
  const applied = new Set(appliedRows.map((row) => row.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }

    console.log(`[DB] Applying migration ${migration.id}`);
    await db.begin(async (tx) => {
      await migration.up(tx);
      await tx`INSERT INTO schema_migrations (id) VALUES (${migration.id})`;
    });
    console.log(`[DB] Migration ${migration.id} applied`);
  }
}
