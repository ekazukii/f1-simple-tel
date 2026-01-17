using System.Diagnostics;
using System.Text;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Backend.Cli;
using Backend.Data;
using Backend.Datasources;
using Backend.Services;
using Dapper;

DefaultTypeMap.MatchNamesWithUnderscores = true;

var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = null;
});

builder.Services.AddSingleton<Database>();
builder.Services.AddSingleton<SessionService>();
builder.Services.AddHttpClient<OpenF1Client>(client =>
{
    client.BaseAddress = new Uri("https://api.openf1.org/v1");
    client.Timeout = TimeSpan.FromSeconds(15);
});
builder.Services.AddHttpClient<TranscriptionService>();

var parsedPort = int.TryParse(Environment.GetEnvironmentVariable("PORT"), out var portValue)
    ? portValue
    : 4000;
var port = parsedPort > 0 ? parsedPort : 4000;
builder.WebHost.UseUrls($"http://*:{port}");

var app = builder.Build();

if (await CliRunner.TryRunAsync(args, app.Services))
{
    return;
}

var database = app.Services.GetRequiredService<Database>();
try
{
    await DatabaseMigrator.InitializeAsync(database);
}
catch (Exception error)
{
    Console.Error.WriteLine($"Failed to initialize database: {error}");
    Environment.Exit(1);
}

app.Use(async (context, next) =>
{
    var startedAt = Stopwatch.GetTimestamp();
    Console.WriteLine($"[HTTP] start {context.Request.Method} {context.Request.Path}{context.Request.QueryString}");

    try
    {
        await next();
    }
    catch (Exception error)
    {
        Console.Error.WriteLine("Unhandled error: " + error);
        context.Response.StatusCode = 500;
        await context.Response.WriteAsJsonAsync(new { error = "Internal server error" });
    }
    finally
    {
        var durationMs = Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds;
        Console.WriteLine(
            $"[HTTP] {context.Request.Method} {context.Request.Path}{context.Request.QueryString} -> {context.Response.StatusCode} ({durationMs:F0}ms)");
    }
});

app.Use(async (context, next) =>
{
    context.Response.Headers["Access-Control-Allow-Origin"] = "*";
    context.Response.Headers["Access-Control-Allow-Headers"] =
        context.Request.Headers["Access-Control-Request-Headers"].ToString() ?? "*";
    context.Response.Headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";

    if (HttpMethods.IsOptions(context.Request.Method))
    {
        context.Response.StatusCode = 204;
        return;
    }

    await next();
});

app.MapGet("/session/{key}", async (HttpRequest request, string key, SessionService service) =>
{
    var sessionKey = key?.Trim();
    var sampleSecondsRaw = request.Query["sampleSeconds"].FirstOrDefault()
                           ?? request.Query["sample"].FirstOrDefault()
                           ?? request.Query["s"].FirstOrDefault();
    var sampleSeconds = double.TryParse(
            sampleSecondsRaw,
            NumberStyles.Float,
            CultureInfo.InvariantCulture,
            out var sampleValue) && sampleValue > 0
        ? sampleValue
        : (double?)null;

    var telemetryRaw = (request.Query["telemetry"].FirstOrDefault()
                        ?? request.Query["includeTelemetry"].FirstOrDefault()
                        ?? "full").ToLowerInvariant();
    var telemetryMode = telemetryRaw switch
    {
        "0" or "false" or "none" or "no" => TelemetryMode.None,
        "position" or "pos" => TelemetryMode.Position,
        _ => TelemetryMode.Full
    };

    if (string.IsNullOrWhiteSpace(sessionKey))
    {
        return Results.Json(new { error = "Session key is required" }, statusCode: 400);
    }

    try
    {
        Console.WriteLine($"[DB] Querying session {sessionKey}");
        var data = await service.GetSessionDataAsync(sessionKey, sampleSeconds, telemetryMode);
        Console.WriteLine($"[DB] Finish querying session {sessionKey}");
        return Results.Json(data);
    }
    catch (SessionNotFoundException error)
    {
        return Results.Json(new { error = error.Message }, statusCode: 404);
    }
    catch (Exception error)
    {
        Console.Error.WriteLine($"[HTTP] Failed to load session {sessionKey}: {error}");
        return Results.Json(
            new { error = "Failed to fetch session data", detail = error.Message },
            statusCode: 502);
    }
});

app.MapGet("/session/{key}/telemetry", async (HttpRequest request, string key, SessionService service) =>
{
    var sessionKey = key?.Trim();
    if (string.IsNullOrWhiteSpace(sessionKey))
    {
        return Results.Json(new { error = "Session key is required" }, statusCode: 400);
    }

    var driversRaw = request.Query["drivers"];
    var driverAlt = request.Query["driver"];
    var driverValues = new List<string>();
    if (driversRaw.Count > 0)
    {
        driverValues.AddRange(driversRaw.SelectMany(value =>
            (value ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries)));
    }
    if (driverAlt.Count > 0)
    {
        driverValues.AddRange(driverAlt.SelectMany(value =>
            (value ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries)));
    }

    var drivers = driverValues
        .Select(value => int.TryParse(value.Trim(), out var parsed) ? parsed : (int?)null)
        .Where(value => value.HasValue)
        .Select(value => value!.Value)
        .Distinct()
        .ToArray();

    if (drivers.Length is 0 or > 2)
    {
        return Results.Json(
            new { error = "drivers must include 1 or 2 numeric identifiers" },
            statusCode: 400);
    }

    var lapRaw = request.Query["lap"].FirstOrDefault();
    if (!int.TryParse(lapRaw, out var lapNumber) || lapNumber <= 0)
    {
        return Results.Json(new { error = "lap must be a positive number" }, statusCode: 400);
    }

    var sampleSecondsRaw = request.Query["sampleSeconds"].FirstOrDefault()
                           ?? request.Query["sample"].FirstOrDefault()
                           ?? request.Query["s"].FirstOrDefault();
    var sampleSeconds = double.TryParse(
            sampleSecondsRaw,
            NumberStyles.Float,
            CultureInfo.InvariantCulture,
            out var sampleValue) && sampleValue > 0
        ? sampleValue
        : (double?)null;

    var resolved = await service.ResolveSessionAsync(sessionKey);
    if (resolved is null)
    {
        return Results.Json(new { error = "Session not found" }, statusCode: 404);
    }

    try
    {
        var telemetry = await service.GetTelemetrySliceAsync(
            sessionKey,
            drivers,
            lapNumber,
            sampleSeconds);
        return Results.Json(telemetry);
    }
    catch (Exception error)
    {
        return Results.Json(
            new { error = "Failed to fetch telemetry slice", detail = error.Message },
            statusCode: 502);
    }
});

app.MapGet("/track-layout/{circuitKey}", async (string circuitKey) =>
{
    if (string.IsNullOrWhiteSpace(circuitKey) || !int.TryParse(circuitKey, out _))
    {
        return Results.Json(new { error = "Circuit key must be a numeric identifier" }, statusCode: 400);
    }

    var cwd = Directory.GetCurrentDirectory();
    var candidateDirs = new[]
    {
        Path.Combine(cwd, "assets", "track_heatmaps"),
        Path.Combine(cwd, "backend", "assets", "track_heatmaps"),
        Path.Combine(Path.GetFullPath(Path.Combine(cwd, "..")), "backend", "assets", "track_heatmaps")
    };
    var fileName = $"circuit_{circuitKey}.svg";
    var filePath = candidateDirs
        .Select(dir => Path.Combine(dir, fileName))
        .FirstOrDefault(File.Exists);

    if (filePath is null)
    {
        return Results.Json(new { error = "Track layout not found" }, statusCode: 404);
    }

    try
    {
        var svg = await File.ReadAllTextAsync(filePath);
        return Results.Text(svg, "image/svg+xml");
    }
    catch (Exception error)
    {
        return Results.Json(
            new { error = "Failed to read track layout", detail = error.Message },
            statusCode: 500);
    }
});

app.MapGet("/track-speed/{sessionKey}/{driver}/{lap}", async (
    string sessionKey,
    string driver,
    string lap,
    SessionService service) =>
{
    if (string.IsNullOrWhiteSpace(sessionKey)
        || string.IsNullOrWhiteSpace(driver)
        || string.IsNullOrWhiteSpace(lap))
    {
        return Results.Json(new { error = "Session, driver, and lap are required" }, statusCode: 400);
    }

    var resolved = await service.ResolveSessionAsync(sessionKey);
    if (resolved is null)
    {
        return Results.Json(new { error = "Session not found" }, statusCode: 404);
    }

    if (!int.TryParse(driver, out var driverNumber) || !int.TryParse(lap, out var lapNumber))
    {
        return Results.Json(
            new { error = "Driver and lap must be numeric identifiers" },
            statusCode: 400);
    }

    var numericSessionKey = resolved.NumericKey;
    var cwd = Directory.GetCurrentDirectory();
    var driverDir = $"driver_{driverNumber}";
    var candidateDirs = new[]
    {
        Path.Combine(cwd, "assets", "track_speed_maps", numericSessionKey.ToString(), driverDir),
        Path.Combine(cwd, "backend", "assets", "track_speed_maps", numericSessionKey.ToString(), driverDir),
        Path.Combine(
            Path.GetFullPath(Path.Combine(cwd, "..")),
            "backend",
            "assets",
            "track_speed_maps",
            numericSessionKey.ToString(),
            driverDir)
    };
    var fileName = $"lap_{lapNumber}.svg";
    var filePath = candidateDirs
        .Select(dir => Path.Combine(dir, fileName))
        .FirstOrDefault(File.Exists);

    if (filePath is null)
    {
        return Results.Json(new { error = "Track speed map not found" }, statusCode: 404);
    }

    try
    {
        var svg = await File.ReadAllTextAsync(filePath);
        return Results.Text(svg, "image/svg+xml");
    }
    catch (Exception error)
    {
        return Results.Json(
            new { error = "Failed to read track speed map", detail = error.Message },
            statusCode: 500);
    }
});

app.MapPost("/simulation/strategy", async (HttpContext context) =>
{
    JsonNode? payload;
    try
    {
        payload = await JsonNode.ParseAsync(context.Request.Body);
    }
    catch (Exception error)
    {
        return Results.Json(
            new { error = "Invalid JSON payload", detail = error.Message },
            statusCode: 400);
    }

    if (payload is not JsonObject root)
    {
        return Results.Json(new { error = "Invalid JSON payload" }, statusCode: 400);
    }

    if (root["strategy"] is not JsonObject strategyNode)
    {
        return Results.Json(new { error = "Missing strategy configuration" }, statusCode: 400);
    }

    var pathsNode = root["paths"] as JsonObject ?? new JsonObject();
    var optionsNode = root["options"] as JsonObject ?? new JsonObject();

    var repoRoot = ResolveRepoRoot();
    var modelsDir = Path.Combine(repoRoot, "models");

    pathsNode["base_dir"] ??= repoRoot;
    pathsNode["bundle_path"] ??= ResolveModelPath(modelsDir, "laptime_model_bundle.joblib");
    pathsNode["data_path"] ??= ResolveModelPath(modelsDir, "fastf1_lap_dataset.csv");
    pathsNode["overtake_path"] ??= ResolveModelPath(modelsDir, "overtaking_model.joblib");
    pathsNode["dnf_path"] ??= ResolveModelPath(modelsDir, "dnf_model.joblib");
    pathsNode["safety_path"] ??= ResolveModelPath(modelsDir, "safety_car_model.joblib");

    var seed = ParseSeed(optionsNode["seed"]);
    if (!seed.HasValue)
    {
        seed = Random.Shared.Next(0, 1_000_000_000);
    }

    optionsNode["noise_scale"] = 0.5;
    optionsNode["seed"] = seed.Value;
    strategyNode["num_runs_compare"] = 10;
    strategyNode["update_every"] = 2;

    root["paths"] = pathsNode;
    root["options"] = optionsNode;
    root["strategy"] = strategyNode;

    var tempDir = Directory.CreateTempSubdirectory("f1sim-");
    var inputPath = Path.Combine(tempDir.FullName, "input.json");
    var outputPath = Path.Combine(tempDir.FullName, "output.json");
    await File.WriteAllTextAsync(
        inputPath,
        root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

    var scriptPath = Path.Combine(modelsDir, "montecarlo_sim.py");
    var pythonBin = Environment.GetEnvironmentVariable("PYTHON_BIN") ?? "python3";

    var process = new Process
    {
        StartInfo = new ProcessStartInfo
        {
            FileName = pythonBin,
            WorkingDirectory = repoRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
    };
    process.StartInfo.ArgumentList.Add(scriptPath);
    process.StartInfo.ArgumentList.Add("--strategy");
    process.StartInfo.ArgumentList.Add("--input");
    process.StartInfo.ArgumentList.Add(inputPath);
    process.StartInfo.ArgumentList.Add("--output");
    process.StartInfo.ArgumentList.Add(outputPath);

    if (!process.Start())
    {
        return Results.Json(new { error = "Failed to start simulation" }, statusCode: 500);
    }

    var response = context.Response;
    response.StatusCode = 200;
    response.ContentType = "application/x-ndjson";
    response.Headers["Cache-Control"] = "no-cache";
    response.Headers["Connection"] = "keep-alive";
    response.Headers["Access-Control-Allow-Origin"] = "*";

    await using var writer = new StreamWriter(response.Body, new UTF8Encoding(false));
    var writeLock = new SemaphoreSlim(1, 1);

    async Task SendLineAsync(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return;
        }

        if (!line.EndsWith('\n'))
        {
            line += "\n";
        }

        await writeLock.WaitAsync();
        try
        {
            await writer.WriteAsync(line);
            await writer.FlushAsync();
        }
        finally
        {
            writeLock.Release();
        }
    }

    Task CleanupAsync()
    {
        try
        {
            tempDir.Delete(true);
        }
        catch
        {
            // ignore cleanup errors
        }

        return Task.CompletedTask;
    }

    void HandleProcessError(string message)
    {
        var errorPayload = JsonSerializer.Serialize(new { @event = "error", message });
        SendLineAsync(errorPayload).GetAwaiter().GetResult();
    }

    var stdoutTask = Task.Run(async () =>
    {
        string? line;
        while ((line = await process.StandardOutput.ReadLineAsync()) != null)
        {
            await SendLineAsync(line);
        }
    });

    var stderrTask = Task.Run(async () =>
    {
        string? line;
        while ((line = await process.StandardError.ReadLineAsync()) != null)
        {
            if (!string.IsNullOrWhiteSpace(line))
            {
                Console.Error.WriteLine("[SIM] stderr: " + line);
                var eventPayload = JsonSerializer.Serialize(new { @event = "stderr", message = line });
                await SendLineAsync(eventPayload);
            }
        }
    });

    context.RequestAborted.Register(() =>
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(true);
            }
        }
        catch
        {
            // ignore termination errors
        }
    });

    await process.WaitForExitAsync();
    await Task.WhenAll(stdoutTask, stderrTask);

    if (process.ExitCode != 0)
    {
        HandleProcessError($"Simulation failed with exit code {process.ExitCode}");
        await CleanupAsync();
        return Results.Empty;
    }

    try
    {
        var outputText = await File.ReadAllTextAsync(outputPath);
        var outputData = JsonSerializer.Deserialize<JsonNode>(outputText);
        var resultPayload = JsonSerializer.Serialize(new { @event = "result", data = outputData });
        await SendLineAsync(resultPayload);
    }
    catch (Exception error)
    {
        HandleProcessError($"Failed to read output: {error.Message}");
    }
    finally
    {
        await CleanupAsync();
    }

    return Results.Empty;
});

app.Run();

static string ResolveRepoRoot()
{
    var configured = Environment.GetEnvironmentVariable("F1STUFF_ROOT");
    if (!string.IsNullOrWhiteSpace(configured))
    {
        return configured;
    }

    var cwd = Directory.GetCurrentDirectory();
    return Directory.Exists(Path.Combine(cwd, "models"))
        ? cwd
        : Path.GetFullPath(Path.Combine(cwd, ".."));
}

static string ResolveModelPath(string modelsDir, string fileName)
{
    var primary = Path.Combine(modelsDir, fileName);
    if (File.Exists(primary))
    {
        return primary;
    }

    var nested = Path.Combine(modelsDir, "models", fileName);
    return File.Exists(nested) ? nested : primary;
}

static int? ParseSeed(JsonNode? node)
{
    if (node is JsonValue value)
    {
        if (value.TryGetValue<int>(out var number))
        {
            return number;
        }

        if (value.TryGetValue<string>(out var str)
            && int.TryParse(str, out var parsed))
        {
            return parsed;
        }
    }

    return null;
}
