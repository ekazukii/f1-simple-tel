using System.Globalization;
using Backend.Data;
using Dapper;

namespace Backend.Scripts;

public static class ExportScDatasetScript
{
    private static readonly HashSet<string> StreetCircuits =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "MONACO",
            "BAKU",
            "JEDDAH",
            "SINGAPORE",
            "MIAMI",
            "LAS_VEGAS",
            "MELBOURNE",
            "MONTREAL"
        };

    public static async Task RunAsync(string[] args, IServiceProvider services)
    {
        var options = ParseArgs(args);
        var db = services.GetRequiredService<Database>();
        await DatabaseMigrator.InitializeAsync(db);

        await using var connection = await db.OpenConnectionAsync();
        var sessions = (await connection.QueryAsync<SessionRecord>(
            """
            SELECT
              s.session_key,
              s.meeting_key,
              s.session_type,
              s.session_name,
              s.date_start,
              s.date_end,
              m.year,
              m.circuit_short_name,
              m.meeting_name
            FROM sessions s
            JOIN meetings m ON m.meeting_key = s.meeting_key
            WHERE s.session_type IN ('Race','Sprint')
              AND m.year BETWEEN 2023 AND 2025
            ORDER BY m.year, s.date_start
            """)).ToList();

        var filteredSessions = sessions.Where(session => options.Years.Contains(session.Year)).ToList();
        if (filteredSessions.Count == 0)
        {
            Console.Error.WriteLine("[Export] No sessions found for requested years");
            Environment.Exit(1);
        }

        var outputFile = Path.GetFullPath(options.OutputPath);
        Directory.CreateDirectory(Path.GetDirectoryName(outputFile) ?? ".");
        await using var stream = new StreamWriter(outputFile);
        await stream.WriteLineAsync(
            string.Join(
                ",",
                new[]
                {
                    "race_id",
                    "year",
                    "circuit_id",
                    "is_street_circuit",
                    "lap_number",
                    "total_laps",
                    "status_sc_active",
                    "status_vsc_active",
                    "num_cars_running",
                    "min_gap_between_any_cars",
                    "num_pairs_gap_lt_1s",
                    "num_pitstops_last_1_lap",
                    "avg_tyre_age_laps",
                    "air_temperature",
                    "humidity",
                    "pressure",
                    "rainfall",
                    "track_temperature",
                    "wind_speed",
                    "label_sc_next_lap"
                }.Select(CsvEscape)));

        foreach (var session in filteredSessions)
        {
            Console.WriteLine($"\n[Export] Processing session {session.SessionKey}");
            var data = await LoadSessionDataAsync(connection, session.SessionKey);
            var rows = BuildLapRows(session, data);
            foreach (var row in rows)
            {
                await stream.WriteLineAsync(row);
            }
        }

        Console.WriteLine($"[Export] CSV written to {outputFile}");
    }

    private static async Task<SessionData> LoadSessionDataAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey)
    {
        var laps = (await connection.QueryAsync<LapRecordRow>(
            """
            SELECT driver_number, lap_number, date_start, lap_duration
            FROM laps
            WHERE session_key = @SessionKey
            """,
            new { SessionKey = sessionKey })).ToList();

        var pitStops = (await connection.QueryAsync<PitStopRow>(
            """
            SELECT lap_number
            FROM pit_stops
            WHERE session_key = @SessionKey
            """,
            new { SessionKey = sessionKey })).ToList();

        var stints = (await connection.QueryAsync<StintRecord>(
            """
            SELECT driver_number, lap_start, lap_end, tyre_age_at_start
            FROM stints
            WHERE session_key = @SessionKey
            """,
            new { SessionKey = sessionKey })).ToList();

        var raceControl = (await connection.QueryAsync<RaceControlRow>(
            """
            SELECT event_time, message, flag
            FROM race_control_events
            WHERE session_key = @SessionKey
            ORDER BY event_time
            """,
            new { SessionKey = sessionKey })).ToList();

        var weather = (await connection.QueryAsync<WeatherRow>(
            """
            SELECT
              recorded_at,
              air_temperature,
              humidity,
              pressure,
              rainfall,
              track_temperature,
              wind_direction,
              wind_speed
            FROM weather_samples
            WHERE session_key = @SessionKey
            ORDER BY recorded_at
            """,
            new { SessionKey = sessionKey })).ToList();

        return new SessionData(laps, pitStops, stints, raceControl, weather);
    }

    private static List<string> BuildLapRows(SessionRecord session, SessionData data)
    {
        var totalLaps = Math.Max(data.Laps.Select(lap => lap.LapNumber).DefaultIfEmpty(0).Max(), 0);
        if (totalLaps == 0)
        {
            return [];
        }

        var lapEntries = new Dictionary<int, List<LapEntry>>();
        var maxLapByDriver = new Dictionary<int, int>();
        foreach (var lap in data.Laps)
        {
            if (lap.LapNumber <= 0)
            {
                continue;
            }

            var finish = ComputeLapFinish(lap);
            if (!lapEntries.TryGetValue(lap.LapNumber, out var list))
            {
                list = [];
                lapEntries[lap.LapNumber] = list;
            }

            list.Add(new LapEntry(lap.DriverNumber, finish));
            var prevMax = maxLapByDriver.GetValueOrDefault(lap.DriverNumber, 0);
            if (lap.LapNumber > prevMax)
            {
                maxLapByDriver[lap.DriverNumber] = lap.LapNumber;
            }
        }

        var pitStopsByLap = new Dictionary<int, int>();
        foreach (var stop in data.PitStops)
        {
            if (stop.LapNumber <= 0)
            {
                continue;
            }

            pitStopsByLap[stop.LapNumber] = pitStopsByLap.GetValueOrDefault(stop.LapNumber, 0) + 1;
        }

        var stintsByDriver = new Dictionary<int, List<StintInfo>>();
        foreach (var stint in data.Stints)
        {
            var driver = stint.DriverNumber;
            if (!stintsByDriver.TryGetValue(driver, out var list))
            {
                list = [];
                stintsByDriver[driver] = list;
            }

            var lapStart = stint.LapStart ?? 1;
            var lapEnd = stint.LapEnd ?? totalLaps;
            list.Add(new StintInfo(lapStart, lapEnd, stint.TyreAgeAtStart ?? 0));
        }

        foreach (var list in stintsByDriver.Values)
        {
            list.Sort((a, b) => a.Start.CompareTo(b.Start));
        }

        var raceEndMs = ToUnixTimeMs(session.DateEnd);
        var scData = BuildSafetyData(data.RaceControl, raceEndMs);
        var weatherTimeline = data.Weather
            .Select(sample => new WeatherTimeline(ToUnixTimeMs(sample.RecordedAt), sample))
            .ToList();

        var rows = new List<string>();
        var lapEndTimes = new Dictionary<int, long>();
        double? lastMinGap = null;
        double? lastAvgTyre = null;

        var sessionStartMs = ToUnixTimeMs(session.DateStart);
        for (var lap = 1; lap <= totalLaps; lap++)
        {
            var entries = lapEntries.GetValueOrDefault(lap, []);
            entries.Sort((a, b) => a.Finish.CompareTo(b.Finish));

            var leaderFinish = entries.Count > 0
                ? entries[0].Finish
                : lapEndTimes.GetValueOrDefault(lap - 1, sessionStartMs);
            lapEndTimes[lap] = leaderFinish;

            var numCarsRunning = CountCarsRunning(maxLapByDriver, lap);
            var gapStats = ComputeGapStats(entries);
            var pitCount = pitStopsByLap.GetValueOrDefault(lap, 0);
            var avgTyreAge = ComputeAverageTyreAge(stintsByDriver, lap, numCarsRunning);
            var minGapValue = gapStats.MinGap ?? lastMinGap;
            var avgTyreValue = avgTyreAge ?? lastAvgTyre;
            var weatherSample = PickWeatherSample(weatherTimeline, leaderFinish);
            var scActive = IsTimeInIntervals(leaderFinish, scData.ScIntervals) ? 1 : 0;
            var vscActive = IsTimeInIntervals(leaderFinish, scData.VscIntervals) ? 1 : 0;
            var nextLabel = ComputeNextScLabel(
                lap,
                lapEndTimes,
                totalLaps,
                scData.ScDeployTimes,
                raceEndMs);

            var raceId = BuildRaceId(session);
            var circuitId = (session.CircuitShortName ?? session.MeetingName ?? session.MeetingKey.ToString())
                .Replace(" ", "_", StringComparison.Ordinal)
                .ToUpperInvariant();
            var streetFlag = StreetCircuits.Contains(session.CircuitShortName ?? string.Empty) ? 1 : 0;

            var row = string.Join(
                ",",
                new[]
                {
                    raceId,
                    session.Year.ToString(CultureInfo.InvariantCulture),
                    circuitId,
                    streetFlag.ToString(CultureInfo.InvariantCulture),
                    lap.ToString(CultureInfo.InvariantCulture),
                    totalLaps.ToString(CultureInfo.InvariantCulture),
                    scActive.ToString(CultureInfo.InvariantCulture),
                    vscActive.ToString(CultureInfo.InvariantCulture),
                    numCarsRunning.ToString(CultureInfo.InvariantCulture),
                    FormatNumber(minGapValue),
                    gapStats.PairsLt1s.ToString(CultureInfo.InvariantCulture),
                    pitCount.ToString(CultureInfo.InvariantCulture),
                    FormatNumber(avgTyreValue),
                    FormatNumber(weatherSample?.AirTemperature),
                    FormatNumber(weatherSample?.Humidity),
                    FormatNumber(weatherSample?.Pressure),
                    FormatNumber(weatherSample?.Rainfall),
                    FormatNumber(weatherSample?.TrackTemperature),
                    FormatNumber(weatherSample?.WindSpeed),
                    nextLabel.ToString(CultureInfo.InvariantCulture)
                }.Select(CsvEscape));

            rows.Add(row);

            if (minGapValue.HasValue)
            {
                lastMinGap = minGapValue;
            }

            if (avgTyreValue.HasValue)
            {
                lastAvgTyre = avgTyreValue;
            }
        }

        return rows;
    }

    private static long ComputeLapFinish(LapRecordRow lap)
    {
        var startMs = lap.DateStart.HasValue ? ToUnixTimeMs(lap.DateStart.Value) : 0;
        var durationMs = (lap.LapDuration ?? 0) * 1000;
        if (startMs > 0)
        {
            return startMs + (long)durationMs;
        }

        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private static int CountCarsRunning(Dictionary<int, int> maxLapByDriver, int lap)
    {
        var count = 0;
        foreach (var maxLap in maxLapByDriver.Values)
        {
            if (maxLap >= lap)
            {
                count++;
            }
        }

        return count;
    }

    private static GapStats ComputeGapStats(List<LapEntry> entries)
    {
        if (entries.Count < 2)
        {
            return new GapStats(null, 0);
        }

        double? minGap = null;
        var pairsLt1s = 0;
        for (var i = 1; i < entries.Count; i++)
        {
            var gap = (entries[i].Finish - entries[i - 1].Finish) / 1000.0;
            if (gap < 0)
            {
                continue;
            }

            minGap = minGap.HasValue ? Math.Min(minGap.Value, gap) : gap;
            if (gap < 1)
            {
                pairsLt1s++;
            }
        }

        return new GapStats(minGap, pairsLt1s);
    }

    private static double? ComputeAverageTyreAge(
        Dictionary<int, List<StintInfo>> stintsByDriver,
        int lap,
        int numCarsRunning)
    {
        if (numCarsRunning == 0)
        {
            return null;
        }

        var sum = 0.0;
        var count = 0;
        foreach (var entry in stintsByDriver)
        {
            var stint = entry.Value.FirstOrDefault(s => lap >= s.Start && lap <= s.End);
            if (stint is null)
            {
                continue;
            }

            var age = stint.AgeStart + (lap - stint.Start + 1);
            if (double.IsFinite(age))
            {
                sum += age;
                count++;
            }
        }

        if (count == 0)
        {
            return null;
        }

        return sum / count;
    }

    private static WeatherRow? PickWeatherSample(
        List<WeatherTimeline> samples,
        long targetTime)
    {
        if (samples.Count == 0)
        {
            return null;
        }

        var picked = samples[0].Values;
        foreach (var sample in samples)
        {
            if (sample.Time <= targetTime)
            {
                picked = sample.Values;
            }
            else
            {
                break;
            }
        }

        return picked;
    }

    private static SafetyData BuildSafetyData(List<RaceControlRow> events, long sessionEndMs)
    {
        var scIntervals = new List<Interval>();
        var vscIntervals = new List<Interval>();
        var scDeployTimes = new List<long>();

        long? scStart = null;
        long? vscStart = null;

        foreach (var evt in events)
        {
            var time = ToUnixTimeMs(evt.EventTime);
            var kind = ClassifyRaceControlEvent(evt);
            if (kind == "sc_start")
            {
                if (scStart is null)
                {
                    scStart = time;
                    scDeployTimes.Add(time);
                }
            }
            else if (kind == "sc_end" && scStart.HasValue)
            {
                scIntervals.Add(new Interval(scStart.Value, time));
                scStart = null;
            }
            else if (kind == "vsc_start")
            {
                if (vscStart is null)
                {
                    vscStart = time;
                }
            }
            else if (kind == "vsc_end" && vscStart.HasValue)
            {
                vscIntervals.Add(new Interval(vscStart.Value, time));
                vscStart = null;
            }
        }

        if (scStart.HasValue)
        {
            scIntervals.Add(new Interval(scStart.Value, sessionEndMs));
        }

        if (vscStart.HasValue)
        {
            vscIntervals.Add(new Interval(vscStart.Value, sessionEndMs));
        }

        return new SafetyData(scIntervals, vscIntervals, scDeployTimes);
    }

    private static string? ClassifyRaceControlEvent(RaceControlRow row)
    {
        var message = (row.Message ?? string.Empty).ToUpperInvariant();
        if (message.Contains("VIRTUAL SAFETY CAR", StringComparison.Ordinal))
        {
            if (message.Contains("DEPLOY", StringComparison.Ordinal))
            {
                return "vsc_start";
            }

            if (message.Contains("ENDING", StringComparison.Ordinal)
                || message.Contains("IN THIS LAP", StringComparison.Ordinal)
                || message.Contains("NOT ACTIVE", StringComparison.Ordinal))
            {
                return "vsc_end";
            }
        }

        if (message.Contains("SAFETY CAR", StringComparison.Ordinal))
        {
            if (!message.Contains("VIRTUAL", StringComparison.Ordinal))
            {
                if (message.Contains("DEPLOY", StringComparison.Ordinal))
                {
                    return "sc_start";
                }

                if (message.Contains("IN THIS LAP", StringComparison.Ordinal)
                    || message.Contains("ENDING", StringComparison.Ordinal)
                    || message.Contains("NOT ACTIVE", StringComparison.Ordinal))
                {
                    return "sc_end";
                }
            }
        }

        return null;
    }

    private static bool IsTimeInIntervals(long time, List<Interval> intervals)
    {
        return intervals.Any(interval => time >= interval.Start && time <= interval.End);
    }

    private static int ComputeNextScLabel(
        int lap,
        Dictionary<int, long> lapEndTimes,
        int totalLaps,
        List<long> scDeployTimes,
        long sessionEndMs)
    {
        if (lap >= totalLaps)
        {
            return 0;
        }

        var currentEnd = lapEndTimes.GetValueOrDefault(lap, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        var nextEnd = lapEndTimes.GetValueOrDefault(lap + 1, sessionEndMs);
        return scDeployTimes.Any(time => time > currentEnd && time <= nextEnd) ? 1 : 0;
    }

    private static string BuildRaceId(SessionRecord session)
    {
        var circuit = (session.CircuitShortName ?? session.MeetingName ?? string.Empty)
            .Replace(" ", "_", StringComparison.Ordinal);
        var normalizedName = (session.SessionName ?? string.Empty).ToLowerInvariant();
        var isSprint = session.SessionType.ToLowerInvariant().Contains("sprint", StringComparison.Ordinal)
                       || normalizedName.Contains("sprint", StringComparison.Ordinal);
        var suffix = isSprint ? "S" : "R";
        var baseId = string.IsNullOrWhiteSpace(circuit) ? session.MeetingKey.ToString() : circuit;
        return $"{session.Year}_{baseId}_{suffix}".ToUpperInvariant();
    }

    private static string CsvEscape(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        if (value.Contains(',') || value.Contains('"') || value.Contains('\n'))
        {
            return $"\"{value.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
        }

        return value;
    }

    private static string FormatNumber(double? value)
    {
        if (!value.HasValue || double.IsNaN(value.Value))
        {
            return string.Empty;
        }

        return value.Value.ToString("0.###", CultureInfo.InvariantCulture);
    }

    private static Options ParseArgs(string[] args)
    {
        var outputPath = Path.GetFullPath("race_state.csv");
        var years = new HashSet<int> { 2023, 2024, 2025 };
        var customYears = false;

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if ((arg == "--output" || arg == "-o") && i + 1 < args.Length)
            {
                outputPath = Path.GetFullPath(args[i + 1]);
                i++;
            }
            else if (arg == "--year" && i + 1 < args.Length)
            {
                if (!customYears)
                {
                    years.Clear();
                    customYears = true;
                }
                if (int.TryParse(args[i + 1], out var year))
                {
                    years.Add(year);
                }
                i++;
            }
            else if (arg.StartsWith("--year=", StringComparison.Ordinal))
            {
                if (!customYears)
                {
                    years.Clear();
                    customYears = true;
                }

                if (int.TryParse(arg.Split('=')[1], out var year))
                {
                    years.Add(year);
                }
            }
        }

        return new Options(outputPath, years.Where(y => y > 0).ToList());
    }

    private static long ToUnixTimeMs(DateTime value)
    {
        var utc = value.Kind == DateTimeKind.Utc ? value : DateTime.SpecifyKind(value, DateTimeKind.Utc);
        return new DateTimeOffset(utc).ToUnixTimeMilliseconds();
    }

    private sealed record Options(string OutputPath, List<int> Years);
    private sealed record SessionRecord
    {
        public int SessionKey { get; init; }
        public int MeetingKey { get; init; }
        public string SessionType { get; init; } = string.Empty;
        public string SessionName { get; init; } = string.Empty;
        public DateTime DateStart { get; init; }
        public DateTime DateEnd { get; init; }
        public int Year { get; init; }
        public string? CircuitShortName { get; init; }
        public string? MeetingName { get; init; }
    }

    private sealed record LapRecordRow
    {
        public int DriverNumber { get; init; }
        public int LapNumber { get; init; }
        public DateTime? DateStart { get; init; }
        public double? LapDuration { get; init; }
    }

    private sealed record PitStopRow
    {
        public int LapNumber { get; init; }
    }

    private sealed record StintRecord
    {
        public int DriverNumber { get; init; }
        public int? LapStart { get; init; }
        public int? LapEnd { get; init; }
        public int? TyreAgeAtStart { get; init; }
    }

    private sealed record RaceControlRow
    {
        public DateTime EventTime { get; init; }
        public string? Message { get; init; }
        public string? Flag { get; init; }
    }

    private sealed record WeatherRow
    {
        public DateTime RecordedAt { get; init; }
        public double? AirTemperature { get; init; }
        public double? Humidity { get; init; }
        public double? Pressure { get; init; }
        public double? Rainfall { get; init; }
        public double? TrackTemperature { get; init; }
        public double? WindDirection { get; init; }
        public double? WindSpeed { get; init; }
    }

    private sealed record SessionData(
        List<LapRecordRow> Laps,
        List<PitStopRow> PitStops,
        List<StintRecord> Stints,
        List<RaceControlRow> RaceControl,
        List<WeatherRow> Weather);

    private sealed record LapEntry(int Driver, long Finish);
    private sealed record StintInfo(int Start, int End, int AgeStart);
    private sealed record GapStats(double? MinGap, int PairsLt1s);
    private sealed record WeatherTimeline(long Time, WeatherRow Values);
    private sealed record Interval(long Start, long End);
    private sealed record SafetyData(
        List<Interval> ScIntervals,
        List<Interval> VscIntervals,
        List<long> ScDeployTimes);
}
