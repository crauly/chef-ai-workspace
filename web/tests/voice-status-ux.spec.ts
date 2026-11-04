import {test,expect,type Page} from "@playwright/test";
import {voiceInput} from "./voice-input";
const material=(name="パスタ",quantity="100")=>({name,quantity,unit:"g",price_jpy:"",price_quantity:"",price_unit:"",supplier:""});
const draft=(materials=[material()])=>({title:"パスタ",materials,selling_price_jpy:"",notes:[],missing:[]});
async function input(page:Page,text:string){await page.getByLabel("音声認識できない場合の入力").fill(text);await page.getByRole("button",{name:"反映",exact:true}).click();}
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};};

test("validated prefix appears before a delayed correction without authorizing save and parses only the remaining delta",async({page},info)=>{
 const first=gate(),second=gate();const bodies:any[]=[];let saves=0;
 await page.route("**/api/recipes/full",route=>{saves++;return route.abort();});
 await page.route("**/api/voice-recipe",async route=>{
  bodies.push(route.request().postDataJSON());const count=bodies.length;
  await (count===1?first:second).promise;
  return route.fulfill({json:count===1?draft():draft([material("パスタ","150"),material("トマト","20")])});
 });
 await page.goto("/");await input(page,"パスタ100g");await expect.poll(()=>bodies.length).toBe(1);
 await input(page,"パスタは150gに訂正、トマト20gを追加");
 await expect(page.getByLabel("認識した発話",{exact:true})).toHaveText("パスタは150gに訂正、トマト20gを追加");
 const released=Date.now();first.release();await expect.poll(()=>bodies.length).toBe(2);
 await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("パスタ");
 await expect(page.getByLabel("未反映の発話")).toBeVisible();
 await expect(page.getByRole("button",{name:"レシピを登録",exact:true})).toBeDisabled();expect(saves).toBe(0);
 expect(bodies[1].turns).toEqual(["パスタは150gに訂正、トマト20gを追加"]);
 expect(bodies[1].previous.materials[0].quantity).toBe("100");expect(bodies.every(b=>b.defer_prices===true)).toBe(true);
 await info.attach("fixture-prefix-timing",{body:JSON.stringify({firstResponseToPreviewMs:Date.now()-released,latestParseStillBlocked:true,realMeta:false}),contentType:"application/json"});
 second.release();await expect(page.getByLabel("未反映の発話")).toHaveCount(0);
 await expect(page.getByLabel("未保存のレシピ下書き").locator(":scope > ul > li")).toHaveCount(2);
 // Source turns remain intact and the final complete replacement owns prices.
 await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("150g");
 await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("トマト");
 await expect(page.locator(".voice-status-list")).toHaveCount(0);expect(saves).toBe(0);
});

for(const width of [390,1280])test(`one compact panel combines recording and price research at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:800});const prices=gate();
 await page.route("**/api/voice-recipe",route=>route.fulfill({json:{...draft(),research_state:"deferred",pending_research:[{material_name:"パスタ",material_index:0,row_name:"パスタ",request:"平均価格を調べて",trigger:"muse"}],provisional_prices:[null]}}));
 await page.route("**/api/voice-recipe/prices",async route=>{await prices.promise;return route.fulfill({json:{research_state:"complete",price_references:[],research_status:[],provisional_prices:[null]}});});
 await page.goto("/");await voiceInput(page,"パスタ100g、平均価格を調べて");
 const panel=page.locator(".voice-status-list");await expect(panel).toHaveCount(1);
 await expect(panel.locator('[data-stage="listen"]')).toHaveText(/音声受付中/);
 await expect(panel.locator('[data-stage="price"]')).toHaveText(/価格検索中/);
 await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 const geometry=await panel.evaluate(element=>{
  const icon=element.querySelector('li > span[aria-hidden="true"]')!;
  const bounds=icon.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(icon);
  const glyph=range.getBoundingClientRect();
  return {overflow:element.scrollWidth>element.clientWidth,iconOffset:Math.abs((glyph.left+glyph.right-bounds.left-bounds.right)/2)};
 });
 expect(geometry.overflow).toBe(false);expect(geometry.iconOffset).toBeLessThan(3);
 const bounds=await panel.boundingBox();expect(bounds).not.toBeNull();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
 if(width===390){const nav=await page.locator(".bottom-nav").boundingBox();expect(bounds!.y+bounds!.height).toBeLessThan(nav!.y);}
 await info.attach("floating-status",{body:await page.screenshot(),contentType:"image/png"});
 prices.release();await expect(panel.locator('[data-stage="price"]')).toHaveCount(0);
 await expect(panel.locator('[data-stage="listen"]')).toBeVisible();
 await page.getByRole("button",{name:"■ マイクを停止",exact:true}).click();await expect(panel).toHaveCount(0);
});

test("settings field speech shares the root panel and clears after transcription",async({page})=>{
 const transcribe=gate();await page.route("**/api/voice/transcribe",async route=>{await transcribe.promise;return route.fulfill({json:{transcript:"Amazon"}});});
 await page.goto("/settings?section=supplier");
 await page.evaluate(()=>{
  const Native=window.AudioWorkletNode;
  window.AudioWorkletNode=class extends Native{constructor(context:BaseAudioContext,name:string,options?:AudioWorkletNodeOptions){
   super(context,name,options);(window as any).feedField=()=>{for(const [seconds,value] of [[.5,.1],[1.1,0]])this.port.onmessage?.call(this.port,new MessageEvent("message",{data:{samples:new Float32Array(Math.ceil(context.sampleRate*seconds)).fill(value),reviewEpoch:0}}));};
  }};
  Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>{const c=new AudioContext();return c.createMediaStreamDestination().stream;}});
 });
 await page.getByRole("button",{name:"🎙 仕入れ先名を音声入力"}).click();
 await expect(page.locator('.voice-status-list [data-stage="listen"]')).toBeVisible();
 await expect(page.locator(".voice-status-list")).toHaveCount(1);
 await page.waitForFunction(()=>typeof (window as any).feedField==="function");
 await page.evaluate(()=>(window as any).feedField());
 await expect(page.locator('.voice-status-list [data-stage="transcribe"]')).toBeVisible();
 transcribe.release();await expect(page.locator(".voice-status-list")).toHaveCount(0);
 await expect(page.getByRole("textbox",{name:"仕入れ先名",exact:true})).toHaveValue("Amazon");
});

test("discarding a prefix invalidates late analysis and clears its status",async({page})=>{
 const first=gate(),later=gate();let calls=0;
 await page.route("**/api/voice-recipe",async route=>{
  const count=++calls;await(count===1?first:later).promise;
  await route.fulfill({json:draft()}).catch(()=>{});
 });
 await page.goto("/");await input(page,"パスタ100g");await expect.poll(()=>calls).toBe(1);
 await input(page,"トマト20g");first.release();await expect(page.getByLabel("未反映の発話")).toBeVisible();
 await expect.poll(()=>calls).toBe(2);
 await page.getByRole("button",{name:"下書きを破棄",exact:true}).click();later.release();
 await expect(page.getByLabel("未保存のレシピ下書き")).toHaveCount(0);
 await expect(page.getByLabel("未反映の発話")).toHaveCount(0);
 await expect(page.locator(".voice-status-list")).toHaveCount(0);
 await page.reload();await expect(page.getByLabel("未保存のレシピ下書き")).toHaveCount(0);
});

test("a retrieved price stops searching while a newer parse still owns result binding",async({page})=>{
 const parse=gate(),prices=gate();let parses=0,priceCalls=0;
 const deferred={...draft(),research_state:"deferred",pending_research:[{material_name:"パスタ",material_index:0,row_name:"パスタ",request:"平均価格を調べて",trigger:"muse"}],provisional_prices:[null]};
 await page.route("**/api/voice-recipe",async route=>{if(++parses===2)await parse.promise;return route.fulfill({json:deferred});});
 await page.route("**/api/voice-recipe/prices",async route=>{priceCalls++;await prices.promise;return route.fulfill({json:{research_state:"complete",price_references:[],research_status:[],provisional_prices:[null]}});});
 await page.goto("/");await input(page,"パスタ100g、平均価格を調べて");
 await expect(page.locator('.voice-status-list [data-stage="price"]')).toBeVisible();
 await input(page,"パスタ120gに変更");await expect.poll(()=>parses).toBe(2);
 await expect(page.locator('.voice-status-list [data-stage="parse"]')).toBeVisible();
 prices.release();await expect(page.locator('.voice-status-list [data-stage="price"]')).toHaveCount(0);
 await expect(page.locator('.voice-status-list [data-stage="parse"]')).toBeVisible();
 parse.release();await expect(page.locator(".voice-status-list")).toHaveCount(0);expect(priceCalls).toBe(1);
});

test("a save uttered before the complete draft is shown cannot approve it later",async({page})=>{
 const parsing=gate();let parses=0,saves=0;
 await page.route("**/api/voice-recipe",async route=>{parses++;await parsing.promise;return route.fulfill({json:draft()});});
 await page.route("**/api/recipes/full",route=>{saves++;return route.abort();});
 await page.goto("/");await voiceInput(page,"パスタ100g");await expect.poll(()=>parses).toBe(1);
 await voiceInput(page,"保存してください");
 parsing.release();await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 await expect(page.getByText("確認前に発話された保存指示は実行しません。",{exact:false})).toBeAttached();expect(saves).toBe(0);
 // A new utterance after presentation still uses the formal approved path.
 await voiceInput(page,"保存してください");
 await expect(page.getByLabel("正式登録の確認")).toBeVisible();expect(saves).toBe(0);
 await voiceInput(page,"保存してください");await expect.poll(()=>saves).toBe(1);
});
