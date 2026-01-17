using Backend.Data;
using Dapper;

namespace Backend.Scripts;

public static class DeleteSessionScript
{
    public static async Task RunAsync(string[] args, IServiceProvider services)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("Usage: dotnet run -- delete-session -- <session_key_or_alias>");
            Environment.Exit(1);
        }

        var sessionKeyArg = args[0];
        var db = services.GetRequiredService<Database>();
        await DatabaseMigrator.InitializeAsync(db);

        await using var connection = await db.OpenConnectionAsync();
        var resolved = await ResolveSessionKeyAsync(connection, sessionKeyArg);
        if (resolved is null)
        {
            Console.Error.WriteLine($"Session {sessionKeyArg} not found");
            Environment.Exit(1);
        }

        await DeleteSessionAsync(connection, resolved.SessionKey);
        Console.WriteLine(
            $"Deleted session {resolved.SessionKey}{(resolved.Alias is null ? "" : $" ({resolved.Alias})")}");
    }

    private static async Task<ResolvedSession?> ResolveSessionKeyAsync(
        Npgsql.NpgsqlConnection connection,
        string identifier)
    {
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

    private static async Task DeleteSessionAsync(
        Npgsql.NpgsqlConnection connection,
        int sessionKey)
    {
        await using var tx = await connection.BeginTransactionAsync();
        await connection.ExecuteAsync(
            "DELETE FROM telemetry_samples WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey },
            tx);
        await connection.ExecuteAsync(
            "DELETE FROM pit_stops WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey },
            tx);
        await connection.ExecuteAsync(
            "DELETE FROM race_control_events WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey },
            tx);
        await connection.ExecuteAsync(
            "DELETE FROM stints WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey },
            tx);
        await connection.ExecuteAsync(
            "DELETE FROM laps WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey },
            tx);
        await connection.ExecuteAsync(
            "DELETE FROM weather_samples WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey },
            tx);
        await connection.ExecuteAsync(
            "DELETE FROM session_aliases WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey },
            tx);
        await connection.ExecuteAsync(
            "DELETE FROM sessions WHERE session_key = @SessionKey",
            new { SessionKey = sessionKey },
            tx);
        await tx.CommitAsync();
    }

    private sealed record ResolvedSession(int SessionKey, string? Alias);
}
