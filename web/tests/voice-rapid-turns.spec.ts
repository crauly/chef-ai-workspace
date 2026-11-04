import {test, expect, type Page} from "@playwright/test";

// Regression: normal-speed continuous registration must not lose audio.
// "新しいレシピを登録します" + 5 ingredients submitted back-to-back while the
// first Muse parse is still in flight. Every turn must reach voice-recipe in
// order, and the draft must reflect all of them.
const COMMAND = "新しいレシピを登録します";
const INGREDIENTS = [
  "イタリア産ホールトマト200g",
  "ディチェコ乾燥パスタ100g",
  "ギリシャ産オリーブオイル20g",
  "国産ニンニク10g",
  "グラナパダーノ10g",
];
const ALL_TURNS = [COMMAND, ...INGREDIENTS];

const fullDraft = {
  title: "ペペロンチーノ", selling_price_jpy: "", notes: [], missing: [],
  materials: [
    {name: "イタリア産ホールトマト", quantity: "200", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""},
    {name: "ディチェコ乾燥パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""},
    {name: "ギリシャ産オリーブオイル", quantity: "20", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""},
    {name: "国産ニンニク", quantity: "10", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""},
    {name: "グラナパダーノ", quantity: "10", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""},
  ],
  research_state: "complete", pending_research: [],
  price_references: [], research_status: [], provisional_prices: [null, null, null, null, null],
};

async function submit(page: any, text: string) {
  await page.getByLabel("音声認識できない場合の入力").fill(text);
  await page.getByRole("button", {name: "反映"}).click();
}

test.beforeEach(async ({request}) => { await request.post("http://127.0.0.1:8100/test/reset"); });

test("rapid command + 5 ingredients keep every turn in order", async ({page}) => {
  const bodies: any[] = [];
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    bodies.push(route.request().postDataJSON());
    // First parse stays in flight while the follow-ups arrive, like Muse
    // latency under normal speaking speed.
    if (bodies.length === 1) await new Promise(r => setTimeout(r, 1500));
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(fullDraft)});
  });
  await page.goto("/");
  for (const text of ALL_TURNS) await submit(page, text);
  // Analysis actually runs while input arrives.
  await expect(page.getByText("レシピ解析中")).toBeVisible({timeout: 8000});
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("ペペロンチーノ", {timeout: 10000});
  for (const name of ["イタリア産ホールトマト", "ディチェコ乾燥パスタ", "ギリシャ産オリーブオイル", "国産ニンニク", "グラナパダーノ"])
    await expect(page.getByLabel("未保存のレシピ下書き")).toContainText(name);
  // No turn lost: the command is navigation (mode switch, by design), and all
  // five ingredient turns after it arrive in order in the applied parse.
  const last = bodies[bodies.length - 1];
  expect(last.turns).toEqual(INGREDIENTS);
  // Order preserved on screen (newest first).
  await page.getByText(/認識した発話/).first().click();
  const items = page.getByLabel("認識した発話の一覧").getByRole("listitem");
  await expect(items.nth(0)).toContainText("グラナパダーノ");
  await expect(items.nth(4)).toContainText("イタリア産ホールトマト");
  // Status follows reality: analyzing ends, completion shows.
  await expect(page.getByText("レシピ解析中")).toBeHidden({timeout: 8000});
  await expect(page.locator(".voice-status-list [data-stage=parse]")).toHaveCount(0);
});

test("parse failure is visible and keeps every turn for retry", async ({page}) => {
  let calls = 0;
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    calls++;
    if (calls === 1) return route.abort();
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(fullDraft)});
  });
  await page.goto("/");
  await submit(page, COMMAND);
  await submit(page, INGREDIENTS[0]);
  await expect(page.getByText("レシピ解析に失敗")).toBeVisible({timeout: 8000});
  await page.getByText("処理メッセージ").click();
  await expect(page.getByText("料理の解釈に失敗しました")).toBeVisible();
  // Nothing silently vanished: the turns stay listed and retry is offered.
  await expect(page.getByText(/認識した発話/)).toContainText("1件");
  await expect(page.getByRole("button", {name: "解析を再試行"})).toBeEnabled();
  await submit(page, INGREDIENTS[1]);
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("ペペロンチーノ", {timeout: 8000});
  await expect(page.getByText("レシピ解析に失敗")).toBeHidden();
  await expect(page.locator(".voice-status-list [data-stage=parse]")).toHaveCount(0);
});

test("price search runs independently of voice analysis", async ({page}) => {
  const deferred = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  let priceCalls = 0;
  await page.route("**/api/voice-recipe/prices", async route => {
    priceCalls++;
    await new Promise(r => setTimeout(r, 900));
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({
      research_state: "complete",
      price_references: [{material_name: "パスタ", material_index: 0, status: "available", origin: "external", currency: "JPY", text: "参考価格あり"}],
      research_status: [{material_name: "パスタ", material_index: 0, request: "平均価格を調べて", trigger: "muse", ledger: "not_found", web: "available", provisional: true}],
      provisional_prices: [{material_index: 0, material_name: "パスタ", origin: "external", price_jpy: "120", price_quantity: "1", price_unit: "g", currency: "JPY", observation_count: 2, sources: [{url: "https://shop.example/p", title: "Shop"}], fetched_at: "2026-11-01T00:00:00Z", status: "provisional", approval: "unapproved", text: "参考価格"}],
    })});
  });
  let parses = 0;
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    parses++;
    if (parses === 2) await new Promise(r => setTimeout(r, 500));
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(deferred)});
  });
  await page.goto("/");
  await submit(page, "パスタ100グラム、平均価格を調べて");
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible({timeout: 8000});
  await expect(page.getByText("価格検索中")).toBeVisible();
  // A follow-up analyzes while the search keeps running: both states show.
  await submit(page, "パスタ100グラム、平均価格を調べて");
  await expect(page.getByText("レシピ解析中")).toBeVisible({timeout: 8000});
  await expect(page.getByText("検索結果を取得しました")).toBeVisible({timeout: 10000});
  await expect(page.getByText("価格検索中")).toBeHidden();
  await expect(page.getByText("レシピ解析中")).toBeHidden();
  // Unchanged rows reuse the single running search instead of refetching.
  expect(priceCalls).toBe(1);
  await expect(page.getByRole("button", {name: "価格の詳細・出典"})).toBeVisible();
});

test("follow-up during parse keeps every turn when a draft exists", async ({page}) => {
  // Stateless server model (like the real route): each response merges only
  // that request's previous draft with that request's turns. A turn the client
  // never sends is lost for good; the client applies the last response as-is.
  // Deterministic overlap: the second parse stays in flight until all
  // follow-ups are submitted, like Muse latency under normal speaking speed
  // with a draft already present. Submits never block on parses, so no deadlock.
  let releaseSecond = false;
  let calls = 0;
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    calls++;
    const body = route.request().postDataJSON();
    console.log(`CALL turns=${JSON.stringify(body.turns)} prev=${JSON.stringify((body.previous?.materials ?? []).map((m: any) => m.name))}`);
    const names: string[] = [];
    for (const name of [...(body.previous?.materials ?? []).map((m: any) => m.name), ...body.turns]) if (!names.includes(name)) names.push(name);
    if (calls === 2) {
      const start = Date.now();
      while (!releaseSecond && Date.now() - start < 15000) await new Promise(r => setTimeout(r, 50));
    }
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({
      title: "テスト", selling_price_jpy: "", notes: [], missing: [],
      materials: names.map(name => ({name, quantity: "1", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""})),
      research_state: "complete", pending_research: [],
      price_references: [], research_status: [], provisional_prices: names.map(() => null),
    })});
  });
  await page.goto("/");
  const turns = ["トマト200g", "パスタ100g", "オイル20g", "ニンニク10g", "チーズ10g"];
  await submit(page, turns[0]);
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("トマト200g", {timeout: 8000});
  for (const text of turns.slice(1)) await submit(page, text);
  releaseSecond = true;
  // Every turn survives, including the one whose parse went stale mid-flight.
  const draft = page.getByLabel("未保存のレシピ下書き");
  for (const text of turns) await expect(draft).toContainText(text, {timeout: 8000});
});

// Endpoint pressure must be diagnosable, not silent: while two transcriptions
// are in flight, further silence cuts pause (merge) and each pause surfaces as
// a capture.endpoint.deferred event. Buffered audio still transcribes in order.
async function controlledMicrophone(page: Page) {
  await page.addInitScript(() => {
    const state = {opens: 0, stops: 0, feed: null as null | ((seconds: number, speech: boolean) => void)};
    (window as unknown as {resumeMic: typeof state}).resumeMic = state;
    const Worklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Worklet {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        state.feed = (seconds, speech) => { this.port.onmessage?.call(this.port, new MessageEvent("message", {data: {samples: new Float32Array(Math.ceil(context.sampleRate * seconds)).fill(speech ? .1 : 0), reviewEpoch: options?.processorOptions?.reviewEpoch ?? 0}})); };
      }
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {value: async () => {
      const context = new AudioContext(), out = context.createMediaStreamDestination();
      await context.resume();
      const track = out.stream.getTracks()[0], stop = track.stop.bind(track);
      let stopped = false;
      track.stop = () => { if (!stopped) { stopped = true; state.stops++; stop(); void context.close(); } };
      return out.stream;
    }});
  });
}
async function feed(page: Page, seconds: number, speech = true) {
  await page.evaluate(({seconds, speech}) => (window as unknown as {resumeMic: {feed: (s: number, v: boolean) => void}}).resumeMic.feed(seconds, speech), {seconds, speech});
}

test("merge pressure under slow transcription is visible and loses no audio", async ({page}) => {
  await controlledMicrophone(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let transcribes = 0;
  await page.route("**/api/voice/transcribe", async route => {
    if (++transcribes === 1) await held;
    await route.fulfill({json: {transcript: `材料${transcribes}を100g`}});
  });
  await page.route(/\/api\/voice-recipe(\?.*)?$/, route =>
    route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(fullDraft)}));
  await page.goto("/");
  await page.getByRole("button", {name: "🎙 音声操作を開始", exact: true}).click();
  await page.waitForFunction(() => typeof (window as unknown as {resumeMic: {feed: unknown}}).resumeMic.feed === "function");
  for (let i = 0; i < 4; i++) { await feed(page, .5); await feed(page, 1.1, false); }
  // The pause is diagnosed instead of silent: merged seconds + pressure shown.
  await page.getByRole("button", {name: "設定を開く"}).click();
  await page.getByText("音声の状態履歴").click();
  await expect(page.getByText("capture.endpoint.deferred").first()).toBeVisible({timeout: 8000});
  await page.getByRole("button", {name: "設定を開く"}).click();
  expect(await page.evaluate(() => (window as unknown as {resumeMic: {stops: number}}).resumeMic.stops)).toBe(0);
  release();
  // The merged tail is still buffered, not dropped: one more utterance flushes
  // it as a single request carrying the accumulated audio (cycles 3-5), so the
  // mock numbers it 材料3を100g. A real provider would transcribe the whole span.
  await feed(page, .5); await feed(page, 1.1, false);
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("ペペロンチーノ", {timeout: 10000});
  await page.getByText(/認識した発話/).first().click();
  const turns = page.getByLabel("認識した発話の一覧");
  await expect(turns).toContainText("材料3を100g");
  await expect(turns).toContainText("材料2を100g");
  await expect(turns).toContainText("材料1を100g");
  // Five fed fragments traveled in three requests: nothing was dropped, the
  // merge is accounted for, and the microphone never stopped.
  expect(transcribes).toBe(3);
  expect(await page.evaluate(() => (window as unknown as {resumeMic: {stops: number}}).resumeMic.stops)).toBe(0);
});
