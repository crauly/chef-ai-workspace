// Explicitly opt-in only. Requires isolated FastAPI/Meta backend on loopback :8101.
import {test, expect} from "@playwright/test";
test.skip(process.env.CHEF_LIVE_META_BROWSER !== "1", "Real Meta browser test is opt-in");
test("real Muse self-correction, diff, explicit chef approval, food cost and reload", async ({page}) => {
  await page.goto("/"); await page.getByRole("button", {name: "詳細を見る"}).first().click();
  await page.getByRole("button", {name: "AIに変更を相談"}).click();
  await page.getByLabel("料理人の指示", {exact: true}).fill("片栗粉10g、いや15g。売価1800円に");
  await page.getByRole("button", {name: "変更案を作る"}).click();
  const diff = page.getByRole("region", {name: "提案の差分"});
  await expect(diff).toContainText("10 g → 15 g", {timeout: 30000});
  await expect(diff).toContainText("¥1000 → ¥1800");
  await expect(diff).toContainText("Meta Muse · muse-spark-1.3");
  const cost = page.getByRole("region", {name: "Recipe cost summary"});
  await expect(cost).toContainText("¥10");
  const confirm = page.getByRole("button", {name: "承認して保存・原価再計算"});
  await expect(confirm).toBeDisabled(); await page.getByRole("checkbox").check();
  await confirm.click(); await expect(cost).toContainText("¥15"); await expect(cost).toContainText("0.8%");
  await page.getByText("聞き間違い・解釈の訂正を登録", {exact: true}).click();
  await page.getByLabel("元の表現・誤認した言葉").fill("澱粉");
  await page.getByLabel("料理人が指定する表現").fill("片栗粉");
  await page.getByRole("button", {name: "訂正を確認して登録"}).click();
  await expect(page.getByRole("status")).toContainText("訂正履歴を登録しました");
  await page.reload(); await page.getByRole("button", {name: "詳細を見る"}).first().click();
  await expect(cost).toContainText("¥15"); await expect(cost).toContainText("0.8%");
});
