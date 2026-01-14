import process from "process";
import { initializeDatabase, db } from "../database";
import { fetchWeather } from "../datasources/openf1org";

interface CliOptions {
  sessionKeys: Set<string>;
  syncAll: boolean;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await initializeDatabase();
  if (options.syncAll) {
    const rows = (await db`SELECT session_key FROM sessions`) as Array<{
      session_key: number;
    }>;
    rows.forEach((row) => options.sessionKeys.add(String(row.session_key)));
  }

  if (!options.sessionKeys.size) {
    console.error("[Weather] No sessions provided. Use --session <key> or --all.");
    process.exit(1);
  }

  for (const key of options.sessionKeys) {
    await syncSessionWeather(key);
  }

  console.log("[Weather] Sync completed");
}

async function syncSessionWeather(sessionKey: string) {
  console.log(`[Weather] Fetching weather for session ${sessionKey}`);
  const remote = await fetchWeather({ sessionKey });
  if (!remote.length) {
    console.log(`[Weather] No samples for session ${sessionKey}`);
    return;
  }

  const rows = remote
    .map((sample) => {
      const recorded_at = toIso(sample.date);
      if (!recorded_at) {
        return null;
      }
      return {
        session_key: Number(sessionKey),
        recorded_at,
        air_temperature: toNumber(sample.air_temperature),
        humidity: toNumber(sample.humidity),
        pressure: toNumber(sample.pressure),
        rainfall: toNumber(sample.rainfall),
        track_temperature: toNumber(sample.track_temperature),
        wind_direction: toNumber(sample.wind_direction),
        wind_speed: toNumber(sample.wind_speed),
      };
    })
    .filter((row): row is Required<typeof row> => Boolean(row));

  if (!rows.length) {
    console.log(`[Weather] No valid samples for session ${sessionKey}`);
    return;
  }

  await db.begin(async (tx) => {
    const numericKey = Number(sessionKey);
    await tx`DELETE FROM weather_samples WHERE session_key = ${numericKey}`;
    for (const row of rows) {
      await tx`
        INSERT INTO weather_samples ${tx({ ...row, session_key: numericKey })}
        ON CONFLICT (session_key, recorded_at) DO UPDATE SET
          air_temperature = EXCLUDED.air_temperature,
          humidity = EXCLUDED.humidity,
          pressure = EXCLUDED.pressure,
          rainfall = EXCLUDED.rainfall,
          track_temperature = EXCLUDED.track_temperature,
          wind_direction = EXCLUDED.wind_direction,
          wind_speed = EXCLUDED.wind_speed
      `;
    }
  });

  console.log(`[Weather] Stored ${rows.length} samples for session ${sessionKey}`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { sessionKeys: new Set(), syncAll: false };

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

function toNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function printUsage(): never {
  console.error("Usage: bun run sync-weather -- [--session <session_key> ... | --all]");
  process.exit(1);
}

main().catch((error) => {
  console.error("[Weather] Sync failed", error);
  process.exit(1);
});
