// Server transport: never import into a client component. No persistence or logging.
export const MAX_WAV_BYTES = 24_000 * 2 * 30 + 44;
export const VOICE_MODEL = "muse-voice-transcribe-1.0";
// Domain hints steer recognition without replacing or rewriting the transcript.
export const JAPANESE_VOICE_KEYWORDS = ["食材", "使用量", "仕入単価", "仕入れ価格", "売価", "乾燥パスタ", "訂正", "アーリオオーリオ", "ペペロンチーノ"];

export function validWav(audio: Uint8Array): boolean {
  if (audio.length < 46 || audio.length > MAX_WAV_BYTES) return false;
  const v = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const tag = (at: number, text: string) => [...text].every((c, i) => audio[at + i] === c.charCodeAt(0));
  const rate = v.getUint32(24, true), size = audio.length - 44;
  // A deliberately narrow canonical WAV contract, supported by future native clients too.
  return tag(0, "RIFF") && tag(8, "WAVE") && tag(12, "fmt ") && tag(36, "data") &&
    v.getUint32(4, true) === audio.length - 8 && v.getUint32(16, true) === 16 &&
    v.getUint16(20, true) === 1 && v.getUint16(22, true) === 1 &&
    [16_000, 24_000].includes(rate) && v.getUint32(28, true) === rate * 2 &&
    v.getUint16(32, true) === 2 && v.getUint16(34, true) === 16 &&
    v.getUint32(40, true) === size && size % 2 === 0 && size <= rate * 2 * 30;
}

export async function transcribeWav(audio: Uint8Array, language: "ja" | "en-US", key: string,
  transport: typeof fetch = fetch) {
  if (!validWav(audio)) throw new Error("Invalid audio");
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify({model: VOICE_MODEL, mode: "PUSH_TO_TALK",
    audioEncoding: "WAV", languageBias: [language === "ja" ? "Japanese" : "English"],
    ...(language === "ja" ? {keywords: JAPANESE_VOICE_KEYWORDS} : {})})],
    {type: "application/json"}));
  form.append("audio", new Blob([new Uint8Array(audio)], {type: "audio/wav"}), "utterance.wav");
  const response = await transport("https://api.meta.ai/v1/asr/transcribe", {
    method: "POST", headers: {Authorization: "Bearer " + key, Accept: "application/json"},
    body: form, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error("Transcription unavailable");
  // Bound the response too. Provider error bodies and session identifiers are not reflected.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Invalid transcription");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65_536) {await reader.cancel(); throw new Error("Invalid transcription");}
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
  const out: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const transcript = out && typeof out === "object" ? (out as {transcript?: unknown}).transcript : null;
  if (typeof transcript !== "string" || !transcript.trim() || transcript.length > 1000)
    throw new Error("Invalid transcription");
  return {transcript, provider: "meta_voice", model: VOICE_MODEL};
}
