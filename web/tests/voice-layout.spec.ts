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
  const overflowing = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")]
    .map(el => ({tag: el.tagName, cls: String(el.className).slice(0, 100),
      right: Math.round(el.getBoundingClientRect().right),
      left: Math.round(el.getBoundingClientRect().left)}))
    .filter(el => el.right > innerWidth + 1 || el.left < -1)
    .slice(0, 12));
  expect(overflow, JSON.stringify(overflowing)).toBeLessThanOrEqual(1);
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
  await page.locator(".voice-quick-modes").getByRole("button", {name: "参照"}).click();
  await expect(page.locator(".voice-quick-modes").getByRole("button", {name: "参照"})).toBeVisible();
  await page.locator("nav.bottom-nav").getByRole("button", {name: "下書き"}).click();
  await expect(page.getByText("未保存の下書き：保持カレー")).toBeVisible();
  await expect(page.locator(".voice-quick-modes").getByRole("button", {name: "登録"})).toBeVisible();
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
  await expect(panelMic).toHaveAttribute("aria-label", "■ マイクを停止");
  expect(await navMic.getAttribute("aria-pressed")).toBe("true");
  await panelMic.click();
  expect(await navMic.getAttribute("aria-pressed")).toBe("false");
});

test("voice settings and recognized turns remain collapsed until requested", async ({page}) => {
  await page.goto("/");
  const settings = page.getByRole("button", {name: "設定を開く"});
  await expect(settings).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("region", {name: "音声設定"})).toHaveCount(0);
  await settings.click();
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("region", {name: "音声設定"})).toBeVisible();
  await expect(page.getByLabel("通知音の音量")).toBeVisible();
  const help = page.locator(".voice-help");
  // Registration guidance and transcript are not expanded until requested.
  await page.locator(".voice-quick-modes").getByRole("button", {name: "登録"}).click();
  await expect(help).not.toHaveAttribute("open", "");
  const transcript = page.locator(".voice-transcript");
  await expect(transcript).not.toHaveAttribute("open", "");
  await transcript.locator("summary").click();
  await expect(transcript).toHaveAttribute("open", "");
});

test("header price bell keeps notification list collapsed until opened", async ({page}) => {
  await page.route("**/api/notifications", route => route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[{id:"n1",observation_id:"o1",ingredient_id:"i1",change_jpy:"50",unit_basis:"kg",currency:"JPY",status:"unread",created_at:"2026-11-01T00:00:00Z"}]})}));
  await page.goto("/");
  const bell=page.getByRole("button",{name:"価格通知を開く"});
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAttribute("aria-expanded","false");
  await expect(page.getByRole("region",{name:"価格通知"})).toHaveCount(0);
  await expect(bell.locator(".price-bell-count")).toHaveText("1");
  await bell.click();
  await expect(bell).toHaveAttribute("aria-expanded","true");
  await expect(page.getByRole("region",{name:"価格通知"})).toBeVisible();
  await page.getByRole("button",{name:"通知を閉じる"}).click();
  await expect(bell).toHaveAttribute("aria-expanded","false");
});

test("header notification failure remains distinguishable from zero unread", async ({page}) => {
  await page.route("**/api/notifications", route => route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"notifications_unavailable"})}));
  await page.goto("/");
  const bell=page.getByRole("button",{name:"価格通知を開く"});
  await expect(bell.locator(".price-bell-error")).toBeVisible();
  await bell.click();
  await expect(page.getByText("通知を取得できませんでした。")).toBeVisible();
});

test("mobile price bell panel stays within viewport edges", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.route("**/api/notifications", route => route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[]})}));
  await page.goto("/");
  await page.getByRole("button",{name:"価格通知を開く"}).click();
  const panel=page.locator(".price-bell-panel");
  await expect(panel).toBeVisible();
  const box=await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x+box!.width).toBeLessThanOrEqual(390);
  expect(box!.y+box!.height).toBeLessThanOrEqual(844);
});

test("reference prices are informative, remain unconfirmed, and do not block review", async ({page}) => {
  await page.route("**/api/voice-recipe",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    title:"Soy sauce test",materials:[{name:"濃口醤油",quantity:"10",unit:"g",price_jpy:"",price_quantity:"",price_unit:"",supplier:""}],
    selling_price_jpy:"",notes:[],missing:["濃口醤油の仕入単価・基準数量・単位"],interpretations:[],
    price_references:[{material_name:"濃口醤油",status:"available",ingredient_name:"濃口醤油",currency:"USD",unit_basis:"g",average_unit_price:"0.5",observation_count:2,observed_to:"2026-10-20",text:"Reference: USD 0.5/g, based on 2 observations (unconfirmed)"}]
  })}));
  await page.goto("/");
  const entry=page.getByLabel("音声認識できない場合の入力");
  await entry.fill("濃口醤油を10グラム、参考価格を調べて");
  await page.getByRole("button",{name:"反映"}).click();
  const draft=page.locator("#draft");
  await expect(draft.getByRole("region",{name:"参考価格の調査結果"})).toContainText("USD 0.5/g");
  await expect(draft).toContainText("仕入単価 未確定");
  await expect(draft.getByRole("button",{name:"内容を確認"})).toBeEnabled();
  await draft.getByRole("button",{name:"内容を確認"}).click();
  await expect(draft.getByRole("button",{name:"価格未確定として承認して保存"})).toBeEnabled();
});
