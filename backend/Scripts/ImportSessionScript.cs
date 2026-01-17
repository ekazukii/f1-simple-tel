using System.Globalization;
using System.Diagnostics.CodeAnalysis;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Backend.Data;
using Backend.Datasources;
using Dapper;

namespace Backend.Scripts;

public static class ImportSessionScript
{
    private const int BatchSize = 1000;

    public static async Task RunAsync(string[] args, IServiceProvider services)
    {
        var resolved = ResolveSource(args);
        var db = services.GetRequiredService<Database>();
        var openF1 = services.GetRequiredService<OpenF1Client>();

        await DatabaseMigrator.InitializeAsync(db);

        if (resolved.Source.Kind == ImportKind.Meeting)
        {
            await ImportMeetingSessionsAsync(db, openF1, resolved.Source.Key, resolved.IncludeTelemetry);
            return;
        }

        if (resolved.Source.Kind == ImportKind.MeetingRange)
        {
            Console.WriteLine(
                $"[Import] Bulk meeting import start for keys {resolved.Source.Start}..{resolved.Source.End}");
            for (var meeting = resolved.Source.Start; meeting <= resolved.Source.End; meeting++)
            {
                await ImportMeetingSessionsAsync(db, openF1, meeting, resolved.IncludeTelemetry);
            }
            Console.WriteLine("[Import] Bulk meeting import ended");
            return;
        }

        if (resolved.Source.Kind == ImportKind.SessionRange)
        {
            Console.WriteLine(
                $"[Import] Bulk session import start for keys {resolved.Source.Start}..{resolved.Source.End}");
            for (var key = resolved.Source.Start; key <= resolved.Source.End; key++)
            {
                await ImportSessionByKeyAsync(db, openF1, key.ToString(), resolved.IncludeTelemetry);
            }
            Console.WriteLine("[Import] Bulk session import ended");
            return;
        }

        if (resolved.Source.Kind == ImportKind.File)
        {
            Console.WriteLine($"[Import] Reading session from file {resolved.Source.Path}");
            var sessionData = await ReadSessionFromFileAsync(resolved.Source.Path);
            await ImportSessionAsync(db, sessionData, resolved.IncludeTelemetry);
            Console.WriteLine(
                $"Imported session {sessionData.SessionInfo.SessionKey} ({sessionData.SessionInfo.SessionName})");
            return;
        }

        await ImportSessionByKeyAsync(db, openF1, resolved.Source.Value, resolved.IncludeTelemetry);
    }

    private static ResolvedImport ResolveSource(string[] args)
    {
        if (args.Length == 0)
        {
            PrintUsage();
        }

        var includeTelemetry = true;
        ImportSource? source = null;
        var positional = new List<string>();

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
                case "--no-telemetry":
                    includeTelemetry = false;
                    break;
                case "--telemetry":
                    includeTelemetry = true;
                    break;
                case "--session":
                case "-s":
                    source = ParseSessionValue(ReadNext(i));
                    i++;
                    break;
                case "--file":
                case "-f":
                    source = ImportSource.File(Path.GetFullPath(ReadNext(i)));
                    i++;
                    break;
                case "--meeting":
                case "-m":
                    source = ParseMeetingValue(ReadNext(i));
                    i++;
                    break;
                case "--help":
                case "-h":
                    PrintUsage();
                    break;
                default:
                    positional.Add(arg);
                    break;
            }
        }

        if (source is null && positional.Count > 0)
        {
            var candidate = positional[0];
            var candidatePath = Path.GetFullPath(candidate);
            source = File.Exists(candidatePath)
                ? ImportSource.File(candidatePath)
                : ParseSessionValue(candidate);
        }

        if (source is null)
        {
            PrintUsage();
        }

        return new ResolvedImport(source!, includeTelemetry);
    }

    private static ImportSource ParseSessionValue(string value)
    {
        var range = ParseRange(value);
        return range.HasValue
            ? ImportSource.SessionRange(range.Value.Start, range.Value.End)
            : ImportSource.Session(value);
    }

    private static ImportSource ParseMeetingValue(string value)
    {
        var range = ParseRange(value);
        if (range.HasValue)
        {
            return ImportSource.MeetingRange(range.Value.Start, range.Value.End);
        }

        if (!int.TryParse(value, out var meeting))
        {
            PrintUsage();
        }

        return ImportSource.Meeting(meeting);
    }

    private static (int Start, int End)? ParseRange(string value)
    {
        if (!value.Contains(':'))
        {
            return null;
        }

        var parts = value.Split(':', 2);
        if (!int.TryParse(parts[0], out var start))
        {
            PrintUsage();
        }
        if (!int.TryParse(parts[1], out var end))
        {
            PrintUsage();
        }
        if (start > end)
        {
            PrintUsage();
        }

        return (start, end);
    }

    private static async Task ImportSessionByKeyAsync(
        Database db,
        OpenF1Client client,
        string sessionKey,
        bool includeTelemetry)
    {
        Console.WriteLine($"[Import] Fetching session {sessionKey} from openf1.org");
        var sessionData = await client.FetchSessionAsync(sessionKey, includeTelemetry);
        await ImportSessionAsync(db, sessionData, includeTelemetry);
        Console.WriteLine(
            $"Imported session {sessionData.SessionInfo.SessionKey} ({sessionData.SessionInfo.SessionName})");
    }

    private static async Task ImportMeetingSessionsAsync(
        Database db,
        OpenF1Client client,
        int meetingKey,
        bool includeTelemetry)
    {
        Console.WriteLine($"[Import] Resolving sessions for meeting {meetingKey}");
        await using var connection = await db.OpenConnectionAsync();
        var sessions = (await connection.QueryAsync<int>(
            """
            SELECT session_key
            FROM sessions
            WHERE meeting_key = @MeetingKey
            ORDER BY date_start
            """,
            new { MeetingKey = meetingKey })).ToList();

        if (sessions.Count == 0)
        {
            Console.Error.WriteLine(
                $"[Import] No sessions found in database for meeting {meetingKey}. Run sync-sessions first.");
            Environment.Exit(1);
        }

        foreach (var key in sessions)
        {
            Console.WriteLine($"\n[Import] Fetching session {key} for meeting {meetingKey}");
            var sessionData = await client.FetchSessionAsync(key.ToString(), includeTelemetry);
            await ImportSessionAsync(db, sessionData, includeTelemetry);
            Console.WriteLine(
                $"[Import] Completed session {sessionData.SessionInfo.SessionKey} ({sessionData.SessionInfo.SessionName})");
        }
    }

    private static async Task<OpenF1SessionData> ReadSessionFromFileAsync(string filePath)
    {
        var buffer = await File.ReadAllBytesAsync(filePath);
        var ext = Path.GetExtension(filePath).ToLowerInvariant();
        byte[] jsonBytes;
        if (ext is ".zip" or ".gz")
        {
            using var input = new MemoryStream(buffer);
            using var gzip = new GZipStream(input, CompressionMode.Decompress);
            using var output = new MemoryStream();
            await gzip.CopyToAsync(output);
            jsonBytes = output.ToArray();
        }
        else
        {
            jsonBytes = buffer;
        }

        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var data = JsonSerializer.Deserialize<OpenF1SessionData>(jsonBytes, options);
        if (data is null)
        {
            throw new InvalidOperationException("Failed to parse session file");
        }

        return data;
    }

    private static async Task ImportSessionAsync(
        Database db,
        OpenF1SessionData data,
        bool includeTelemetry)
    {
        var alias = string.IsNullOrWhiteSpace(data.SessionKey) ? null : data.SessionKey.Trim();
        var info = data.SessionInfo;
        var sessionKey = info.SessionKey;
        var meetingKey = info.MeetingKey;
        var meetingMeta = data.MeetingInfo;

        var carData = data.CarData ?? [];
        var driverStartTimes = ComputeDriverStartTimes(carData);
        var telemetryRows = includeTelemetry
            ? MergeTelemetry(
                carData,
                data.Locations ?? [],
                data.Laps ?? [],
                sessionKey,
                meetingKey,
                driverStartTimes)
            : new List<TelemetryRow>();

        Console.WriteLine(
            includeTelemetry
                ? $"[Import] telemetry rows: {telemetryRows.Count}"
                : "[Import] telemetry rows skipped");

        var pitRows = (data.PitStops ?? new List<Dictionary<string, JsonElement>>())
            .Select(pit =>
            {
                var stopTime = ParseDateTime(pit, "date");
                var driverNumber = GetInt(pit, "driver_number");
                var lapNumber = GetInt(pit, "lap_number");
                if (!stopTime.HasValue || driverNumber is null || lapNumber is null)
                {
                    return null;
                }

                return new PitStopRow
                {
                    SessionKey = sessionKey,
                    MeetingKey = meetingKey,
                    DriverNumber = driverNumber.Value,
                    LapNumber = lapNumber.Value,
                    StopTime = stopTime.Value,
                    PitDuration = GetDouble(pit, "pit_duration")
                };
            })
            .Where(row => row is not null)
            .Cast<PitStopRow>()
            .ToList();

        var raceControlRows = (data.RaceControl ?? new List<Dictionary<string, JsonElement>>())
            .Select(evt =>
            {
                var eventTime = ParseDateTime(evt, "date");
                if (!eventTime.HasValue)
                {
                    return null;
                }

                return new RaceControlRow
                {
                    SessionKey = sessionKey,
                    MeetingKey = meetingKey,
                    EventTime = eventTime.Value,
                    LapNumber = GetInt(evt, "lap_number"),
                    DriverNumber = GetInt(evt, "driver_number"),
                    Category = GetString(evt, "category") ?? string.Empty,
                    Flag = GetString(evt, "flag"),
                    Scope = GetString(evt, "scope"),
                    Sector = GetString(evt, "sector"),
                    Message = GetString(evt, "message")
                };
            })
            .Where(row => row is not null)
            .Cast<RaceControlRow>()
            .ToList();

        var stintRows = (data.Stints ?? new List<Dictionary<string, JsonElement>>())
            .Select(stint =>
            {
                var driverNumber = GetInt(stint, "driver_number");
                var stintNumber = GetInt(stint, "stint_number");
                if (driverNumber is null || stintNumber is null)
                {
                    return null;
                }

                return new StintRow
                {
                    SessionKey = sessionKey,
                    MeetingKey = meetingKey,
                    DriverNumber = driverNumber.Value,
                    StintNumber = stintNumber.Value,
                    LapStart = GetInt(stint, "lap_start"),
                    LapEnd = GetInt(stint, "lap_end"),
                    Compound = GetString(stint, "compound"),
                    TyreAgeAtStart = GetInt(stint, "tyre_age_at_start")
                };
            })
            .Where(row => row is not null)
            .Cast<StintRow>()
            .ToList();

        var lapRows = (data.Laps ?? new List<Dictionary<string, JsonElement>>())
            .Select(lap =>
            {
                var driverNumber = GetInt(lap, "driver_number");
                var lapNumber = GetInt(lap, "lap_number");
                if (driverNumber is null || lapNumber is null)
                {
                    return null;
                }

                return new LapRow
                {
                    SessionKey = sessionKey,
                    MeetingKey = meetingKey,
                    DriverNumber = driverNumber.Value,
                    LapNumber = lapNumber.Value,
                    DateStart = ParseDateTime(lap, "date_start"),
                    LapDuration = GetDouble(lap, "lap_duration"),
                    DurationSector1 = GetDouble(lap, "duration_sector_1"),
                    DurationSector2 = GetDouble(lap, "duration_sector_2"),
                    DurationSector3 = GetDouble(lap, "duration_sector_3"),
                    I1Speed = GetInt(lap, "i1_speed"),
                    I2Speed = GetInt(lap, "i2_speed"),
                    StSpeed = GetInt(lap, "st_speed"),
                    IsPitOutLap = GetBool(lap, "is_pit_out_lap"),
                    SegmentsSector1 = NormalizeSegmentArray(lap, "segments_sector_1"),
                    SegmentsSector2 = NormalizeSegmentArray(lap, "segments_sector_2"),
                    SegmentsSector3 = NormalizeSegmentArray(lap, "segments_sector_3")
                };
            })
            .Where(row => row is not null)
            .Cast<LapRow>()
            .ToList();

        var weatherRows = data.Weather
            .Select(sample =>
            {
                if (!DateTime.TryParse(sample.Date, out var recorded))
                {
                    return null;
                }

                return new WeatherRow
                {
                    SessionKey = sessionKey,
                    RecordedAt = DateTime.SpecifyKind(recorded, DateTimeKind.Utc),
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

        await using var connection = await db.OpenConnectionAsync();
        await using var tx = await connection.BeginTransactionAsync();

        var hasTelemetry = telemetryRows.Count > 0;
        var sessionDataStatus = hasTelemetry ? "with_telemetry" : "no_telemetry";
        var refreshedAt = DateTime.UtcNow;

        var mergedMeeting = new
        {
            location = NullableString(meetingMeta?.Location) ?? NullableString(info.Location),
            country_name = NullableString(meetingMeta?.CountryName) ?? NullableString(info.CountryName),
            country_code = NullableString(meetingMeta?.CountryCode) ?? NullableString(info.CountryCode),
            country_key = meetingMeta?.CountryKey ?? info.CountryKey,
            gmt_offset = NullableString(meetingMeta?.GmtOffset) ?? NullableString(info.GmtOffset),
            circuit_key = meetingMeta?.CircuitKey ?? info.CircuitKey,
            circuit_short_name =
                NullableString(meetingMeta?.CircuitShortName) ?? NullableString(info.CircuitShortName),
            year = meetingMeta?.Year ?? info.Year,
            meeting_name = NullableString(meetingMeta?.MeetingName),
            meeting_official_name = NullableString(meetingMeta?.MeetingOfficialName)
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
            new { meeting_key = meetingKey, mergedMeeting.location, mergedMeeting.country_name, mergedMeeting.country_code, mergedMeeting.country_key, mergedMeeting.gmt_offset, mergedMeeting.circuit_key, mergedMeeting.circuit_short_name, mergedMeeting.year, mergedMeeting.meeting_name, mergedMeeting.meeting_official_name },
            tx);

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
              date_end = EXCLUDED.date_end,
              data_status = EXCLUDED.data_status,
              last_refreshed = EXCLUDED.last_refreshed
            """,
            new
            {
                session_key = sessionKey,
                meeting_key = meetingKey,
                session_type = info.SessionType,
                session_name = info.SessionName,
                date_start = ParseIsoDate(info.DateStart),
                date_end = ParseIsoDate(info.DateEnd),
                data_status = sessionDataStatus,
                last_refreshed = refreshedAt
            },
            tx);

        var aliasValues = new HashSet<string>();
        if (!string.IsNullOrWhiteSpace(alias))
        {
            aliasValues.Add(alias);
        }
        var circuitAlias = NullableString(info.CircuitShortName);
        if (!string.IsNullOrWhiteSpace(circuitAlias))
        {
            aliasValues.Add(circuitAlias);
        }

        foreach (var aliasValue in aliasValues)
        {
            await connection.ExecuteAsync(
                """
                INSERT INTO session_aliases (alias, session_key)
                VALUES (@alias, @session_key)
                ON CONFLICT (alias) DO UPDATE SET session_key = EXCLUDED.session_key
                """,
                new { alias = aliasValue, session_key = sessionKey },
                tx);
        }

        await connection.ExecuteAsync("DELETE FROM telemetry_samples WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey }, tx);
        await connection.ExecuteAsync("DELETE FROM pit_stops WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey }, tx);
        await connection.ExecuteAsync("DELETE FROM race_control_events WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey }, tx);
        await connection.ExecuteAsync("DELETE FROM stints WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey }, tx);
        await connection.ExecuteAsync("DELETE FROM laps WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey }, tx);
        await connection.ExecuteAsync("DELETE FROM weather_samples WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey }, tx);

        if (telemetryRows.Count > 0)
        {
            await InsertTelemetryAsync(connection, tx, telemetryRows);
        }
        if (pitRows.Count > 0)
        {
            await InsertPitStopsAsync(connection, tx, pitRows);
        }
        if (raceControlRows.Count > 0)
        {
            await InsertRaceControlAsync(connection, tx, raceControlRows);
        }
        if (stintRows.Count > 0)
        {
            await InsertStintsAsync(connection, tx, stintRows);
        }
        if (lapRows.Count > 0)
        {
            await InsertLapsAsync(connection, tx, lapRows);
        }
        if (weatherRows.Count > 0)
        {
            await InsertWeatherAsync(connection, tx, weatherRows);
        }

        await tx.CommitAsync();
    }

    private static List<TelemetryRow> MergeTelemetry(
        List<Dictionary<string, JsonElement>> carData,
        List<Dictionary<string, JsonElement>> locations,
        List<Dictionary<string, JsonElement>> laps,
        int sessionKey,
        int meetingKey,
        Dictionary<int, double> driverStartTimes)
    {
        var lapTimelines = BuildLapTimelines(laps, driverStartTimes);
        var lapPointers = new Dictionary<int, int>();
        var carByDriver = GroupByDriver(ToTimedEntries(carData));
        var locByDriver = GroupByDriver(ToTimedEntries(locations));
        var merged = new List<TelemetryRow>();

        foreach (var entry in carByDriver)
        {
            var driver = entry.Key;
            var carEntries = entry.Value;
            if (!locByDriver.TryGetValue(driver, out var locationEntries))
            {
                continue;
            }

            if (carEntries.Count == 0 || locationEntries.Count == 0)
            {
                continue;
            }

            var locIndex = 0;
            foreach (var car in carEntries)
            {
                while (locIndex + 1 < locationEntries.Count
                       && Math.Abs(locationEntries[locIndex + 1].Timestamp - car.Timestamp)
                       <= Math.Abs(locationEntries[locIndex].Timestamp - car.Timestamp))
                {
                    locIndex++;
                }

                var location = locationEntries[locIndex];
                var lapNumber = ResolveLapNumber(lapTimelines, lapPointers, driver, car.Timestamp);
                var sampleTime = DateTimeOffset.FromUnixTimeMilliseconds((long)car.Timestamp)
                    .UtcDateTime;

                merged.Add(new TelemetryRow
                {
                    SessionKey = sessionKey,
                    MeetingKey = meetingKey,
                    DriverNumber = driver,
                    SampleTime = sampleTime,
                    LapNumber = lapNumber,
                    Drs = GetInt(car.Record, "drs"),
                    Speed = GetInt(car.Record, "speed"),
                    Brake = GetInt(car.Record, "brake"),
                    Rpm = GetInt(car.Record, "rpm"),
                    NGear = GetInt(car.Record, "n_gear"),
                    Throttle = GetInt(car.Record, "throttle"),
                    X = GetInt(location.Record, "x"),
                    Y = GetInt(location.Record, "y"),
                    Z = GetInt(location.Record, "z"),
                    Latitude = GetDouble(location.Record, "latitude", "lat"),
                    Longitude = GetDouble(location.Record, "longitude", "long", "lon")
                });
            }
        }

        return merged;
    }

    private static Dictionary<int, List<TimedEntry>> GroupByDriver(List<TimedEntry> entries)
    {
        var grouped = new Dictionary<int, List<TimedEntry>>();
        foreach (var entry in entries)
        {
            var driver = GetInt(entry.Record, "driver_number");
            if (driver is null)
            {
                continue;
            }

            if (!grouped.TryGetValue(driver.Value, out var bucket))
            {
                bucket = [];
                grouped[driver.Value] = bucket;
            }

            bucket.Add(entry);
        }

        foreach (var bucket in grouped.Values)
        {
            bucket.Sort((a, b) => a.Timestamp.CompareTo(b.Timestamp));
        }

        return grouped;
    }

    private static Dictionary<int, List<LapTimelineEntry>> BuildLapTimelines(
        List<Dictionary<string, JsonElement>> laps,
        Dictionary<int, double> driverStartTimes)
    {
        var timelines = new Dictionary<int, List<LapTimelineEntry>>();
        foreach (var lap in laps)
        {
            var driver = GetInt(lap, "driver_number");
            var lapNumber = GetInt(lap, "lap_number");
            var startMs = ParseDateMs(lap, "date_start");
            if (driver is null || lapNumber is null)
            {
                continue;
            }

            var durationSec = GetDouble(lap, "lap_duration");
            if (!timelines.TryGetValue(driver.Value, out var timeline))
            {
                timeline = [];
                timelines[driver.Value] = timeline;
            }

            var isFirstLap = timeline.Count == 0;
            var fallbackStart = isFirstLap
                ? driverStartTimes.GetValueOrDefault(driver.Value, 0)
                : timeline[^1].End;
            var effectiveStart = startMs ?? fallbackStart;
            var endMs = startMs.HasValue && durationSec.HasValue
                ? startMs.Value + durationSec.Value * 1000
                : double.PositiveInfinity;

            timeline.Add(new LapTimelineEntry
            {
                Start = effectiveStart,
                End = endMs,
                Lap = lapNumber.Value
            });
        }

        foreach (var timeline in timelines.Values)
        {
            timeline.Sort((a, b) => a.Start.CompareTo(b.Start));
            for (var i = 0; i < timeline.Count; i++)
            {
                var nextStart = i + 1 < timeline.Count ? timeline[i + 1].Start : double.PositiveInfinity;
                if (!double.IsFinite(timeline[i].Start))
                {
                    timeline[i].Start = i == 0 ? 0 : timeline[i - 1].End;
                }

                if (!double.IsFinite(timeline[i].End) || timeline[i].End <= timeline[i].Start)
                {
                    timeline[i].End = nextStart;
                }
            }
        }

        return timelines;
    }

    private static Dictionary<int, double> ComputeDriverStartTimes(
        List<Dictionary<string, JsonElement>> carData)
    {
        var starts = new Dictionary<int, double>();
        foreach (var record in carData)
        {
            var driver = GetInt(record, "driver_number");
            if (driver is null)
            {
                continue;
            }

            var ts = ParseDateMs(record, "date");
            if (!ts.HasValue)
            {
                continue;
            }

            if (!starts.TryGetValue(driver.Value, out var existing) || ts.Value < existing)
            {
                starts[driver.Value] = ts.Value;
            }
        }

        return starts;
    }

    private static int? ResolveLapNumber(
        Dictionary<int, List<LapTimelineEntry>> timelines,
        Dictionary<int, int> pointers,
        int driver,
        double timestamp)
    {
        if (!timelines.TryGetValue(driver, out var timeline) || timeline.Count == 0)
        {
            return null;
        }

        var index = pointers.GetValueOrDefault(driver, 0);
        while (index + 1 < timeline.Count && timestamp >= timeline[index + 1].Start)
        {
            index++;
        }

        while (index < timeline.Count && timestamp > timeline[index].End)
        {
            index++;
        }

        if (index >= timeline.Count)
        {
            index = timeline.Count - 1;
        }

        pointers[driver] = index;
        return timeline[index].Lap;
    }

    private static List<TimedEntry> ToTimedEntries(
        List<Dictionary<string, JsonElement>> records)
    {
        var entries = new List<TimedEntry>();
        foreach (var record in records)
        {
            var rawDate = GetString(record, "date") ??
                          GetString(record, "time") ??
                          GetString(record, "timestamp");
            var timestamp = ParseDateMs(rawDate);
            if (!timestamp.HasValue)
            {
                continue;
            }

            entries.Add(new TimedEntry
            {
                Timestamp = timestamp.Value,
                Record = record
            });
        }

        entries.Sort((a, b) => a.Timestamp.CompareTo(b.Timestamp));
        return entries;
    }

    private static DateTime? ParseIsoDate(string value)
    {
        if (DateTimeOffset.TryParse(value, null, DateTimeStyles.AssumeUniversal, out var parsed))
        {
            return parsed.UtcDateTime;
        }

        return null;
    }

    private static DateTime? ParseDateTime(
        Dictionary<string, JsonElement> record,
        string key)
    {
        var value = GetString(record, key);
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

    private static double? ParseDateMs(Dictionary<string, JsonElement> record, string key)
    {
        var value = GetString(record, key);
        return ParseDateMs(value);
    }

    private static double? ParseDateMs(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        if (DateTimeOffset.TryParse(value, null, DateTimeStyles.AssumeUniversal, out var parsed))
        {
            return parsed.ToUnixTimeMilliseconds();
        }

        return null;
    }

    private static int? GetInt(Dictionary<string, JsonElement> record, params string[] keys)
    {
        foreach (var key in keys)
        {
            if (!record.TryGetValue(key, out var element))
            {
                continue;
            }

            if (element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out var number))
            {
                return number;
            }
            if (element.ValueKind == JsonValueKind.String
                && int.TryParse(element.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out number))
            {
                return number;
            }
        }

        return null;
    }

    private static double? GetDouble(Dictionary<string, JsonElement> record, params string[] keys)
    {
        foreach (var key in keys)
        {
            if (!record.TryGetValue(key, out var element))
            {
                continue;
            }

            if (element.ValueKind == JsonValueKind.Number && element.TryGetDouble(out var number))
            {
                return number;
            }
            if (element.ValueKind == JsonValueKind.String
                && double.TryParse(element.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out number))
            {
                return number;
            }
        }

        return null;
    }

    private static string? GetString(Dictionary<string, JsonElement> record, string key)
    {
        if (!record.TryGetValue(key, out var element))
        {
            return null;
        }

        if (element.ValueKind == JsonValueKind.String)
        {
            var value = element.GetString();
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }

        if (element.ValueKind == JsonValueKind.Number)
        {
            return element.GetRawText();
        }

        return null;
    }

    private static bool GetBool(Dictionary<string, JsonElement> record, string key)
    {
        if (!record.TryGetValue(key, out var element))
        {
            return false;
        }

        return element.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String => bool.TryParse(element.GetString(), out var value) && value,
            _ => false
        };
    }

    private static int?[]? NormalizeSegmentArray(Dictionary<string, JsonElement> record, string key)
    {
        if (!record.TryGetValue(key, out var element) || element.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var values = new List<int?>();
        foreach (var entry in element.EnumerateArray())
        {
            if (entry.ValueKind == JsonValueKind.Null)
            {
                values.Add(null);
            }
            else if (entry.ValueKind == JsonValueKind.Number && entry.TryGetInt32(out var num))
            {
                values.Add(num);
            }
            else if (entry.ValueKind == JsonValueKind.String
                     && int.TryParse(entry.GetString(), out var parsed))
            {
                values.Add(parsed);
            }
            else
            {
                values.Add(null);
            }
        }

        return values.ToArray();
    }

    private static string? NullableString(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static string? FormatIntArray(int?[]? values)
    {
        if (values is null)
        {
            return null;
        }

        var body = string.Join(
            ",",
            values.Select(value => value.HasValue ? value.Value.ToString(CultureInfo.InvariantCulture) : "NULL"));
        return $"{{{body}}}";
    }

    private static async Task InsertTelemetryAsync(
        Npgsql.NpgsqlConnection connection,
        Npgsql.NpgsqlTransaction tx,
        List<TelemetryRow> rows)
    {
        foreach (var chunk in Chunk(rows, BatchSize))
        {
            var uniqueRows = DedupeTelemetryRows(chunk);
            if (uniqueRows.Count == 0)
            {
                continue;
            }

            var sql = new StringBuilder();
            sql.Append(
                """
                INSERT INTO telemetry_samples (
                  session_key,
                  meeting_key,
                  driver_number,
                  sample_time,
                  lap_number,
                  drs,
                  speed,
                  brake,
                  rpm,
                  n_gear,
                  throttle,
                  x,
                  y,
                  z,
                  latitude,
                  longitude
                ) VALUES 
                """);

            var parameters = new DynamicParameters();
            for (var i = 0; i < uniqueRows.Count; i++)
            {
                var row = uniqueRows[i];
                if (i > 0)
                {
                    sql.Append(',');
                }

                sql.Append(
                    $"(@session_key{i}, @meeting_key{i}, @driver_number{i}, @sample_time{i}, @lap_number{i}, @drs{i}, @speed{i}, @brake{i}, @rpm{i}, @n_gear{i}, @throttle{i}, @x{i}, @y{i}, @z{i}, @latitude{i}, @longitude{i})");

                parameters.Add($"session_key{i}", row.SessionKey);
                parameters.Add($"meeting_key{i}", row.MeetingKey);
                parameters.Add($"driver_number{i}", row.DriverNumber);
                parameters.Add($"sample_time{i}", row.SampleTime);
                parameters.Add($"lap_number{i}", row.LapNumber);
                parameters.Add($"drs{i}", row.Drs);
                parameters.Add($"speed{i}", row.Speed);
                parameters.Add($"brake{i}", row.Brake);
                parameters.Add($"rpm{i}", row.Rpm);
                parameters.Add($"n_gear{i}", row.NGear);
                parameters.Add($"throttle{i}", row.Throttle);
                parameters.Add($"x{i}", row.X);
                parameters.Add($"y{i}", row.Y);
                parameters.Add($"z{i}", row.Z);
                parameters.Add($"latitude{i}", row.Latitude);
                parameters.Add($"longitude{i}", row.Longitude);
            }

            sql.Append(
                """
                ON CONFLICT (session_key, driver_number, sample_time) DO UPDATE SET
                  drs = EXCLUDED.drs,
                  speed = EXCLUDED.speed,
                  brake = EXCLUDED.brake,
                  rpm = EXCLUDED.rpm,
                  n_gear = EXCLUDED.n_gear,
                  throttle = EXCLUDED.throttle,
                  x = EXCLUDED.x,
                  y = EXCLUDED.y,
                  z = EXCLUDED.z,
                  latitude = EXCLUDED.latitude,
                  longitude = EXCLUDED.longitude
                """);

            await connection.ExecuteAsync(sql.ToString(), parameters, tx);
        }
    }

    private static async Task InsertPitStopsAsync(
        Npgsql.NpgsqlConnection connection,
        Npgsql.NpgsqlTransaction tx,
        List<PitStopRow> rows)
    {
        foreach (var row in rows)
        {
            await connection.ExecuteAsync(
                """
                INSERT INTO pit_stops (
                  session_key,
                  meeting_key,
                  driver_number,
                  lap_number,
                  stop_time,
                  pit_duration
                )
                VALUES (
                  @SessionKey,
                  @MeetingKey,
                  @DriverNumber,
                  @LapNumber,
                  @StopTime,
                  @PitDuration
                )
                ON CONFLICT (session_key, driver_number, stop_time) DO UPDATE SET
                  lap_number = EXCLUDED.lap_number,
                  pit_duration = EXCLUDED.pit_duration
                """,
                row,
                tx);
        }
    }

    private static async Task InsertRaceControlAsync(
        Npgsql.NpgsqlConnection connection,
        Npgsql.NpgsqlTransaction tx,
        List<RaceControlRow> rows)
    {
        foreach (var row in rows)
        {
            await connection.ExecuteAsync(
                """
                INSERT INTO race_control_events (
                  session_key,
                  meeting_key,
                  event_time,
                  lap_number,
                  driver_number,
                  category,
                  flag,
                  scope,
                  sector,
                  message
                )
                VALUES (
                  @SessionKey,
                  @MeetingKey,
                  @EventTime,
                  @LapNumber,
                  @DriverNumber,
                  @Category,
                  @Flag,
                  @Scope,
                  @Sector,
                  @Message
                )
                """,
                row,
                tx);
        }
    }

    private static async Task InsertStintsAsync(
        Npgsql.NpgsqlConnection connection,
        Npgsql.NpgsqlTransaction tx,
        List<StintRow> rows)
    {
        foreach (var row in rows)
        {
            await connection.ExecuteAsync(
                """
                INSERT INTO stints (
                  session_key,
                  meeting_key,
                  driver_number,
                  stint_number,
                  lap_start,
                  lap_end,
                  compound,
                  tyre_age_at_start
                )
                VALUES (
                  @SessionKey,
                  @MeetingKey,
                  @DriverNumber,
                  @StintNumber,
                  @LapStart,
                  @LapEnd,
                  @Compound,
                  @TyreAgeAtStart
                )
                ON CONFLICT (session_key, driver_number, stint_number) DO UPDATE SET
                  lap_start = EXCLUDED.lap_start,
                  lap_end = EXCLUDED.lap_end,
                  compound = EXCLUDED.compound,
                  tyre_age_at_start = EXCLUDED.tyre_age_at_start
                """,
                row,
                tx);
        }
    }

    private static async Task InsertLapsAsync(
        Npgsql.NpgsqlConnection connection,
        Npgsql.NpgsqlTransaction tx,
        List<LapRow> rows)
    {
        foreach (var row in rows)
        {
            await connection.ExecuteAsync(
                """
                INSERT INTO laps (
                  session_key,
                  meeting_key,
                  driver_number,
                  lap_number,
                  date_start,
                  lap_duration,
                  duration_sector_1,
                  duration_sector_2,
                  duration_sector_3,
                  i1_speed,
                  i2_speed,
                  st_speed,
                  is_pit_out_lap,
                  segments_sector_1,
                  segments_sector_2,
                  segments_sector_3
                )
                VALUES (
                  @SessionKey,
                  @MeetingKey,
                  @DriverNumber,
                  @LapNumber,
                  @DateStart,
                  @LapDuration,
                  @DurationSector1,
                  @DurationSector2,
                  @DurationSector3,
                  @I1Speed,
                  @I2Speed,
                  @StSpeed,
                  @IsPitOutLap,
                  @SegmentsSector1::int[],
                  @SegmentsSector2::int[],
                  @SegmentsSector3::int[]
                )
                ON CONFLICT (session_key, driver_number, lap_number) DO UPDATE SET
                  lap_duration = EXCLUDED.lap_duration,
                  duration_sector_1 = EXCLUDED.duration_sector_1,
                  duration_sector_2 = EXCLUDED.duration_sector_2,
                  duration_sector_3 = EXCLUDED.duration_sector_3,
                  date_start = EXCLUDED.date_start,
                  i1_speed = EXCLUDED.i1_speed,
                  i2_speed = EXCLUDED.i2_speed,
                  st_speed = EXCLUDED.st_speed,
                  is_pit_out_lap = EXCLUDED.is_pit_out_lap,
                  segments_sector_1 = EXCLUDED.segments_sector_1,
                  segments_sector_2 = EXCLUDED.segments_sector_2,
                  segments_sector_3 = EXCLUDED.segments_sector_3
                """,
                new
                {
                    row.SessionKey,
                    row.MeetingKey,
                    row.DriverNumber,
                    row.LapNumber,
                    row.DateStart,
                    row.LapDuration,
                    row.DurationSector1,
                    row.DurationSector2,
                    row.DurationSector3,
                    row.I1Speed,
                    row.I2Speed,
                    row.StSpeed,
                    row.IsPitOutLap,
                    SegmentsSector1 = FormatIntArray(row.SegmentsSector1),
                    SegmentsSector2 = FormatIntArray(row.SegmentsSector2),
                    SegmentsSector3 = FormatIntArray(row.SegmentsSector3)
                },
                tx);
        }
    }

    private static async Task InsertWeatherAsync(
        Npgsql.NpgsqlConnection connection,
        Npgsql.NpgsqlTransaction tx,
        List<WeatherRow> rows)
    {
        foreach (var chunk in Chunk(rows, BatchSize))
        {
            var sql = new StringBuilder();
            sql.Append(
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
                ) VALUES 
                """);

            var parameters = new DynamicParameters();
            for (var i = 0; i < chunk.Count; i++)
            {
                var row = chunk[i];
                if (i > 0)
                {
                    sql.Append(',');
                }

                sql.Append(
                    $"(@session_key{i}, @recorded_at{i}, @air_temperature{i}, @humidity{i}, @pressure{i}, @rainfall{i}, @track_temperature{i}, @wind_direction{i}, @wind_speed{i})");

                parameters.Add($"session_key{i}", row.SessionKey);
                parameters.Add($"recorded_at{i}", row.RecordedAt);
                parameters.Add($"air_temperature{i}", row.AirTemperature);
                parameters.Add($"humidity{i}", row.Humidity);
                parameters.Add($"pressure{i}", row.Pressure);
                parameters.Add($"rainfall{i}", row.Rainfall);
                parameters.Add($"track_temperature{i}", row.TrackTemperature);
                parameters.Add($"wind_direction{i}", row.WindDirection);
                parameters.Add($"wind_speed{i}", row.WindSpeed);
            }

            sql.Append(
                """
                ON CONFLICT (session_key, recorded_at) DO UPDATE SET
                  air_temperature = EXCLUDED.air_temperature,
                  humidity = EXCLUDED.humidity,
                  pressure = EXCLUDED.pressure,
                  rainfall = EXCLUDED.rainfall,
                  track_temperature = EXCLUDED.track_temperature,
                  wind_direction = EXCLUDED.wind_direction,
                  wind_speed = EXCLUDED.wind_speed
                """);

            await connection.ExecuteAsync(sql.ToString(), parameters, tx);
        }
    }

    private static List<List<T>> Chunk<T>(List<T> values, int size)
    {
        var chunks = new List<List<T>>();
        for (var i = 0; i < values.Count; i += size)
        {
            chunks.Add(values.Skip(i).Take(size).ToList());
        }

        return chunks;
    }

    private static List<TelemetryRow> DedupeTelemetryRows(List<TelemetryRow> rows)
    {
        var seen = new HashSet<string>();
        var result = new List<TelemetryRow>();
        foreach (var row in rows)
        {
            var key = $"{row.SessionKey}:{row.DriverNumber}:{row.SampleTime:O}";
            if (seen.Add(key))
            {
                result.Add(row);
            }
        }

        return result;
    }

    [DoesNotReturn]
    private static void PrintUsage()
    {
        Console.Error.WriteLine(
            "Usage: dotnet run -- import-session -- [--file <path>|--session <session_key>|--meeting <meeting_key>|<path>] [--no-telemetry]");
        Environment.Exit(1);
    }

    private sealed record ResolvedImport(ImportSource Source, bool IncludeTelemetry);

    private sealed record ImportSource
    {
        public ImportKind Kind { get; init; }
        public string Value { get; init; } = string.Empty;
        public string Path { get; init; } = string.Empty;
        public int Key { get; init; }
        public int Start { get; init; }
        public int End { get; init; }

        public static ImportSource File(string path) => new() { Kind = ImportKind.File, Path = path };
        public static ImportSource Session(string key) => new() { Kind = ImportKind.Session, Value = key };
        public static ImportSource SessionRange(int start, int end) => new()
        {
            Kind = ImportKind.SessionRange,
            Start = start,
            End = end
        };
        public static ImportSource Meeting(int key) => new() { Kind = ImportKind.Meeting, Key = key };
        public static ImportSource MeetingRange(int start, int end) => new()
        {
            Kind = ImportKind.MeetingRange,
            Start = start,
            End = end
        };
    }

    private enum ImportKind
    {
        File,
        Session,
        SessionRange,
        Meeting,
        MeetingRange
    }

    private sealed record TimedEntry
    {
        public required double Timestamp { get; init; }
        public required Dictionary<string, JsonElement> Record { get; init; }
    }

    private sealed record LapTimelineEntry
    {
        public double Start { get; set; }
        public double End { get; set; }
        public int Lap { get; init; }
    }

    private sealed record TelemetryRow
    {
        public int SessionKey { get; init; }
        public int MeetingKey { get; init; }
        public int DriverNumber { get; init; }
        public DateTime SampleTime { get; init; }
        public int? LapNumber { get; init; }
        public int? Drs { get; init; }
        public int? Speed { get; init; }
        public int? Brake { get; init; }
        public int? Rpm { get; init; }
        public int? NGear { get; init; }
        public int? Throttle { get; init; }
        public int? X { get; init; }
        public int? Y { get; init; }
        public int? Z { get; init; }
        public double? Latitude { get; init; }
        public double? Longitude { get; init; }
    }

    private sealed record PitStopRow
    {
        public int SessionKey { get; init; }
        public int MeetingKey { get; init; }
        public int DriverNumber { get; init; }
        public int LapNumber { get; init; }
        public DateTime StopTime { get; init; }
        public double? PitDuration { get; init; }
    }

    private sealed record RaceControlRow
    {
        public int SessionKey { get; init; }
        public int MeetingKey { get; init; }
        public DateTime EventTime { get; init; }
        public int? LapNumber { get; init; }
        public int? DriverNumber { get; init; }
        public string Category { get; init; } = string.Empty;
        public string? Flag { get; init; }
        public string? Scope { get; init; }
        public string? Sector { get; init; }
        public string? Message { get; init; }
    }

    private sealed record StintRow
    {
        public int SessionKey { get; init; }
        public int MeetingKey { get; init; }
        public int DriverNumber { get; init; }
        public int StintNumber { get; init; }
        public int? LapStart { get; init; }
        public int? LapEnd { get; init; }
        public string? Compound { get; init; }
        public int? TyreAgeAtStart { get; init; }
    }

    private sealed record LapRow
    {
        public int SessionKey { get; init; }
        public int MeetingKey { get; init; }
        public int DriverNumber { get; init; }
        public int LapNumber { get; init; }
        public DateTime? DateStart { get; init; }
        public double? LapDuration { get; init; }
        public double? DurationSector1 { get; init; }
        public double? DurationSector2 { get; init; }
        public double? DurationSector3 { get; init; }
        public int? I1Speed { get; init; }
        public int? I2Speed { get; init; }
        public int? StSpeed { get; init; }
        public bool IsPitOutLap { get; init; }
        public int?[]? SegmentsSector1 { get; init; }
        public int?[]? SegmentsSector2 { get; init; }
        public int?[]? SegmentsSector3 { get; init; }
    }

    private sealed record WeatherRow
    {
        public int SessionKey { get; init; }
        public DateTime RecordedAt { get; init; }
        public double? AirTemperature { get; init; }
        public double? Humidity { get; init; }
        public double? Pressure { get; init; }
        public double? Rainfall { get; init; }
        public double? TrackTemperature { get; init; }
        public double? WindDirection { get; init; }
        public double? WindSpeed { get; init; }
    }
}
