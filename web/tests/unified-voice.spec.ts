import {test,expect,type Page} from "@playwright/test";
import {voiceNavigation,explicitEditRequest} from "../app/voice-navigation";

const recipeDraft={title:"片栗粉のレシピ",materials:[{name:"片栗粉",quantity:"10",unit:"g",price_jpy:"1000",price_quantity:"1",price_unit:"kg"}],selling_price_jpy:"1000",missing:[],notes:[]};
async function type(page:Page,text:string){await page.getByLabel("音声認識できない場合の入力").fill(text);await page.getByRole("button",{name:"反映",exact:true}).click();}
test.beforeEach(async({request})=>{await request.post("http://127.0.0.1:8100/test/reset");});

test("navigation matches whole requests and leaves quantities, negation and quoted names as data",()=>{
 expect(voiceNavigation("レシピを登録します")).toEqual({mode:"create",target:""});
 expect(voiceNavigation("新しいメニュー")).toEqual({mode:"create",target:""});
 expect(voiceNavigation("レシピを登録します、カルボナーラ、卵100g")).toEqual({mode:"create",target:"カルボナーラ、卵100g"});
 expect(voiceNavigation("片栗粉のレシピを見せて")).toEqual({mode:"browse",target:"片栗粉"});
 expect(voiceNavigation("レシピの編集モード")).toEqual({mode:"edit",target:""});
 expect(voiceNavigation("片栗粉のレシピを編集して")).toEqual({mode:"edit",target:"片栗粉"});
 for(const input of ["パスタを150gに変更","登録しないでください","登録という名前のパスタ100g"])
  expect(voiceNavigation(input)).toBeNull();
 expect(explicitEditRequest("パスタを150gに変更してください")).toBe(true);
 expect(explicitEditRequest("パスタは変更しないでください")).toBe(false);
 expect(explicitEditRequest("ありがとう")).toBe(false);
});

test("one uninterrupted microphone creates, reviews, saves, browses and edits with one cue per transition",async({page,request})=>{
 await page.addInitScript(()=>{
  const Native=window.AudioContext;
  const state={opens:0,stops:0,cues:[] as number[],gain:null as GainNode|null};
  (window as unknown as {unifiedMic:typeof state}).unifiedMic=state;
  window.AudioContext=class extends Native{
   createOscillator(){const oscillator=super.createOscillator(),start=oscillator.start.bind(oscillator);
    oscillator.start=(when?:number)=>{if(oscillator.frequency.value!==777)state.cues.push(oscillator.frequency.value);start(when);};return oscillator;}
  };
  Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>{
   state.opens++;const context=new AudioContext(),osc=context.createOscillator(),gain=context.createGain(),out=context.createMediaStreamDestination();
   osc.frequency.value=777;gain.gain.value=0;state.gain=gain;osc.connect(gain);gain.connect(out);osc.start();await context.resume();
   const track=out.stream.getTracks()[0],stop=track.stop.bind(track);track.stop=()=>{state.stops++;stop();void context.close();};return out.stream;
  }});
 });
 const texts:string[]=[];let transcribed=0,full=0,parses=0;
 await page.route("**/api/voice/transcribe",route=>{transcribed++;return route.fulfill({json:{transcript:texts.shift()}});});
 await page.route("**/api/voice-recipe",route=>{parses++;return route.fulfill({json:recipeDraft});});
 await page.route("**/api/recipes/full",async route=>{
  full++;expect(route.request().postDataJSON().materials[0].quantity).toBe("10");
  await route.fulfill({status:201,json:{id:"11111111-1111-4111-8111-111111111111",title:{value:recipeDraft.title},revision:0,materials:[],selling_price_jpy:{value:"1000"}}});
 });
 await page.goto("/");await expect(page.getByRole("button",{name:/🎙/})).toHaveCount(1);
 await page.getByRole("button",{name:"🎙 音声操作を開始",exact:true}).click();
 async function speak(text:string){
  const expected=transcribed+1;texts.push(text);await page.waitForTimeout(800);
  await page.evaluate(()=>(window as unknown as {unifiedMic:{gain:GainNode}}).unifiedMic.gain.gain.value=.1);
  await page.waitForTimeout(400);
  await page.evaluate(()=>(window as unknown as {unifiedMic:{gain:GainNode}}).unifiedMic.gain.gain.value=0);
  await expect.poll(()=>transcribed).toBe(expected);
 }
 await speak("レシピを登録します");await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("現在のモード: 登録");expect(parses).toBe(0);
 await speak("片栗粉のレシピ、片栗粉10g、1kg1000円、売価1000円");await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 await speak("内容を確認");await expect(page.getByRole("button",{name:"レシピを登録",exact:true})).toBeEnabled();expect(full).toBe(0);
 await speak("保存してください");await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("レシピを保存しました。");expect(full).toBe(1);
 await speak("片栗粉のレシピを見せて");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥10");
 await speak("片栗粉を15gに変更");await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("現在のモード: 編集");
 await expect(page.getByLabel("提案の差分")).toBeVisible();
 expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(0);
 await speak("保存してください");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥15");
 const state=await (await request.get("http://127.0.0.1:8100/test/state")).json();expect(state.confirms).toHaveLength(1);expect(parses).toBe(1);expect(transcribed).toBe(7);
 const audio=await page.evaluate(()=>{const s=(window as unknown as {unifiedMic:{opens:number;stops:number;cues:number[]}}).unifiedMic;return {opens:s.opens,stops:s.stops,cues:s.cues};});
 expect(audio.opens).toBe(1);expect(audio.stops).toBe(0);
 expect(audio.cues.map(value=>Math.round(value*100)/100)).toEqual([523.25,659.25,392,523.25,587.33,440,587.33]);
 await expect(page.getByRole("button",{name:"■ マイクを停止",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"■ マイクを停止",exact:true}).click();
});

test("switching preserves registration draft and refuses to lose an unapproved edit",async({page,request})=>{
 let parses=0;await page.route("**/api/voice-recipe",route=>{parses++;return route.fulfill({json:recipeDraft});});
 await page.goto("/");await type(page,"片栗粉10g、1kg1000円");await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 await type(page,"内容を確認");await expect(page.getByRole("button",{name:"レシピを登録",exact:true})).toBeEnabled();
 await type(page,"片栗粉のレシピを見せて");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toBeVisible();
 await type(page,"レシピを登録します");await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("片栗粉のレシピ");expect(parses).toBe(1);
 await expect(page.getByRole("button",{name:"レシピを登録",exact:true})).toBeEnabled();
 await type(page,"片栗粉のレシピを見せて");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toBeVisible();
 await type(page,"片栗粉を15gに変更");await expect(page.getByLabel("提案の差分")).toBeVisible();
 await type(page,"新しいメニュー");await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("未保存の変更案があります");
 await expect(page.getByLabel("提案の差分")).toBeVisible();
 await type(page,"変更案を破棄");await type(page,"新しいメニュー");await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(0);
});

test("ambiguous navigation stays put; a named edit resolves the recipe without writing",async({page,request})=>{
 await page.route("**/api/intent",route=>route.fulfill({json:{intent:"clarify",target:""}}));
 await page.goto("/");await type(page,"レシピを参照したいような、登録したいような");
 await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("切り替え先を確認できませんでした");
 await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("現在のモード: 待機");
 await type(page,"片栗粉のレシピを見せて");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toBeVisible();
 await type(page,"ありがとう");await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("参照モードのままです");
 await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("現在のモード: 参照");
 await type(page,"片栗粉のレシピを編集して");
 await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("現在のモード: 編集");
 await expect(page.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥10");
 expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(0);
});

test("approval queued before an edit proposal is displayed cannot approve that proposal",async({page,request})=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 let started!:()=>void;const sending=new Promise<void>(resolve=>{started=resolve;});
 await page.route("**/propose",async route=>{started();await held;await route.continue();});
 await page.goto("/");await type(page,"片栗粉のレシピを見せて");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toBeVisible();
 await type(page,"片栗粉を15gに変更");await sending;
 await type(page,"保存してください");release();await expect(page.getByLabel("提案の差分")).toBeVisible();
 await expect(page.getByRole("region",{name:"音声操作モード"})).not.toContainText("操作を処理中");
 expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(0);
 await type(page,"保存してください");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥15");
 expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(1);
});
