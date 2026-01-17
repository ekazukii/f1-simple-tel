using System.Globalization;
using System.Diagnostics.CodeAnalysis;
using Backend.Data;
using Backend.Datasources;
using Backend.Services;
using Dapper;

namespace Backend.Scripts;

public static class SyncRadioScript
{
    public static async Task RunAsync(string[] args, IServiceProvider services)
    {
        var options = ParseArgs(args);
        if (!options.SyncAll && options.MeetingKeys.Count == 0 && options.SessionKeys.Count == 0)
        {
            PrintUsage();
        }

        var db = services.GetRequiredService<Database>();
        var openF1 = services.GetRequiredService<OpenF1Client>();
        var transcription = services.GetRequiredService<TranscriptionService>();
        await DatabaseMigrator.InitializeAsync(db);

        var sessionKeys = new HashSet<string>(options.SessionKeys);
        await using var connection = await db.OpenConnectionAsync();

        if (options.SyncAll)
        {
            var rows = await connection.QueryAsync<int>("SELECT session_key FROM sessions");
            foreach (var row in rows)
            {
                sessionKeys.Add(row.ToString());
            }
        }

        foreach (var meetingKey in options.MeetingKeys)
        {
            var rows = await connection.QueryAsync<int>(
                "SELECT session_key FROM sessions WHERE meeting_key = @MeetingKey",
                new { MeetingKey = meetingKey });
            if (!rows.Any())
            {
                Console.WriteLine($"[Radio] No sessions stored for meeting {meetingKey}");
            }
            foreach (var row in rows)
            {
                sessionKeys.Add(row.ToString());
            }
        }

        if (sessionKeys.Count == 0)
        {
            Console.WriteLine("[Radio] No sessions to process");
            return;
        }

        foreach (var sessionKey in sessionKeys)
        {
            await SyncSessionRadioAsync(connection, openF1, transcription, sessionKey);
        }

        Console.WriteLine("[Radio] Sync completed");
    }

    private static async Task SyncSessionRadioAsync(
        Npgsql.NpgsqlConnection connection,
        OpenF1Client openF1,
        TranscriptionService transcription,
        string sessionKey)
    {
        Console.WriteLine($"\n[Radio] Fetching team radio for session {sessionKey}");
        var remote = await openF1.FetchTeamRadioAsync(sessionKey);
        if (remote.Count == 0)
        {
            Console.WriteLine($"[Radio] No radio entries for session {sessionKey}");
            return;
        }

        var existingRows = await connection.QueryAsync<TeamRadioRow>(
            """
            SELECT driver_number, recorded_at, transcript
            FROM team_radios
            WHERE session_key = @SessionKey
            """,
            new { SessionKey = sessionKey });

        var existing = new Dictionary<string, string?>();
        foreach (var row in existingRows)
        {
            existing[RecordKey(row.DriverNumber, row.RecordedAt)] = row.Transcript;
        }

        foreach (var entry in remote)
        {
            var recordedAt = ToIso(entry.Date);
            if (recordedAt is null)
            {
                continue;
            }

            var key = RecordKey(entry.DriverNumber, recordedAt);
            var transcript = existing.TryGetValue(key, out var existingTranscript)
                ? existingTranscript
                : null;
            if (string.IsNullOrWhiteSpace(transcript))
            {
                try
                {
                    transcript = await transcription.TranscribeRecordingFromUrlAsync(entry.RecordingUrl);
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine(
                        $"[Radio] Failed to transcribe {entry.RecordingUrl}: {error}");
                }
            }

            await connection.ExecuteAsync(
                """
                INSERT INTO team_radios (
                  session_key,
                  driver_number,
                  recorded_at,
                  recording_url,
                  transcript
                )
                VALUES (
                  @session_key,
                  @driver_number,
                  @recorded_at,
                  @recording_url,
                  @transcript
                )
                ON CONFLICT (session_key, driver_number, recorded_at) DO UPDATE SET
                  recording_url = EXCLUDED.recording_url,
                  transcript = COALESCE(EXCLUDED.transcript, team_radios.transcript)
                """,
                new
                {
                    session_key = int.Parse(sessionKey),
                    driver_number = entry.DriverNumber,
                    recorded_at = recordedAt,
                    recording_url = entry.RecordingUrl,
                    transcript
                });
        }

        Console.WriteLine($"[Radio] Stored {remote.Count} entries for session {sessionKey}");
    }

    private static string RecordKey(int driver, string recordedAt)
    {
        return $"{driver}-{recordedAt}";
    }

    private static CliOptions ParseArgs(string[] args)
    {
        var options = new CliOptions();
        string ReadNext(int index)
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
                case "--session":
                case "-s":
                    options.SessionKeys.Add(ReadNext(i));
                    i++;
                    break;
                case "--meeting":
                case "-m":
                    if (!int.TryParse(ReadNext(i), out var meetingKey))
                    {
                        PrintUsage();
                    }
                    options.MeetingKeys.Add(meetingKey);
                    i++;
                    break;
                case "--all":
                    options.SyncAll = true;
                    break;
                case "--help":
                case "-h":
                    PrintUsage();
                    break;
                default:
                    options.SessionKeys.Add(arg);
                    break;
            }
        }

        return options;
    }

    private static string? ToIso(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        if (DateTimeOffset.TryParse(value, null, DateTimeStyles.AssumeUniversal, out var parsed))
        {
            return parsed.UtcDateTime.ToString("O");
        }

        return null;
    }

    [DoesNotReturn]
    private static void PrintUsage()
    {
        Console.Error.WriteLine(
            "Usage: dotnet run -- sync-radio -- [--session <session_key> ...] [--meeting <meeting_key> ...] [--all]");
        Environment.Exit(1);
    }

    private sealed class CliOptions
    {
        public HashSet<string> SessionKeys { get; } = new();
        public HashSet<int> MeetingKeys { get; } = new();
        public bool SyncAll { get; set; }
    }

    private sealed class TeamRadioRow
    {
        public int DriverNumber { get; init; }
        public string RecordedAt { get; init; } = string.Empty;
        public string? Transcript { get; init; }
    }
}
