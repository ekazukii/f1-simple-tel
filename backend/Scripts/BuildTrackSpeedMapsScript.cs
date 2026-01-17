using System.Globalization;
using Backend.Data;
using Dapper;

namespace Backend.Scripts;

public static class BuildTrackSpeedMapsScript
{
    private static readonly string OutDir =
        Path.Combine(Directory.GetCurrentDirectory(), "assets", "track_speed_maps");
    private static readonly int CanvasWidth = GetEnvInt("TRACK_SPEED_WIDTH", 900);
    private static readonly int CanvasHeight = GetEnvInt("TRACK_SPEED_HEIGHT", 500);
    private static readonly int CanvasPadding = GetEnvInt("TRACK_SPEED_PADDING", 24);
    private static readonly int MaxPoints = GetEnvInt("TRACK_SPEED_MAX_POINTS", 1000);
    private static readonly int SampleSeconds = GetEnvInt("TRACK_SPEED_SAMPLE_SECONDS", 1);
    private static readonly int SpeedBins = GetEnvInt("TRACK_SPEED_BINS", 128);

    public static async Task RunAsync(string[] args, IServiceProvider services)
    {
        var options = ParseArgs(args);
        var db = services.GetRequiredService<Database>();
        await DatabaseMigrator.InitializeAsync(db);
        Directory.CreateDirectory(OutDir);

        await using var connection = await db.OpenConnectionAsync();
        var sessionRows = (await FetchRaceSessionsAsync(connection)).ToList();
        var targets = options.Sessions.Count > 0
            ? sessionRows.Where(session => options.Sessions.Contains(session.SessionKey)).ToList()
            : sessionRows;

        if (targets.Count == 0)
        {
            Console.WriteLine("[TRACK SPEED] No race sessions found");
            return;
        }

        foreach (var session in targets)
        {
            var label = session.CircuitShortName ?? "Unknown circuit";
            var year = session.Year.HasValue ? $" {session.Year}" : string.Empty;
            Console.WriteLine($"[TRACK SPEED] Session {session.SessionKey} ({label}{year})");
            await BuildForSessionAsync(connection, session, options.Force);
        }
    }

    private static async Task<IEnumerable<SessionRow>> FetchRaceSessionsAsync(
        Npgsql.NpgsqlConnection connection)
    {
        return await connection.QueryAsync<SessionRow>(
            """
            SELECT s.session_key, s.session_name, m.circuit_short_name, m.year
            FROM sessions s
            JOIN meetings m ON m.meeting_key = s.meeting_key
            WHERE UPPER(s.session_type) = 'RACE'
            ORDER BY s.date_start
            """);
    }

    private static async Task<List<TelemetryRow>> FetchTelemetryAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey)
    {
        if (SampleSeconds > 0)
        {
            return (await connection.QueryAsync<TelemetryRow>(
                """
                SELECT
                  driver_number,
                  lap_number,
                  sample_time,
                  speed,
                  x,
                  y,
                  latitude,
                  longitude
                FROM (
                  SELECT
                    driver_number,
                    lap_number,
                    sample_time,
                    speed,
                    x,
                    y,
                    latitude,
                    longitude,
                    ROW_NUMBER() OVER (
                      PARTITION BY driver_number,
                        time_bucket(@SampleSeconds * INTERVAL '1 second', sample_time)
                      ORDER BY sample_time DESC
                    ) AS row_rank
                  FROM telemetry_samples
                  WHERE session_key = @SessionKey
                    AND lap_number IS NOT NULL
                    AND lap_number > 0
                ) AS ranked
                WHERE row_rank = 1
                ORDER BY driver_number, lap_number, sample_time
                """,
                new { SessionKey = sessionKey, SampleSeconds = SampleSeconds })).ToList();
        }

        return (await connection.QueryAsync<TelemetryRow>(
            """
            SELECT
              driver_number,
              lap_number,
              sample_time,
              speed,
              x,
              y,
              latitude,
              longitude
            FROM telemetry_samples
            WHERE session_key = @SessionKey
              AND lap_number IS NOT NULL
              AND lap_number > 0
            ORDER BY driver_number, lap_number, sample_time
            """,
            new { SessionKey = sessionKey })).ToList();
    }

    private static async Task BuildForSessionAsync(
        Npgsql.NpgsqlConnection connection,
        SessionRow session,
        bool force)
    {
        var rows = await FetchTelemetryAsync(connection, session.SessionKey);
        if (rows.Count == 0)
        {
            Console.WriteLine($"[TRACK SPEED] No telemetry for session {session.SessionKey}");
            return;
        }

        int? currentDriver = null;
        int? currentLap = null;
        var points = new List<TrackPoint>();
        var sampleCount = 0;

        async Task FlushAsync()
        {
            if (!currentDriver.HasValue || !currentLap.HasValue || points.Count < 2)
            {
                points.Clear();
                sampleCount = 0;
                return;
            }

            var label = $"Session {session.SessionKey} driver {currentDriver} lap {currentLap}";
            var svg = BuildSvg(points, label);
            if (svg is null)
            {
                points.Clear();
                sampleCount = 0;
                return;
            }

            var written = await WriteSvgFileAsync(
                session.SessionKey,
                currentDriver.Value,
                currentLap.Value,
                svg,
                force);
            if (written)
            {
                Console.WriteLine(
                    $"[TRACK SPEED] Wrote {session.SessionKey} driver {currentDriver} lap {currentLap}");
            }

            points.Clear();
            sampleCount = 0;
        }

        foreach (var row in rows)
        {
            var driverNumber = row.DriverNumber;
            var lapNumber = row.LapNumber;
            if (!driverNumber.HasValue || !lapNumber.HasValue)
            {
                continue;
            }

            var isNewLap = currentDriver is null
                           || currentLap is null
                           || driverNumber != currentDriver
                           || lapNumber != currentLap;

            if (isNewLap)
            {
                await FlushAsync();
                currentDriver = driverNumber;
                currentLap = lapNumber;
            }

            if (sampleCount >= MaxPoints)
            {
                continue;
            }

            var position = PickPosition(row);
            if (position is null)
            {
                continue;
            }

            var speed = row.Speed;
            points.Add(new TrackPoint
            {
                X = position.Value.X,
                Y = position.Value.Y,
                Speed = speed
            });
            sampleCount++;
        }

        await FlushAsync();
    }

    private static (double X, double Y)? PickPosition(TelemetryRow row)
    {
        if (row.X.HasValue && row.Y.HasValue)
        {
            return (row.X.Value, row.Y.Value);
        }

        if (row.Longitude.HasValue && row.Latitude.HasValue)
        {
            return (row.Longitude.Value, row.Latitude.Value);
        }

        return null;
    }

    private static string? BuildSvg(List<TrackPoint> points, string label)
    {
        if (points.Count < 2)
        {
            return null;
        }

        var bounds = GetBounds(points);
        if (!double.IsFinite(bounds.MinX) || !double.IsFinite(bounds.MinY))
        {
            return null;
        }

        var speedBounds = GetSpeedBounds(points);
        double ScaleX(double value) =>
            CanvasPadding +
            ((value - bounds.MinX) / (bounds.MaxX - bounds.MinX == 0 ? 1 : bounds.MaxX - bounds.MinX)) *
            (CanvasWidth - CanvasPadding * 2);
        double ScaleY(double value) =>
            CanvasPadding +
            ((value - bounds.MinY) / (bounds.MaxY - bounds.MinY == 0 ? 1 : bounds.MaxY - bounds.MinY)) *
            (CanvasHeight - CanvasPadding * 2);

        var pathsByColor = new Dictionary<string, List<string>>();
        var colorOrder = new List<string>();
        (double X, double Y)? lastPoint = null;
        string? currentColor = null;
        var currentPath = new List<string>();

        void FlushPath()
        {
            if (string.IsNullOrWhiteSpace(currentColor) || currentPath.Count == 0)
            {
                currentPath.Clear();
                return;
            }

            if (!pathsByColor.TryGetValue(currentColor, out var paths))
            {
                paths = [];
                pathsByColor[currentColor] = paths;
                colorOrder.Add(currentColor);
            }

            paths.Add(string.Join(" ", currentPath));
            currentPath.Clear();
        }

        foreach (var point in points)
        {
            var px = ScaleX(point.X);
            var py = ScaleY(point.Y);
            var color = GetSpeedColor(point.Speed, speedBounds);

            if (color != currentColor)
            {
                FlushPath();
                currentColor = color;
                if (lastPoint.HasValue)
                {
                    currentPath.Add($"M {FormatNumber(lastPoint.Value.X)} {FormatNumber(lastPoint.Value.Y)}");
                    currentPath.Add($"L {FormatNumber(px)} {FormatNumber(py)}");
                }
                else
                {
                    currentPath.Add($"M {FormatNumber(px)} {FormatNumber(py)}");
                }
            }
            else if (currentPath.Count == 0)
            {
                currentPath.Add($"M {FormatNumber(px)} {FormatNumber(py)}");
            }
            else
            {
                currentPath.Add($"L {FormatNumber(px)} {FormatNumber(py)}");
            }

            lastPoint = (px, py);
        }

        FlushPath();

        var header = $"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {CanvasWidth.ToString(CultureInfo.InvariantCulture)} {CanvasHeight.ToString(CultureInfo.InvariantCulture)}\" preserveAspectRatio=\"xMidYMid meet\">";
        var title = $"<title>{label}</title>";
        var background = "<rect width=\"100%\" height=\"100%\" fill=\"#f8fafc\" />";
        var paths = string.Join(
            "",
            colorOrder.Select(color =>
            {
                var d = pathsByColor[color];
                return $"<path d=\"{string.Join(" ", d)}\" stroke=\"{color}\" />";
            }));
        var group = $"<g fill=\"none\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\">{paths}</g>";
        var footer = "</svg>";

        return string.Join("", header, title, background, group, footer);
    }

    private static Bounds GetBounds(List<TrackPoint> points)
    {
        var minX = double.PositiveInfinity;
        var maxX = double.NegativeInfinity;
        var minY = double.PositiveInfinity;
        var maxY = double.NegativeInfinity;
        foreach (var point in points)
        {
            minX = Math.Min(minX, point.X);
            maxX = Math.Max(maxX, point.X);
            minY = Math.Min(minY, point.Y);
            maxY = Math.Max(maxY, point.Y);
        }

        return new Bounds { MinX = minX, MaxX = maxX, MinY = minY, MaxY = maxY };
    }

    private static SpeedBounds GetSpeedBounds(List<TrackPoint> points)
    {
        var min = double.PositiveInfinity;
        var max = double.NegativeInfinity;
        var hasData = false;
        foreach (var point in points)
        {
            if (point.Speed.HasValue && double.IsFinite(point.Speed.Value))
            {
                hasData = true;
                min = Math.Min(min, point.Speed.Value);
                max = Math.Max(max, point.Speed.Value);
            }
        }

        if (!hasData)
        {
            return new SpeedBounds { Min = 0, Max = 0 };
        }

        return new SpeedBounds { Min = min, Max = max };
    }

    private static double QuantizeRatio(double ratio)
    {
        var clamped = Math.Min(1, Math.Max(0, ratio));
        if (SpeedBins <= 1)
        {
            return 0;
        }

        var steps = SpeedBins - 1;
        return Math.Round(clamped * steps) / steps;
    }

    private static string SpeedToColor(double ratio)
    {
        var quantized = QuantizeRatio(ratio);
        var hue = (1 - quantized) * 240;
        return $"hsl({hue.ToString("F0", CultureInfo.InvariantCulture)}, 90%, 55%)";
    }

    private static string GetSpeedColor(double? speed, SpeedBounds bounds)
    {
        if (speed.HasValue && double.IsFinite(speed.Value) && bounds.Max > bounds.Min)
        {
            var clamped = Math.Max(bounds.Min, Math.Min(bounds.Max, speed.Value));
            var ratio = (clamped - bounds.Min) / (bounds.Max - bounds.Min == 0 ? 1 : bounds.Max - bounds.Min);
            return SpeedToColor(ratio);
        }

        if (speed.HasValue && double.IsFinite(speed.Value))
        {
            return SpeedToColor(0.5);
        }

        return "#0f172a";
    }

    private static async Task<bool> WriteSvgFileAsync(
        int sessionKey,
        int driverNumber,
        int lapNumber,
        string svg,
        bool force)
    {
        var sessionDir = Path.Combine(OutDir, sessionKey.ToString());
        var driverDir = Path.Combine(sessionDir, $"driver_{driverNumber}");
        Directory.CreateDirectory(driverDir);
        var filePath = Path.Combine(driverDir, $"lap_{lapNumber}.svg");

        if (!force && File.Exists(filePath))
        {
            return false;
        }

        await File.WriteAllTextAsync(filePath, svg);
        return true;
    }

    private static Options ParseArgs(string[] args)
    {
        var force = false;
        var sessions = new HashSet<int>();
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (arg == "--force")
            {
                force = true;
                continue;
            }

            if (arg is "--session" or "-s")
            {
                var raw = i + 1 < args.Length ? args[i + 1] : string.Empty;
                if (!string.IsNullOrWhiteSpace(raw))
                {
                    foreach (var value in raw.Split(',', StringSplitOptions.RemoveEmptyEntries))
                    {
                        if (int.TryParse(value, out var parsed))
                        {
                            sessions.Add(parsed);
                        }
                    }
                }

                i++;
            }
        }

        return new Options(force, sessions);
    }

    private static int GetEnvInt(string name, int fallback)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return int.TryParse(raw, out var value) ? value : fallback;
    }

    private static string FormatNumber(double value)
    {
        return value.ToString("F2", CultureInfo.InvariantCulture);
    }

    private sealed record Options(bool Force, HashSet<int> Sessions);

    private sealed record SessionRow
    {
        public int SessionKey { get; init; }
        public string? SessionName { get; init; }
        public string? CircuitShortName { get; init; }
        public int? Year { get; init; }
    }

    private sealed record TelemetryRow
    {
        public int? DriverNumber { get; init; }
        public int? LapNumber { get; init; }
        public DateTime SampleTime { get; init; }
        public double? Speed { get; init; }
        public double? X { get; init; }
        public double? Y { get; init; }
        public double? Latitude { get; init; }
        public double? Longitude { get; init; }
    }

    private sealed record TrackPoint
    {
        public double X { get; init; }
        public double Y { get; init; }
        public double? Speed { get; init; }
    }

    private sealed record Bounds
    {
        public double MinX { get; init; }
        public double MaxX { get; init; }
        public double MinY { get; init; }
        public double MaxY { get; init; }
    }

    private sealed record SpeedBounds
    {
        public double Min { get; init; }
        public double Max { get; init; }
    }
}
