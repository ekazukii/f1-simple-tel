namespace Backend.Data;

public sealed record Migration(string Id, IReadOnlyList<string> Statements);
