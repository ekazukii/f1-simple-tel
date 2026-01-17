using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Backend.Datasources;

public sealed class OpenF1Client
{
    private const string BaseUrl = "https://api.openf1.org/v1";
    private const int TimeSliceCount = 30;
    private readonly HttpClient _client;
    private readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public OpenF1Client(HttpClient client)
    {
        _client = client;
    }

    public async Task<OpenF1SessionData> FetchSessionAsync(
        string sessionKey,
        bool includeTelemetry = true)
    {
        var sessionInfo = await FetchSessionMetadataAsync(sessionKey);
        var meetingInfo = await FetchMeetingMetadataAsync(sessionInfo.MeetingKey);
        var slices = CreateTimeSlices(sessionInfo.DateStart, sessionInfo.DateEnd, TimeSliceCount);

        var carData = includeTelemetry
            ? await FetchTimeSlicedSeriesAsync("car_data", sessionKey, slices)
            : new List<Dictionary<string, JsonElement>>();
        var locations = includeTelemetry
            ? await FetchTimeSlicedSeriesAsync("location", sessionKey, slices)
            : new List<Dictionary<string, JsonElement>>();

        var pitStopsTask = FetchCollectionAsync<Dictionary<string, JsonElement>>(
            "pit",
            new Dictionary<string, string> { ["session_key"] = sessionKey });
        var raceControlTask = FetchCollectionAsync<Dictionary<string, JsonElement>>(
            "race_control",
            new Dictionary<string, string> { ["session_key"] = sessionKey });
        var stintsTask = FetchCollectionAsync<Dictionary<string, JsonElement>>(
            "stints",
            new Dictionary<string, string> { ["session_key"] = sessionKey });
        var lapsTask = FetchCollectionAsync<Dictionary<string, JsonElement>>(
            "laps",
            new Dictionary<string, string> { ["session_key"] = sessionKey });
        var weatherTask = FetchWeatherAsync(sessionKey);

        await Task.WhenAll(pitStopsTask, raceControlTask, stintsTask, lapsTask, weatherTask);

        return new OpenF1SessionData
        {
            SessionKey = sessionKey,
            SessionInfo = sessionInfo,
            MeetingInfo = meetingInfo,
            CarData = carData,
            Locations = locations,
            PitStops = pitStopsTask.Result,
            RaceControl = raceControlTask.Result,
            Stints = stintsTask.Result,
            Laps = lapsTask.Result,
            Weather = weatherTask.Result
        };
    }

    public Task<List<OpenF1SessionMeta>> FetchSessionsListAsync(int? year = null)
    {
        var query = new Dictionary<string, string>();
        if (year.HasValue)
        {
            query["year"] = year.Value.ToString();
        }
        return FetchCollectionAsync<OpenF1SessionMeta>("sessions", query);
    }

    public Task<List<OpenF1MeetingMeta>> FetchMeetingsListAsync(int? year = null)
    {
        var query = new Dictionary<string, string>();
        if (year.HasValue)
        {
            query["year"] = year.Value.ToString();
        }
        return FetchCollectionAsync<OpenF1MeetingMeta>("meetings", query);
    }

    public Task<List<OpenF1TeamRadioRecord>> FetchTeamRadioAsync(
        string sessionKey,
        int? driverNumber = null)
    {
        var query = new Dictionary<string, string> { ["session_key"] = sessionKey };
        if (driverNumber.HasValue)
        {
            query["driver_number"] = driverNumber.Value.ToString();
        }
        return FetchCollectionAsync<OpenF1TeamRadioRecord>("team_radio", query);
    }

    public Task<List<OpenF1WeatherRecord>> FetchWeatherAsync(string sessionKey)
    {
        return FetchCollectionAsync<OpenF1WeatherRecord>(
            "weather",
            new Dictionary<string, string> { ["session_key"] = sessionKey });
    }

    private async Task<OpenF1SessionMeta> FetchSessionMetadataAsync(string sessionKey)
    {
        var sessions = await FetchCollectionAsync<OpenF1SessionMeta>(
            "sessions",
            new Dictionary<string, string> { ["session_key"] = sessionKey });

        if (sessions.Count == 0)
        {
            throw new InvalidOperationException($"No session metadata found for session_key={sessionKey}");
        }

        return sessions[0];
    }

    private async Task<OpenF1MeetingMeta?> FetchMeetingMetadataAsync(int meetingKey)
    {
        if (meetingKey <= 0)
        {
            return null;
        }

        var meetings = await FetchCollectionAsync<OpenF1MeetingMeta>(
            "meetings",
            new Dictionary<string, string> { ["meeting_key"] = meetingKey.ToString() });

        return meetings.Count == 0 ? null : meetings[0];
    }

    private async Task<List<Dictionary<string, JsonElement>>> FetchTimeSlicedSeriesAsync(
        string endpoint,
        string sessionKey,
        List<(string From, string To)> slices)
    {
        var combined = new List<Dictionary<string, JsonElement>>();
        foreach (var slice in slices)
        {
            var data = await FetchCollectionAsync<Dictionary<string, JsonElement>>(
                endpoint,
                new Dictionary<string, string>
                {
                    ["session_key"] = sessionKey,
                    ["date>"] = slice.From,
                    ["date<"] = slice.To
                });

            if (data.Count > 0)
            {
                combined.AddRange(data);
            }

            await Task.Delay(200);
        }

        return combined;
    }

    private async Task<List<T>> FetchCollectionAsync<T>(
        string endpoint,
        Dictionary<string, string> query,
        int maxAttempts = 5)
    {
        var path = endpoint.TrimStart('/');
        var fullUrl = BuildFullUrl(path, query);
        Console.WriteLine($"[OpenF1] GET {fullUrl}");

        var attempts = 0;
        Exception? lastError = null;

        while (attempts < maxAttempts)
        {
            try
            {
                var response = await _client.GetAsync(fullUrl);
                if (response.IsSuccessStatusCode)
                {
                    var data = await response.Content.ReadFromJsonAsync<List<T>>(_jsonOptions)
                               ?? new List<T>();
                    Console.WriteLine(
                        $"[OpenF1] GET {fullUrl} -> {(int)response.StatusCode} ({data.Count} rows)");
                    return data;
                }

                var shouldRetry = ShouldRetry(response.StatusCode);
                attempts++;
                var body = await response.Content.ReadAsStringAsync();
                if (!shouldRetry || attempts >= maxAttempts)
                {
                    throw new HttpRequestException(
                        $"Failed to fetch {endpoint}: {(int)response.StatusCode} {body}");
                }

                await BackoffAsync(fullUrl, response.StatusCode, attempts, maxAttempts);
            }
            catch (Exception ex)
            {
                lastError = ex;
                attempts++;
                var shouldRetry = ex is HttpRequestException;
                if (!shouldRetry || attempts >= maxAttempts)
                {
                    Console.Error.WriteLine(
                        $"[OpenF1] GET {fullUrl} FAILED after {attempts} attempts: {ex.Message}");
                    throw new InvalidOperationException($"Failed to fetch {endpoint}: {ex.Message}", ex);
                }

                await BackoffAsync(fullUrl, null, attempts, maxAttempts);
            }
        }

        throw new InvalidOperationException(
            $"Failed to fetch {endpoint}: {lastError?.Message ?? "Unknown error"}");
    }

    private static string BuildFullUrl(string path, Dictionary<string, string> query)
    {
        var baseUrl = BaseUrl.TrimEnd('/');
        var uriBuilder = new UriBuilder($"{baseUrl}/{path}");
        if (query.Count > 0)
        {
            var queryParts = query.Select(
                kvp => $"{WebUtility.UrlEncode(kvp.Key)}={WebUtility.UrlEncode(kvp.Value)}");
            uriBuilder.Query = string.Join("&", queryParts);
        }

        return uriBuilder.Uri.ToString();
    }

    private static bool ShouldRetry(HttpStatusCode status)
    {
        return status == (HttpStatusCode)429
               || status == HttpStatusCode.BadGateway
               || status == HttpStatusCode.ServiceUnavailable
               || status == HttpStatusCode.GatewayTimeout;
    }

    private static async Task BackoffAsync(
        string url,
        HttpStatusCode? status,
        int attempt,
        int maxAttempts)
    {
        var delayBase = 500;
        var delay = Math.Min(8000, delayBase * Math.Pow(2, attempt - 1));
        var jitter = Random.Shared.NextDouble() * 250;
        Console.WriteLine(
            $"[OpenF1] {(status.HasValue ? (int)status.Value : "ERR")} for {url} (attempt {attempt}/{maxAttempts}), retrying in {Math.Round(delay + jitter)}ms");
        await Task.Delay(TimeSpan.FromMilliseconds(delay + jitter));
    }

    private static List<(string From, string To)> CreateTimeSlices(
        string dateStart,
        string dateEnd,
        int sliceCount)
    {
        if (!DateTime.TryParse(dateStart, out var start)
            || !DateTime.TryParse(dateEnd, out var end))
        {
            throw new InvalidOperationException(
                $"Invalid session date range: start={dateStart} end={dateEnd}");
        }

        var startMs = start.ToUniversalTime().Ticks;
        var endMs = end.ToUniversalTime().Ticks;
        if (endMs <= startMs)
        {
            var iso = start.ToUniversalTime().ToString("O");
            return new List<(string From, string To)> { (iso, iso) };
        }

        var buckets = Math.Max(1, sliceCount);
        var delta = (endMs - startMs) / buckets;
        var slices = new List<(string From, string To)>();

        for (var i = 0; i < buckets; i++)
        {
            var fromTicks = startMs + delta * i;
            var toTicks = i == buckets - 1 ? endMs : startMs + delta * (i + 1);
            var fromIso = new DateTime(fromTicks, DateTimeKind.Utc).ToString("O");
            var toIso = new DateTime(toTicks, DateTimeKind.Utc).ToString("O");
            slices.Add((fromIso, toIso));
        }

        return slices;
    }
}

public sealed class OpenF1SessionData
{
    public required string SessionKey { get; init; }
    public required OpenF1SessionMeta SessionInfo { get; init; }
    public OpenF1MeetingMeta? MeetingInfo { get; init; }
    public List<Dictionary<string, JsonElement>> CarData { get; init; } = [];
    public List<Dictionary<string, JsonElement>> Locations { get; init; } = [];
    public List<Dictionary<string, JsonElement>> PitStops { get; init; } = [];
    public List<Dictionary<string, JsonElement>> RaceControl { get; init; } = [];
    public List<Dictionary<string, JsonElement>> Stints { get; init; } = [];
    public List<Dictionary<string, JsonElement>> Laps { get; init; } = [];
    public List<OpenF1WeatherRecord> Weather { get; init; } = [];
}

public sealed record OpenF1SessionMeta
{
    [JsonPropertyName("circuit_key")] public int CircuitKey { get; init; }
    [JsonPropertyName("circuit_short_name")] public string CircuitShortName { get; init; } = string.Empty;
    [JsonPropertyName("country_code")] public string CountryCode { get; init; } = string.Empty;
    [JsonPropertyName("country_key")] public int CountryKey { get; init; }
    [JsonPropertyName("country_name")] public string CountryName { get; init; } = string.Empty;
    [JsonPropertyName("date_end")] public string DateEnd { get; init; } = string.Empty;
    [JsonPropertyName("date_start")] public string DateStart { get; init; } = string.Empty;
    [JsonPropertyName("gmt_offset")] public string GmtOffset { get; init; } = string.Empty;
    [JsonPropertyName("location")] public string Location { get; init; } = string.Empty;
    [JsonPropertyName("meeting_key")] public int MeetingKey { get; init; }
    [JsonPropertyName("session_key")] public int SessionKey { get; init; }
    [JsonPropertyName("session_name")] public string SessionName { get; init; } = string.Empty;
    [JsonPropertyName("session_type")] public string SessionType { get; init; } = string.Empty;
    [JsonPropertyName("year")] public int Year { get; init; }
    [JsonPropertyName("meeting_name")] public string? MeetingName { get; init; }
    [JsonPropertyName("meeting_official_name")] public string? MeetingOfficialName { get; init; }
}

public sealed record OpenF1TeamRadioRecord
{
    [JsonPropertyName("date")] public string Date { get; init; } = string.Empty;
    [JsonPropertyName("driver_number")] public int DriverNumber { get; init; }
    [JsonPropertyName("recording_url")] public string RecordingUrl { get; init; } = string.Empty;
    [JsonPropertyName("session_key")] public int SessionKey { get; init; }
}

public sealed record OpenF1MeetingMeta
{
    [JsonPropertyName("meeting_key")] public int MeetingKey { get; init; }
    [JsonPropertyName("meeting_name")] public string? MeetingName { get; init; }
    [JsonPropertyName("meeting_official_name")] public string? MeetingOfficialName { get; init; }
    [JsonPropertyName("location")] public string? Location { get; init; }
    [JsonPropertyName("country_name")] public string? CountryName { get; init; }
    [JsonPropertyName("country_code")] public string? CountryCode { get; init; }
    [JsonPropertyName("country_key")] public int? CountryKey { get; init; }
    [JsonPropertyName("gmt_offset")] public string? GmtOffset { get; init; }
    [JsonPropertyName("circuit_key")] public int? CircuitKey { get; init; }
    [JsonPropertyName("circuit_short_name")] public string? CircuitShortName { get; init; }
    [JsonPropertyName("year")] public int? Year { get; init; }
}

public sealed record OpenF1WeatherRecord
{
    [JsonPropertyName("date")] public string Date { get; init; } = string.Empty;
    [JsonPropertyName("session_key")] public int SessionKey { get; init; }
    [JsonPropertyName("air_temperature")] public double? AirTemperature { get; init; }
    [JsonPropertyName("humidity")] public double? Humidity { get; init; }
    [JsonPropertyName("pressure")] public double? Pressure { get; init; }
    [JsonPropertyName("rainfall")] public double? Rainfall { get; init; }
    [JsonPropertyName("track_temperature")] public double? TrackTemperature { get; init; }
    [JsonPropertyName("wind_direction")] public double? WindDirection { get; init; }
    [JsonPropertyName("wind_speed")] public double? WindSpeed { get; init; }
}
