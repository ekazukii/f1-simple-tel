using System.Globalization;
using System.Diagnostics.CodeAnalysis;
using Backend.Data;
using Backend.Datasources;
using Dapper;

namespace Backend.Scripts;

public static class SyncSessionsScript
{
    private const int EarliestYear = 2018;

    public static async Task RunAsync(string[] args, IServiceProvider services)
    {
        var options = ParseArgs(args);
        if (options.Years.Count == 0)
        {
            Console.Error.WriteLine("No years to sync");
            Environment.Exit(1);
        }

        var db = services.GetRequiredService<Database>();
        var openF1 = services.GetRequiredService<OpenF1Client>();
        await DatabaseMigrator.InitializeAsync(db);

        foreach (var year in options.Years)
        {
            Console.WriteLine($"\n[Sync] Fetching metadata for year {year}");
            await SyncYearAsync(db, openF1, year);
        }

        Console.WriteLine("[Sync] Completed session + meeting sync");
    }

    private static async Task SyncYearAsync(Database db, OpenF1Client client, int year)
    {
        var meetings = await client.FetchMeetingsListAsync(year);
        Console.WriteLine($"[Sync] Retrieved {meetings.Count} meetings");
        await using (var connection = await db.OpenConnectionAsync())
        {
            foreach (var meeting in meetings)
            {
                await UpsertMeetingAsync(connection, meeting);
            }
        }

        var sessions = await client.FetchSessionsListAsync(year);
        Console.WriteLine($"[Sync] Retrieved {sessions.Count} sessions");
        await using (var connection = await db.OpenConnectionAsync())
        {
            foreach (var session in sessions)
            {
                await UpsertSessionAsync(connection, session);
            }
        }
    }

    private static async Task UpsertMeetingAsync(
        Npgsql.NpgsqlConnection connection,
        OpenF1MeetingMeta meeting)
    {
        var record = new
        {
            meeting_key = meeting.MeetingKey,
            location = NullableString(meeting.Location),
            country_name = NullableString(meeting.CountryName),
            country_code = NullableString(meeting.CountryCode),
            country_key = meeting.CountryKey,
            gmt_offset = NullableString(meeting.GmtOffset),
            circuit_key = meeting.CircuitKey,
            circuit_short_name = NullableString(meeting.CircuitShortName),
            year = meeting.Year,
            meeting_name = NullableString(meeting.MeetingName),
            meeting_official_name = NullableString(meeting.MeetingOfficialName)
        };

        await connection.ExecuteAsync(
            """
            INSERT INTO meetings (
              meeting_key,
              location,
              country_name,
              country_code,
              country_key,
              gmt_offset,
              circuit_key,
              circuit_short_name,
              year,
              meeting_name,
              meeting_official_name
            )
            VALUES (
              @meeting_key,
              @location,
              @country_name,
              @country_code,
              @country_key,
              @gmt_offset,
              @circuit_key,
              @circuit_short_name,
              @year,
              @meeting_name,
              @meeting_official_name
            )
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
            """,
            record);
    }

    private static async Task UpsertSessionAsync(
        Npgsql.NpgsqlConnection connection,
        OpenF1SessionMeta session)
    {
        var record = new
        {
            session_key = session.SessionKey,
            meeting_key = session.MeetingKey,
            session_type = NullableString(session.SessionType),
            session_name = NullableString(session.SessionName),
            date_start = ParseDate(session.DateStart),
            date_end = ParseDate(session.DateEnd),
            data_status = "none",
            last_refreshed = (DateTime?)null
        };

        await connection.ExecuteAsync(
            """
            INSERT INTO sessions (
              session_key,
              meeting_key,
              session_type,
              session_name,
              date_start,
              date_end,
              data_status,
              last_refreshed
            )
            VALUES (
              @session_key,
              @meeting_key,
              @session_type,
              @session_name,
              @date_start,
              @date_end,
              @data_status,
              @last_refreshed
            )
            ON CONFLICT (session_key) DO UPDATE SET
              meeting_key = EXCLUDED.meeting_key,
              session_type = EXCLUDED.session_type,
              session_name = EXCLUDED.session_name,
              date_start = EXCLUDED.date_start,
              date_end = EXCLUDED.date_end
            """,
            record);

        var alias = NullableString(session.CircuitShortName);
        if (!string.IsNullOrWhiteSpace(alias))
        {
            await connection.ExecuteAsync(
                """
                INSERT INTO session_aliases (alias, session_key)
                VALUES (@alias, @session_key)
                ON CONFLICT (alias) DO NOTHING
                """,
                new { alias, session_key = session.SessionKey });
        }
    }

    private static SyncOptions ParseArgs(string[] args)
    {
        var years = new SortedSet<int>();
        int? rangeStart = null;
        int? rangeEnd = null;
        var useAllYears = false;

        string GetNext(int index)
        {
            if (index + 1 >= args.Length)
            {
                PrintUsage();
            }

            return args[index + 1];
        }

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            switch (arg)
            {
                case "--year":
                case "-y":
                    if (!int.TryParse(GetNext(i), out var year))
                    {
                        PrintUsage();
                    }
                    years.Add(year);
                    i++;
                    break;
                case "--from-year":
                    if (!int.TryParse(GetNext(i), out var fromYear))
                    {
                        PrintUsage();
                    }
                    rangeStart = fromYear;
                    i++;
                    break;
                case "--to-year":
                    if (!int.TryParse(GetNext(i), out var toYear))
                    {
                        PrintUsage();
                    }
                    rangeEnd = toYear;
                    i++;
                    break;
                case "--all-years":
                case "--all":
                    useAllYears = true;
                    break;
                case "--help":
                case "-h":
                    PrintUsage();
                    break;
                default:
                    if (int.TryParse(arg, out var parsed))
                    {
                        years.Add(parsed);
                    }
                    else
                    {
                        PrintUsage();
                    }
                    break;
            }
        }

        if (useAllYears)
        {
            var currentYear = DateTime.UtcNow.Year;
            for (var year = EarliestYear; year <= currentYear; year++)
            {
                years.Add(year);
            }
        }
        else if (rangeStart.HasValue || rangeEnd.HasValue)
        {
            if (!rangeStart.HasValue || !rangeEnd.HasValue || rangeStart > rangeEnd)
            {
                PrintUsage();
            }

            for (var year = rangeStart.Value; year <= rangeEnd.Value; year++)
            {
                years.Add(year);
            }
        }

        if (years.Count == 0)
        {
            years.Add(DateTime.UtcNow.Year);
        }

        return new SyncOptions(years.ToList());
    }

    private static DateTime? ParseDate(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }
        if (DateTimeOffset.TryParse(value, null, DateTimeStyles.AssumeUniversal, out var parsed))
        {
            return parsed.UtcDateTime;
        }
        return null;
    }

    private static string? NullableString(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    [DoesNotReturn]
    private static void PrintUsage()
    {
        Console.Error.WriteLine(
            "Usage: dotnet run -- sync-sessions -- [--year <year> ...] [--from-year <start>] [--to-year <end>] [--all-years]");
        Environment.Exit(1);
    }

    private sealed record SyncOptions(List<int> Years);
}
