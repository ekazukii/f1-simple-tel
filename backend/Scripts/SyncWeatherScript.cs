using System.Globalization;
using System.Diagnostics.CodeAnalysis;
using Backend.Data;
using Backend.Datasources;
using Dapper;

namespace Backend.Scripts;

public static class SyncWeatherScript
{
    public static async Task RunAsync(string[] args, IServiceProvider services)
    {
        var options = ParseArgs(args);
        var db = services.GetRequiredService<Database>();
        var openF1 = services.GetRequiredService<OpenF1Client>();

        await DatabaseMigrator.InitializeAsync(db);

        await using var connection = await db.OpenConnectionAsync();
        if (options.SyncAll)
        {
            var rows = await connection.QueryAsync<int>("SELECT session_key FROM sessions");
            foreach (var row in rows)
            {
                options.SessionKeys.Add(row.ToString());
            }
        }

        if (options.SessionKeys.Count == 0)
        {
            Console.Error.WriteLine(
                "[Weather] No sessions provided. Use --session <key> or --all.");
            Environment.Exit(1);
        }

        foreach (var key in options.SessionKeys)
        {
            await SyncSessionWeatherAsync(connection, openF1, key);
        }

        Console.WriteLine("[Weather] Sync completed");
    }

    private static async Task SyncSessionWeatherAsync(
        Npgsql.NpgsqlConnection connection,
        OpenF1Client openF1,
        string sessionKey)
    {
        Console.WriteLine($"[Weather] Fetching weather for session {sessionKey}");
        var remote = await openF1.FetchWeatherAsync(sessionKey);
        if (remote.Count == 0)
        {
            Console.WriteLine($"[Weather] No samples for session {sessionKey}");
            return;
        }

        var rows = remote
            .Select(sample =>
            {
                var recordedAt = ToIso(sample.Date);
                if (recordedAt is null)
                {
                    return null;
                }

                return new WeatherRow
                {
                    SessionKey = int.Parse(sessionKey),
                    RecordedAt = recordedAt,
                    AirTemperature = sample.AirTemperature,
                    Humidity = sample.Humidity,
                    Pressure = sample.Pressure,
                    Rainfall = sample.Rainfall,
                    TrackTemperature = sample.TrackTemperature,
                    WindDirection = sample.WindDirection,
                    WindSpeed = sample.WindSpeed
                };
            })
            .Where(row => row is not null)
            .Cast<WeatherRow>()
            .ToList();

        if (rows.Count == 0)
        {
            Console.WriteLine($"[Weather] No valid samples for session {sessionKey}");
            return;
        }

        await using var tx = await connection.BeginTransactionAsync();
        await connection.ExecuteAsync(
            "DELETE FROM weather_samples WHERE session_key = @SessionKey",
            new { SessionKey = int.Parse(sessionKey) },
            tx);

        foreach (var row in rows)
        {
            await connection.ExecuteAsync(
                """
                INSERT INTO weather_samples (
                  session_key,
                  recorded_at,
                  air_temperature,
                  humidity,
                  pressure,
                  rainfall,
                  track_temperature,
                  wind_direction,
                  wind_speed
                )
                VALUES (
                  @SessionKey,
                  @RecordedAt,
                  @AirTemperature,
                  @Humidity,
                  @Pressure,
                  @Rainfall,
                  @TrackTemperature,
                  @WindDirection,
                  @WindSpeed
                )
                ON CONFLICT (session_key, recorded_at) DO UPDATE SET
                  air_temperature = EXCLUDED.air_temperature,
                  humidity = EXCLUDED.humidity,
                  pressure = EXCLUDED.pressure,
                  rainfall = EXCLUDED.rainfall,
                  track_temperature = EXCLUDED.track_temperature,
                  wind_direction = EXCLUDED.wind_direction,
                  wind_speed = EXCLUDED.wind_speed
                """,
                row,
                tx);
        }

        await tx.CommitAsync();

        Console.WriteLine($"[Weather] Stored {rows.Count} samples for session {sessionKey}");
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
            "Usage: dotnet run -- sync-weather -- [--session <session_key> ... | --all]");
        Environment.Exit(1);
    }

    private sealed class CliOptions
    {
        public HashSet<string> SessionKeys { get; } = new();
        public bool SyncAll { get; set; }
    }

    private sealed class WeatherRow
    {
        public int SessionKey { get; init; }
        public string RecordedAt { get; init; } = string.Empty;
        public double? AirTemperature { get; init; }
        public double? Humidity { get; init; }
        public double? Pressure { get; init; }
        public double? Rainfall { get; init; }
        public double? TrackTemperature { get; init; }
        public double? WindDirection { get; init; }
        public double? WindSpeed { get; init; }
    }
}
