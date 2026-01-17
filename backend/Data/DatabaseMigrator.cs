using Dapper;

namespace Backend.Data;

public static class DatabaseMigrator
{
    public static async Task InitializeAsync(Database database, CancellationToken cancellationToken = default)
    {
        await using var connection = await database.OpenConnectionAsync();

        await connection.ExecuteAsync(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
              id TEXT PRIMARY KEY,
              applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """);

        var appliedRows = await connection.QueryAsync<string>("SELECT id FROM schema_migrations");
        var applied = new HashSet<string>(appliedRows);

        foreach (var migration in Migrations.All)
        {
            if (applied.Contains(migration.Id))
            {
                continue;
            }

            Console.WriteLine($"[DB] Applying migration {migration.Id}");
            await using var tx = await connection.BeginTransactionAsync(cancellationToken);
            foreach (var statement in migration.Statements)
            {
                await connection.ExecuteAsync(statement, transaction: tx);
            }

            await connection.ExecuteAsync(
                "INSERT INTO schema_migrations (id) VALUES (@Id)",
                new { migration.Id },
                tx);

            await tx.CommitAsync(cancellationToken);
            Console.WriteLine($"[DB] Migration {migration.Id} applied");
        }
    }
}
