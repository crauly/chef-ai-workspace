// Explicit opt-in: real Voice/Spark and dedicated Supabase. No production owner.
import {test,expect} from "@playwright/test";
import path from "node:path";
test.skip(process.env.CHEF_LIVE_VOICE!=="1"||process.env.CHEF_LIVE_VOICE_CASE!=="complaint","Complaint acceptance is opt-in");

test("reported dish-name and polite-save conversation reaches one durable recipe",async({page,request})=>{
 const audioDir=process.env.CHEF_LIVE_VOICE_AUDIO_DIR;
 if(!audioDir)throw new Error("Test audio directory required");
 const state=async()=>{const result=await request.get("http://127.0.0.1:8102/test/live-state");expect(result.ok()).toBe(true);return result.json();};
 expect((await state()).recipes).toHaveLength(0);
 await page.addInitScript(()=>{
  (window as unknown as {testMicOpens:number}).testMicOpens=0;
  Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>{
   (window as unknown as {testMicOpens:number}).testMicOpens++;
   const context=new AudioContext(),out=context.createMediaStreamDestination();
   (window as unknown as {testPlay:(name:string)=>Promise<void>}).testPlay=async name=>{
    const response=await fetch("/test-audio/"+name+".wav"),source=context.createBufferSource();
    source.buffer=await context.decodeAudioData(await response.arrayBuffer());source.connect(out);source.start();
    await new Promise<void>(resolve=>{source.onended=()=>resolve();});
   };
   await context.resume();
   const track=out.stream.getTracks()[0],stop=track.stop.bind(track);
   track.stop=()=>{stop();void context.close();};return out.stream;
  }});
 });
 for(const name of ["dish","recipe","review","save","browse","edit"])
  await page.route(`**/test-audio/${name}.wav`,route=>route.fulfill({path:path.join(audioDir,name+".wav"),contentType:"audio/wav"}));
 let parses=0;
 page.on("response",async response=>{
  if(response.url().endsWith("/api/voice/transcribe")&&response.ok())console.log("LIVE complaint transcript:",JSON.stringify(await response.json()));
  if(response.url().endsWith("/api/voice-recipe")&&response.ok()){
   parses++;console.log("LIVE complaint interpretation:",JSON.stringify({timing:response.headers()["server-timing"],draft:await response.json()}));
  }
 });
 await page.goto("/");
 await page.getByRole("button",{name:"🎙 音声登録を開始",exact:true}).click();
 await page.waitForFunction(()=>typeof (window as unknown as {testPlay?:unknown}).testPlay==="function");
 const record=async(name:string)=>{
  await page.waitForTimeout(800);
  const transcription=page.waitForResponse(response=>response.url().endsWith("/api/voice/transcribe"),{timeout:40_000});
  await page.evaluate(name=>(window as unknown as {testPlay:(name:string)=>Promise<void>}).testPlay(name),name);
  // A clip can contain two utterances. Flush its last quiet gap before moving on.
  await page.waitForTimeout(1500);
  expect((await transcription).ok()).toBe(true);
  await expect(page.getByRole("region",{name:"音声操作モード"})).not.toContainText("音声を文字にしています",{timeout:40_000});
 };
 await record("dish");await record("recipe");
 const draft=page.getByLabel("未保存のレシピ下書き");
 await expect(draft).toContainText("ペペロンチーノ",{timeout:40_000});
 await expect(page.getByRole("button",{name:"解析を再試行",exact:true})).toBeEnabled({timeout:40_000});
 const parsed=await draft.textContent();
 if(!parsed?.includes("¥4000 / 1kg")||!parsed.includes("ディチェコ")||parsed.includes("要確認")){
  expect((await state()).recipes).toHaveLength(0);
  console.log("LIVE explicit correction: ASR ambiguity is clarified by the human, not by guessing a price");
  await page.getByLabel("音声認識できない場合の入力").fill("乾燥パスタのメーカーはディチェコです。ギリシャ産単一種エクストラバージンオイルの仕入単価は1kg4000円に訂正、使用量25gです。売価は未設定のままです。");
  await page.getByRole("button",{name:"反映",exact:true}).click();
  await expect(page.getByRole("button",{name:"解析を再試行",exact:true})).toBeEnabled({timeout:40_000});
 }
 await expect(draft).toContainText("¥4000 / 1kg",{timeout:40_000});
 await expect(draft).toContainText("100g");await expect(draft).toContainText("10g");await expect(draft).toContainText("25g");
 await expect(page.getByRole("button",{name:"内容を確認",exact:true})).toBeEnabled({timeout:40_000});
 const before=parses;expect((await state()).recipes).toHaveLength(0);
 await record("review");
 await expect(page.getByRole("button",{name:"内容を承認して保存",exact:true})).toBeEnabled({timeout:40_000});
 expect((await state()).recipes).toHaveLength(0);expect(parses).toBe(before);
 await record("save");
 await expect(page.getByText("レシピを保存しました。")).toBeVisible({timeout:40_000});
 const stored=await state();expect(stored.recipes).toHaveLength(1);expect(stored.versions).toHaveLength(1);
 expect(stored.recipes[0].title).toContain("ペペロンチーノ");
 expect(stored.recipes[0].state.materials.map((item:{price_override:{amount_jpy:{value:string}}})=>item.price_override.amount_jpy.value)).toEqual(["350","4600","4000"]);
 expect(stored.recipes[0].state.selling_price_jpy.value).toBeNull();
 expect(stored.versions[0].cost_snapshot.total_cost_jpy).toBe("216");expect(parses).toBe(before);
 await record("browse");
 await expect(page.getByRole("region",{name:"音声操作モード"})).not.toContainText("操作を処理中",{timeout:40_000});
 await expect(page.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥216");
 await record("edit");await expect(page.getByLabel("提案の差分")).toContainText("150",{timeout:40_000});
 expect((await state()).versions).toHaveLength(1);
 await record("save");
 await expect(page.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥251",{timeout:40_000});
 const edited=await state();expect(edited.recipes).toHaveLength(1);expect(edited.versions).toHaveLength(2);
 expect(edited.recipes[0].revision).toBe(1);expect(edited.recipes[0].state.materials[0].quantity.value).toBe("150");
 expect(await page.evaluate(()=>(window as unknown as {testMicOpens:number}).testMicOpens)).toBe(1);
 await expect(page.getByRole("button",{name:"■ マイクを停止",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"■ マイクを停止",exact:true}).click();
 await page.reload();await page.getByRole("button",{name:"詳細を見る",exact:true}).click();
 await expect(page.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥251");
 console.log("LIVE unified durable result:",JSON.stringify({microphone_opens:1,recipes:1,versions:2,cost_jpy:"251",selling_price:null,parses}));
});
