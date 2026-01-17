using Dapper;
using Backend.Data;

namespace Backend.Services;

public enum TelemetryMode
{
    Full,
    None,
    Position
}

public sealed class SessionService
{
    private readonly Database _database;

    public SessionService(Database database)
    {
        _database = database;
    }

    public async Task<object> GetSessionDataAsync(
        string requestKey,
        double? sampleSeconds,
        TelemetryMode telemetryMode)
    {
        await using var connection = await _database.OpenConnectionAsync();
        var resolved = await ResolveSessionKeyAsync(connection, requestKey);
        if (resolved is null)
        {
            throw new SessionNotFoundException($"Session {requestKey} not found");
        }

        return await LoadSessionFromDatabaseAsync(
            connection,
            resolved.NumericKey,
            resolved.Alias ?? requestKey,
            sampleSeconds,
            telemetryMode);
    }

    public async Task<object?> GetTelemetrySliceAsync(
        string requestKey,
        int[] drivers,
        int lapNumber,
        double? sampleSeconds)
    {
        await using var connection = await _database.OpenConnectionAsync();
        var resolved = await ResolveSessionKeyAsync(connection, requestKey);
        if (resolved is null)
        {
            return null;
        }

        var telemetry = await FetchTelemetrySliceAsync(
            connection,
            resolved.NumericKey,
            drivers,
            lapNumber,
            sampleSeconds);

        return new
        {
            sessionKey = resolved.Alias ?? resolved.NumericKey.ToString(),
            lapNumber,
            drivers,
            sampleSeconds,
            telemetry
        };
    }

    public sealed record ResolvedSession(int NumericKey, string? Alias);

    public async Task<ResolvedSession?> ResolveSessionAsync(string identifier)
    {
        await using var connection = await _database.OpenConnectionAsync();
        return await ResolveSessionKeyAsync(connection, identifier);
    }

    private async Task<ResolvedSession?> ResolveSessionKeyAsync(
        Npgsql.NpgsqlConnection connection,
        string identifier)
    {
        if (string.IsNullOrWhiteSpace(identifier))
        {
            return null;
        }

        var aliasRow = await connection.QueryFirstOrDefaultAsync<int?>(
            "SELECT session_key FROM session_aliases WHERE alias = @Alias LIMIT 1",
            new { Alias = identifier });
        if (aliasRow.HasValue)
        {
            return new ResolvedSession(aliasRow.Value, identifier);
        }

        if (!int.TryParse(identifier, out var numeric))
        {
            return null;
        }

        var sessionRow = await connection.QueryFirstOrDefaultAsync<int?>(
            "SELECT session_key FROM sessions WHERE session_key = @SessionKey LIMIT 1",
            new { SessionKey = numeric });

        return sessionRow.HasValue ? new ResolvedSession(sessionRow.Value, null) : null;
    }

    private async Task<object> LoadSessionFromDatabaseAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey,
        string requestKey,
        double? sampleSeconds,
        TelemetryMode telemetryMode)
    {
        SessionInfoRow? infoRow;
        try
        {
            infoRow = await connection.QueryFirstOrDefaultAsync<SessionInfoRow>(
                """
                SELECT
                  s.session_key,
                  s.session_type,
                  s.session_name,
                  s.date_start,
                  s.date_end,
                  s.data_status,
                  s.last_refreshed,
                  m.meeting_key,
                  m.meeting_name,
                  m.meeting_official_name,
                  m.location,
                  m.country_name,
                  m.country_code,
                  m.country_key,
                  m.circuit_key,
                  m.circuit_short_name,
                  m.gmt_offset::text AS gmt_offset,
                  m.year
                FROM sessions s
                JOIN meetings m ON m.meeting_key = s.meeting_key
                WHERE s.session_key = @SessionKey
                LIMIT 1
                """,
                new { SessionKey = sessionKey });
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"[DB] Failed to load session metadata for {sessionKey}: {error}");
            throw new Exception("Failed to read data");
        }

        if (infoRow is null)
        {
            throw new SessionNotFoundException($"Session {sessionKey} not found");
        }

        var aliasRow = await connection.QueryFirstOrDefaultAsync<string?>(
            "SELECT alias FROM session_aliases WHERE session_key = @SessionKey LIMIT 1",
            new { SessionKey = sessionKey });

        var sessionInfo = new
        {
            circuit_key = infoRow.CircuitKey,
            circuit_short_name = infoRow.CircuitShortName,
            country_code = infoRow.CountryCode,
            country_key = infoRow.CountryKey,
            country_name = infoRow.CountryName,
            date_end = ToIsoNullable(infoRow.DateEnd),
            date_start = ToIsoNullable(infoRow.DateStart),
            gmt_offset = infoRow.GmtOffset,
            location = infoRow.Location,
            meeting_key = infoRow.MeetingKey,
            meeting_name = infoRow.MeetingName,
            meeting_official_name = infoRow.MeetingOfficialName,
            session_key = infoRow.SessionKey,
            session_name = infoRow.SessionName,
            session_type = infoRow.SessionType,
            year = infoRow.Year
        };

        var dataState = MapSessionDataState(infoRow.DataStatus);
        var lastRefreshed = ToIsoNullable(infoRow.LastRefreshed);

        var telemetry = telemetryMode switch
        {
            TelemetryMode.Full => await FetchTelemetryAsync(connection, sessionKey, sampleSeconds),
            TelemetryMode.Position => await FetchTelemetryPositionAsync(connection, sessionKey, sampleSeconds),
            _ => new List<object>()
        };

        var pitStops = await FetchPitStopsAsync(connection, sessionKey);
        var raceControl = await FetchRaceControlAsync(connection, sessionKey);
        var stints = await FetchStintsAsync(connection, sessionKey);
        var laps = await FetchLapsAsync(connection, sessionKey);
        var weather = await FetchWeatherSamplesAsync(connection, sessionKey);

        return new
        {
            sessionKey = aliasRow ?? requestKey ?? sessionKey.ToString(),
            dataState,
            lastRefreshed,
            sessionInfo,
            telemetry,
            pitStops,
            raceControl,
            stints,
            laps,
            weather
        };
    }

    private static string MapSessionDataState(string? value)
    {
        return value is "no_telemetry" or "with_telemetry" ? value : "none";
    }

    private async Task<List<object>> FetchTelemetryAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey,
        double? sampleSeconds)
    {
        var rows = sampleSeconds.HasValue
            ? await connection.QueryAsync<TelemetryRow>(
                """
                SELECT
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
                FROM (
                  SELECT
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
                    longitude,
                    ROW_NUMBER() OVER (
                      PARTITION BY driver_number,
                        time_bucket(@SampleSeconds * INTERVAL '1 second', sample_time)
                      ORDER BY sample_time DESC
                    ) AS row_rank
                  FROM telemetry_samples
                  WHERE session_key = @SessionKey
                ) AS ranked
                WHERE row_rank = 1
                ORDER BY driver_number, sample_time
                """,
                new { SessionKey = sessionKey, SampleSeconds = sampleSeconds })
            : await connection.QueryAsync<TelemetryRow>(
                """
                SELECT
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
                FROM telemetry_samples
                WHERE session_key = @SessionKey
                ORDER BY driver_number, sample_time
                """,
                new { SessionKey = sessionKey });

        return rows
            .Select(row => new
            {
                driver_number = row.DriverNumber,
                sample_time = ToIso(row.SampleTime),
                lap_number = row.LapNumber,
                drs = row.Drs,
                speed = row.Speed,
                brake = row.Brake,
                rpm = row.Rpm,
                n_gear = row.NGear,
                throttle = row.Throttle,
                x = row.X,
                y = row.Y,
                z = row.Z,
                latitude = row.Latitude,
                longitude = row.Longitude
            })
            .Cast<object>()
            .ToList();
    }

    private async Task<List<object>> FetchTelemetryPositionAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey,
        double? sampleSeconds)
    {
        var rows = sampleSeconds.HasValue
            ? await connection.QueryAsync<TelemetryPositionRow>(
                """
                SELECT
                  driver_number,
                  sample_time,
                  x,
                  y
                FROM (
                  SELECT
                    driver_number,
                    sample_time,
                    x,
                    y,
                    ROW_NUMBER() OVER (
                      PARTITION BY driver_number,
                        time_bucket(@SampleSeconds * INTERVAL '1 second', sample_time)
                      ORDER BY sample_time DESC
                    ) AS row_rank
                  FROM telemetry_samples
                  WHERE session_key = @SessionKey
                ) AS ranked
                WHERE row_rank = 1
                ORDER BY driver_number, sample_time
                """,
                new { SessionKey = sessionKey, SampleSeconds = sampleSeconds })
            : await connection.QueryAsync<TelemetryPositionRow>(
                """
                SELECT
                  driver_number,
                  sample_time,
                  x,
                  y
                FROM telemetry_samples
                WHERE session_key = @SessionKey
                ORDER BY driver_number, sample_time
                """,
                new { SessionKey = sessionKey });

        return rows
            .Select(row => new
            {
                driver_number = row.DriverNumber,
                sample_time = ToIso(row.SampleTime),
                x = row.X,
                y = row.Y
            })
            .Cast<object>()
            .ToList();
    }

    private async Task<List<object>> FetchTelemetrySliceAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey,
        int[] drivers,
        int lapNumber,
        double? sampleSeconds)
    {
        var rows = sampleSeconds.HasValue
            ? await connection.QueryAsync<TelemetrySliceRow>(
                """
                SELECT
                  driver_number,
                  sample_time,
                  lap_number,
                  speed,
                  brake,
                  rpm,
                  n_gear,
                  throttle
                FROM (
                  SELECT
                    driver_number,
                    sample_time,
                    lap_number,
                    speed,
                    brake,
                    rpm,
                    n_gear,
                    throttle,
                    ROW_NUMBER() OVER (
                      PARTITION BY driver_number,
                        time_bucket(@SampleSeconds * INTERVAL '1 second', sample_time)
                      ORDER BY sample_time DESC
                    ) AS row_rank
                  FROM telemetry_samples
                  WHERE session_key = @SessionKey
                    AND lap_number = @LapNumber
                    AND driver_number = ANY(@Drivers)
                ) AS ranked
                WHERE row_rank = 1
                ORDER BY driver_number, sample_time
                """,
                new { SessionKey = sessionKey, LapNumber = lapNumber, Drivers = drivers, SampleSeconds = sampleSeconds })
            : await connection.QueryAsync<TelemetrySliceRow>(
                """
                SELECT
                  driver_number,
                  sample_time,
                  lap_number,
                  speed,
                  brake,
                  rpm,
                  n_gear,
                  throttle
                FROM telemetry_samples
                WHERE session_key = @SessionKey
                  AND lap_number = @LapNumber
                  AND driver_number = ANY(@Drivers)
                ORDER BY driver_number, sample_time
                """,
                new { SessionKey = sessionKey, LapNumber = lapNumber, Drivers = drivers });

        return rows
            .Select(row => new
            {
                driver_number = row.DriverNumber,
                sample_time = ToIso(row.SampleTime),
                lap_number = row.LapNumber,
                speed = row.Speed,
                brake = row.Brake,
                rpm = row.Rpm,
                n_gear = row.NGear,
                throttle = row.Throttle
            })
            .Cast<object>()
            .ToList();
    }

    private async Task<List<object>> FetchPitStopsAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey)
    {
        var rows = await connection.QueryAsync<PitStopRow>(
            """
            SELECT driver_number, lap_number, stop_time, pit_duration
            FROM pit_stops
            WHERE session_key = @SessionKey
            ORDER BY stop_time
            """,
            new { SessionKey = sessionKey });

        return rows
            .Select(row => new
            {
                driver_number = row.DriverNumber,
                lap_number = row.LapNumber,
                stop_time = ToIso(row.StopTime),
                pit_duration = row.PitDuration
            })
            .Cast<object>()
            .ToList();
    }

    private async Task<List<object>> FetchRaceControlAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey)
    {
        var rows = await connection.QueryAsync<RaceControlRow>(
            """
            SELECT
              driver_number,
              lap_number,
              category,
              flag,
              scope,
              sector,
              message,
              event_time
            FROM race_control_events
            WHERE session_key = @SessionKey
            ORDER BY event_time
            """,
            new { SessionKey = sessionKey });

        return rows
            .Select(row => new
            {
                driver_number = row.DriverNumber,
                lap_number = row.LapNumber,
                category = row.Category,
                flag = row.Flag,
                scope = row.Scope,
                sector = row.Sector,
                message = row.Message,
                event_time = ToIso(row.EventTime)
            })
            .Cast<object>()
            .ToList();
    }

    private async Task<List<object>> FetchStintsAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey)
    {
        var rows = await connection.QueryAsync<StintRow>(
            """
            SELECT
              driver_number,
              stint_number,
              lap_start,
              lap_end,
              compound,
              tyre_age_at_start
            FROM stints
            WHERE session_key = @SessionKey
            ORDER BY driver_number, stint_number
            """,
            new { SessionKey = sessionKey });

        return rows
            .Select(row => new
            {
                driver_number = row.DriverNumber,
                stint_number = row.StintNumber,
                lap_start = row.LapStart,
                lap_end = row.LapEnd,
                compound = row.Compound,
                tyre_age_at_start = row.TyreAgeAtStart
            })
            .Cast<object>()
            .ToList();
    }

    private async Task<List<object>> FetchLapsAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey)
    {
        var rows = await connection.QueryAsync<LapRow>(
            """
            SELECT
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
              array_to_json(segments_sector_1) AS segments_sector_1,
              array_to_json(segments_sector_2) AS segments_sector_2,
              array_to_json(segments_sector_3) AS segments_sector_3
            FROM laps
            WHERE session_key = @SessionKey
            ORDER BY driver_number, lap_number
            """,
            new { SessionKey = sessionKey });

        return rows
            .Select(row => new
            {
                driver_number = row.DriverNumber,
                lap_number = row.LapNumber,
                date_start = ToIsoNullable(row.DateStart),
                lap_duration = row.LapDuration,
                duration_sector_1 = row.DurationSector1,
                duration_sector_2 = row.DurationSector2,
                duration_sector_3 = row.DurationSector3,
                i1_speed = row.I1Speed,
                i2_speed = row.I2Speed,
                st_speed = row.StSpeed,
                is_pit_out_lap = row.IsPitOutLap,
                segments_sector_1 = ParseNumberArray(row.SegmentsSector1),
                segments_sector_2 = ParseNumberArray(row.SegmentsSector2),
                segments_sector_3 = ParseNumberArray(row.SegmentsSector3)
            })
            .Cast<object>()
            .ToList();
    }

    private async Task<List<object>> FetchWeatherSamplesAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey)
    {
        var rows = await connection.QueryAsync<WeatherRow>(
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
            new { SessionKey = sessionKey });

        return rows
            .Select(row => new
            {
                recorded_at = ToIso(row.RecordedAt),
                air_temperature = row.AirTemperature,
                humidity = row.Humidity,
                pressure = row.Pressure,
                rainfall = row.Rainfall,
                track_temperature = row.TrackTemperature,
                wind_direction = row.WindDirection,
                wind_speed = row.WindSpeed
            })
            .Cast<object>()
            .ToList();
    }

    private static IReadOnlyList<int?>? ParseNumberArray(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<List<int?>>(value);
        }
        catch
        {
            Console.WriteLine($"[WARN] Failed to parse segment array {value}");
            return null;
        }
    }

    private static string ToIso(DateTime value)
    {
        if (value.Kind == DateTimeKind.Unspecified)
        {
            value = DateTime.SpecifyKind(value, DateTimeKind.Utc);
        }
        return value.ToUniversalTime().ToString("O");
    }

    private static string? ToIsoNullable(DateTime? value)
    {
        return value.HasValue ? ToIso(value.Value) : null;
    }

    private sealed record SessionInfoRow
    {
        public int SessionKey { get; init; }
        public string? SessionType { get; init; }
        public string? SessionName { get; init; }
        public DateTime? DateStart { get; init; }
        public DateTime? DateEnd { get; init; }
        public string? DataStatus { get; init; }
        public DateTime? LastRefreshed { get; init; }
        public int MeetingKey { get; init; }
        public string? MeetingName { get; init; }
        public string? MeetingOfficialName { get; init; }
        public string? Location { get; init; }
        public string? CountryName { get; init; }
        public string? CountryCode { get; init; }
        public int? CountryKey { get; init; }
        public int? CircuitKey { get; init; }
        public string? CircuitShortName { get; init; }
        public string? GmtOffset { get; init; }
        public int? Year { get; init; }
    }

    private sealed record TelemetryRow
    {
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

    private sealed record TelemetryPositionRow
    {
        public int DriverNumber { get; init; }
        public DateTime SampleTime { get; init; }
        public int? X { get; init; }
        public int? Y { get; init; }
    }

    private sealed record TelemetrySliceRow
    {
        public int DriverNumber { get; init; }
        public DateTime SampleTime { get; init; }
        public int? LapNumber { get; init; }
        public int? Speed { get; init; }
        public int? Brake { get; init; }
        public int? Rpm { get; init; }
        public int? NGear { get; init; }
        public int? Throttle { get; init; }
    }

    private sealed record PitStopRow
    {
        public int DriverNumber { get; init; }
        public int LapNumber { get; init; }
        public DateTime StopTime { get; init; }
        public decimal? PitDuration { get; init; }
    }

    private sealed record RaceControlRow
    {
        public int? DriverNumber { get; init; }
        public int? LapNumber { get; init; }
        public string? Category { get; init; }
        public string? Flag { get; init; }
        public string? Scope { get; init; }
        public string? Sector { get; init; }
        public string? Message { get; init; }
        public DateTime EventTime { get; init; }
    }

    private sealed record StintRow
    {
        public int DriverNumber { get; init; }
        public int StintNumber { get; init; }
        public int? LapStart { get; init; }
        public int? LapEnd { get; init; }
        public string? Compound { get; init; }
        public int? TyreAgeAtStart { get; init; }
    }

    private sealed record LapRow
    {
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
        public string? SegmentsSector1 { get; init; }
        public string? SegmentsSector2 { get; init; }
        public string? SegmentsSector3 { get; init; }
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
}

public sealed class SessionNotFoundException : Exception
{
    public SessionNotFoundException(string message) : base(message) { }
}
