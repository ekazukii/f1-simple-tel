import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIPT_MODEL = process.env.OPENAI_TRANSCRIPT_MODEL || "whisper-1";

export async function transcribeRecordingFromUrl(
  url: string
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const audioResponse = await fetch(url);
  if (!audioResponse.ok) {
    throw new Error(`Failed to download audio: ${audioResponse.status}`);
  }
  const buffer = Buffer.from(await audioResponse.arrayBuffer());

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "f1-radio-"));
  const tmpFile = path.join(tmpDir, `${randomUUID()}.mp3`);
  await fsp.writeFile(tmpFile, buffer);

  try {
    const formData = new FormData();
    formData.append("model", TRANSCRIPT_MODEL);
    formData.append(
      "file",
      new Blob([buffer], { type: "audio/mpeg" }),
      "team-radio.mp3"
    );

    const response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Transcription failed: ${response.status} ${text}`);
    }
    const data = (await response.json()) as { text?: string };
    return data.text?.trim() ?? null;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}
