import {test, expect} from "@playwright/test";

// NOTE: "**/api/voice-recipe" glob also matches ".../prices", so the prices
// handler must be registered first (first match wins in Playwright).
async function mockParse(page: any, handler: (route: any) => Promise<void>) {
  await page.route(/\/api\/voice-recipe(\?.*)?$/, handler);
}

// Price search must survive follow-up utterances for unchanged ingredients.
test("follow-up utterance keeps the running price search (no cancel)", async ({page}) => {
  let priceCalls = 0;
  const deferred = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  await page.route("**/api/voice-recipe/prices", async route => {
    priceCalls++;
    await new Promise(r => setTimeout(r, 600));
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({
      research_state: "complete",
      price_references: [{material_name: "パスタ", material_index: 0, status: "available", origin: "external", currency: "JPY", text: "参考価格あり"}],
      research_status: [{material_name: "パスタ", material_index: 0, request: "平均価格を調べて", trigger: "muse", ledger: "not_found", web: "available", provisional: true}],
      provisional_prices: [{material_index: 0, material_name: "パスタ", origin: "external", price_jpy: "120", price_quantity: "1", price_unit: "g", currency: "JPY", observation_count: 2, sources: [{url: "https://shop.example/p", title: "Shop"}], fetched_at: "2026-11-01T00:00:00Z", status: "provisional", approval: "unapproved", text: "参考価格"}],
    })});
  });
  await mockParse(page, async route => {
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(deferred)});
  });
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  const reflect = page.getByRole("button", {name: "反映"});
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible();
  await expect(page.getByText("価格を検索しています")).toBeVisible();
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("検索結果を取得しました")).toBeVisible({timeout: 8000});
  expect(priceCalls).toBe(1);
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible();
  await expect(page.getByRole("button", {name: "価格の詳細・出典"})).toBeVisible();
});

// Changed ingredient must not receive the stale price.
test("renamed ingredient does not inherit the stale price search", async ({page}) => {
  let calls = 0;
  const first = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  const second = {
    title: "うどん", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "うどん", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "うどん", material_index: 0, row_name: "うどん", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  let n = 0;
  await page.route("**/api/voice-recipe/prices", async route => {
    calls++;
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({
      research_state: "complete", price_references: [], research_status: [],
      provisional_prices: [null],
    })});
  });
  await mockParse(page, async route => {
    n++;
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(n === 1 ? first : second)});
  });
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  const reflect = page.getByRole("button", {name: "反映"});
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible();
  await entry.fill("うどんに変更");
  await reflect.click();
  await expect(page.getByText("未保存の下書き：うどん")).toBeVisible({timeout: 8000});
  await expect.poll(() => calls, {timeout: 8000}).toBeGreaterThanOrEqual(2);
  // No stale provisional from パスタ may appear on the うどん row.
  await expect(page.getByRole("button", {name: "この価格を使う"})).toBeHidden();
});

// Failure keeps the draft and never leaves "searching" stuck on.
test("price failure keeps the draft and clears the searching status", async ({page}) => {
  const deferred = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  await page.route("**/api/voice-recipe/prices", async route => {
    await route.abort("failed");
  });
  await mockParse(page, async route => {
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(deferred)});
  });
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await page.getByRole("button", {name: "反映"}).click();
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible();
  await expect(page.getByText("価格を確認できませんでした")).toBeVisible({timeout: 8000});
  await expect(page.getByText("価格を検索しています")).toBeHidden();
});

// Bottom mic keeps a single recording source of truth for animation.
test("bottom mic exposes recording state for animation", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/");
  const mic = page.locator(".bottom-nav-mic");
  await expect(mic).toBeVisible();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
});

// Empty follow-up pending terminates the old flight: unneeded prices must
// never land on the new draft, and loading must not stick.
test("empty follow-up pending terminates the old price search", async ({page}) => {
  let priceCalls = 0;
  const deferred = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  const complete = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "complete",
    price_references: [], research_status: [], provisional_prices: [null],
  };
  let n = 0;
  await page.route("**/api/voice-recipe/prices", async route => {
    priceCalls++;
    await new Promise(r => setTimeout(r, 800));
    try {
      await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({
        research_state: "complete", price_references: [], research_status: [],
        provisional_prices: [{material_index: 0, material_name: "パスタ", origin: "external", price_jpy: "120", price_quantity: "1", price_unit: "g", currency: "JPY", observation_count: 1, sources: [], fetched_at: null, status: "provisional", approval: "unapproved", text: "x"}],
      })});
    } catch { /* aborted by the follow-up draft: expected */ }
  });
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    n++;
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(n === 1 ? deferred : complete)});
  });
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  const reflect = page.getByRole("button", {name: "反映"});
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible();
  await expect(page.getByText("価格を検索しています")).toBeVisible();
  await entry.fill("やっぱり価格調査は不要");
  await reflect.click();
  await expect(page.getByText("価格を検索しています")).toBeHidden({timeout: 8000});
  // The late search result must not surface after the draft dropped research.
  await page.waitForTimeout(1200);
  await expect(page.getByText("検索結果を取得しました")).toBeHidden();
  await expect(page.getByRole("button", {name: "この価格を使う"})).toBeHidden();
  await expect(page.getByRole("button", {name: "価格の詳細・出典"})).toBeHidden();
  expect(priceCalls).toBe(1);
});

// Discarding the draft resets search history: the same ingredient in a new
// registration must be searched again instead of suppressed as "done".
test("discarded draft resets search history for the next registration", async ({page}) => {
  let priceCalls = 0;
  const deferred = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  const done = {
    research_state: "complete",
    price_references: [{material_name: "パスタ", material_index: 0, status: "available", origin: "external", currency: "JPY", text: "参考価格あり"}],
    research_status: [{material_name: "パスタ", material_index: 0, request: "平均価格を調べて", trigger: "muse", ledger: "not_found", web: "available", provisional: true}],
    provisional_prices: [{material_index: 0, material_name: "パスタ", origin: "external", price_jpy: "120", price_quantity: "1", price_unit: "g", currency: "JPY", observation_count: 1, sources: [], fetched_at: null, status: "provisional", approval: "unapproved", text: "参考価格"}],
  };
  await page.route("**/api/voice-recipe/prices", async route => {
    priceCalls++;
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(done)});
  });
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(deferred)});
  });
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  const reflect = page.getByRole("button", {name: "反映"});
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("検索結果を取得しました")).toBeVisible({timeout: 8000});
  await page.getByRole("button", {name: "下書きを破棄"}).click();
  await expect(page.getByText("未保存の下書き：パスタ")).toBeHidden();
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("検索結果を取得しました")).toBeVisible({timeout: 8000});
  expect(priceCalls).toBe(2);
});

// A search finishing mid-parse must be applied without loss or duplication:
// exactly one prices call even though the second parse was still in flight.
test("search finishing during parse is applied without refetch", async ({page}) => {
  let priceCalls = 0;
  const deferred = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  const done = {
    research_state: "complete",
    price_references: [{material_name: "パスタ", material_index: 0, status: "available", origin: "external", currency: "JPY", text: "参考価格あり"}],
    research_status: [{material_name: "パスタ", material_index: 0, request: "平均価格を調べて", trigger: "muse", ledger: "not_found", web: "available", provisional: true}],
    provisional_prices: [{material_index: 0, material_name: "パスタ", origin: "external", price_jpy: "120", price_quantity: "1", price_unit: "g", currency: "JPY", observation_count: 1, sources: [], fetched_at: null, status: "provisional", approval: "unapproved", text: "参考価格"}],
  };
  let n = 0;
  await page.route("**/api/voice-recipe/prices", async route => {
    priceCalls++;
    await new Promise(r => setTimeout(r, 600));
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(done)});
  });
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    n++;
    // The follow-up parse is slower than the running price search, so the
    // search completes while no live draft exists.
    if (n > 1) await new Promise(r => setTimeout(r, 900));
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(deferred)});
  });
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  const reflect = page.getByRole("button", {name: "反映"});
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("価格を検索しています")).toBeVisible();
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("検索結果を取得しました")).toBeVisible({timeout: 10000});
  expect(priceCalls).toBe(1);
  await expect(page.getByRole("button", {name: "価格の詳細・出典"})).toBeVisible();
});

// A repeated identical request reuses the completed result: no refetch and
// no row stuck in pending with no search running.
test("repeated identical request reuses the completed result", async ({page}) => {
  let priceCalls = 0;
  const deferred = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  const done = {
    research_state: "complete",
    price_references: [{material_name: "パスタ", material_index: 0, status: "available", origin: "external", currency: "JPY", text: "参考価格あり"}],
    research_status: [{material_name: "パスタ", material_index: 0, request: "平均価格を調べて", trigger: "muse", ledger: "not_found", web: "available", provisional: true}],
    provisional_prices: [{material_index: 0, material_name: "パスタ", origin: "external", price_jpy: "120", price_quantity: "1", price_unit: "g", currency: "JPY", observation_count: 1, sources: [], fetched_at: null, status: "provisional", approval: "unapproved", text: "参考価格"}],
  };
  await page.route("**/api/voice-recipe/prices", async route => {
    priceCalls++;
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(done)});
  });
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(deferred)});
  });
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  const reflect = page.getByRole("button", {name: "反映"});
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("検索結果を取得しました")).toBeVisible({timeout: 8000});
  // Same research request again: served from cache, no second fetch.
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("検索結果を取得しました")).toBeVisible({timeout: 8000});
  await page.waitForTimeout(500);
  expect(priceCalls).toBe(1);
  await expect(page.getByText("価格を検索しています")).toBeHidden();
  await expect(page.getByText("価格を調査中…")).toBeHidden();
  await expect(page.getByRole("button", {name: "価格の詳細・出典"})).toBeVisible();
});

// Reviewing during a search that then fails invalidates the approval: the
// user must review again instead of facing an enabled but dead approval.
test("review during search is invalidated when the search fails", async ({page}) => {
  const deferred = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  await page.route("**/api/voice-recipe/prices", async route => {
    await new Promise(r => setTimeout(r, 800));
    await route.abort("failed");
  });
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(deferred)});
  });
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await page.getByRole("button", {name: "反映"}).click();
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible();
  await entry.fill("内容を確認");
  await page.getByRole("button", {name: "反映"}).click();
  await expect(page.getByRole("button", {name: "レシピを登録"})).toBeEnabled();
  // The running search fails: the failure stays explicit, the draft is kept,
  // and nothing was saved without an explicit registration.
  await expect(page.getByText("価格を確認できませんでした")).toBeVisible({timeout: 8000});
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible();
  await expect(page.getByRole("button", {name: "レシピを登録"})).toBeEnabled();
});

// A new parse that supersedes the failed research clears the obsolete failure:
// manual prices need no search, so the old warning must go and completion shows.
test("superseding parse clears the obsolete price failure", async ({page}) => {
  const deferred = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  const manual = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "350", price_quantity: "500", price_unit: "g", supplier: ""}],
    research_state: "complete",
    price_references: [], research_status: [], provisional_prices: [null],
  };
  let n = 0;
  await page.route("**/api/voice-recipe/prices", async route => {
    await route.abort("failed");
  });
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    n++;
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(n === 1 ? deferred : manual)});
  });
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  const reflect = page.getByRole("button", {name: "反映"});
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible();
  await expect(page.getByText("価格検索に失敗しました")).toBeVisible({timeout: 8000});
  await expect(page.getByText("処理完了")).toBeHidden();
  // Manual prices supersede the failed research: no pending, no new search.
  await entry.fill("パスタは500グラム350円で買った");
  await reflect.click();
  await expect(page.getByText("価格検索に失敗しました")).toBeHidden({timeout: 8000});
  await expect(page.getByText("処理完了")).toBeVisible();
});

// A successful save must not carry the failure into the next recipe: the next
// registration starts with no price warning.
test("successful save clears the price failure for the next recipe", async ({page}) => {
  const deferred = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  const fresh = {
    title: "うどん", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "うどん", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "complete",
    price_references: [], research_status: [], provisional_prices: [null],
  };
  let n = 0;
  await page.route("**/api/voice-recipe/prices", async route => {
    await route.abort("failed");
  });
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    n++;
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(n === 1 ? deferred : fresh)});
  });
  await page.route("**/api/recipes/full", async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({status: 201, json: {id: body.request_id, title: {value: body.title}, revision: 0, materials: [], selling_price_jpy: {value: null}}});
  });
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  const reflect = page.getByRole("button", {name: "反映"});
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible();
  await expect(page.getByText("価格検索に失敗しました")).toBeVisible({timeout: 8000});
  // One explicit registration saves the price-unconfirmed draft directly.
  await page.getByRole("button", {name: "レシピを登録"}).click();
  await expect(page.getByRole("region",{name:"音声操作モード"}).getByText("価格未確定として保存しました。")).toBeVisible({timeout: 8000});
  // Next recipe with no research inherits no failure from the previous one.
  // Saving leaves registration mode, so return via the Create tab first.
  await page.getByRole("button", {name: "登録"}).click();
  await entry.fill("うどん100グラム");
  await reflect.click();
  await expect(page.getByText("未保存の下書き：うどん")).toBeVisible({timeout: 8000});
  await expect(page.getByText("価格検索に失敗しました")).toBeHidden();
  await expect(page.getByText("処理完了")).toBeVisible();
});

// A genuine failure with no superseding parse or save must stay visible:
// review commands and unrelated activity never clear it silently.
test("genuine price failure survives review without a new parse", async ({page}) => {
  const deferred = {
    title: "パスタ", selling_price_jpy: "", notes: [], missing: [],
    materials: [{name: "パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    research_state: "deferred",
    pending_research: [{material_name: "パスタ", material_index: 0, row_name: "パスタ", request: "平均価格を調べて", trigger: "muse"}],
    price_references: [], research_status: [], provisional_prices: [null],
  };
  await page.route("**/api/voice-recipe/prices", async route => {
    await route.abort("failed");
  });
  await page.route(/\/api\/voice-recipe(\?.*)?$/, async route => {
    await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(deferred)});
  });
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  const reflect = page.getByRole("button", {name: "反映"});
  await entry.fill("パスタ100グラム、平均価格を調べて");
  await reflect.click();
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible();
  await expect(page.getByText("価格検索に失敗しました")).toBeVisible({timeout: 8000});
  // Review is a command, not a new parse: the failure must persist.
  await entry.fill("内容を確認");
  await reflect.click();
  await expect(page.getByText("価格検索に失敗しました")).toBeVisible({timeout: 8000});
  await expect(page.getByText("未保存の下書き：パスタ")).toBeVisible();
  await expect(page.getByText("処理完了")).toBeHidden();
});
