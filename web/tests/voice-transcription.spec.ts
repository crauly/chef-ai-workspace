import {test, expect, type Page} from "@playwright/test";
import {MAX_WAV_BYTES, transcribeWav, validWav, VOICE_MODEL, JAPANESE_VOICE_KEYWORDS} from "../app/voice-transcription";
import {NextRequest} from "next/server";
import {POST as parseRecipe} from "../app/api/voice-recipe/route";

function wav(rate = 24_000, seconds = 1) {
  const b = Buffer.alloc(44 + rate * seconds * 2);
  b.write("RIFF", 0); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(b.length - 44, 40);
  return b;
}

test("Meta Voice transport uses the documented multipart contract and preserves raw Japanese", async () => {
  const audio = wav();
  const transport: typeof fetch = async (url, init) => {
    expect(url).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect(init?.headers).toEqual({Authorization: "Bearer fixture-key", Accept: "application/json"});
    expect(init?.redirect).toBe("error"); expect(init?.cache).toBe("no-store");
    const form = init?.body as FormData;
    expect(JSON.parse(await (form.get("request") as Blob).text())).toEqual({
      model: VOICE_MODEL, mode: "PUSH_TO_TALK", audioEncoding: "WAV", languageBias: ["Japanese"],
      keywords: JAPANESE_VOICE_KEYWORDS,
    });
    expect(Buffer.from(await (form.get("audio") as Blob).arrayBuffer())).toEqual(audio);
    return Response.json({transcript: "片栗粉10g、いや15g。", sessionId: "private-session"});
  };
  expect(await transcribeWav(audio, "ja", "fixture-key", transport)).toEqual({
    transcript: "片栗粉10g、いや15g。", provider: "meta_voice", model: VOICE_MODEL,
  });
  expect(validWav(wav(16_000))).toBe(true);
  for (const audio of [wav(48_000), wav(24_000, 31), Buffer.from("not audio"), wav().subarray(0, 100)])
    expect(validWav(audio)).toBe(false);
  const stereo = wav(); stereo.writeUInt16LE(2, 22); expect(validWav(stereo)).toBe(false);
});

test("English settings and malformed, excessive or failed upstream responses fail closed", async () => {
  await transcribeWav(wav(), "en-US", "fixture", async (_, init) => {
    const settings = JSON.parse(await ((init?.body as FormData).get("request") as Blob).text());
    expect(settings.languageBias).toEqual(["English"]);
    return Response.json({transcript: "pasta"});
  });
  for (const response of [Response.json({text: "wrong schema"}),
    Response.json({transcript: "x".repeat(1001)}), new Response("secret", {status: 401}),
    new Response("x".repeat(70_000)), new Response("bad JSON")]) {
    await expect(transcribeWav(wav(), "ja", "fixture", async () => response)).rejects.toThrow();
  }
});

test("empty transcript is silence, not a provider fault: 200 no_speech without transcript", async () => {
  // Live-verified Meta shape for silence: HTTP 200 {transcript: "", ...}.
  for (const body of [{transcript: ""}, {transcript: "   ", sessionId: "s", audioDurationMs: 1040, turns: []}]) {
    const out = await transcribeWav(wav(), "ja", "fixture", async () => Response.json(body));
    expect(out).toEqual({transcript: "", no_speech: true, provider: "meta_voice", model: VOICE_MODEL});
  }
});

test("live-observed Spark notes-string response is rejected; typed notes array yields a reviewable draft", async () => {
  const previousFetch = global.fetch, password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  process.env.DEMO_PREVIEW_PASSWORD = "test-only-preview-password-32-characters";
  process.env.MODEL_API_KEY = "fixture-key";
  try {
    for (const notes of ["", []]) {
      global.fetch = async (_, init) => {
        const sent = JSON.parse(String(init?.body));
        expect(sent.messages[0].content).toContain("notes MUST be an array of strings");
        expect(sent.messages[0].role).toBe("developer");
        expect(sent.reasoning_effort).toBe("low");
        return Response.json({choices: [{message: {content: JSON.stringify({
          title: "音声テスト", materials: [{name: "乾燥パスタ", quantity: "150", unit: "g", price_jpy: "350", price_quantity: "500", price_unit: "g", supplier: ""}],
          selling_price_jpy: "1800", notes,
        })}}]});
      };
      const response = await parseRecipe(new NextRequest("http://localhost/api/voice-recipe", {method: "POST",
        headers: {Origin: "http://localhost", Authorization: "Basic " + Buffer.from("chef:" + process.env.DEMO_PREVIEW_PASSWORD).toString("base64")},
        body: JSON.stringify({turns: ["乾燥パスタ150g、500g350円、売価1800円"]})}));
      expect(response.status).toBe(Array.isArray(notes) ? 200 : 502);
      if (Array.isArray(notes)) expect((await response.json()).missing).toEqual([]);
    }
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
  }
});

test("audio route rejects anonymous, cross-origin, invalid and oversized input before provider access", async ({request}) => {
  const url = "http://localhost:3100/api/voice/transcribe";
  expect((await fetch(url, {method: "POST"})).status).toBe(401);
  expect((await request.post(url, {headers: {Origin: "https://other.example"}})).status()).toBe(403);
  // Send credentials preemptively for binary uploads, as the signed-in browser does.
  const headers = {Authorization: "Basic " + Buffer.from("chef:test-only-preview-password-32-characters").toString("base64"),
    Origin: "http://localhost:3100", "Content-Type": "audio/wav", "X-Audio-Language": "ja"};
  expect((await request.post(url, {headers: {...headers, "Content-Type": "audio/webm"}, data: wav()})).status()).toBe(415);
  expect((await request.post(url, {headers: {...headers, "X-Audio-Language": "xx"}, data: wav()})).status()).toBe(400);
  expect((await request.post(url, {headers, data: Buffer.from("invalid")})).status()).toBe(400);
  expect((await request.post(url, {headers, data: Buffer.alloc(MAX_WAV_BYTES + 1)})).status()).toBe(413);
  // Exercise a full-size valid upload through the real Next route too.
  const full = await request.post(url, {headers, data: wav(24_000, 30)});
  expect(full.status()).toBe(503);
  expect(full.headers()["x-content-type-options"]).toBe("nosniff");
  const result = await request.post(url, {headers, data: wav()});
  expect(result.status()).toBe(503); // Test web server has no real API key.
  expect(result.headers()["cache-control"]).toBe("no-store");
  expect((await fetch(url, {method: "POST", headers: {
    "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware"}})).status).toBe(401);
});

async function installMicrophone(page: Page) {
  // Synthetic microphone; actual AudioWorklet and OfflineAudioContext encoding run in Chromium.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {value: async () => {
      const c = new AudioContext(), oscillator = c.createOscillator(), gain = c.createGain();
      const destination = c.createMediaStreamDestination();
      oscillator.connect(gain); gain.connect(destination); gain.gain.value = 0.1; oscillator.start();
      await c.resume();
      const track = destination.stream.getTracks()[0], stop = track.stop.bind(track);
      track.stop = () => {stop(); void c.close();};
      return destination.stream;
    }});
  });
}

test("real Web Audio capture sends WAV through transcription, review and explicit save only", async ({page}) => {
  await installMicrophone(page);
  let saved = 0, transcribed = 0;
  const texts = ["カルボナーラ、卵100グラム、50グラム60円、売価1800円", "内容を確認", "登録"];
  await page.route("**/api/voice/transcribe", async route => {
    const data = route.request().postDataBuffer()!;
    expect(validWav(data)).toBe(true);
    expect(route.request().headers()["x-audio-language"]).toBe("ja");
    await route.fulfill({json: {transcript: texts[transcribed++], provider: "meta_voice", model: VOICE_MODEL}});
  });
  await page.route("**/api/voice-recipe", route => route.fulfill({json: {
    title: "カルボナーラ", materials: [{name: "卵", quantity: "100", unit: "g", price_jpy: "60", price_quantity: "50", price_unit: "g", supplier: ""}],
    selling_price_jpy: "1800", notes: [], missing: [],
  }}));
  await page.route("**/api/recipes/full", async route => {
    saved++; const body = route.request().postDataJSON();
    await route.fulfill({status: 201, json: {id: body.request_id, title: {value: body.title}, revision: 0, materials: [], selling_price_jpy: {value: "1800"}}});
  });
  await page.goto("/");
  const recordTurn = async () => {
    await page.getByRole("button", {name: "🎙 音声操作を開始", exact: true}).click();
    await page.waitForTimeout(700);
    await page.getByRole("button", {name: "■ マイクを停止", exact: true}).click();
  };
  await recordTurn();
  await expect(page.getByText("未保存の下書き：カルボナーラ")).toBeVisible();
  expect(saved).toBe(0);
  // Review presents the eligible draft; only an explicit save commits it.
  await recordTurn();
  await expect(page.getByRole("button", {name: "レシピを登録"})).toBeEnabled();
  expect(saved).toBe(0);
  await recordTurn();
  await expect(page.getByText("レシピを保存しました。")).toBeVisible();
  expect(saved).toBe(1); expect(transcribed).toBe(3);
});

test("transcription failure keeps capture running, reports recovery and never sends a draft or save", async ({page}) => {
  // Tone for 400ms then silence: the 1s silence split submits mid-recording,
  // so the mocked 502 fails while the microphone is still open.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {value: async () => {
      const c = new AudioContext(), oscillator = c.createOscillator(), gain = c.createGain();
      const destination = c.createMediaStreamDestination();
      oscillator.connect(gain); gain.connect(destination);
      const t = c.currentTime;
      gain.gain.setValueAtTime(0.1, t); gain.gain.setValueAtTime(0.0001, t + 0.4);
      oscillator.start();
      await c.resume();
      return destination.stream;
    }});
  });
  let mutations = 0;
  await page.route("**/api/voice-recipe", route => {mutations++; return route.fulfill({status: 500});});
  await page.route("**/api/recipes/full", route => {mutations++; return route.fulfill({status: 500});});
  await page.route("**/api/voice/transcribe", route => route.fulfill({status: 502, json: {error: "failed"}}));
  await page.goto("/");
  await page.getByRole("button", {name: "🎙 音声操作を開始", exact: true}).click();
  // Capture continues despite the failed fragment: the stop control stays,
  // the failure is announced, and no draft or save is produced from it.
  await expect(page.getByRole("button", {name: "■ マイクを停止", exact: true})).toBeEnabled();
  await expect(page.getByRole("region", {name: "音声操作モード"}).getByRole("alert")).toContainText("受付は続けています");
  await page.getByRole("button", {name: "■ マイクを停止", exact: true}).click();
  expect(mutations).toBe(0);
});

test("leaving the shared microphone discards an in-flight transcript", async ({page}) => {
  await installMicrophone(page);
  let parsed = 0;
  await page.route("**/api/voice-recipe", route => {parsed++; return route.fulfill({status: 500});});
  let release!: () => void;
  const blocked = new Promise<void>(resolve => {release = resolve;});
  let started!: () => void;
  const sending = new Promise<void>(resolve => {started = resolve;});
  await page.route("**/api/voice/transcribe", async route => {
    started(); await blocked;
    await route.fulfill({json: {transcript: "この発話は破棄される"}}).catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", {name: "🎙 音声操作を開始", exact: true}).click();
  await page.waitForTimeout(700);
  await page.getByRole("button", {name: "■ マイクを停止", exact: true}).click();
  await sending;
  await expect(page.getByRole("button", {name: /🎙/})).toHaveCount(1);
  await page.reload();
  release(); await page.waitForTimeout(300);
  expect(parsed).toBe(0);
  await expect(page.getByLabel("未保存のレシピ下書き")).toHaveCount(0);
  await page.reload();
});

test("transcription failures are classified: timeout vs upstream vs invalid", async () => {
  const {TranscriptionError} = await import("../app/voice-transcription");
  type TranscriptionErrorType = InstanceType<typeof TranscriptionError>;
  try {
    await transcribeWav(wav(), "ja", "fixture", async () => {
      throw Object.assign(new Error("timeout"), {name: "TimeoutError"});
    });
    throw new Error("should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(TranscriptionError);
    expect((error as TranscriptionErrorType).kind).toBe("timeout");
  }
  try {
    await transcribeWav(wav(), "ja", "fixture", async () => new Response("down", {status: 503}));
    throw new Error("should have thrown");
  } catch (error) {
    expect((error as TranscriptionErrorType).kind).toBe("upstream");
  }
  try {
    await transcribeWav(wav(), "ja", "fixture", async () => Response.json({text: "no transcript"}));
    throw new Error("should have thrown");
  } catch (error) {
    expect((error as TranscriptionErrorType).kind).toBe("invalid");
  }
});

test("a stalled response body stays a timeout; a broken body stays upstream", async () => {
  const {TranscriptionError} = await import("../app/voice-transcription");
  type TranscriptionErrorType = InstanceType<typeof TranscriptionError>;
  const stall = () => new Response(new ReadableStream({}), {status: 200});
  try {
    await transcribeWav(wav(), "ja", "fixture", async () => stall(), 50);
    throw new Error("should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(TranscriptionError);
    expect((error as TranscriptionErrorType).kind).toBe("timeout");
  }
  const broken = () => new Response(new ReadableStream({start(c) {c.error(new TypeError("network"));}}), {status: 200});
  try {
    await transcribeWav(wav(), "ja", "fixture", async () => broken());
    throw new Error("should have thrown");
  } catch (error) {
    expect((error as TranscriptionErrorType).kind).toBe("upstream");
  }
});
