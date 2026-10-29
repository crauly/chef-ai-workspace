// Explicit opt-in: real Voice/Spark and dedicated Supabase. No production owner.
import {test,expect} from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
test.skip(process.env.CHEF_LIVE_VOICE!=="1"||process.env.CHEF_LIVE_VOICE_CASE!=="complaint","Complaint acceptance is opt-in");

test("reported dish-name and polite-save conversation reaches one durable recipe",async({page,request})=>{
 const audioDir=process.env.CHEF_LIVE_VOICE_AUDIO_DIR;
 if(!audioDir)throw new Error("Test audio directory required");
 const state=async()=>{const result=await request.get("http://127.0.0.1:8102/test/live-state");expect(result.ok()).toBe(true);return result.json();};
 expect((await state()).recipes).toHaveLength(0);
 await page.addInitScript(()=>{
  Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>{
   const context=new AudioContext(),out=context.createMediaStreamDestination();
   const response=await fetch((window as unknown as {testAudio:string}).testAudio);
   const source=context.createBufferSource();source.buffer=await context.decodeAudioData(await response.arrayBuffer());
   source.connect(out);await context.resume();source.start();
   const track=out.stream.getTracks()[0],stop=track.stop.bind(track);
   track.stop=()=>{stop();void context.close();};return out.stream;
  }});
 });
 for(const name of ["dish","recipe","review","save"])
  await page.route(`**/test-audio/${name}.wav`,route=>route.fulfill({path:path.join(audioDir,name+".wav"),contentType:"audio/wav"}));
 let parses=0;
 page.on("response",async response=>{
  if(response.url().endsWith("/api/voice/transcribe")&&response.ok())console.log("LIVE complaint transcript:",JSON.stringify(await response.json()));
  if(response.url().endsWith("/api/voice-recipe")&&response.ok()){
   parses++;console.log("LIVE complaint interpretation:",JSON.stringify({timing:response.headers()["server-timing"],draft:await response.json()}));
  }
 });
 await page.goto("/");
 const record=async(name:string)=>{
  const wav=fs.readFileSync(path.join(audioDir,name+".wav")),duration=(wav.length-44)/wav.readUInt32LE(28);
  await page.evaluate(name=>{(window as unknown as {testAudio:string}).testAudio="/test-audio/"+name+".wav";},name);
  await page.getByRole("button",{name:"🎙 音声登録を開始",exact:true}).click();
  await page.waitForTimeout(duration*1000+250);
  await page.getByRole("button",{name:"■ マイクを停止",exact:true}).click();
  await expect(page.getByRole("button",{name:"🎙 音声登録を開始",exact:true})).toBeEnabled({timeout:40_000});
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
 await page.reload();await page.getByRole("button",{name:"詳細を見る",exact:true}).click();
 await expect(page.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥216");
 console.log("LIVE complaint durable result:",JSON.stringify({recipes:1,versions:1,cost_jpy:"216",selling_price:null,parses}));
});
