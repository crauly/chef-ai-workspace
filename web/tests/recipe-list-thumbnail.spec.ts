import {test,expect} from "@playwright/test";

const IMG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test.beforeEach(async ({request}) => {
 await request.post("http://127.0.0.1:8100/test/reset");
});

test("generated image appears in recipe list on the same origin, survives reload, and other recipes retain placeholder", async ({page}) => {
 await page.route("**/api/dish-image",route=>route.fulfill({json:{image:IMG,mode:"generate"}}));
 await page.goto("/");
 const named="片栗粉のレシピ";
 const recipe=page.getByRole("button",{name:`${named}の詳細を開く`});
 await expect(recipe.locator(".recipe-list-thumbnail img")).toHaveCount(0);
 await recipe.click();
 const detail=page.getByRole("region",{name:"料理イメージ"});
 await detail.getByRole("button",{name:"✦ 料理画像を生成"}).click();
 await expect(detail.getByText("このブラウザに自動保存済み")).toBeVisible();
 await page.getByRole("button",{name:"← ホーム"}).click();
 await expect(page.getByRole("button",{name:`${named}の詳細を開く`}).locator(".recipe-list-thumbnail img")).toHaveAttribute("src",IMG);
 await expect(page.getByRole("button",{name:"ミートソースパスタの詳細を開く"}).locator(".recipe-list-thumbnail img")).toHaveCount(0);
 await page.reload();
 await expect(page.getByRole("button",{name:`${named}の詳細を開く`}).locator(".recipe-list-thumbnail img")).toHaveAttribute("src",IMG);
});
