import process from "process";
import { initializeDatabase, db } from "../database";
import {
  fetchTeamRadio,
  type OpenF1TeamRadioRecord,
} from "../datasources/openf1org";
import { transcribeRecordingFromUrl } from "../services/transcription";

interface CliOptions {
  sessionKeys: Set<string>;
  meetingKeys: Set<number>;
  syncAll: boolean;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (
    !options.syncAll &&
    !options.meetingKeys.size &&
    !options.sessionKeys.size
  ) {
    printUsage();
  }

  await initializeDatabase();

  const sessionKeys = new Set<string>(options.sessionKeys);

  if (options.syncAll) {
    const rows = (await db`SELECT session_key FROM sessions`) as Array<{
      session_key: number;
    }>;
    rows.forEach((row) => sessionKeys.add(String(row.session_key)));
  }

  for (const meetingKey of options.meetingKeys) {
    const rows = (await db`
      SELECT session_key FROM sessions WHERE meeting_key = ${meetingKey}
    `) as Array<{ session_key: number }>;
    if (!rows.length) {
      console.warn(`[Radio] No sessions stored for meeting ${meetingKey}`);
    }
    rows.forEach((row) => sessionKeys.add(String(row.session_key)));
  }

  if (!sessionKeys.size) {
    console.warn("[Radio] No sessions to process");
    return;
  }

  for (const sessionKey of sessionKeys) {
    await syncSessionRadio(sessionKey);
  }

  console.log("[Radio] Sync completed");
}

async function syncSessionRadio(sessionKey: string) {
  console.log(`\n[Radio] Fetching team radio for session ${sessionKey}`);
  const remote = await fetchTeamRadio({ sessionKey });
  if (!remote.length) {
    console.log(`[Radio] No radio entries for session ${sessionKey}`);
    return;
  }

  const existingRows = (await db`
    SELECT driver_number, recorded_at, transcript
    FROM team_radios
    WHERE session_key = ${sessionKey}
  `) as Array<{ driver_number: number; recorded_at: string; transcript: string | null }>;
  const existing = new Map<string, string | null>();
  existingRows.forEach((row) => {
    existing.set(recordKey(row.driver_number, row.recorded_at), row.transcript);
  });

  for (const entry of remote) {
    const recordedAt = toIso(entry.date);
    if (!recordedAt) {
      continue;
    }
    const key = recordKey(entry.driver_number, recordedAt);
    let transcript = existing.get(key) ?? null;
    if (!transcript) {
      try {
        transcript = await transcribeRecordingFromUrl(entry.recording_url);
      } catch (error) {
        console.error(
          `[Radio] Failed to transcribe ${entry.recording_url}:`,
          error
        );
      }
    }

    await db`
      INSERT INTO team_radios ${db({
        session_key: Number(sessionKey),
        driver_number: entry.driver_number,
        recorded_at: recordedAt,
        recording_url: entry.recording_url,
        transcript,
      })}
      ON CONFLICT (session_key, driver_number, recorded_at) DO UPDATE SET
        recording_url = EXCLUDED.recording_url,
        transcript = COALESCE(EXCLUDED.transcript, team_radios.transcript)
    `;
  }

  console.log(`[Radio] Stored ${remote.length} entries for session ${sessionKey}`);
}

function recordKey(driver: number, recordedAt: string) {
  return `${driver}-${recordedAt}`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sessionKeys: new Set(),
    meetingKeys: new Set(),
    syncAll: false,
  };

  const readNext = (index: number) => {
    const value = argv[index + 1];
    if (!value) {
      printUsage();
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--session":
      case "-s": {
        const value = readNext(i);
        i += 1;
        options.sessionKeys.add(value);
        break;
      }
      case "--meeting":
      case "-m": {
        const value = Number(readNext(i));
        i += 1;
        if (!Number.isFinite(value)) {
          printUsage();
        }
        options.meetingKeys.add(value);
        break;
      }
      case "--all":
        options.syncAll = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        break;
      default:
        options.sessionKeys.add(arg);
    }
  }

  return options;
}

function toIso(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

function printUsage(): never {
  console.error(
    "Usage: bun run sync-radio -- [--session <session_key> ...] [--meeting <meeting_key> ...] [--all]"
  );
  process.exit(1);
}

main().catch((error) => {
  console.error("[Radio] Sync failed", error);
  process.exit(1);
});
