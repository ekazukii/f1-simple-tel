using System.Net.Http.Headers;

namespace Backend.Services;

public sealed class TranscriptionService
{
    private const string OpenAiEndpoint = "https://api.openai.com/v1/audio/transcriptions";
    private readonly HttpClient _client;

    public TranscriptionService(HttpClient client)
    {
        _client = client;
    }

    public async Task<string?> TranscribeRecordingFromUrlAsync(string url)
    {
        var apiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY");
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return null;
        }

        var model = Environment.GetEnvironmentVariable("OPENAI_TRANSCRIPT_MODEL") ?? "whisper-1";
        using var audioResponse = await _client.GetAsync(url);
        if (!audioResponse.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"Failed to download audio: {(int)audioResponse.StatusCode}");
        }

        var buffer = await audioResponse.Content.ReadAsByteArrayAsync();
        using var form = new MultipartFormDataContent();
        var modelContent = new StringContent(model);
        form.Add(modelContent, "model");
        var audioContent = new ByteArrayContent(buffer);
        audioContent.Headers.ContentType = new MediaTypeHeaderValue("audio/mpeg");
        form.Add(audioContent, "file", "team-radio.mp3");

        using var request = new HttpRequestMessage(HttpMethod.Post, OpenAiEndpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        request.Content = form;

        using var response = await _client.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            var text = await response.Content.ReadAsStringAsync();
            throw new InvalidOperationException(
                $"Transcription failed: {(int)response.StatusCode} {text}");
        }

        using var responseStream = await response.Content.ReadAsStreamAsync();
        var data = await System.Text.Json.JsonDocument.ParseAsync(responseStream);
        if (data.RootElement.TryGetProperty("text", out var textProp))
        {
            var text = textProp.GetString();
            return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
        }

        return null;
    }
}
