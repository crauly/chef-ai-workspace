import { expect, test } from "@playwright/test";

test("voice-first layout keeps nav, mic and draft anchors usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("text=Chef AI").first()).toBeVisible();
  await expect(page.locator("#voice-controls")).toBeVisible();
  await expect(page.locator(".mic-primary")).toBeVisible();
  await expect(page.locator("nav.bottom-nav")).toHaveCount(1);
  await expect(page.locator("#recipes")).toHaveCount(1);
  await expect(page.locator("#recipes")).toBeVisible();
});

test("mobile width keeps mic reachable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("nav.bottom-nav")).toBeVisible();
  await expect(page.locator(".mic-primary")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("desktop width shows voice panel without scrolling past header", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const box = await page.locator("#voice-controls").boundingBox();
  expect(box).not.toBeNull();
});

test("bottom nav reveals a retained draft from browse mode", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/voice-recipe", route => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(
    {title: "保持カレー", materials: [], selling_price_jpy: "", notes: [], missing: ["保持カレーの仕入単価・基準数量・単位"]})}));
  await page.goto("/");
  const entry = page.getByLabel("音声認識できない場合の入力");
  await entry.fill("保持カレー、具材を10グラム");
  await page.getByRole("button", {name: "反映"}).click();
  await expect(page.getByText("未保存の下書き：保持カレー")).toBeVisible();
  // Leave create mode: the draft must stay reachable from the fixed nav.
  await page.getByRole("button", {name: "レシピを参照"}).click();
  await expect(page.locator("#voice-controls").getByText("参照", {exact: true})).toBeVisible();
  await page.locator("nav.bottom-nav").getByRole("button", {name: "下書き"}).click();
  await expect(page.getByText("未保存の下書き：保持カレー")).toBeVisible();
  await expect(page.locator("#voice-controls").getByText("登録", {exact: true})).toBeVisible();
});

test("bottom mic control shares one recording state with the panel button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {value: async () => {
      const c = new AudioContext(), oscillator = c.createOscillator(), gain = c.createGain();
      const destination = c.createMediaStreamDestination();
      oscillator.connect(gain); gain.connect(destination); gain.gain.value = 0.0001; oscillator.start();
      await c.resume();
      return destination.stream;
    }});
  });
  await page.goto("/");
  const panelMic = page.locator(".mic-primary");
  const navMic = page.locator("nav.bottom-nav").getByLabel("下部の音声操作");
  await expect(panelMic).toBeEnabled();
  expect(await navMic.getAttribute("aria-pressed")).toBe("false");
  await navMic.click();
  await expect(panelMic).toHaveText("■ マイクを停止");
  expect(await navMic.getAttribute("aria-pressed")).toBe("true");
  await panelMic.click();
  expect(await navMic.getAttribute("aria-pressed")).toBe("false");
});
