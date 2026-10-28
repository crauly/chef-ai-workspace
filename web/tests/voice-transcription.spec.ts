import {test, expect, type Page} from "@playwright/test";
import {MAX_WAV_BYTES, transcribeWav, validWav, VOICE_MODEL} from "../app/voice-transcription";

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

test("English settings and malformed, empty, excessive or failed upstream responses fail closed", async () => {
  await transcribeWav(wav(), "en-US", "fixture", async (_, init) => {
    const settings = JSON.parse(await ((init?.body as FormData).get("request") as Blob).text());
    expect(settings.languageBias).toEqual(["English"]);
    return Response.json({transcript: "pasta"});
  });
  for (const response of [Response.json({transcript: ""}), Response.json({text: "wrong schema"}),
    Response.json({transcript: "x".repeat(1001)}), new Response("secret", {status: 401}),
    new Response("x".repeat(70_000)), new Response("bad JSON")]) {
    await expect(transcribeWav(wav(), "ja", "fixture", async () => response)).rejects.toThrow();
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
  const texts = ["カルボナーラ、卵100グラム、50グラム60円、売価1800円", "登録を確定", "内容を確認", "登録を確定"];
  await page.route("**/api/voice/transcribe", async route => {
    const data = route.request().postDataBuffer()!;
    expect(validWav(data)).toBe(true);
    expect(route.request().headers()["x-audio-language"]).toBe("ja");
    await route.fulfill({json: {transcript: texts[transcribed++], provider: "meta_voice", model: VOICE_MODEL}});
  });
  await page.route("**/api/voice-recipe", route => route.fulfill({json: {
    title: "カルボナーラ", materials: [{name: "卵", quantity: "100", unit: "g", price_jpy: "60", price_quantity: "50", price_unit: "g"}],
    selling_price_jpy: "1800", notes: [], missing: [],
  }}));
  await page.route("**/api/recipes/full", async route => {
    saved++; const body = route.request().postDataJSON();
    await route.fulfill({status: 201, json: {id: body.request_id, title: {value: body.title}, revision: 0, materials: [], selling_price_jpy: {value: "1800"}}});
  });
  await page.goto("/");
  const recordTurn = async () => {
    await page.getByRole("button", {name: "🎙 音声登録を開始", exact: true}).click();
    await page.waitForTimeout(700);
    await page.getByRole("button", {name: "■ マイクを停止", exact: true}).click();
  };
  await recordTurn();
  await expect(page.getByText("未保存の下書き：カルボナーラ")).toBeVisible();
  expect(saved).toBe(0);
  await recordTurn();
  await expect(page.getByText('先に「内容を確認」と話してください。')).toBeVisible();
  expect(saved).toBe(0);
  await recordTurn();
  await expect(page.getByRole("button", {name: "内容を承認して保存"})).toBeEnabled();
  expect(saved).toBe(0);
  await recordTurn();
  await expect(page.getByText("レシピを保存しました。")).toBeVisible();
  expect(saved).toBe(1); expect(transcribed).toBe(4);
});

test("transcription failure stops capture, reports recovery and never sends a draft or save", async ({page}) => {
  await installMicrophone(page);
  let mutations = 0;
  await page.route("**/api/voice-recipe", route => {mutations++; return route.fulfill({status: 500});});
  await page.route("**/api/recipes/full", route => {mutations++; return route.fulfill({status: 500});});
  await page.route("**/api/voice/transcribe", route => route.fulfill({status: 502, json: {error: "failed"}}));
  await page.goto("/");
  await page.getByRole("button", {name: "🎙 音声登録を開始", exact: true}).click();
  await page.waitForTimeout(700);
  await page.getByRole("button", {name: "■ マイクを停止", exact: true}).click();
  await expect(page.getByRole("region", {name: "音声レシピ一括登録"}).getByRole("alert")).toContainText("音声を文字にできませんでした");
  await expect(page.getByRole("button", {name: "🎙 音声登録を開始", exact: true})).toBeEnabled();
  expect(mutations).toBe(0);
});

test("switching microphones discards an in-flight transcript from the previous input", async ({page}) => {
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
  await page.getByRole("button", {name: "🎙 音声登録を開始", exact: true}).click();
  await page.waitForTimeout(700);
  await page.getByRole("button", {name: "■ マイクを停止", exact: true}).click();
  await sending;
  await page.getByRole("button", {name: "🎙 音声コマンドを話す", exact: true}).click();
  release(); await page.waitForTimeout(300);
  expect(parsed).toBe(0);
  await expect(page.getByText("認識した発話：なし")).toBeVisible();
  await page.reload();
});
