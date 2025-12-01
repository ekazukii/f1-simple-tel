import process from "process";
import { db, initializeDatabase } from "../database";

async function main() {
  const sessionKeyArg = process.argv[2];
  if (!sessionKeyArg) {
    console.error("Usage: bun run delete-session -- <session_key_or_alias>");
    process.exit(1);
  }

  await initializeDatabase();
  const resolved = await resolveSessionKey(sessionKeyArg);
  if (!resolved) {
    console.error(`Session ${sessionKeyArg} not found`);
    process.exit(1);
  }

  await deleteSession(resolved);
  console.log(`Deleted session ${resolved.sessionKey}${resolved.alias ? ` (${resolved.alias})` : ""}`);
}

main().catch((error) => {
  console.error("Failed to delete session", error);
  process.exit(1);
});

async function resolveSessionKey(identifier: string) {
  const aliasRows = (await db`
    SELECT session_key FROM session_aliases WHERE alias = ${identifier} LIMIT 1
  `) as Array<{ session_key: number }>;

  if (aliasRows.length) {
    return { sessionKey: aliasRows[0].session_key, alias: identifier };
  }

  const numeric = Number(identifier);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const sessionRows = (await db`
    SELECT session_key FROM sessions WHERE session_key = ${numeric} LIMIT 1
  `) as Array<{ session_key: number }>;

  if (!sessionRows.length) {
    return null;
  }

  return { sessionKey: sessionRows[0].session_key };
}

async function deleteSession({ sessionKey }: { sessionKey: number }) {
  await db.begin(async (tx) => {
    await tx`DELETE FROM telemetry_samples WHERE session_key = ${sessionKey}`;
    await tx`DELETE FROM pit_stops WHERE session_key = ${sessionKey}`;
    await tx`DELETE FROM race_control_events WHERE session_key = ${sessionKey}`;
    await tx`DELETE FROM stints WHERE session_key = ${sessionKey}`;
    await tx`DELETE FROM laps WHERE session_key = ${sessionKey}`;
    await tx`DELETE FROM session_aliases WHERE session_key = ${sessionKey}`;
    await tx`DELETE FROM sessions WHERE session_key = ${sessionKey}`;
  });
}
