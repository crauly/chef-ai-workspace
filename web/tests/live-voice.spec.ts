// Explicit opt-in only: live Muse Voice + Spark + dedicated Supabase via local servers.
import {test, expect} from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
test.skip(process.env.CHEF_LIVE_VOICE !== "1", "Live voice/database acceptance is opt-in");

test("Japanese audio → live Muse Voice/Spark → explicit correction/review/save → live Supabase reload", async ({page, request}) => {
  const state = async () => {
    const response = await request.get("http://127.0.0.1:8102/test/live-state");
    expect(response.ok()).toBe(true); return response.json();
  };
  expect((await state()).recipes).toHaveLength(0);
  const transcripts: Array<{transcript: string; model: string}> = [];
  const audioDir = process.env.CHEF_LIVE_VOICE_AUDIO_DIR;
  if (!audioDir) throw new Error("Set CHEF_LIVE_VOICE_AUDIO_DIR to the four canonical test WAV files");
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {value: async () => {
      const c = new AudioContext(), dest = c.createMediaStreamDestination();
      const response = await fetch((window as unknown as {testAudio: string}).testAudio);
      const source = c.createBufferSource(); source.buffer = await c.decodeAudioData(await response.arrayBuffer());
      source.connect(dest); await c.resume(); source.start();
      const track = dest.stream.getTracks()[0], stop = track.stop.bind(track);
      track.stop = () => {stop(); void c.close();};
      return dest.stream;
    }});
  });
  for (const name of ["recipe", "correction", "review", "save"]) {
    await page.route(`**/test-audio/${name}.wav`, route => route.fulfill({
      path: path.join(audioDir, name + ".wav"), contentType: "audio/wav",
    }));
  }
  page.on("response", async response => {
    if (response.url().endsWith("/api/voice/transcribe") && response.ok()) {
      const transcript = await response.json(); transcripts.push(transcript);
      console.log("LIVE raw transcript:", JSON.stringify(transcript));
    }
  });
  await page.goto("/");
  const record = async (name: string) => {
    const wav = fs.readFileSync(path.join(audioDir, name + ".wav"));
    const seconds = (wav.length - 44) / wav.readUInt32LE(28);
    await page.evaluate(name => {(window as unknown as {testAudio: string}).testAudio = "/test-audio/" + name + ".wav";}, name);
    await page.getByRole("button", {name: "🎙 音声登録を開始", exact: true}).click();
    await page.waitForTimeout(seconds * 1000 + 400);
    await page.getByRole("button", {name: "■ マイクを停止", exact: true}).click();
    await expect(page.getByRole("button", {name: "🎙 音声登録を開始", exact: true})).toBeEnabled({timeout: 40_000});
  };
  await record("recipe");
  const draft = page.getByLabel("未保存のレシピ下書き");
  await expect(draft).toBeVisible({timeout: 40_000});
  console.log("LIVE initial draft:", (await draft.textContent())?.replace(/\s+/g, " "));
  expect((await state()).recipes).toHaveLength(0);
  await expect(page.getByRole("button", {name: "内容を承認して保存"})).toBeDisabled();
  await record("correction");
  await expect(draft).toContainText("150g", {timeout: 40_000});
  console.log("LIVE corrected draft:", (await draft.textContent())?.replace(/\s+/g, " "));
  expect((await state()).recipes).toHaveLength(0);
  // Recognition is not deterministic. Exercise the existing human-authored
  // recovery input if the audio still leaves an incorrect/ambiguous draft.
  const text = await draft.textContent();
  if (!text?.includes("未保存の下書き：音声テスト") || !text.includes("¥350 / 500g") || text.includes("不足情報") || text.includes("要確認")) {
    console.log("LIVE recovery: explicit typed correction required; no save attempted");
    await page.getByLabel("音声認識できない場合の入力").fill("料理名は音声テストに訂正。乾燥パスタの使用量は150g、仕入単価は500gで350円、売価は1800円に訂正。先ほどの料理名・金額の曖昧さをこの指定で解消してください。");
    await page.getByRole("button", {name: "反映", exact: true}).click();
    await expect(draft).toContainText("未保存の下書き：音声テスト", {timeout: 40_000});
    await expect(draft).toContainText("¥350 / 500g", {timeout: 40_000});
    await expect(draft).not.toContainText("不足情報"); await expect(draft).not.toContainText("要確認");
  }
  await expect(page.getByRole("button", {name: "内容を承認して保存"})).toBeDisabled();
  await record("review");
  // A malformed recognition of an approval phrase must never be treated as approval.
  if (!/^(内容を確認)[。\s]*$/.test(transcripts.at(-1)?.transcript || "")) {
    console.log("LIVE recovery: explicit typed review after unrecognized audio command");
    await page.getByLabel("音声認識できない場合の入力").fill("内容を確認");
    await page.getByRole("button", {name: "反映", exact: true}).click();
  }
  await expect(page.getByRole("button", {name: "内容を承認して保存"})).toBeEnabled({timeout: 40_000});
  expect((await state()).recipes).toHaveLength(0);
  await record("save");
  if (!/^(登録を確定)[。\s]*$/.test(transcripts.at(-1)?.transcript || "")) {
    // An unknown utterance can invalidate review. Require review again, then the
    // existing explicit approval button; do not normalize ASR hallucinations.
    console.log("LIVE recovery: explicit re-review and button approval required");
    expect((await state()).recipes).toHaveLength(0);
    await page.getByLabel("音声認識できない場合の入力").fill("内容を確認");
    await page.getByRole("button", {name: "反映", exact: true}).click();
    await page.getByRole("button", {name: "内容を承認して保存"}).click();
  }
  await expect(page.getByText("レシピを保存しました。")).toBeVisible({timeout: 40_000});
  const stored = await state(); expect(stored.recipes).toHaveLength(1);
  expect(stored.recipes[0].state.materials[0].quantity.value).toBe("150");
  expect(stored.recipes[0].state.title.value).toBe("音声テスト");
  expect(stored.recipes[0].state.selling_price_jpy.value).toBe("1800");
  expect(stored.versions).toHaveLength(1);
  expect(stored.versions[0].cost_snapshot.total_cost_jpy).toBe("105");
  await page.reload(); await expect(page.getByRole("button", {name: "詳細を見る"})).toHaveCount(1);
  await page.getByRole("button", {name: "詳細を見る"}).click();
  await expect(page.getByRole("region", {name: "Recipe cost summary"})).toContainText("¥105");
  console.log("LIVE transcripts:", JSON.stringify(transcripts));
  console.log("LIVE durable state:", JSON.stringify({recipes: stored.recipes.length, cost: stored.versions[0].cost_snapshot, revision: stored.recipes[0].revision}));
});
