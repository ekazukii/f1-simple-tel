import process from "process";
import { initializeDatabase, db } from "../database";
import {
  fetchSessionsList,
  fetchMeetingsList,
  type OpenF1SessionMeta,
  type OpenF1MeetingMeta,
} from "../datasources/openf1org";

const EARLIEST_YEAR = 2018;

interface SyncOptions {
  years: number[];
}

type YearFilter = { year?: number };

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.years.length) {
    console.error("No years to sync");
    process.exit(1);
  }
  await initializeDatabase();

  for (const year of options.years) {
    console.log(`\n[Sync] Fetching metadata for year ${year}`);
    await syncYear({ year });
  }

  console.log("[Sync] Completed session + meeting sync");
}

async function syncYear(filter: YearFilter) {
  const meetingParams = filter.year ? { year: filter.year } : {};
  const sessionParams = filter.year ? { year: filter.year } : {};

  const meetings = await fetchMeetingsList(meetingParams);
  console.log(`[Sync] Retrieved ${meetings.length} meetings`);
  for (const meeting of meetings) {
    await upsertMeeting(meeting);
  }

  const sessions = await fetchSessionsList(sessionParams);
  console.log(`[Sync] Retrieved ${sessions.length} sessions`);
  for (const session of sessions) {
    await upsertSession(session);
  }
}

async function upsertMeeting(meeting: OpenF1MeetingMeta) {
  const record = {
    meeting_key: toNumber(meeting.meeting_key) ?? 0,
    location: nullableString(meeting.location),
    country_name: nullableString(meeting.country_name),
    country_code: nullableString(meeting.country_code),
    country_key: toNumber(meeting.country_key),
    gmt_offset: nullableString(meeting.gmt_offset),
    circuit_key: toNumber(meeting.circuit_key),
    circuit_short_name: nullableString(meeting.circuit_short_name),
    year: toNumber(meeting.year),
    meeting_name: nullableString(meeting.meeting_name),
    meeting_official_name: nullableString(meeting.meeting_official_name),
  };

  await db`
    INSERT INTO meetings ${db(record)}
    ON CONFLICT (meeting_key) DO UPDATE SET
      location = EXCLUDED.location,
      country_name = EXCLUDED.country_name,
      country_code = EXCLUDED.country_code,
      country_key = EXCLUDED.country_key,
      gmt_offset = EXCLUDED.gmt_offset,
      circuit_key = EXCLUDED.circuit_key,
      circuit_short_name = EXCLUDED.circuit_short_name,
      year = EXCLUDED.year,
      meeting_name = EXCLUDED.meeting_name,
      meeting_official_name = EXCLUDED.meeting_official_name
  `;
}

async function upsertSession(session: OpenF1SessionMeta) {
  const record = {
    session_key: toNumber(session.session_key) ?? 0,
    meeting_key: toNumber(session.meeting_key) ?? 0,
    session_type: nullableString(session.session_type),
    session_name: nullableString(session.session_name),
    date_start: parseDate(session.date_start),
    date_end: parseDate(session.date_end),
    data_status: "none",
    last_refreshed: null as string | null,
  };

  await db`
    INSERT INTO sessions ${db(record)}
    ON CONFLICT (session_key) DO UPDATE SET
      meeting_key = EXCLUDED.meeting_key,
      session_type = EXCLUDED.session_type,
      session_name = EXCLUDED.session_name,
      date_start = EXCLUDED.date_start,
      date_end = EXCLUDED.date_end
  `;

  const alias = nullableString(session.circuit_short_name);
  if (alias) {
    await db`
      INSERT INTO session_aliases ${db({ alias, session_key: record.session_key })}
      ON CONFLICT (alias) DO NOTHING
    `;
  }
}

function parseArgs(argv: string[]): SyncOptions {
  const years = new Set<number>();
  let rangeStart: number | null = null;
  let rangeEnd: number | null = null;
  let useAllYears = false;

  const getValue = (index: number) => {
    const value = argv[index + 1];
    if (!value) {
      printUsage();
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--year":
      case "-y": {
        const val = Number(getValue(i));
        i += 1;
        if (!Number.isFinite(val)) {
          printUsage();
        }
        years.add(val);
        break;
      }
      case "--from-year": {
        const val = Number(getValue(i));
        i += 1;
        if (!Number.isFinite(val)) {
          printUsage();
        }
        rangeStart = val;
        break;
      }
      case "--to-year": {
        const val = Number(getValue(i));
        i += 1;
        if (!Number.isFinite(val)) {
          printUsage();
        }
        rangeEnd = val;
        break;
      }
      case "--all-years":
      case "--all": {
        useAllYears = true;
        break;
      }
      case "--help":
      case "-h":
        printUsage();
        break;
      default: {
        const parsed = Number(arg);
        if (Number.isFinite(parsed)) {
          years.add(parsed);
        } else {
          printUsage();
        }
      }
    }
  }

  if (useAllYears) {
    const currentYear = new Date().getUTCFullYear();
    for (let year = EARLIEST_YEAR; year <= currentYear; year += 1) {
      years.add(year);
    }
  } else if (rangeStart != null || rangeEnd != null) {
    if (rangeStart == null || rangeEnd == null || rangeStart > rangeEnd) {
      printUsage();
    }
    for (let year = rangeStart!; year <= rangeEnd!; year += 1) {
      years.add(year);
    }
  }

  if (!years.size) {
    years.add(new Date().getUTCFullYear());
  }

  return { years: Array.from(years).sort((a, b) => a - b) };
}

function parseDate(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const str = String(value);
  if (!str.length) {
    return null;
  }
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function nullableString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const str = String(value).trim();
  return str.length ? str : null;
}

function printUsage(): never {
  console.error(
    "Usage: bun run sync-sessions -- [--year <YYYY> ...] [--from-year <YYYY> --to-year <YYYY>] [--all-years]"
  );
  process.exit(1);
}

main().catch((error) => {
  console.error("[Sync] Failed", error);
  process.exit(1);
});
