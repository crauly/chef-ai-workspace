"use client";
import {useEffect,useImperativeHandle,useRef,useState,type Ref} from "react";
import type {Locale} from "./i18n";
import {request,type Recipe} from "./types";
import {useVoiceCapture,type VoiceCaptureMeta} from "./useVoiceCapture";
import {voiceCommand,type VoiceCommand} from "./voice-commands";
import {logVoiceEvent} from "./voice-diagnostics";

type Ingredient={name:string;quantity:string;unit:string;price_jpy:string;price_quantity:string;price_unit:string};
type Interpretation={source:string;suggestion:string;reason:string};
type Draft={title:string;materials:Ingredient[];selling_price_jpy:string;notes:string[];missing:string[];interpretations?:Interpretation[]};
type Input={text:string;command:VoiceCommand;revision:number;approval:Draft|null;traceId:string};
export type SaveMode="confirmed"|"unconfirmed";
// Missing-entry kinds mirror web/app/api/voice-recipe/route.ts. Only a draft
// whose gaps are all purchase prices may take the explicit unconfirmed path;
// a missing name, quantity/unit, title, or any note keeps saving blocked.
const PRICE_SUFFIX="の仕入単価・基準数量・単位";
export function saveModeFor(draft:Draft):SaveMode|null{
 if(!draft.title.trim()||draft.notes.length)return null;
 let priceOnly=false;
 for(const entry of draft.missing){
  if(entry.endsWith(PRICE_SUFFIX)){priceOnly=true;continue;}
  return null;
 }
 return priceOnly?"unconfirmed":"confirmed";
}
export function priceMissingNames(draft:Draft):string[]{
 const names=new Set<string>();
 draft.materials.forEach((m,i)=>{
  if(!(m.price_jpy&&m.price_quantity&&m.price_unit))
   names.add(m.name.trim()||`食材${i+1}`);
 });
 return [...names];
}
// Unconfirmed saves omit unknown prices so the backend stores unpriced lines
// (partial cost, explicit unresolved IDs) instead of zero-filled guesses.
// Empty quantity/unit also becomes null; the eligibility recheck in save()
// keeps such drafts blocked, so this never silently widens the gate.
export function toSaveMaterials(draft:Draft){
 return draft.materials.map(m=>({name:m.name,
  quantity:m.quantity||null,unit:m.unit||null,
  price_jpy:m.price_jpy||null,price_quantity:m.price_quantity||null,
  price_unit:m.price_unit||null}));
}

export type RegistrationHandle={submit:(text:string,meta?:VoiceCaptureMeta)=>void;hasPending:()=>boolean;isSaving:()=>boolean;suspend:()=>void;requestReview:()=>void};
export default function VoiceRecipeRegistration({locale,onCreated,onDiscarded,control,sharedVoice}:{locale:Locale;onCreated:(recipe:Recipe,mode:SaveMode)=>void;onDiscarded?:()=>void;control?:Ref<RegistrationHandle>;sharedVoice?:{markReview:()=>number;cancel:()=>void;captureMessage:string}}){
 const ja=locale==="ja";
 const [busy,setBusy]=useState(false),[turns,setTurns]=useState<string[]>([]),[draft,setDraft]=useState<Draft|null>(null);
 const [phase,setPhase]=useState<"dictating"|"review"|"saving">("dictating");
 const [message,setMessage]=useState(ja?"料理名・食材・分量・仕入単価を話してください。":"Describe the recipe, quantities and purchase prices.");
 const [manual,setManual]=useState("");
 const dataTurns=useRef<string[]>([]),draftRef=useRef<Draft|null>(null),reviewed=useRef<Draft|null>(null);
 const phaseRef=useRef<"dictating"|"review"|"saving">("dictating");
 const approvalEpoch=useRef(0);
 const reviewMode=useRef<SaveMode|null>(null);
 const inbox=useRef<Input[]>([]),draining=useRef(false),revision=useRef(0),epoch=useRef(0);
 const requestId=useRef<string|null>(null),semanticAbort=useRef<AbortController|null>(null),alive=useRef(true);
 const clearTrace=useRef("");
 const capture=useVoiceCapture(locale,enqueue,true);
 const voice={...capture,...sharedVoice};
 useImperativeHandle(control,()=>({submit:enqueue,hasPending:()=>Boolean(dataTurns.current.length||inbox.current.length||draftRef.current),isSaving:()=>phaseRef.current==="saving",requestReview:()=>{showReview();},suspend:()=>{
  reviewed.current=null;inbox.current=inbox.current.filter(input=>input.command==="data");setStage("dictating");
 }}));
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;semanticAbort.current?.abort();inbox.current=[];};},[]);
 function setStage(next:"dictating"|"review"|"saving"){phaseRef.current=next;setPhase(next);}
 function say(text:string){if(alive.current)setMessage(text);}
 function clear(){
  if(phaseRef.current==="saving")return;
  epoch.current++;revision.current++;semanticAbort.current?.abort();voice.cancel();inbox.current=[];
  dataTurns.current=[];setTurns([]);draftRef.current=null;reviewed.current=null;reviewMode.current=null;setDraft(null);requestId.current=null;
  setStage("dictating");logVoiceEvent("draft.discarded.explicit","explicit cancel",clearTrace.current);clearTrace.current="";onDiscarded?.();say("下書きを破棄しました。新しいレシピを話してください。");
 }
 async function parse(next:string[],version:number,traceId=""){
  const current=epoch.current,aborter=new AbortController();semanticAbort.current=aborter;
  logVoiceEvent("muse.start",`${next.length} turns`,traceId);say("Museが料理の文脈・数量・価格を解釈しています…");
  try{
   const out=await request<Draft>("/api/voice-recipe",{method:"POST",body:JSON.stringify({turns:next}),signal:aborter.signal});
   if(!alive.current||epoch.current!==current||revision.current!==version){logVoiceEvent("muse.ok","stale result ignored",traceId);return;}
   logVoiceEvent(draftRef.current?"draft.updated":"draft.created", "voice-recipe",traceId);
   draftRef.current=out;setDraft(out);reviewed.current=null;reviewMode.current=null;requestId.current=null;setStage("dictating");
   say(out.missing.length||out.notes.length?"確認が必要です："+[...out.missing,...out.notes].join("、"):
    "下書きを更新しました。内容を確認し、「保存してください」と話すか、確認ボタンを押してください。");
  }catch{
   if(alive.current&&epoch.current===current&&revision.current===version&&!aborter.signal.aborted){
    logVoiceEvent("muse.fail","voice-recipe failed; draft kept",traceId);
    say("料理の解釈に失敗しました。保存していません。「解析を再試行」か補助入力で再開できます。");
   }
  }
 }
 function showReview(traceId=""){
  const d=draftRef.current;
  if(!d){say(dataTurns.current.length?"最新の入力を解釈中、または解釈に失敗しています。解析が終わるまで保存しません。":"新しいレシピを登録します。料理名・食材・分量・仕入単価を話してください。");return;}
  const mode=saveModeFor(d);
  if(!mode){
   say("まだ登録できません："+[...(!d.title.trim()?["料理名"]:[]),...d.missing,...d.notes].join("、"));return;
  }
  reviewed.current=d;reviewMode.current=mode;approvalEpoch.current=voice.markReview();setStage("review");
  if(mode==="confirmed")
   say("確認用の下書きを表示しました。料理名・食材・数量・価格を確認し、正しければもう一度「保存してください」と話すか、承認して保存を押してください。");
  else
   say("仕入単価が不明の項目があります（"+priceMissingNames(d).join("、")+"）。数量は確定、価格は未確定として保存できます。価格を推測やゼロ埋めで補いません。よければもう一度「保存してください」と話すか、価格未確定として保存を押してください。");
 }
 async function save(){
  const d=draftRef.current;
  const mode=reviewMode.current;
  if(phaseRef.current!=="review"||!d||!mode||reviewed.current!==d||saveModeFor(d)!==mode)return;
  voice.cancel();setStage("saving");if(!draining.current)setBusy(true);say("承認された内容を保存しています…");
  if(!requestId.current)requestId.current=crypto.randomUUID();
  try{
   const recipe=await request<Recipe>("/api/recipes/full",{method:"POST",body:JSON.stringify({request_id:requestId.current,title:d.title,materials:mode==="confirmed"?d.materials:toSaveMaterials(d),selling_price_jpy:d.selling_price_jpy||null})});
   if(!alive.current)return;
   epoch.current++;revision.current++;inbox.current=[];
   dataTurns.current=[];setTurns([]);draftRef.current=null;reviewed.current=null;reviewMode.current=null;setDraft(null);requestId.current=null;setStage("dictating");
   say(mode==="confirmed"?(sharedVoice?"保存済みです。":"レシピを保存しました。"):"価格未確定として保存しました。未確定の仕入単価はゼロにせず、部分原価のみ表示されます。");onCreated(recipe,mode);
  }catch{setStage("review");say("保存結果を確認できませんでした。再送時も同じ登録IDを使います。一覧を確認してから再試行してください。");}
  finally{if(alive.current&&!draining.current)setBusy(false);}
 }
 async function drain(){
  if(draining.current)return;draining.current=true;setBusy(true);
  try{
   while(alive.current&&inbox.current.length){
    const input=inbox.current.shift()!;
    if(input.command==="data"){
     const batch=[input];while(inbox.current[0]?.command==="data")batch.push(inbox.current.shift()!);
     dataTurns.current=[...dataTurns.current,...batch.map(item=>item.text)].slice(-30);
     await parse(dataTurns.current,batch[batch.length-1].revision,batch[batch.length-1].traceId);
    }else if(input.revision===revision.current){
     if(input.command==="review")showReview(input.traceId);
     else if(input.command==="save"){
      // An explicit save request presents review first; a later request approves it.
      if(input.approval&&phaseRef.current==="review"&&input.approval===reviewed.current&&reviewed.current===draftRef.current)await save();
      else showReview(input.traceId);
     }else if(input.command==="hold"){
      reviewed.current=null;setStage("dictating");say("保存せず、下書きを保持します。");
     }
    }
   }
  }finally{draining.current=false;if(alive.current)setBusy(false);}
 }
 function enqueue(text:string,meta?:VoiceCaptureMeta){
  if(!text.trim()||phaseRef.current==="saving")return;
  const command=voiceCommand(text);
  if(command==="cancel"){clearTrace.current=meta?.traceId??"";clear();return;}
  setTurns(previous=>[...previous,text].slice(-30));
  if(command==="data"){
   revision.current++;reviewed.current=null;reviewMode.current=null;draftRef.current=null;requestId.current=null;setStage("dictating");
  }
  const afterReview=!meta||meta.reviewEpoch===approvalEpoch.current;
  inbox.current.push({text,command,revision:revision.current,approval:afterReview&&phaseRef.current==="review"?reviewed.current:null,traceId:meta?.traceId??""});void drain();
 }
 function retry(){
  if(!dataTurns.current.length||draining.current)return;
  // Retry the same source, without fabricating another spoken turn.
  draining.current=true;setBusy(true);
  void parse(dataTurns.current,revision.current).finally(()=>{
   draining.current=false;if(alive.current)setBusy(false);if(inbox.current.length)void drain();
  });
 }
 const eligible=draftRef.current?saveModeFor(draftRef.current):null;
 return <section className="card" aria-label="音声レシピ一括登録">
  <h2>{ja?"音声でレシピを一括登録":"Full recipe by voice"}</h2>
  <p>料理名、食材、分量、仕入単価、売価を自然な言葉で伝えてください。料理の文脈を解釈し、変更案を下書きで確認できます。</p>
  <p>「内容を確認」「保存してください」などで確認へ進みます。確認後、もう一度の明示承認で保存します。キャンセルは下書きを破棄します。</p>
  <p>仕入単価だけが不明でも、確認後に価格未確定として保存できます（推測・ゼロ埋めしません）。確定保存と未確定保存は確認画面で区別されます。</p>
  <p>{ja?"音声はMetaへ送信して文字起こしします。録音は保存しません。発話の間を約1秒空けると解釈します。":"Audio is sent to Meta and not stored. Pause for about one second between turns."}</p>
  {!sharedVoice&&<><button type="button" disabled={!voice.recording&&(voice.supported===false||voice.busy||phase==="saving")} onClick={voice.recording?voice.stop:()=>void voice.start()} aria-pressed={voice.recording}>{voice.recording?"■ マイクを停止":"🎙 音声操作を開始"}</button>
  <p aria-live="polite">{voice.recording?"聞き取り中… ":""}{voice.busy?"音声を文字にしています…":""}</p>
  {voice.error&&<p role="alert">{voice.error}</p>}
  {voice.supported===false&&<p>音声入力を利用できません。補助入力を使用してください。</p>}</>}
  <p aria-live="polite">{busy?"処理中：":""}{message}</p>
  {!sharedVoice&&<form onSubmit={event=>{event.preventDefault();if(manual.trim()){enqueue(manual);setManual("");}}}>
   <input aria-label="音声認識できない場合の入力" value={manual} onChange={event=>setManual(event.target.value)} placeholder="音声認識できないときの補助入力" disabled={phase==="saving"}/>
   <button type="submit" disabled={!manual.trim()||phase==="saving"}>反映</button>
  </form>}
  <button type="button" disabled={busy||!dataTurns.current.length||phase==="saving"} onClick={retry}>解析を再試行</button>
  <p>認識した発話：{turns.length?turns.join(" ／ "):"なし"}</p>
  {draft&&<div id="draft" aria-label="未保存のレシピ下書き">
   <h3>未保存の下書き：{draft.title||"料理名未設定"}</h3>
   {draft.interpretations?.map((item,index)=><p key={index}>料理の文脈からの解釈案：{item.source} → {item.suggestion}（{item.reason}）</p>)}
   <p>売価：{draft.selling_price_jpy?("¥"+draft.selling_price_jpy):"未設定（売価なしでも保存できます）"}</p>
   <ul>{draft.materials.map((material,index)=>{const priced=Boolean(material.price_jpy&&material.price_quantity&&material.price_unit);return <li key={index}>{material.name||"食材名不明"}：{material.quantity||"?"}{material.unit} ／ {priced?`仕入単価 ¥${material.price_jpy} / ${material.price_quantity}${material.price_unit}`:"仕入単価 未確定（推測しません）"}</li>;})}</ul>
   {draft.missing.length>0&&<p role="alert">不足情報：{draft.missing.join("、")}</p>}
   {draft.notes.length>0&&<p role="alert">要確認：{draft.notes.join("、")}</p>}
   <p>{phase==="review"?(reviewMode.current==="unconfirmed"?"確認待ち（価格未確定）：数量は確定、価格は未確定として保存します。よければ明示承認してください。":"確認待ち：内容が正しければ、保存を明示承認してください。"):"まだ保存されていません。"}</p>
   {sharedVoice&&<><p role="status">{sharedVoice.captureMessage}</p><a href="#voice-controls">音声操作・再開へ戻る</a></>}
   <button type="button" disabled={busy||!eligible||phase==="saving"} onClick={()=>showReview()}>内容を確認</button>
   <button type="button" disabled={busy||phase!=="review"||!eligible} onClick={()=>void save()}>{phase==="review"&&reviewMode.current==="unconfirmed"?"価格未確定として承認して保存":"内容を承認して保存"}</button>
   <button type="button" disabled={phase==="saving"} onClick={clear}>下書きを破棄</button>
  </div>}
 </section>;
}
