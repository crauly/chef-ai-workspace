import {test, expect} from "@playwright/test";
const id = "11111111-1111-4111-8111-111111111111";
test.beforeEach(async ({request}) => {await request.post("http://127.0.0.1:8100/test/reset");});
test("Japanese chef reviews, explicitly approves, saves, recalculates and records a correction", async ({page, request}) => {
  await page.goto("/"); await page.getByRole("button", {name: /の詳細を開く/}).first().click();
  await page.getByRole("button", {name: "◇ AIに変更相談"}).click();
  await page.getByLabel("料理人の指示", {exact: true}).fill("片栗粉15g、売価1800円に");
  await page.getByRole("button", {name: "変更案を作る"}).click();
  const proposal = page.getByRole("region", {name: "提案の差分"});
  await expect(proposal).toContainText("10 g → 15 g");
  await expect(proposal).toContainText("¥1000 → ¥1800");
  await expect(proposal).toContainText("Meta Muse · muse-spark-1.3");
  const save = page.getByRole("button", {name: "承認して保存・原価再計算"});
  await expect(save).toBeDisabled();
  await page.screenshot({path: "test-results/japanese-proposal.png", fullPage: true});
  expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(0);
  await page.getByRole("checkbox").check(); await save.click();
  await expect(page.locator("section.recipe-detail")).toContainText("¥15");
  const state = await (await request.get("http://127.0.0.1:8100/test/state")).json();
  expect(state.confirms).toHaveLength(1); expect(state.confirms[0].save_version).toBe(true); expect(state.revision).toBe(1);
  await page.getByText("聞き間違い・解釈の訂正を登録", {exact: true}).click();
  await page.getByLabel("元の表現・誤認した言葉").fill("澱粉"); await page.getByLabel("料理人が指定する表現").fill("片栗粉");
  await page.getByRole("button", {name: "訂正を確認して登録"}).click();
  await expect(page.getByRole("region",{name:"AIに変更を相談"}).getByRole("status")).toContainText("訂正履歴を登録しました");
  expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).corrections).toEqual([{heard: "澱粉", preferred: "片栗粉"}]);
  // Reload restores the standalone recipe URL directly with the saved values.
  await page.reload();
  await expect(page.locator("section.recipe-detail")).toContainText("¥15");
  await page.getByRole("button", {name: "← ホーム"}).click();
  await page.getByRole("button", {name: /の詳細を開く/}).first().click();
  await expect(page.locator("section.recipe-detail")).toContainText("¥15");
});
test("English mobile: edit/discard invalidates approval; empty, stale and unavailable proposals never save", async ({page, request}) => {
  await page.setViewportSize({width: 390, height: 844}); await page.goto("/");
  await page.getByLabel("Display language").selectOption("en-US");
  await page.getByRole("button", {name: /View /}).first().click();
  await page.getByRole("button", {name: "◇ Ask AI to edit"}).click();
  const input = page.getByLabel("Chef instruction", {exact: true});
  await input.fill("Change to 15g"); await page.getByRole("button", {name: "Suggest changes"}).click();
  await page.getByRole("checkbox").check(); await input.fill("Different instruction");
  await expect(page.getByRole("button", {name: "Approve, save & recalculate"})).toHaveCount(0);
  await page.getByRole("button", {name: "Suggest changes"}).click(); await page.getByRole("button", {name: "Discard proposal"}).click();
  for (const instruction of ["empty", "stale", "failure"]) {
    await input.fill(instruction); await page.getByRole("button", {name: "Suggest changes"}).click();
    await expect(page.getByRole("button", {name: "Approve, save & recalculate"})).toHaveCount(0);
    await expect(page.getByRole("button", {name: "Suggest changes"})).toBeEnabled();
  }
  await expect(page.getByText("The model is shown with each proposal. Review the changes and approve before saving.")).toBeVisible();
  await page.screenshot({path: "test-results/english-mobile.png", fullPage: true});
  expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload(); await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
});
test("proxy gates anonymous calls, cross-origin writes, invalid IDs and private backend errors", async ({request}) => {
  // Native fetch deliberately bypasses Playwright's configured HTTP credentials.
  for (const path of ["/", "/api/recipes", `/api/recipes/${id}/propose`]) expect((await fetch(`http://localhost:3100${path}`)).status).toBe(401);
  const bypass = await fetch("http://localhost:3100/api/recipes", {headers: {"x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware"}});
  expect([401, 403]).toContain(bypass.status);
  expect((await request.post(`/api/recipes/${id}/confirm`, {headers: {Origin: "https://attacker.example"}, data: {}})).status()).toBe(403);
  expect((await request.get("/api/recipes/invalid")).status()).toBe(400);
  const result = await request.post(`/api/recipes/${id}/propose`, {headers: {Origin: "http://localhost:3100"}, data: {instruction: "failure"}});
  expect(result.status()).toBe(502); expect(await result.text()).not.toContain("test-only-backend-token");
});
test("uncertain save retries the exact request ID without a second commit", async ({page, request}) => {
  await page.goto("/"); await page.getByRole("button", {name: /の詳細を開く/}).first().click();
  await page.getByRole("button", {name: "◇ AIに変更相談"}).click();
  await page.getByLabel("料理人の指示", {exact: true}).fill("片栗粉15g、売価1800円に");
  await page.getByRole("button", {name: "変更案を作る"}).click();
  await page.getByRole("checkbox").check();
  const payloads: unknown[] = [];
  await page.route(`**/api/recipes/${id}/confirm`, async route => {
    payloads.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (payloads.length === 1) await route.fulfill({status: 502, json: {error: "Response lost after commit"}});
    else await route.fulfill({response});
  });
  const save = page.getByRole("button", {name: "承認して保存・原価再計算"});
  await save.click(); await expect(page.getByRole("region", {name: "AIに変更を相談", exact: true}).getByRole("alert")).toContainText("保存結果が不明");
  await save.click();
  await expect(page.locator("section.recipe-detail")).toContainText("¥15");
  expect(payloads).toHaveLength(2); expect(payloads[0]).toEqual(payloads[1]);
  expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(1);
});
test("a concurrent revision refreshes the selected recipe and permits a fresh review without reopening", async ({page, request}) => {
  await page.goto("/"); await page.getByRole("button", {name: /の詳細を開く/}).first().click();
  await page.getByRole("button", {name: "◇ AIに変更相談"}).click();
  await page.getByLabel("料理人の指示", {exact: true}).fill("片栗粉15g、売価1800円に");
  await page.getByRole("button", {name: "変更案を作る"}).click(); await page.getByRole("checkbox").check();
  await request.post("http://127.0.0.1:8100/test/advance");
  await page.getByRole("button", {name: "承認して保存・原価再計算"}).click();
  await expect(page.getByRole("region", {name: "AIに変更を相談", exact: true}).getByRole("alert")).toContainText("最新のレシピを取得しました");
  await expect(page.getByRole("button", {name: "承認して保存・原価再計算"})).toHaveCount(0);
  await page.getByRole("button", {name: "変更案を作る"}).click();
  await expect(page.getByRole("region", {name: "提案の差分"})).toContainText("20 g → 15 g");
  await page.getByRole("checkbox").check(); await page.getByRole("button", {name: "承認して保存・原価再計算"}).click();
  await expect(page.locator("section.recipe-detail")).toContainText("¥15");
  const state = await (await request.get("http://127.0.0.1:8100/test/state")).json();
  expect(state.revision).toBe(2); expect(state.confirms).toHaveLength(1); expect(state.confirms[0].base_revision).toBe(1);
});
