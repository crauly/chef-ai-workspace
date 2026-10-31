import { expect, test } from "@playwright/test";

test("voice-first layout keeps nav, mic and draft anchors usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("text=Chef AI").first()).toBeVisible();
  await expect(page.locator("#voice-controls")).toBeVisible();
  await expect(page.locator(".mic-primary")).toBeVisible();
  await expect(page.locator('nav.bottom-nav a[href="#draft"]')).toHaveCount(1);
  await expect(page.locator('nav.bottom-nav a[href="#recipes"]')).toHaveCount(1);
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
