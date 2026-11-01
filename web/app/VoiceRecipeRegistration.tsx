"use client";
import {useEffect,useImperativeHandle,useRef,useState,type Ref} from "react";
import type {Locale} from "./i18n";
import {request,type Recipe} from "./types";
import {useVoiceCapture,type VoiceCaptureMeta} from "./useVoiceCapture";
import {voiceCommand,type VoiceCommand} from "./voice-commands";
import {logVoiceEvent} from "./voice-diagnostics";

type Ingredient={name:string;quantity:string;unit:string;price_jpy:string;price_quantity:string;price_unit:string;supplier:string};
type Interpretation={source:string;suggestion:string;reason:string};
type NameCorrection={material_name:string;heard:string;candidates:{name:string;reason:string}[]};
type PriceReference={material_name:string;status:string;origin?:"ledger"|"external";ingredient_name?:string;currency?:string;unit_basis?:string;average_unit_price?:string;observation_count?:number;observed_to?:string|null;sources?:{url:string;title:string}[];fetched_at?:string;text:string};
type ProvisionalPrice={material_index:number;material_name:string;origin:"ledger"|"external";price_jpy:string;price_quantity:string;price_unit:string;currency:string;observation_count:number;sources:{url:string;title:string}[];fetched_at:string|null;status:"provisional";approval:"unapproved";text:string};
type ResearchStatus={material_name:string;material_index:number;request:string;trigger:"muse"|"heuristic";ledger:string;web:"not_attempted"|"available"|"empty"|"not_searched"|"provider_error"|"timeout"|"misconfigured";provisional:boolean};
type Draft={title:string;materials:Ingredient[];selling_price_jpy:string;notes:string[];missing:string[];interpretations?:Interpretation[];price_references?:PriceReference[];provisional_prices?:Array<ProvisionalPrice|null>;research_status?:ResearchStatus[];nameCorrections?:NameCorrection[]};
const validPrice=/^(?:0|[1-9]\d*)(?:\.\d+)?$/;
function sourceUrl(url:string){try{const parsed=new URL(url);return parsed.protocol==="https:"?parsed.href:null;}catch{return null;}}
function researchLabel(status:ResearchStatus,ja:boolean){
 const messages:Record<ResearchStatus["web"],[string,string]>={
  not_attempted:["Web検索未実施（仕入台帳を参照）","Web search not attempted (ledger used)"],
  available:["Web検索完了","Web research completed"],empty:["価格候補なし","No comparable prices found"],
  not_searched:["Web検索を確認できません","Web search not confirmed"],
  provider_error:["検索サービスの応答エラー","Search provider error"],
  timeout:["検索がタイムアウトしました","Search timed out"],
  misconfigured:["検索サービスの設定を確認してください","Search configuration unavailable"]};
 return messages[status.web][ja?0:1];
}
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
// Save boundary: recipe lines carry no supplier column and
// CompleteRecipeMaterial forbids extras, so every save mode projects drafts
// through toSaveMaterials (prices nulled when unknown, supplier omitted).
// The spoken purchase source stays visible in review and is handed to the
// chef as a memo; formal supplier linkage uses the existing ledger path
// (ingredient-assist -> offer observations -> observations/confirm, all
// Human-Gate approved), never an automatic write.
export function toSaveMaterials(draft:Draft){
 return draft.materials.map(m=>({name:m.name,
  quantity:m.quantity||null,unit:m.unit||null,
  price_jpy:m.price_jpy||null,price_quantity:m.price_quantity||null,
  price_unit:m.price_unit||null}));
}

function applyFoundPrices(draft:Draft):Draft{
 const applied=new Set<number>();
 const materials=draft.materials.map((m,index)=>{
  const p=draft.provisional_prices?.[index];
  if(!p||p.material_index!==index||p.material_name.trim()!==m.name.trim()||
    p.status!=="provisional"||p.approval!=="unapproved"||p.currency!=="JPY"||
    p.price_quantity!=="1"||!["g","ml"].includes(p.price_unit)||
    !validPrice.test(p.price_jpy)||Number(p.price_jpy)<=0||
    (m.price_jpy&&m.price_quantity&&m.price_unit))return m;
  applied.add(index);
  return {...m,price_jpy:p.price_jpy,price_quantity:p.price_quantity,price_unit:p.price_unit};
 });
 if(!applied.size)return draft;
 const missing=draft.missing.filter(item=>!draft.materials.some((m,i)=>applied.has(i)&&item===m.name+PRICE_SUFFIX));
 return {...draft,materials,missing};
}
export type RegistrationHandle={submit:(text:string,meta?:VoiceCaptureMeta)=>void;hasPending:()=>boolean;isSaving:()=>boolean;suspend:()=>void;requestReview:()=>void};
export default function VoiceRecipeRegistration({locale,onCreated,onDiscarded,control,sharedVoice}:{locale:Locale;onCreated:(recipe:Recipe,mode:SaveMode,suppliers:string[])=>void;onDiscarded?:()=>void;control?:Ref<RegistrationHandle>;sharedVoice?:{markReview:()=>number;cancel:()=>void;captureMessage:string}}){
 const ja=locale==="ja";
 const [busy,setBusy]=useState(false),[turns,setTurns]=useState<string[]>([]),[draft,setDraft]=useState<Draft|null>(null);
 const [phase,setPhase]=useState<"dictating"|"review"|"saving">("dictating");
 const [message,setMessage]=useState(ja?"料理名・食材・分量・仕入単価を話してください。":"Describe the recipe, quantities and purchase prices.");
 const [manual,setManual]=useState("");
 const [correctionIndex,setCorrectionIndex]=useState<number|null>(null);
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
 const englishMessages:Record<string,string>={"下書きを破棄しました。新しいレシピを話してください。":"Draft discarded. Describe a new recipe.","Museが料理の文脈・数量・価格を解釈しています…":"Muse is interpreting the dish, quantities and prices…","料理の解釈に失敗しました。保存していません。「解析を再試行」か補助入力で再開できます。":"Could not interpret the recipe. Nothing was saved. Retry analysis or use manual input.","確認用の下書きを表示しました。料理名・食材・数量・価格を確認し、正しければもう一度「保存してください」と話すか、承認して保存を押してください。":"Draft ready to review. Check the dish, ingredients, quantities and prices, then explicitly approve saving.","承認された内容を保存しています…":"Saving approved recipe…","保存済みです。":"Already saved.","レシピを保存しました。":"Recipe saved.","価格未確定として保存しました。未確定の仕入単価はゼロにせず、部分原価のみ表示されます。":"Saved with unconfirmed purchase prices. Unknown prices are not set to zero; only partial costs are shown.","保存結果を確認できませんでした。再送時も同じ登録IDを使います。一覧を確認してから再試行してください。":"Could not confirm the save result. The same request ID is used for retries; check the recipe list first.","保存せず、下書きを保持します。":"Not saved. Draft preserved."};
 function say(text:string){if(alive.current)setMessage(ja?text:(englishMessages[text]??text));}
 function clear(){
  if(phaseRef.current==="saving")return;
  epoch.current++;revision.current++;semanticAbort.current?.abort();voice.cancel();inbox.current=[];
  setCorrectionIndex(null);dataTurns.current=[];setTurns([]);parsedTurns.current=0;parseBase.current=null;draftRef.current=null;reviewed.current=null;reviewMode.current=null;setDraft(null);requestId.current=null;
  setStage("dictating");logVoiceEvent("draft.discarded.explicit","explicit cancel",clearTrace.current);clearTrace.current="";onDiscarded?.();say("下書きを破棄しました。新しいレシピを話してください。");
 }
 const parsedTurns=useRef(0);
 // Last successfully parsed draft. enqueue() clears the live draftRef on new
 // dictation (approval can never commit it), but parseBase survives as Muse
 // revision context so follow-ups resend only unparsed turns, not history.
 const parseBase=useRef<Draft|null>(null);
 async function parse(next:string[],version:number,traceId=""){
  const current=epoch.current,aborter=new AbortController();semanticAbort.current=aborter;
  // Incremental revision: resend only turns not yet parsed, with the last
  // successfully parsed draft as context, instead of reprocessing history.
  const previous=parseBase.current;
  const fresh=next.slice(parsedTurns.current);
  const turnsToSend=fresh.length?fresh:next.slice(-30);
  const usePrevious=previous&&fresh.length?previous:null;
  logVoiceEvent("muse.start",`${turnsToSend.length} new turns${usePrevious?"+draft":""}`,traceId);say("Museが料理の文脈・数量・価格を解釈しています…");
  try{
   const out=await request<Draft>("/api/voice-recipe",{method:"POST",body:JSON.stringify(usePrevious?{turns:turnsToSend,previous:usePrevious}:{turns:next}),signal:aborter.signal});
   parsedTurns.current=next.length;
   if(!alive.current||epoch.current!==current||revision.current!==version){logVoiceEvent("muse.ok","stale result ignored",traceId);return;}
   const enriched=applyFoundPrices(out);
   parseBase.current=enriched;
   logVoiceEvent(draftRef.current?"draft.updated":"draft.created", "voice-recipe",traceId);
   setCorrectionIndex(null);draftRef.current=enriched;setDraft(enriched);reviewed.current=null;reviewMode.current=null;requestId.current=null;setStage("dictating");
   say(enriched.missing.length||enriched.notes.length?(ja?"確認が必要です："+[...enriched.missing,...enriched.notes].join("、"):"Needs review: "+[...enriched.missing,...enriched.notes].join(", ")):
    (ja?"下書きを更新しました。内容を確認し、「保存してください」と話すか、確認ボタンを押してください。":"Draft updated. Review it, then explicitly approve saving."));
  }catch{
   if(alive.current&&epoch.current===current&&revision.current===version&&!aborter.signal.aborted){
    logVoiceEvent("muse.fail","voice-recipe failed; draft kept",traceId);
    say("料理の解釈に失敗しました。保存していません。「解析を再試行」か補助入力で再開できます。");
   }
  }
 }
 function showReview(traceId=""){
  const d=draftRef.current;
  if(!d){say(dataTurns.current.length?(ja?"最新の入力を解釈中、または解釈に失敗しています。解析が終わるまで保存しません。":"The latest input is processing or failed. Saving is blocked until analysis finishes."):(ja?"新しいレシピを登録します。料理名・食材・分量・仕入単価を話してください。":"Describe the dish, ingredients, quantities and purchase prices."));return;}
  const mode=saveModeFor(d);
  if(!mode){
   say((ja?"まだ登録できません：":"Cannot save yet: ")+[...(!d.title.trim()?[ja?"料理名":"Recipe name"]:[]),...d.missing,...d.notes].join(ja?"、":", "));return;
  }
  reviewed.current=d;reviewMode.current=mode;approvalEpoch.current=voice.markReview();setStage("review");
  if(mode==="confirmed")
   say("確認用の下書きを表示しました。料理名・食材・数量・価格を確認し、正しければもう一度「保存してください」と話すか、承認して保存を押してください。");
  else
   say(ja?"仕入単価が不明の項目があります（"+priceMissingNames(d).join("、")+"）。数量は確定、価格は未確定として保存できます。価格を推測やゼロ埋めで補いません。よければもう一度「保存してください」と話すか、価格未確定として保存を押してください。":"Missing purchase prices: "+priceMissingNames(d).join(", ")+". Quantities are confirmed. You may explicitly approve saving with unconfirmed prices; no price will be guessed or set to zero.");
 }
 async function save(){
  const d=draftRef.current;
  const mode=reviewMode.current;
  if(phaseRef.current!=="review"||!d||!mode||reviewed.current!==d||saveModeFor(d)!==mode)return;
  voice.cancel();setStage("saving");if(!draining.current)setBusy(true);say("承認された内容を保存しています…");
  if(!requestId.current)requestId.current=crypto.randomUUID();
  try{
   const recipe=await request<Recipe>("/api/recipes/full",{method:"POST",body:JSON.stringify({request_id:requestId.current,title:d.title,materials:toSaveMaterials(d),selling_price_jpy:d.selling_price_jpy||null})});
   if(!alive.current)return;
   epoch.current++;revision.current++;inbox.current=[];
   dataTurns.current=[];setTurns([]);parsedTurns.current=0;parseBase.current=null;draftRef.current=null;reviewed.current=null;reviewMode.current=null;setDraft(null);requestId.current=null;setStage("dictating");
   // Spoken purchase sources travel with the save callback: the workspace
   // announces them after its browse transition (this panel hides then).
   const suppliers=[...new Set(d.materials.map(m=>(m.supplier||"").trim()).filter(Boolean))];
   say(mode==="confirmed"?(sharedVoice?"保存済みです。":"レシピを保存しました。"):"価格未確定として保存しました。未確定の仕入単価はゼロにせず、部分原価のみ表示されます。");onCreated(recipe,mode,suppliers);
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
     // Parse history is absolute: parsedTurns indexes this uncapped array,
     // so turns past #30 keep their context and incremental parsing resumes.
     // Only the on-screen transcript is capped (see enqueue).
     dataTurns.current=[...dataTurns.current,...batch.map(item=>item.text)];
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
   if(draftRef.current)parseBase.current=draftRef.current;
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
 function chooseName(index:number,name:string){
  const current=draftRef.current;
  if(!current||phaseRef.current==="saving")return;
  const entry=current.nameCorrections?.[index];
  if(!entry)return;
  const materialIndex=current.materials.findIndex(m=>m.name===entry.material_name);
  if(materialIndex<0)return;
  const previousName=current.materials[materialIndex].name;
  const materials=current.materials.map((m,i)=>i===materialIndex?{...m,name}:m);
  const missing=current.missing.map(text=>text.startsWith(previousName+"の仕入単価")?name+text.slice(previousName.length):text);
  const nameCorrections=current.nameCorrections?.filter((_,i)=>i!==index);
  // A price lookup for the old ingredient name cannot safely be carried over.
  const price_references=name===previousName?current.price_references:current.price_references?.filter(ref=>ref.material_name!==previousName);
  const provisional_prices=current.provisional_prices?.map((p,i)=>i===materialIndex&&name!==previousName?null:p);
  const research_status=name===previousName?current.research_status:current.research_status?.filter(item=>item.material_index!==materialIndex);
  const next={...current,materials,missing,nameCorrections,price_references,provisional_prices,research_status};
  draftRef.current=next;parseBase.current=next;setDraft(next);
  reviewed.current=null;reviewMode.current=null;requestId.current=null;setStage("dictating");setCorrectionIndex(null);
 }
 function adoptProvisional(index:number){
  const current=draftRef.current;
  if(!current||phaseRef.current==="saving"||busy)return;
  const candidate=current.provisional_prices?.[index];
  const material=current.materials[index];
  if(!candidate||!material||candidate.material_index!==index||candidate.material_name.trim()!==material.name.trim()||
     candidate.status!=="provisional"||candidate.approval!=="unapproved"||candidate.currency!=="JPY"||
     !["g","ml"].includes(candidate.price_unit)||candidate.price_quantity!=="1"||
     !validPrice.test(candidate.price_jpy)||Number(candidate.price_jpy)<=0||
     (material.price_jpy&&material.price_quantity&&material.price_unit))return;
  const materials=current.materials.map((m,i)=>i===index?{...m,price_jpy:candidate.price_jpy,price_quantity:candidate.price_quantity,price_unit:candidate.price_unit}:m);
  const missing=current.missing.filter(item=>item!==material.name+PRICE_SUFFIX);
  const next={...current,materials,missing};
  draftRef.current=next;parseBase.current=next;setDraft(next);
  reviewed.current=null;reviewMode.current=null;requestId.current=null;setStage("dictating");
  say(ja?"参考価格を下書きに採用しました。内容を確認してから保存してください。":"Reference price applied to the draft. Review before saving.");
 }
 const eligible=draftRef.current?saveModeFor(draftRef.current):null;
 return <section className="card" aria-label={ja?"音声レシピ一括登録":"Voice recipe registration"}>
  <h2>{ja?"音声でレシピを一括登録":"Full recipe by voice"}</h2>
  <details className="voice-help"><summary>{ja?"登録の使い方":"How to register"}</summary>
  <p>{ja?"料理名、食材、分量、仕入単価、売価を自然な言葉で伝えてください。料理の文脈を解釈し、変更案を下書きで確認できます。":"Describe the dish, ingredients, quantities, purchase prices and selling price naturally. Review the interpreted recipe as a draft."}</p>
  <p>{ja?"「内容を確認」「保存してください」などで確認へ進みます。確認後、もう一度の明示承認で保存します。キャンセルは下書きを破棄します。":"Ask to review the draft before saving. An explicit approval is required to save; discarding removes the draft."}</p>
  <p>{ja?"仕入単価だけが不明でも、確認後に価格未確定として保存できます（推測・ゼロ埋めしません）。確定保存と未確定保存は確認画面で区別されます。":"If only purchase prices are missing, you may approve saving with unconfirmed prices. Missing prices are never guessed or set to zero."}</p>
  <p>{ja?"音声はMetaへ送信して文字起こしします。録音は保存しません。発話の間を約1秒空けると解釈します。":"Audio is sent to Meta and not stored. Pause for about one second between turns."}</p>
  </details>
  {!sharedVoice&&<><button type="button" disabled={!voice.recording&&(voice.supported===false||voice.busy||phase==="saving")} onClick={voice.recording?voice.stop:()=>void voice.start()} aria-pressed={voice.recording}>{voice.recording?(ja?"■ マイクを停止":"■ Stop microphone"):(ja?"🎙 音声操作を開始":"🎙 Start voice control")}</button>
  <p aria-live="polite">{voice.recording?"聞き取り中… ":""}{voice.busy?"音声を文字にしています…":""}</p>
  {voice.error&&<p role="alert">{voice.error}</p>}
  {voice.supported===false&&<p>{ja?"音声入力を利用できません。補助入力を使用してください。":"Voice input is unavailable. Use manual input."}</p>}</>}
  <p aria-live="polite">{busy?"処理中：":""}{message}</p>
  {!sharedVoice&&<form onSubmit={event=>{event.preventDefault();if(manual.trim()){enqueue(manual);setManual("");}}}>
   <input aria-label={ja?"音声認識できない場合の入力":"Manual input when voice recognition is unavailable"} value={manual} onChange={event=>setManual(event.target.value)} placeholder={ja?"音声認識できないときの補助入力":"Type when voice recognition is unavailable"} disabled={phase==="saving"}/>
   <button type="submit" disabled={!manual.trim()||phase==="saving"}>{ja?"反映":"Apply"}</button>
  </form>}
  <button type="button" disabled={busy||!dataTurns.current.length||phase==="saving"} onClick={retry}>{ja?"解析を再試行":"Retry analysis"}</button>

  {draft&&<div id="draft" aria-label="未保存のレシピ下書き">
   <h3>{ja?"未保存の下書き：":"Unsaved draft: "}{draft.title||(ja?"料理名未設定":"Untitled recipe")}</h3>
   {draft.interpretations?.map((item,index)=><p key={index}>料理の文脈からの解釈案：{item.source} → {item.suggestion}（{item.reason}）</p>)}
   <p>{ja?"売価：":"Selling price: "}{draft.selling_price_jpy?("¥"+draft.selling_price_jpy):(ja?"未設定（売価なしでも保存できます）":"Not set (optional)")}</p>
   <ul>{draft.materials.map((material,index)=>{const priced=Boolean(material.price_jpy&&material.price_quantity&&material.price_unit);
    const provisional=draft.provisional_prices?.[index];
    const status=draft.research_status?.find(item=>item.material_index===index);
    const canApply=provisional&&provisional.material_index===index&&provisional.material_name.trim()===material.name.trim()&&
     provisional.currency==="JPY"&&provisional.price_quantity==="1"&&["g","ml"].includes(provisional.price_unit)&&
     validPrice.test(provisional.price_jpy)&&Number(provisional.price_jpy)>0;
    return <li key={index}>
     <div><strong>{material.name||(ja?"食材名不明":"Unnamed ingredient")}</strong> — {material.quantity||"?"}{material.unit}</div>
     <div>{priced?`${ja?"仕入単価":"Purchase price"} ¥${material.price_jpy} / ${material.price_quantity}${material.price_unit}`:(ja?"仕入単価 未確定":"Purchase price unconfirmed")}{material.supplier?` / ${ja?"仕入先":"Supplier"}: ${material.supplier}`:""}</div>
     {status&&<p className="muted" role="status">{researchLabel(status,ja)}</p>}
     {provisional&&canApply&&<div className="rounded-xl border border-current/20 p-3">
      <div><strong>{ja?"参考価格（仮設定候補）":"Provisional reference price"}</strong> — ¥{provisional.price_jpy} / {provisional.price_quantity}{provisional.price_unit}</div>
      <p className="muted">{provisional.origin==="external"?(ja?"Web検索":"Web research"):(ja?"仕入履歴":"Purchase ledger")} ・ {provisional.observation_count}{ja?"件のサンプル":" samples"}{provisional.fetched_at?` ・ ${provisional.fetched_at}`:""}</p>
      <p className="muted">{priced?(ja?"下書き価格に仮反映済み（保存前に内容を確認してください）":"Provisional price applied to draft; review before saving"):(ja?"参考価格を確認して採用できます":"Review and apply this reference price")}</p>
      {!priced&&<button type="button" disabled={busy||phase==="saving"} onClick={()=>adoptProvisional(index)}>{ja?"参考価格を下書きに採用":"Apply reference price to draft"}</button>}
      {provisional.sources?.length>0&&<details><summary>{ja?"価格の出典":"Price sources"}</summary><ul>{provisional.sources.map((source,i)=>sourceUrl(source.url)?<li key={i}><a href={sourceUrl(source.url)!} target="_blank" rel="noopener noreferrer">{source.title||source.url}</a></li>:null)}</ul></details>}
     </div>}
    </li>;})}</ul>
   {draft.nameCorrections?.map((entry,index)=><div key={index} className="name-correction-row">
    <span>{ja?"食材名の補正候補":"Ingredient name suggestion"}: {entry.material_name}</span>
    <button type="button" disabled={busy||phase==="saving"} onClick={()=>setCorrectionIndex(index)}>{ja?"候補を選択":"Choose name"}</button>
   </div>)}
   {correctionIndex!==null&&draft.nameCorrections?.[correctionIndex]&&<div className="name-choice-overlay" onClick={()=>setCorrectionIndex(null)}>
    <section role="dialog" aria-modal="true" aria-label={ja?"食材名を選択":"Choose ingredient name"} className="name-choice-dialog" onClick={e=>e.stopPropagation()}>
     <h4>{ja?"食材名を選択":"Choose ingredient name"}</h4>
     <p>{ja?"音声認識結果とAIの候補を比較してください。":"Compare the recognized phrase with AI suggestions."}</p>
     <div className="name-choice-options">
      <button type="button" onClick={()=>chooseName(correctionIndex,draft.nameCorrections![correctionIndex].heard||draft.nameCorrections![correctionIndex].material_name)}>{ja?"音声認識の原文":"Original recognition"}: {draft.nameCorrections[correctionIndex].heard||draft.nameCorrections[correctionIndex].material_name}</button>
      {draft.nameCorrections[correctionIndex].candidates.map((c,i)=><button key={i} type="button" onClick={()=>chooseName(correctionIndex,c.name)}>{ja?`候補${i+1}`:`Suggestion ${i+1}`}: {c.name}<small>{c.reason}</small></button>)}
     </div>
     <button type="button" onClick={()=>setCorrectionIndex(null)}>{ja?"閉じる":"Close"}</button>
    </section>
   </div>}
   {Boolean(draft.price_references?.length)&&<section className="rounded-xl border border-current/20 p-3" aria-label={ja?"参考価格の調査結果":"Reference price research"}>
    <h4>{ja?"参考価格（未確定）":"Reference prices (unconfirmed)"}</h4>
    <ul>{draft.price_references?.map((ref,index)=><li key={`${ref.material_name}-${index}`}>
     <strong>{ref.material_name}</strong>{ref.ingredient_name&&ref.ingredient_name!==ref.material_name?` — ${ref.ingredient_name}`:""}
     <p>{ref.text}</p>
     {ref.origin&&<p className="muted">{ref.origin==="external"?(ja?"Web調査による参考情報":"Web research reference"):(ja?"仕入台帳の履歴":"Purchase ledger history")}</p>}
     {ref.origin==="external"&&ref.fetched_at&&<p className="muted">{ja?"調査日時":"Researched at"}: {ref.fetched_at}</p>}
     {ref.origin==="external"&&Boolean(ref.sources?.length)&&<ul>{ref.sources?.filter(source=>{try{return new URL(source.url).protocol==="https:";}catch{return false;}}).map((source,i)=><li key={`${source.url}-${i}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title||source.url}</a></li>)}</ul>}
    </li>)}</ul>
    <p className="muted">{ja?"参考価格を取得できた食材は下書き価格へ仮反映しています。価格と出典を確認してからレシピ全体の保存を承認してください。":"Found reference prices are provisionally applied to draft lines. Review prices and sources before approving recipe save."}</p>
   </section>}
   {draft.missing.length>0&&<p role="alert">不足情報：{draft.missing.join("、")}</p>}
   {draft.notes.length>0&&<p role="alert">要確認：{draft.notes.join("、")}</p>}
   <p>{phase==="review"?(reviewMode.current==="unconfirmed"?(ja?"確認待ち（価格未確定）：数量は確定、価格は未確定として保存します。よければ明示承認してください。":"Pending review: quantities are confirmed, but purchase prices are unconfirmed. Explicitly approve to save."):(ja?"確認待ち：内容が正しければ、保存を明示承認してください。":"Pending review: explicitly approve saving if the details are correct.")):(ja?"まだ保存されていません。":"Not saved yet.")}</p>
   {sharedVoice&&<><p role="status">{sharedVoice.captureMessage}</p><a href="#voice-controls">音声操作・再開へ戻る</a></>}
   <button type="button" disabled={busy||!eligible||phase==="saving"} onClick={()=>showReview()}>{ja?"内容を確認":"Review draft"}</button>
   <button type="button" disabled={busy||phase!=="review"||!eligible} onClick={()=>void save()}>{phase==="review"&&reviewMode.current==="unconfirmed"?(ja?"価格未確定として承認して保存":"Approve & save with unconfirmed prices"):(ja?"内容を承認して保存":"Approve & save")}</button>
   <button type="button" disabled={phase==="saving"} onClick={clear}>{ja?"下書きを破棄":"Discard draft"}</button>
  </div>}
  <details className="voice-transcript"><summary>{ja?"認識した発話":"Recognized utterances"}（{turns.length}{ja?"件":" turns"}）</summary>{turns.length>0?<ol aria-label={ja?"認識した発話の一覧":"Recognized utterances"}>{[...turns].reverse().map((turn,index)=><li key={`${turns.length-index}`}>{turn}</li>)}</ol>:<p>{ja?"まだ発話はありません。":"No utterances yet."}</p>}</details>
 </section>;
}
