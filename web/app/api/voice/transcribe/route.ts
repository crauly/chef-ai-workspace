import {NextRequest, NextResponse} from "next/server";
import {previewAuthorized} from "../../../../preview-access";
import {MAX_WAV_BYTES, transcribeWav, validWav} from "../../../voice-transcription";

export const runtime = "nodejs";
const headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin"};
const fail = (status: number) => NextResponse.json({error: "Voice transcription failed"},
  {status, headers});

// Shared Web/native boundary: raw PCM WAV, not browser-specific recording containers.
export async function POST(req: NextRequest) {
  if (!await previewAuthorized(req)) return NextResponse.json({error: "Protected Chef AI preview"},
    {status: 401, headers: {...headers, "WWW-Authenticate": 'Basic realm="Chef AI preview", charset="UTF-8"'}});
  if (req.headers.get("origin") !== req.nextUrl.origin) return fail(403);
  if (req.headers.get("content-type") !== "audio/wav") return fail(415);
  const language = req.headers.get("x-audio-language");
  if (language !== "ja" && language !== "en-US") return fail(400);
  const length = req.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_WAV_BYTES)) return fail(413);
  try {
    const reader = req.body?.getReader();
    if (!reader) return fail(400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WAV_BYTES) {await reader.cancel(); return fail(413);}
      chunks.push(value);
    }
    const audio = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {audio.set(chunk, offset); offset += chunk.length;}
    if (!validWav(audio)) return fail(400);
    const key = process.env.MODEL_API_KEY;
    if (!key) return fail(503);
    const result = await transcribeWav(audio, language, key);
    return NextResponse.json(result, {headers});
  } catch {return fail(502);}
}
