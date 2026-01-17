using Backend.Scripts;

namespace Backend.Cli;

public static class CliRunner
{
    public static async Task<bool> TryRunAsync(string[] args, IServiceProvider services)
    {
        if (args.Length == 0)
        {
            return false;
        }

        var command = args[0];
        var rest = args.Skip(1).ToArray();

        switch (command)
        {
            case "import-session":
                await ImportSessionScript.RunAsync(rest, services);
                return true;
            case "delete-session":
                await DeleteSessionScript.RunAsync(rest, services);
                return true;
            case "sync-sessions":
                await SyncSessionsScript.RunAsync(rest, services);
                return true;
            case "sync-radio":
                await SyncRadioScript.RunAsync(rest, services);
                return true;
            case "sync-weather":
                await SyncWeatherScript.RunAsync(rest, services);
                return true;
            case "build-track-heatmaps":
                await BuildTrackHeatmapsScript.RunAsync(rest, services);
                return true;
            case "build-track-speed-maps":
                await BuildTrackSpeedMapsScript.RunAsync(rest, services);
                return true;
            case "export-sc-dataset":
                await ExportScDatasetScript.RunAsync(rest, services);
                return true;
            default:
                return false;
        }
    }
}
