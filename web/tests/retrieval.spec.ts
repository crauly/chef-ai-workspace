import {test,expect} from "@playwright/test";

test.beforeEach(async ({request}) => {
  await request.post("http://127.0.0.1:8100/test/reset");
  await request.post("http://127.0.0.1:8100/test/search-fixtures");
});

test("name search reaches the backend beyond the first page, clears and never writes",async({page,request})=>{
  await page.goto("/");
  await expect(page.getByRole("button",{name:/の詳細を開く/})).toHaveCount(20);
  await page.getByLabel("レシピ名で検索").fill("片栗粉");
  await page.getByRole("button",{name:"検索",exact:true}).click();
  await expect(page.getByRole("button",{name:/の詳細を開く/})).toHaveCount(1);
  await page.getByRole("button",{name:/の詳細を開く/}).click();
  await expect(page.locator("section.recipe-detail")).toContainText("¥10");
  const state=await (await request.get("http://127.0.0.1:8100/test/state")).json();
  expect(state.listQueries).toContainEqual({q:"片栗粉",page:1});expect(state.confirms).toHaveLength(0);
  await page.getByRole("button",{name:"← レシピ一覧"}).click();
  await page.getByRole("button",{name:"検索を解除",exact:true}).click();
  await expect(page.getByRole("button",{name:/の詳細を開く/})).toHaveCount(20);
  await page.getByLabel("レシピ名で検索").fill("存在しない料理");
  await page.getByRole("button",{name:"検索",exact:true}).click();
  await expect(page.getByText("一致するレシピがありません。")).toBeVisible();
});

test("browse target from the shared microphone is used as the owner-scoped name query",async({page,request})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>{
      const context=new AudioContext(), source=context.createOscillator(), gain=context.createGain(), output=context.createMediaStreamDestination();
      gain.gain.value=.1;source.connect(gain);gain.connect(output);source.start();await context.resume();
      const track=output.stream.getTracks()[0],stop=track.stop.bind(track);
      track.stop=()=>{stop();void context.close();};return output.stream;
    }});
  });
  await page.route("**/api/voice/transcribe",route=>route.fulfill({json:{transcript:"片栗粉のレシピを見せて"}}));
  await page.route("**/api/intent",route=>route.fulfill({json:{intent:"browse",target:"片栗粉"}}));
  await page.goto("/");
  await page.getByRole("button",{name:"🎙 音声操作を開始",exact:true}).click();
  await page.waitForTimeout(700);
  await page.getByRole("button",{name:"■ マイクを停止",exact:true}).click();
  await expect.poll(async () => page.getByLabel("レシピ名で検索").inputValue()).toBe("片栗粉");
  // A unique match auto-opens the detail view (browse hides underneath).
  await expect(page.locator("section.recipe-detail").getByRole("heading",{name:"片栗粉のレシピ"})).toBeVisible();
  expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).listQueries).toContainEqual({q:"片栗粉",page:1});
  await expect(page.locator("section.recipe-detail")).toContainText("¥10");
  expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(0);
  // Twenty-one matches: a single item on page two is not a unique recipe.
  // The microphone lives in the browse view: return to the list first.
  await page.getByRole("button",{name:"← レシピ一覧"}).click();
  await page.route("**/api/intent",route=>route.fulfill({json:{intent:"browse",target:"別の料理"}}));
  await page.route("**/api/voice/transcribe",route=>route.fulfill({json:{transcript:"別の料理のレシピを見せて"}}));
  await page.getByRole("button",{name:"🎙 音声操作を開始",exact:true}).click();
  await page.waitForTimeout(700);
  await page.getByRole("button",{name:"■ マイクを停止",exact:true}).click();
  await expect(page.getByRole("button",{name:/の詳細を開く/})).toHaveCount(20);
  await expect(page.locator("section.recipe-detail")).toHaveCount(0);
  await page.getByRole("button",{name:"次へ",exact:true}).click();
  await expect(page.getByRole("button",{name:/の詳細を開く/})).toHaveCount(1);
  await expect(page.locator("section.recipe-detail")).toHaveCount(0);
});

test("an old search response cannot overwrite a newer search",async({page})=>{
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  let started!:()=>void;
  const sending=new Promise<void>(resolve=>{started=resolve;});
  await page.route("**/api/recipes?**",async route=>{
    if(new URL(route.request().url()).searchParams.get("q")==="片栗粉"){
      const response=await route.fetch();started();await blocked;await route.fulfill({response});
    }else await route.continue();
  });
  await page.goto("/");
  await page.getByLabel("レシピ名で検索").fill("片栗粉");await page.getByRole("button",{name:"検索",exact:true}).click();
  await sending;
  await page.getByLabel("レシピ名で検索").fill("別の料理1");await page.getByRole("button",{name:"検索",exact:true}).click();
  await expect(page.getByRole("button",{name:/の詳細を開く/})).toHaveCount(11);
  const oldResponse=page.waitForResponse(response=>new URL(response.url()).searchParams.get("q")==="片栗粉");
  release();await oldResponse;await page.waitForTimeout(150);
  await expect(page.getByRole("button",{name:/の詳細を開く/})).toHaveCount(11);
});
