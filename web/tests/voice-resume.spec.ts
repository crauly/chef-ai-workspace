import {test,expect,type Page} from "@playwright/test";
import {validWav} from "../app/voice-transcription";
const draft={title:"パスタ",materials:[{name:"パスタ",quantity:"100",unit:"g",price_jpy:"350",price_quantity:"500",price_unit:"g"}],selling_price_jpy:"",missing:[],notes:[]};
async function type(page:Page,text:string){await page.getByLabel("音声認識できない場合の入力").fill(text);await page.getByRole("button",{name:"反映",exact:true}).click();}

for(const command of ["登録","登録してください","レシピを登録してください"]){
 test(`a reviewed draft accepts ${command} without create navigation or another model call`,async({page})=>{
  let parses=0,saves=0;
  await page.route("**/api/voice-recipe",route=>{parses++;return route.fulfill({json:draft});});
  await page.route("**/api/recipes/full",async route=>{saves++;await route.fulfill({status:201,json:{id:"11111111-1111-4111-8111-111111111111",title:{value:"パスタ"},revision:0,materials:[],selling_price_jpy:{value:null}}});});
  await page.goto("/");await type(page,"パスタ100g、500g350円");
  await expect(page.getByRole("button",{name:"内容を確認",exact:true})).toBeEnabled();
  await type(page,"内容を確認");await expect(page.getByRole("button",{name:"内容を承認して保存",exact:true})).toBeEnabled();
  expect(saves).toBe(0);await type(page,command);
  await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("レシピを保存しました。");
  expect(saves).toBe(1);expect(parses).toBe(1);
 });
}

test("registration is never approval before review and a negative request clears approval",async({page})=>{
 let saves=0;await page.route("**/api/voice-recipe",route=>route.fulfill({json:draft}));
 await page.route("**/api/recipes/full",route=>{saves++;return route.fulfill({status:500});});
 await page.goto("/");await type(page,"パスタ100g、500g350円");
 await expect(page.getByRole("button",{name:"内容を確認",exact:true})).toBeEnabled();
 await type(page,"レシピを登録してください");await expect(page.getByRole("button",{name:"内容を承認して保存",exact:true})).toBeEnabled();expect(saves).toBe(0);
 await type(page,"登録しないでください");await expect(page.getByRole("button",{name:"内容を承認して保存",exact:true})).toBeDisabled();expect(saves).toBe(0);
 await type(page,"登録");await expect(page.getByRole("button",{name:"内容を承認して保存",exact:true})).toBeEnabled();expect(saves).toBe(0);
});

// Inject worklet frames to exercise the full 29-second bound without sleeping
// through 87 seconds. WAV encoding, request serialization and the hook are real.
async function controlledMicrophone(page:Page){
 await page.addInitScript(()=>{
  const state={opens:0,stops:0,cues:[] as number[],feed:null as null|((seconds:number,speech:boolean)=>void)};
  (window as unknown as {resumeMic:typeof state}).resumeMic=state;
  const Audio=window.AudioContext,Worklet=window.AudioWorkletNode;
  window.AudioContext=class extends Audio{
   createOscillator(){const osc=super.createOscillator(),start=osc.start.bind(osc);osc.start=(when?:number)=>{state.cues.push(osc.frequency.value);start(when);};return osc;}
  };
  window.AudioWorkletNode=class extends Worklet{
   constructor(context:BaseAudioContext,name:string,options?:AudioWorkletNodeOptions){super(context,name,options);
    state.feed=(seconds,speech)=>{this.port.onmessage?.call(this.port,new MessageEvent("message",{data:{samples:new Float32Array(Math.ceil(context.sampleRate*seconds)).fill(speech?.1:0),reviewEpoch:options?.processorOptions?.reviewEpoch??0}}));};
   }
  };
  Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>{
   state.opens++;const context=new AudioContext(),out=context.createMediaStreamDestination();await context.resume();
   const track=out.stream.getTracks()[0],stop=track.stop.bind(track);let stopped=false;
   track.stop=()=>{if(!stopped){stopped=true;state.stops++;stop();void context.close();}};return out.stream;
  }});
 });
}
async function feed(page:Page,seconds:number,speech=true){await page.evaluate(({seconds,speech})=>(window as unknown as {resumeMic:{feed:(seconds:number,speech:boolean)=>void}}).resumeMic.feed(seconds,speech),{seconds,speech});}
async function start(page:Page){await page.goto("/");await page.getByRole("button",{name:"🎙 音声操作を開始",exact:true}).click();await page.waitForFunction(()=>typeof (window as unknown as {resumeMic:{feed:unknown}}).resumeMic.feed==="function");}

test("slow transcription coalesces short fragments instead of aborting the microphone",async({page})=>{
 await controlledMicrophone(page);let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 let transcribes=0;const sources:string[][]=[];
 await page.route("**/api/voice/transcribe",async route=>{const number=++transcribes;expect(validWav(route.request().postDataBuffer()!)).toBe(true);if(number===1)await held;await route.fulfill({json:{transcript:`材料${number}を100g`}});});
 await page.route("**/api/voice-recipe",route=>{sources.push(route.request().postDataJSON().turns);return route.fulfill({json:draft});});
 await start(page);
 for(let i=0;i<5;i++){await feed(page,.5);await feed(page,1.1,false);}
 await expect.poll(()=>transcribes).toBe(1);await expect(page.getByRole("button",{name:"■ マイクを停止",exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as unknown as {resumeMic:{stops:number}}).resumeMic.stops)).toBe(0);
 release();await expect.poll(()=>sources.flat()).toEqual(["材料1を100g","材料2を100g","材料3を100g"]);
 await expect(page.getByRole("button",{name:"■ マイクを停止",exact:true})).toBeVisible();
 expect(transcribes).toBe(3);await page.reload();
});

test("a bounded backlog keeps the microphone open and drains every accepted batch automatically",async({page})=>{
 await controlledMicrophone(page);let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 let transcribes=0;const sources:string[][]=[];
 await page.route("**/api/voice/transcribe",async route=>{const number=++transcribes;expect(validWav(route.request().postDataBuffer()!)).toBe(true);if(number===1)await held;await route.fulfill({json:{transcript:`食材${number}を100g`}});});
 await page.route("**/api/voice-recipe",route=>{sources.push(route.request().postDataJSON().turns);return route.fulfill({json:draft});});
 await start(page);for(let i=0;i<4;i++)await feed(page,29);
 // No pause, no stop cue, no manual resume: buffered utterances wait visibly.
 await expect(page.getByRole("button",{name:"■ マイクを停止",exact:true})).toBeVisible();
 await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("順に文字にしています");
 expect(await page.evaluate(()=>(window as unknown as {resumeMic:{stops:number}}).resumeMic.stops)).toBe(0);
 release();
 await expect.poll(()=>sources.flat()).toEqual(["食材1を100g","食材2を100g","食材3を100g","食材4を100g"]);
 expect(transcribes).toBe(4);await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("パスタ");
 await expect(page.getByRole("region",{name:"音声操作モード"})).not.toContainText("順に文字にしています");
 expect(await page.evaluate(()=>(window as unknown as {resumeMic:{opens:number}}).resumeMic.opens)).toBe(1);
 await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("パスタ");await page.reload();
});

test("one failed transcription stays audible but keeps later accepted and partial audio flowing",async({page})=>{
 await controlledMicrophone(page);let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 let transcribes=0;const sources:string[][]=[];
 await page.route("**/api/voice/transcribe",async route=>{const number=++transcribes;if(number===1){await held;await route.fulfill({status:502});}else await route.fulfill({json:{transcript:`材料${number}を100g`}});});
 await page.route("**/api/voice-recipe",route=>{sources.push(route.request().postDataJSON().turns);return route.fulfill({json:draft});});
 await start(page);for(let i=0;i<2;i++){await feed(page,.5);await feed(page,1.1,false);}await feed(page,.5);
 await expect.poll(()=>transcribes).toBe(1);release();
 // Failure is announced with one error cue, yet the microphone stays open
 // and accepted audio keeps flowing without a manual resume.
 await expect(page.getByRole("region",{name:"音声操作モード"}).getByRole("alert")).toContainText("受付は続けています");
 await expect(page.getByRole("button",{name:"■ マイクを停止",exact:true})).toBeVisible();
 await feed(page,1.1,false);
 await expect.poll(()=>sources.flat()).toEqual(["材料2を100g","材料3を100g"]);expect(transcribes).toBe(3);
 const cues=await page.evaluate(()=>(window as unknown as {resumeMic:{cues:number[]}}).resumeMic.cues);
 expect(cues.filter(frequency=>frequency===220)).toHaveLength(1);await page.reload();
});
