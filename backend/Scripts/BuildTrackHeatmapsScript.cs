using System.Globalization;
using Backend.Data;
using Dapper;

namespace Backend.Scripts;

public static class BuildTrackHeatmapsScript
{
    private static readonly int SessionsPerCircuit = GetEnvInt("HEATMAP_SESSIONS", 5);
    private static readonly int MinLapSamples = GetEnvInt("TRACK_MIN_LAP_SAMPLES", 800);
    private static readonly int CandidateLaps = GetEnvInt("TRACK_CANDIDATES", 12);
    private static readonly double MinAspectRatio = GetEnvDouble("TRACK_MIN_ASPECT", 0.08);
    private static readonly double MaxGapMult = GetEnvDouble("TRACK_MAX_GAP_MULT", 12);
    private static readonly double MinPathMult = GetEnvDouble("TRACK_MIN_PATH_MULT", 2.0);
    private static readonly int MinSimplifiedPoints = GetEnvInt("TRACK_MIN_SIMPLIFIED_POINTS", 60);
    private static readonly double SimplifyEps = GetEnvDouble("TRACK_SIMPLIFY_EPS", 0.0015);
    private static readonly double SimplifyMult = GetEnvDouble("TRACK_SIMPLIFY_MULT", 3);
    private static readonly double StrokeScale = GetEnvDouble("TRACK_STROKE_SCALE", 0.003);
    private static readonly string OutDir = Path.Combine(Directory.GetCurrentDirectory(), "assets", "track_heatmaps");

    public static async Task RunAsync(string[] args, IServiceProvider services)
    {
        var db = services.GetRequiredService<Database>();
        await DatabaseMigrator.InitializeAsync(db);
        Directory.CreateDirectory(OutDir);

        await using var connection = await db.OpenConnectionAsync();
        var sessions = (await connection.QueryAsync<CircuitSession>(
            """
            SELECT s.session_key, s.date_start, m.circuit_key, m.circuit_short_name
            FROM sessions s
            JOIN meetings m ON m.meeting_key = s.meeting_key
            WHERE UPPER(s.session_type) = 'RACE'
            """)).ToList();

        var byCircuit = new Dictionary<int, List<CircuitSession>>();
        foreach (var row in sessions)
        {
            if (!byCircuit.TryGetValue(row.CircuitKey, out var bucket))
            {
                bucket = [];
                byCircuit[row.CircuitKey] = bucket;
            }

            bucket.Add(row);
        }

        foreach (var entry in byCircuit)
        {
            var circuitKey = entry.Key;
            var circuitSessions = entry.Value
                .OrderByDescending(row => row.DateStart)
                .ToList();
            var selected = circuitSessions.Take(SessionsPerCircuit).ToList();
            var sessionKeys = selected.Select(row => row.SessionKey).ToArray();
            var label = selected.FirstOrDefault()?.CircuitShortName ?? "unknown";

            Console.WriteLine(
                $"[TRACK] Circuit {circuitKey} ({label}) using sessions {string.Join(", ", sessionKeys)}");

            var candidates = await FetchReferenceLapCandidatesAsync(connection, sessionKeys, CandidateLaps);
            if (candidates.Count == 0)
            {
                Console.WriteLine($"[TRACK] Skipping {circuitKey} ({label}) - no reference laps found");
                continue;
            }

            var selection = await SelectBestLapAsync(connection, candidates);
            if (selection is null)
            {
                Console.WriteLine($"[TRACK] Skipping {circuitKey} ({label}) - no usable lap data");
                continue;
            }

            var usedFallback = selection.Score == 0 && candidates.Count > 0;
            Console.WriteLine(
                $"[TRACK] Reference lap session {selection.Lap.SessionKey} driver {selection.Lap.DriverNumber} lap {selection.Lap.LapNumber} samples {selection.Lap.SampleCount} ratio {selection.Stats.AspectRatio:F2} length {selection.Stats.PathLength:F1}{(usedFallback ? " (fallback)" : "")}");

            var svg = BuildSvg(selection.Points, circuitKey, label);
            if (svg is null)
            {
                Console.WriteLine($"[TRACK] Skipping {circuitKey} ({label}) - no SVG data");
                continue;
            }

            var filePath = Path.Combine(OutDir, $"circuit_{circuitKey}.svg");
            await File.WriteAllTextAsync(filePath, svg);
            Console.WriteLine($"[TRACK] Wrote {filePath}");
        }
    }

    private static async Task<List<ReferenceLap>> FetchReferenceLapCandidatesAsync(
        Npgsql.NpgsqlConnection connection,
        int[] sessionKeys,
        int limit)
    {
        if (sessionKeys.Length == 0)
        {
            return [];
        }

        var rows = (await connection.QueryAsync<ReferenceLapRow>(
            """
            WITH pit_laps AS (
              SELECT session_key, driver_number, lap_number
              FROM pit_stops
              WHERE session_key = ANY(@SessionKeys)
            )
            SELECT t.session_key, t.driver_number, t.lap_number, COUNT(*) AS sample_count
            FROM telemetry_samples t
            WHERE t.session_key = ANY(@SessionKeys)
              AND t.x IS NOT NULL
              AND t.y IS NOT NULL
              AND t.lap_number IS NOT NULL
              AND t.lap_number > 0
              AND NOT EXISTS (
                SELECT 1
                FROM pit_laps p
                WHERE p.session_key = t.session_key
                  AND p.driver_number = t.driver_number
                  AND (p.lap_number = t.lap_number OR p.lap_number + 1 = t.lap_number)
              )
            GROUP BY t.session_key, t.driver_number, t.lap_number
            ORDER BY sample_count DESC
            LIMIT @Limit
            """,
            new { SessionKeys = sessionKeys, Limit = limit })).ToList();

        return rows
            .Select(row => new ReferenceLap
            {
                SessionKey = row.SessionKey,
                DriverNumber = row.DriverNumber,
                LapNumber = row.LapNumber,
                SampleCount = row.SampleCount
            })
            .ToList();
    }

    private static async Task<List<Point>> FetchLapPointsAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey,
        int driverNumber,
        int lapNumber)
    {
        var rows = await connection.QueryAsync<Point>(
            """
            SELECT x, y
            FROM telemetry_samples
            WHERE session_key = @SessionKey
              AND driver_number = @DriverNumber
              AND lap_number = @LapNumber
              AND x IS NOT NULL
              AND y IS NOT NULL
            ORDER BY sample_time ASC
            """,
            new { SessionKey = sessionKey, DriverNumber = driverNumber, LapNumber = lapNumber });

        return rows
            .Where(point => double.IsFinite(point.X) && double.IsFinite(point.Y))
            .ToList();
    }

    private static async Task<Selection?> SelectBestLapAsync(
        Npgsql.NpgsqlConnection connection,
        List<ReferenceLap> candidates)
    {
        Selection? best = null;

        foreach (var candidate in candidates)
        {
            if (candidate.SampleCount < MinLapSamples)
            {
                continue;
            }

            var points = await FetchLapPointsAsync(connection, candidate.SessionKey, candidate.DriverNumber, candidate.LapNumber);
            if (points.Count < MinLapSamples)
            {
                continue;
            }

            var cleaned = DedupePoints(points);
            var stats = ComputePathStats(cleaned);
            if (stats is null)
            {
                continue;
            }

            if (stats.AspectRatio < MinAspectRatio)
            {
                continue;
            }

            if (stats.MedianSpacing > 0 && stats.MaxSpacing > stats.MedianSpacing * MaxGapMult)
            {
                continue;
            }

            if (stats.PathLength < Math.Max(stats.Width, stats.Height) * MinPathMult)
            {
                continue;
            }

            var score = stats.PathLength * stats.AspectRatio;
            if (best is null || score > best.Score)
            {
                best = new Selection
                {
                    Lap = candidate,
                    Points = cleaned,
                    Stats = stats,
                    Score = score
                };
            }
        }

        if (best is not null)
        {
            return best;
        }

        if (candidates.Count == 0)
        {
            return null;
        }

        var fallback = candidates[0];
        var fallbackPoints = await FetchLapPointsAsync(connection, fallback.SessionKey, fallback.DriverNumber, fallback.LapNumber);
        var fallbackCleaned = DedupePoints(fallbackPoints);
        var fallbackStats = ComputePathStats(fallbackCleaned);
        if (fallbackStats is null)
        {
            return null;
        }

        return new Selection
        {
            Lap = fallback,
            Points = fallbackCleaned,
            Stats = fallbackStats,
            Score = 0
        };
    }

    private static List<Point> DedupePoints(List<Point> points)
    {
        var cleaned = new List<Point>();
        Point? last = null;
        foreach (var point in points)
        {
            if (last is null || point.X != last.X || point.Y != last.Y)
            {
                cleaned.Add(point);
                last = point;
            }
        }

        return cleaned;
    }

    private static List<Point> SimplifyPath(List<Point> points, double epsilon)
    {
        if (points.Count < 3)
        {
            return points;
        }

        void Rdp(int start, int end, bool[] keep)
        {
            var maxDistance = 0.0;
            var index = start;
            var a = points[start];
            var b = points[end];
            var dx = b.X - a.X;
            var dy = b.Y - a.Y;
            var lengthSq = dx * dx + dy * dy;
            if (lengthSq == 0)
            {
                lengthSq = 1;
            }

            for (var i = start + 1; i < end; i++)
            {
                var p = points[i];
                var t = ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / lengthSq;
                var projX = a.X + t * dx;
                var projY = a.Y + t * dy;
                var dist = Math.Sqrt(Math.Pow(p.X - projX, 2) + Math.Pow(p.Y - projY, 2));
                if (dist > maxDistance)
                {
                    maxDistance = dist;
                    index = i;
                }
            }

            if (maxDistance > epsilon)
            {
                keep[index] = true;
                Rdp(start, index, keep);
                Rdp(index, end, keep);
            }
        }

        var keep = new bool[points.Count];
        keep[0] = true;
        keep[^1] = true;
        Rdp(0, points.Count - 1, keep);
        return points.Where((_, idx) => keep[idx]).ToList();
    }

    private static PathStats? ComputePathStats(List<Point> points)
    {
        if (points.Count < 2)
        {
            return null;
        }

        var minX = double.PositiveInfinity;
        var maxX = double.NegativeInfinity;
        var minY = double.PositiveInfinity;
        var maxY = double.NegativeInfinity;
        var distances = new List<double>();
        var pathLength = 0.0;

        for (var i = 0; i < points.Count; i++)
        {
            var point = points[i];
            minX = Math.Min(minX, point.X);
            maxX = Math.Max(maxX, point.X);
            minY = Math.Min(minY, point.Y);
            maxY = Math.Max(maxY, point.Y);

            if (i > 0)
            {
                var prev = points[i - 1];
                var dist = Math.Sqrt(Math.Pow(point.X - prev.X, 2) + Math.Pow(point.Y - prev.Y, 2));
                if (dist > 0)
                {
                    distances.Add(dist);
                    pathLength += dist;
                }
            }
        }

        if (!double.IsFinite(minX) || !double.IsFinite(minY))
        {
            return null;
        }

        var width = maxX - minX;
        var height = maxY - minY;
        if (width == 0)
        {
            width = 1;
        }
        if (height == 0)
        {
            height = 1;
        }

        var maxDim = Math.Max(width, height);
        var aspectRatio = Math.Min(width, height) / maxDim;
        distances.Sort();
        var medianSpacing = distances.Count > 0 ? distances[distances.Count / 2] : 0;
        var maxSpacing = distances.Count > 0 ? distances[^1] : 0;

        return new PathStats
        {
            MinX = minX,
            MaxX = maxX,
            MinY = minY,
            MaxY = maxY,
            Width = width,
            Height = height,
            AspectRatio = aspectRatio,
            PathLength = pathLength,
            MedianSpacing = medianSpacing,
            MaxSpacing = maxSpacing
        };
    }

    private static string? BuildSvg(List<Point> points, int circuitKey, string circuitLabel)
    {
        var cleaned = DedupePoints(points);
        var stats = ComputePathStats(cleaned);
        if (stats is null)
        {
            return null;
        }

        var maxDim = Math.Max(stats.Width, stats.Height);
        var spacingEps = stats.MedianSpacing > 0
            ? stats.MedianSpacing * SimplifyMult
            : SimplifyEps * maxDim;
        var epsilon = Math.Min(SimplifyEps * maxDim, spacingEps);
        var simplified = SimplifyPath(cleaned, epsilon);
        var finalPath = simplified.Count < MinSimplifiedPoints ? cleaned : simplified;
        if (finalPath.Count < 2)
        {
            return null;
        }

        var strokeWidth = Math.Max(1, maxDim * StrokeScale);
        var d = string.Join(
            " ",
            finalPath.Select((point, index) =>
                $"{(index == 0 ? "M" : "L")} {FormatNumber(point.X)} {FormatNumber(point.Y)}"));

        var viewBox = $"{FormatNumber(stats.MinX)} {FormatNumber(stats.MinY)} {FormatNumber(stats.Width)} {FormatNumber(stats.Height)}";
        var svg = string.Join(
            "",
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"",
            viewBox,
            "\" preserveAspectRatio=\"xMidYMid meet\">",
            $"<title>Circuit {circuitLabel} ({circuitKey})</title>",
            "<g>",
            $"<path d=\"{d}\" fill=\"none\" stroke=\"#1d4ed8\" stroke-width=\"{FormatNumber(strokeWidth)}\" stroke-linecap=\"round\" stroke-linejoin=\"round\" opacity=\"0.25\" />",
            "</g>",
            "</svg>");

        return svg;
    }

    private static int GetEnvInt(string name, int fallback)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return int.TryParse(raw, out var value) ? value : fallback;
    }

    private static double GetEnvDouble(string name, double fallback)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return double.TryParse(raw, out var value) ? value : fallback;
    }

    private static string FormatNumber(double value)
    {
        return value.ToString("F2", CultureInfo.InvariantCulture);
    }

    private sealed record CircuitSession
    {
        public int CircuitKey { get; init; }
        public string CircuitShortName { get; init; } = string.Empty;
        public int SessionKey { get; init; }
        public DateTime DateStart { get; init; }
    }

    private sealed record ReferenceLap
    {
        public int SessionKey { get; init; }
        public int DriverNumber { get; init; }
        public int LapNumber { get; init; }
        public int SampleCount { get; init; }
    }

    private sealed record ReferenceLapRow
    {
        public int SessionKey { get; init; }
        public int DriverNumber { get; init; }
        public int LapNumber { get; init; }
        public int SampleCount { get; init; }
    }

    private sealed record Point
    {
        public double X { get; init; }
        public double Y { get; init; }
    }

    private sealed record PathStats
    {
        public double MinX { get; init; }
        public double MaxX { get; init; }
        public double MinY { get; init; }
        public double MaxY { get; init; }
        public double Width { get; init; }
        public double Height { get; init; }
        public double AspectRatio { get; init; }
        public double PathLength { get; init; }
        public double MedianSpacing { get; init; }
        public double MaxSpacing { get; init; }
    }

    private sealed record Selection
    {
        public required ReferenceLap Lap { get; init; }
        public required List<Point> Points { get; init; }
        public required PathStats Stats { get; init; }
        public double Score { get; init; }
    }
}
