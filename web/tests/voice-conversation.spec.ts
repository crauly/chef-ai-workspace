import {test,expect,type Page} from "@playwright/test";
import {voiceCommand} from "../app/voice-commands";
import fs from "node:fs";
import vm from "node:vm";

const draft={title:"アーリオオーリオペペロンチーノ",materials:[
 {name:"乾燥パスタ（ディチェコ 1.6mm）",quantity:"100",unit:"g",price_jpy:"350",price_quantity:"500",price_unit:"g"},
 {name:"国産ニンニク",quantity:"10",unit:"g",price_jpy:"4600",price_quantity:"1",price_unit:"kg"},
 {name:"ギリシャ産 単一種 エクストラバージンオイル",quantity:"25",unit:"g",price_jpy:"4000",price_quantity:"1",price_unit:"kg"},
],selling_price_jpy:"",notes:[],missing:[],interpretations:[{source:"アリオーオーリオベベロンチーノ",suggestion:"アーリオオーリオペペロンチーノ",reason:"料理の構成と発音からの解釈案"}]};
async function input(page:Page,text:string){
 await page.getByLabel("音声認識できない場合の入力").fill(text);
 await page.getByRole("button",{name:"反映",exact:true}).click();
}
async function microphone(page:Page){
 await page.addInitScript(()=>{
  Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>{
   const context=new AudioContext(),source=context.createOscillator(),gain=context.createGain(),output=context.createMediaStreamDestination();
   gain.gain.value=.1;source.connect(gain);gain.connect(output);source.start();await context.resume();
   (window as unknown as {quietTestMic:()=>void}).quietTestMic=()=>{gain.gain.value=0;};
   const track=output.stream.getTracks()[0],stop=track.stop.bind(track);
   track.stop=()=>{stop();void context.close();};return output.stream;
  }});
 });
}

test("natural review/save variants and combined requests are recognized; negation and recipe data never approve",()=>{
 for(const value of ["下書き。確認","下書きを確認してください","内容を確認","内容 を 確認"])
  expect(voiceCommand(value)).toBe("review");
 for(const value of ["内容を登録","内容を保存してください","保存してください","内容を確定","登録を確定","登録を確定。確定。","内容を確認。登録を確定","内容を確認して保存してください","はい、保存してください。"])
  expect(voiceCommand(value)).toBe("save");
 for(const value of ["保存しないでください","登録しません"])
  expect(voiceCommand(value)).toBe("hold");
 for(const value of ["パスタを150gに変更して保存してください","パスタを150gに変更、まだ保存しないでください","保存しないで、パスタは150g","保存してくださいという名前の料理","保存していいですか","お願いします"])
  expect(voiceCommand(value)).toBe("data");
});

test("the recording thread tags pre-review buffers before any delayed main-thread delivery",()=>{
 const packets:Array<{samples:Float32Array;reviewEpoch:number}>=[];
 class Base {
  port={onmessage:null as null|((event:{data:unknown})=>void),postMessage:(packet:{samples:Float32Array;reviewEpoch:number})=>{packets.push(packet);}};
 }
 const Processor=vm.runInNewContext(fs.readFileSync("public/voice-capture-v2.js","utf8")+"\nVoiceCapture;",{AudioWorkletProcessor:Base,registerProcessor:()=>{}});
 const recorder=new Processor({processorOptions:{reviewEpoch:0}});
 recorder.process([[new Float32Array(1024).fill(.1)]]);
 expect(packets).toHaveLength(0);
 recorder.port.onmessage({data:{type:"review",epoch:1}});
 recorder.process([[new Float32Array(2048).fill(.1)]]);
 // Even if delivered in reverse order after review, the old buffer is ineligible.
 expect(packets.map(packet=>packet.reviewEpoch)).toEqual([0,1]);
 expect(packets[0].samples).toHaveLength(1024);
 expect(packets.slice().reverse().map(packet=>packet.reviewEpoch===1)).toEqual([true,false]);
});

test("reported typo is a visible interpretation; combined review/save registers in one explicit action without a selling price",async({page})=>{
 let parses=0,saves=0;
 await page.route("**/api/voice-recipe",route=>{parses++;return route.fulfill({json:draft});});
 await page.route("**/api/recipes/full",async route=>{
  saves++;const body=route.request().postDataJSON();
  expect(body.title).toContain("ペペロンチーノ");expect(body.title).not.toContain("ベベロン");
  expect(body.materials.map((item:{price_jpy:string})=>item.price_jpy)).toEqual(["350","4600","4000"]);
  expect(body.selling_price_jpy).toBeNull();
  await route.fulfill({status:201,json:{id:body.request_id,title:{value:body.title},revision:0,materials:[],selling_price_jpy:{value:null}}});
 });
 await page.goto("/");
 await input(page,"アリオーオーリオベベロンチーノ。乾燥パスタ100g、ディチェコ500g350円。国産ニンニク10g、1kg4600円。オイル25g、1kg4000円");
 await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("料理の文脈からの解釈案");
 await expect(page.locator(".voice-transcript summary")).toContainText("認識した発話（1件）");
 await page.locator(".voice-transcript summary").click();
 await expect(page.getByLabel("認識した発話の一覧").getByRole("listitem")).toContainText("ベベロンチーノ");
 await expect(page.getByRole("button",{name:"レシピを登録",exact:true})).toBeEnabled();
 // A combined review/save is one explicit authorization: it registers at once.
 await input(page,"内容を確認。登録を確定");
 await expect(page.getByText("レシピを保存しました。")).toBeVisible();
 expect(saves).toBe(1);expect(parses).toBe(1);
});

test("queued fragments coalesce and a save queued before review commits the arrived draft once",async({page})=>{
 let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
 let parses=0,saves=0;
 const submitted:{turns:string[];previous?:{title:string}}[]=[];
 await page.route("**/api/voice-recipe",async route=>{
  parses++;submitted.push(route.request().postDataJSON());
  if(parses===1)await blocked;
  await route.fulfill({json:draft});
 });
 await page.route("**/api/recipes/full",async route=>{
  saves++;const body=route.request().postDataJSON();
  await route.fulfill({status:201,json:{id:body.request_id,title:{value:body.title},revision:0,materials:[],selling_price_jpy:{value:null}}});
 });
 await page.goto("/");
 await input(page,"アリオーオーリオベベロンチーノ");
 await expect.poll(()=>parses).toBe(1);
 await input(page,"ディチェコ500g350円");await input(page,"ニンニク10g、1kg4600円");
 await input(page,"オイル25g、1kg4000円");await input(page,"パスタは100g");
 await input(page,"内容を確認");await input(page,"保存してください");await input(page,"登録を確定");
 release();
 // The queued explicit save commits the arrived draft exactly once.
 await expect(page.getByText("レシピを保存しました。")).toBeVisible();
 expect(saves).toBe(1);expect(parses).toBe(2);
 // Cursor fix (#101): the first parse went stale mid-flight (revisions
 // advanced while it was blocked), so no parsed draft exists yet. The
 // follow-up resends the full 5-turn history with no previous context —
 // otherwise the first utterance would never be interpreted at all.
 expect(submitted[1].turns).toHaveLength(5);
 expect(submitted[1].turns).not.toContain("保存してください");
 expect(submitted[1].previous).toBeUndefined();
 // A later negative request saves nothing more; the commit happened once.
 await input(page,"保存しないでください");
 expect(saves).toBe(1);expect(parses).toBe(2);
});

test("a quiet gap submits audio promptly instead of waiting 3.5 seconds",async({page})=>{
 await microphone(page);
 let transcribes=0;
 await page.route("**/api/voice/transcribe",route=>{transcribes++;return route.fulfill({json:{transcript:"パスタ100g"}});});
 await page.route("**/api/voice-recipe",route=>route.fulfill({json:draft}));
 await page.goto("/");await page.getByRole("button",{name:"🎙 音声操作を開始",exact:true}).click();
 await page.waitForFunction(()=>typeof (window as unknown as {quietTestMic?:()=>void}).quietTestMic==="function");
 await page.waitForTimeout(350);
 await page.evaluate(()=>(window as unknown as {quietTestMic:()=>void}).quietTestMic());
 await expect.poll(()=>transcribes,{timeout:2600}).toBe(1);
 await page.reload();
});

test("audio recorded before review cannot approve the draft even when transcription arrives after review",async({page})=>{
 await microphone(page);
 let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
 let started!:()=>void;const sending=new Promise<void>(resolve=>{started=resolve;});
 let saves=0;
 await page.route("**/api/voice-recipe",route=>route.fulfill({json:draft}));
 await page.route("**/api/voice/transcribe",async route=>{started();await blocked;await route.fulfill({json:{transcript:"登録してください"}});});
 await page.route("**/api/recipes/full",async route=>{
  saves++;const body=route.request().postDataJSON();
  await route.fulfill({status:201,json:{id:body.request_id,title:{value:body.title},revision:0,materials:[],selling_price_jpy:{value:null}}});
 });
 await page.goto("/");await input(page,"パスタ100g、500g350円");
 await expect(page.getByRole("button",{name:"レシピを登録",exact:true})).toBeEnabled();
 await page.getByRole("button",{name:"🎙 音声操作を開始",exact:true}).click();
 await page.waitForTimeout(700);await page.getByRole("button",{name:"■ マイクを停止",exact:true}).click();
 await sending;
 // Review from an explicit action while the pre-review audio is still in flight.
 await input(page,"内容を確認");
 release();
 // The late pre-review audio only presents the draft; it cannot commit it.
 await expect(page.getByRole("button",{name:"🎙 音声操作を開始",exact:true})).toBeEnabled();
 await expect(page.getByRole("button",{name:"レシピを登録",exact:true})).toBeEnabled();
 expect(saves).toBe(0);
 await input(page,"保存してください");
 await expect(page.getByText("レシピを保存しました。")).toBeVisible();expect(saves).toBe(1);
});
