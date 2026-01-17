using System.Data;
using Npgsql;

namespace Backend.Data;

public sealed class Database
{
    private readonly string _connectionString;

    public Database(IConfiguration configuration)
    {
        _connectionString = ResolveConnectionString(configuration);
    }

    public async Task<NpgsqlConnection> OpenConnectionAsync()
    {
        var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync();
        return connection;
    }

    private static string ResolveConnectionString(IConfiguration configuration)
    {
        var databaseUrl = Environment.GetEnvironmentVariable("DATABASE_URL")
                          ?? configuration["DATABASE_URL"];
        if (string.IsNullOrWhiteSpace(databaseUrl))
        {
            throw new InvalidOperationException(
                "DATABASE_URL environment variable is required to connect to TimescaleDB.");
        }

        if (!databaseUrl.StartsWith("postgres://", StringComparison.OrdinalIgnoreCase)
            && !databaseUrl.StartsWith("postgresql://", StringComparison.OrdinalIgnoreCase))
        {
            return databaseUrl;
        }

        var uri = new Uri(databaseUrl);
        var userInfo = uri.UserInfo.Split(':', 2, StringSplitOptions.RemoveEmptyEntries);
        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Username = userInfo.Length > 0 ? Uri.UnescapeDataString(userInfo[0]) : string.Empty,
            Password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : string.Empty,
            Database = uri.AbsolutePath.TrimStart('/'),
        };

        if (!string.IsNullOrWhiteSpace(uri.Query))
        {
            var query = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries);
            foreach (var entry in query)
            {
                var parts = entry.Split('=', 2);
                if (parts.Length != 2)
                {
                    continue;
                }

                var key = Uri.UnescapeDataString(parts[0]);
                var value = Uri.UnescapeDataString(parts[1]);
                if (key.Equals("sslmode", StringComparison.OrdinalIgnoreCase))
                {
                    if (Enum.TryParse<SslMode>(value, true, out var sslMode))
                    {
                        builder.SslMode = sslMode;
                    }
                }
                else if (key.Equals("search_path", StringComparison.OrdinalIgnoreCase))
                {
                    builder.SearchPath = value;
                }
                else if (key.Equals("application_name", StringComparison.OrdinalIgnoreCase))
                {
                    builder.ApplicationName = value;
                }
            }
        }

        return builder.ConnectionString;
    }
}
