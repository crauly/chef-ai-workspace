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
type PriceReference={material_name:string;material_index?:number;status:string;origin?:"ledger"|"external";ingredient_name?:string;currency?:string;unit_basis?:string;average_unit_price?:string;observation_count?:number;observed_to?:string|null;sources?:{url:string;title:string}[];fetched_at?:string;text:string};
type ProvisionalPrice={material_index:number;material_name:string;origin:"ledger"|"external";price_jpy:string;price_quantity:string;price_unit:string;currency:string;observation_count:number;sources:{url:string;title:string}[];samples?:{name:string;seller:string;amount:string;package:string;url?:string}[];fetched_at:string|null;status:"provisional";approval:"unapproved";text:string};
type ResearchStatus={material_name:string;material_index:number;request:string;trigger:"muse"|"heuristic";ledger:string;web:"not_attempted"|"available"|"empty"|"not_searched"|"provider_error"|"timeout"|"misconfigured";provisional:boolean};
type PendingResearch={material_name:string;material_index:number;row_name?:string|null;request:string;trigger:"muse"|"heuristic"};
type Draft={research_state?:"deferred"|"complete";pending_research?:PendingResearch[];title:string;materials:Ingredient[];selling_price_jpy:string;notes:string[];missing:string[];interpretations?:Interpretation[];price_references?:PriceReference[];provisional_prices?:Array<ProvisionalPrice|null>;research_status?:ResearchStatus[];nameCorrections?:NameCorrection[]};
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
 const [priceDetailIndex,setPriceDetailIndex]=useState<number|null>(null);
 const [unmatchedDetailIndex,setUnmatchedDetailIndex]=useState<number|null>(null);
 const [priceLoading,setPriceLoading]=useState(false);
 const dataTurns=useRef<string[]>([]),draftRef=useRef<Draft|null>(null),reviewed=useRef<Draft|null>(null);
 const phaseRef=useRef<"dictating"|"review"|"saving">("dictating");
 const approvalEpoch=useRef(0);
 const reviewMode=useRef<SaveMode|null>(null);
 const inbox=useRef<Input[]>([]),draining=useRef(false),revision=useRef(0),epoch=useRef(0);
 const requestId=useRef<string|null>(null),semanticAbort=useRef<AbortController|null>(null),priceAbort=useRef<AbortController|null>(null),priceEpoch=useRef(0),alive=useRef(true);
 const priceFlight=useRef<{key:string;rows:string[]} | null>(null);
 type DonePrices=Pick<Draft,"price_references"|"research_status"|"provisional_prices"|"research_state">;
 // Completed searches: fullKey -> response. A repeated identical request
 // reuses the cached result instead of refetching, so it can never leave
 // the row stuck in pending with no flight. Row names are part of the key,
 // so renamed/reordered rows always miss and search fresh.
 const priceDone=useRef<Map<string,DonePrices>>(new Map());
 type StashedPrices={key:string;rows:string[];response:DonePrices};
 const priceStash=useRef<StashedPrices | null>(null);
 const clearTrace=useRef("");
 const capture=useVoiceCapture(locale,enqueue,true);
 const voice={...capture,...sharedVoice};
 useImperativeHandle(control,()=>({submit:enqueue,hasPending:()=>Boolean(dataTurns.current.length||inbox.current.length||draftRef.current),isSaving:()=>phaseRef.current==="saving",requestReview:()=>{showReview();},suspend:()=>{
  reviewed.current=null;inbox.current=inbox.current.filter(input=>input.command==="data");setStage("dictating");
 }}));
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;semanticAbort.current?.abort();priceAbort.current?.abort();inbox.current=[];};},[]);
 function setStage(next:"dictating"|"review"|"saving"){phaseRef.current=next;setPhase(next);}
 const englishMessages:Record<string,string>={"下書きを破棄しました。新しいレシピを話してください。":"Draft discarded. Describe a new recipe.","Museが料理の文脈・数量・価格を解釈しています…":"Muse is interpreting the dish, quantities and prices…","料理の解釈に失敗しました。保存していません。「解析を再試行」か補助入力で再開できます。":"Could not interpret the recipe. Nothing was saved. Retry analysis or use manual input.","確認用の下書きを表示しました。料理名・食材・数量・価格を確認し、正しければもう一度「保存してください」と話すか、承認して保存を押してください。":"Draft ready to review. Check the dish, ingredients, quantities and prices, then explicitly approve saving.","承認された内容を保存しています…":"Saving approved recipe…","保存済みです。":"Already saved.","レシピを保存しました。":"Recipe saved.","価格未確定として保存しました。未確定の仕入単価はゼロにせず、部分原価のみ表示されます。":"Saved with unconfirmed purchase prices. Unknown prices are not set to zero; only partial costs are shown.","保存結果を確認できませんでした。再送時も同じ登録IDを使います。一覧を確認してから再試行してください。":"Could not confirm the save result. The same request ID is used for retries; check the recipe list first.","保存せず、下書きを保持します。":"Not saved. Draft preserved."};
 function say(text:string){if(alive.current)setMessage(ja?text:(englishMessages[text]??text));}
 function clear(){
  if(phaseRef.current==="saving")return;
  epoch.current++;revision.current++;semanticAbort.current?.abort();priceAbort.current?.abort();priceEpoch.current++;priceFlight.current=null;priceStash.current=null;priceDone.current.clear();setPriceLoading(false);voice.cancel();inbox.current=[];
  setCorrectionIndex(null);setPriceDetailIndex(null);setUnmatchedDetailIndex(null);dataTurns.current=[];setTurns([]);parsedTurns.current=0;parseBase.current=null;draftRef.current=null;reviewed.current=null;reviewMode.current=null;setDraft(null);requestId.current=null;
  setStage("dictating");logVoiceEvent("draft.discarded.explicit","explicit cancel",clearTrace.current);clearTrace.current="";onDiscarded?.();say("下書きを破棄しました。新しいレシピを話してください。");
 }
 const parsedTurns=useRef(0);
 // Last successfully parsed draft. enqueue() clears the live draftRef on new
 // dictation (approval can never commit it), but parseBase survives as Muse
 // revision context so follow-ups resend only unparsed turns, not history.
 const parseBase=useRef<Draft|null>(null);
 function researchKey(entries:PendingResearch[]):string{
  return [...entries].map(e=>`${e.material_name.trim()}|${e.material_index}|${e.row_name??""}|${e.request}`).sort().join(";");
 }
 function rowNamesOf(draft:Draft):string[]{
  return draft.materials.map(m=>m.name.trim());
 }
 function flightMatches(flight:{key:string;rows:string[]},entries:PendingResearch[],draft:Draft):boolean{
  if(flight.key!==researchKey(entries))return false;
  const rows=rowNamesOf(draft);
  // Every in-flight row must still exist by name+index; otherwise the
  // request condition changed and the result must not be carried over.
  return flight.rows.every((name,index)=>rows[index]===name);
 }
 async function parse(next:string[],version:number,traceId=""){
  const current=epoch.current,aborter=new AbortController();semanticAbort.current=aborter;
  // Incremental revision: resend only turns not yet parsed, with the last
  // successfully parsed draft as context, instead of reprocessing history.
  const previous=parseBase.current;
  const fresh=next.slice(parsedTurns.current);
  const turnsToSend=fresh.length?fresh:next.slice(-30);
  const usePrevious=previous&&fresh.length?previous:null;
  logVoiceEvent("muse.start",`${turnsToSend.length} new turns${usePrevious?"+draft":""}`,traceId);say(ja?"レシピを解析中です。価格調査を依頼した場合は続けて検索します…":"Interpreting recipe and checking requested prices…");
  try{
   const out=await request<Draft>("/api/voice-recipe",{method:"POST",body:JSON.stringify(usePrevious?{turns:turnsToSend,previous:usePrevious,defer_prices:true}:{turns:next,defer_prices:true}),signal:aborter.signal});
   parsedTurns.current=next.length;
   if(!alive.current||epoch.current!==current||revision.current!==version){logVoiceEvent("muse.ok","stale result ignored",traceId);return;}
   const enriched=applyFoundPrices(out);
   parseBase.current=enriched;
   logVoiceEvent(draftRef.current?"draft.updated":"draft.created", "voice-recipe",traceId);
   setCorrectionIndex(null);setPriceDetailIndex(null);setUnmatchedDetailIndex(null);draftRef.current=enriched;setDraft(enriched);reviewed.current=null;reviewMode.current=null;requestId.current=null;setStage("dictating");
   const pending=enriched.pending_research??[];
   if(out.research_state==="deferred"&&pending.length){
    const key=researchKey(pending);
    const rows=rowNamesOf(enriched);
    const stash=priceStash.current;
    if(stash&&stash.key===key&&stash.rows.every((name,index)=>rows[index]===name)){
     // A search that finished while this parse was in flight: apply it
     // without refetching, so the result is neither lost nor duplicated.
     const merged=applyFoundPrices({...enriched,...stash.response,pending_research:[]});
     priceStash.current=null;priceFlight.current=null;priceAbort.current=null;setPriceLoading(false);
     priceDone.current.set(key+"@"+rows.join("|"),stash.response);
     draftRef.current=merged;parseBase.current=merged;setDraft(merged);
     reviewed.current=null;reviewMode.current=null;requestId.current=null;setStage("dictating");
     logVoiceEvent("price.ok","stashed research applied",traceId);
    }else{
     priceStash.current=null;
     const fullKey=key+"@"+rows.join("|");
     const cached=priceDone.current.get(fullKey);
     const flight=priceFlight.current;
     if(cached){
      // Identical request already completed: reapply the cached result so
      // the row is never left pending with no search running.
      const merged=applyFoundPrices({...enriched,...cached,pending_research:[]});
      draftRef.current=merged;parseBase.current=merged;setDraft(merged);
      reviewed.current=null;reviewMode.current=null;requestId.current=null;setStage("dictating");
      logVoiceEvent("price.ok","cached research reapplied",traceId);
     }else if(flight&&flightMatches(flight,pending,enriched)&&priceAbort.current&&!priceAbort.current.signal.aborted){
      // Unchanged ingredients: keep the running search, rebase its guard to
      // the new draft so the result is merged instead of dropped.
      priceFlight.current={key:flight.key,rows};
      draftRef.current=enriched;parseBase.current=enriched;setDraft(enriched);
     }else{
      // New/changed condition: stop the stale search, start only what is new.
      priceAbort.current?.abort();priceFlight.current=null;
      draftRef.current=enriched;parseBase.current=enriched;setDraft(enriched);
      void enrichPrices(enriched,version,current,traceId);
     }
    }
   }else{
    // No pending research: terminate any previous flight so unneeded prices
    // can never land on this draft. Stale stash is discarded with it.
    priceAbort.current?.abort();priceAbort.current=null;
    priceFlight.current=null;priceStash.current=null;setPriceLoading(false);
   }
   say(enriched.missing.length||enriched.notes.length?(ja?"確認が必要です："+[...enriched.missing,...enriched.notes].join("、"):"Needs review: "+[...enriched.missing,...enriched.notes].join(", ")):
    (ja?"下書きを更新しました。内容を確認し、「保存してください」と話すか、確認ボタンを押してください。":"Draft updated. Review it, then explicitly approve saving."));
  }catch{
   if(alive.current&&epoch.current===current&&revision.current===version&&!aborter.signal.aborted){
    logVoiceEvent("muse.fail","voice-recipe failed; draft kept",traceId);
    say("料理の解釈に失敗しました。保存していません。「解析を再試行」か補助入力で再開できます。");
    const stash=priceStash.current;
    const candidate=draftRef.current ?? parseBase.current;
    if(stash&&candidate&&researchKey(candidate.pending_research??[])===stash.key&&
       stash.rows.every((name,index)=>rowNamesOf(candidate)[index]===name)){
     const merged=applyFoundPrices({...candidate,...stash.response,pending_research:[]});
     priceDone.current.set(stash.key+"@"+rowNamesOf(candidate).join("|"),stash.response);
     draftRef.current=merged;parseBase.current=merged;setDraft(merged);
     reviewed.current=null;reviewMode.current=null;requestId.current=null;setStage("dictating");
     logVoiceEvent("price.ok","stashed research applied after parse failure",traceId);
    }
    if(stash||!(priceAbort.current&&!priceAbort.current.signal.aborted)){
     // Clear only a finished flight/stash. A still-running search keeps its
     // own flight and loading flag; its completion path owns the outcome.
     priceStash.current=null;priceFlight.current=null;priceAbort.current=null;setPriceLoading(false);
    }
   }
  }
 }
 async function enrichPrices(base:Draft,version:number,requestEpoch:number,traceId:string){
  const entries=base.pending_research??[];
  if(!entries.length)return;
  const key=researchKey(entries);
  const rows=rowNamesOf(base);
  const sequence=++priceEpoch.current;
  priceAbort.current?.abort();
  const controller=new AbortController();priceAbort.current=controller;
  priceFlight.current={key,rows};
  setPriceLoading(true);
  logVoiceEvent("price.start",`${entries.length} entries`,traceId);
  let stashed=false;
  try{
   const response=await request<Pick<Draft,"price_references"|"research_status"|"provisional_prices"|"research_state">>("/api/voice-recipe/prices",{
    method:"POST",body:JSON.stringify({materials:base.materials,entries:entries.map(e=>({...e,material_index:e.material_index===-1?null:e.material_index}))}),signal:controller.signal});
   if(!alive.current||controller.signal.aborted||priceEpoch.current!==sequence||epoch.current!==requestEpoch)return;
   if(phaseRef.current==="saving")return;
   // Merge onto the latest draft when the searched rows are unchanged;
   // never apply a stale result to a renamed/reordered/deleted row.
   // A null live draft with a newer revision means a follow-up parse owns
   // enrichment now: stash the response so parse() applies it without
   // refetching, instead of dropping the result and searching twice.
   const current=draftRef.current ?? (revision.current===version?base:null);
   if(!current){
    if(revision.current!==version&&draftRef.current===null){
     priceStash.current={key,rows,response};stashed=true;
     logVoiceEvent("price.ok","research finished during parse; stashed",traceId);
    }else return;
   }else{
    const flight=priceFlight.current;
    const currentRows=rowNamesOf(current);
    const rowsKept=rows.every((name,index)=>currentRows[index]===name);
    if(!rowsKept)return;
    if(flight&&flight.key===key){
     priceFlight.current={key,rows:currentRows};
    }
    const merged=applyFoundPrices({...current,...response,pending_research:[]});
    priceDone.current.set(key+"@"+currentRows.join("|"),response);
    draftRef.current=merged;parseBase.current=merged;setDraft(merged);
    reviewed.current=null;reviewMode.current=null;requestId.current=null;
    setStage("dictating");logVoiceEvent("price.ok","research returned",traceId);
   }
  }catch{
   if(alive.current&&!controller.signal.aborted&&priceEpoch.current===sequence&&
      epoch.current===requestEpoch&&phaseRef.current!=="saving"){
    const current=draftRef.current ?? (revision.current===version?base:null);
    if(!current){
     if(!(revision.current!==version&&draftRef.current===null))return;
     // A follow-up parse is in flight: leave the outcome to it instead of
     // publishing a failure over a draft that no longer exists.
     return;
    }
    // Never stamp a stale failure over a newer pending condition; the fresh
    // search owns the current rows.
    if(researchKey(current.pending_research??[])!==key)return;
    const fallback={...current,research_state:"complete" as const,pending_research:[],
      research_status:entries.map(e=>({...e,ledger:"unavailable",web:"provider_error" as const,provisional:false}))};
    draftRef.current=fallback;parseBase.current=fallback;setDraft(fallback);
    // The approved content changed, so the old approval must not survive:
    // same invalidation as the success path, otherwise save() would
    // silently no-op with the approval button still enabled.
    reviewed.current=null;reviewMode.current=null;requestId.current=null;
    setStage("dictating");
    logVoiceEvent("price.fail","price research failed; draft retained",traceId);
   }
  }finally{
   if(stashed)return;
   if(alive.current&&priceEpoch.current===sequence){setPriceLoading(false);priceAbort.current=null;priceFlight.current=null;}
  }
 }
 function showReview(traceId=""){
  if(priceLoading){say(ja?"価格調査中ですが、下書きの確認は先にできます。検索結果は確定後に反映されます。":"Price research is running; you can still review the draft now.")} 
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
   priceAbort.current?.abort();priceAbort.current=null;priceFlight.current=null;priceStash.current=null;priceDone.current.clear();setPriceLoading(false);
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
   // Keep a running price search alive across follow-up utterances; parse()
   // adopts it when the searched rows are unchanged, or restarts it when the
   // condition changed. Never abort here (avoids cancelling unchanged rows).
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
  priceAbort.current?.abort();priceAbort.current=null;priceEpoch.current++;priceFlight.current=null;priceStash.current=null;setPriceLoading(false);
  const materials=current.materials.map((m,i)=>i===materialIndex?{...m,name}:m);
  const missing=current.missing.map(text=>text.startsWith(previousName+"の仕入単価")?name+text.slice(previousName.length):text);
  const nameCorrections=current.nameCorrections?.filter((_,i)=>i!==index);
  // A price lookup for the old ingredient name cannot safely be carried over.
  const price_references=name===previousName?current.price_references:current.price_references?.filter(ref=>ref.material_name!==previousName);
  const provisional_prices=current.provisional_prices?.map((p,i)=>i===materialIndex&&name!==previousName?null:p);
  const research_status=name===previousName?current.research_status:current.research_status?.filter(item=>item.material_index!==materialIndex);
  const pending_research=current.pending_research?.filter(item=>name===previousName||item.material_index!==materialIndex)??[];
  const next={...current,materials,missing,nameCorrections,price_references,provisional_prices,research_status,pending_research};
  setPriceDetailIndex(null);setUnmatchedDetailIndex(null);
  draftRef.current=next;parseBase.current=next;setDraft(next);
  reviewed.current=null;reviewMode.current=null;requestId.current=null;setStage("dictating");setCorrectionIndex(null);
  if(pending_research.length)void enrichPrices(next,revision.current,epoch.current,"");
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
  <p aria-live="polite" role="status">{busy?(ja?"処理中 ⏳ ":"Working ⏳ "):""}{message}</p>
  {!sharedVoice&&<form onSubmit={event=>{event.preventDefault();if(manual.trim()){enqueue(manual);setManual("");}}}>
   <input aria-label={ja?"音声認識できない場合の入力":"Manual input when voice recognition is unavailable"} value={manual} onChange={event=>setManual(event.target.value)} placeholder={ja?"音声認識できないときの補助入力":"Type when voice recognition is unavailable"} disabled={phase==="saving"}/>
   <button type="submit" disabled={!manual.trim()||phase==="saving"}>{ja?"反映":"Apply"}</button>
  </form>}
  <button type="button" disabled={busy||!dataTurns.current.length||phase==="saving"} onClick={retry}>{ja?"解析を再試行":"Retry analysis"}</button>

  {draft&&<div id="draft" aria-label="未保存のレシピ下書き">
   {priceLoading&&<p role="status" aria-live="polite">{ja?"価格を検索しています… 下書きは先に確認できます。":"Searching prices… You can inspect the draft now."}</p>}
   {!priceLoading&&(draft.research_status?.length??0)>0&&(()=>{
    const hasResult=(draft.provisional_prices?.some(Boolean)??false)||(draft.research_status?.some(item=>item.provisional)??false);
    return <p role="status" aria-live="polite">{hasResult?(ja?"検索結果を取得しました。価格の詳細・出典で内容を確認できます。":"Search results ready. Check price details and sources."):(ja?"価格を確認できませんでした。下書きは保持しています。":"Could not confirm prices. The draft is kept.")}</p>;
   })()}
   <h3>{ja?"未保存の下書き：":"Unsaved draft: "}{draft.title||(ja?"料理名未設定":"Untitled recipe")}</h3>
   {draft.interpretations?.map((item,index)=><p key={index}>料理の文脈からの解釈案：{item.source} → {item.suggestion}（{item.reason}）</p>)}
   <p>{ja?"売価：":"Selling price: "}{draft.selling_price_jpy?("¥"+draft.selling_price_jpy):(ja?"未設定（売価なしでも保存できます）":"Not set (optional)")}</p>
   <ul>{draft.materials.map((material,index)=>{
    const priced=Boolean(material.price_jpy&&material.price_quantity&&material.price_unit);
    const provisional=draft.provisional_prices?.[index];
    const status=draft.research_status?.find(item=>item.material_index===index);
    const pending=draft.pending_research?.some(item=>item.material_index===index);
    const reference=draft.price_references?.find(ref=>ref.material_index===index);
    const canApply=provisional&&provisional.material_index===index&&provisional.material_name.trim()===material.name.trim()&&
      provisional.currency==="JPY"&&provisional.price_quantity==="1"&&["g","ml"].includes(provisional.price_unit)&&
      validPrice.test(provisional.price_jpy)&&Number(provisional.price_jpy)>0;
    const single=provisional?.observation_count===1&&provisional.samples?.length===1?provisional.samples[0]:null;
    const quotedPackage=Boolean(single&&validPrice.test(single.amount)&&/^\d+(?:\.\d+)?(?:g|kg|ml|L)$/.test(single.package)&&provisional?.currency==="JPY");
    return <li key={index}>
      <div><strong>{material.name||(ja?"食材名不明":"Unnamed ingredient")}</strong> — {material.quantity||"?"}{material.unit}</div>
      <div>{priced?(ja?"仕入価格 ":"Purchase price "):ja?"仕入価格 未設定":"Purchase price unavailable"}
       {priced&&(quotedPackage&&single? ` ¥${Number(single.amount).toLocaleString("ja-JP")} / ${single.package}`:` ¥${material.price_jpy} / ${material.price_quantity}${material.price_unit}`)}
      </div>
      {priced&&canApply&&<p className="muted">{ja?"参考価格を使用":"Using researched price"} ・ ¥{provisional.price_jpy}/{provisional.price_unit}</p>}
      {material.supplier&&<p className="muted">{ja?"仕入先":"Supplier"}: {material.supplier}</p>}
      {pending&&<p className="muted" role="status">{ja?"価格を調査中…":"Researching price…"}</p>}
      {status&&<p className="muted" role="status">{researchLabel(status,ja)}</p>}
      {(status||reference||canApply)&&<button type="button" onClick={()=>setPriceDetailIndex(index)} disabled={phase==="saving"}>{ja?"価格の詳細・出典":"Price details & sources"}</button>}
      {!priced&&canApply&&<button type="button" onClick={()=>adoptProvisional(index)} disabled={busy||phase==="saving"}>{ja?"この価格を使う":"Use this price"}</button>}
    </li>;
   })}</ul>
   {priceDetailIndex!==null&&(()=>{
    const idx=priceDetailIndex,material=draft.materials[idx];
    const provisional=draft.provisional_prices?.[idx];
    const status=draft.research_status?.find(item=>item.material_index===idx);
    const reference=draft.price_references?.find(ref=>ref.material_index===idx);
    if(!material)return null;
    const sources=provisional?.sources??reference?.sources??[];
    return <div className="name-choice-overlay" onClick={()=>setPriceDetailIndex(null)}>
      <section role="dialog" aria-modal="true" aria-label={ja?"価格の調査結果":"Price research results"} className="name-choice-dialog" onClick={event=>event.stopPropagation()}>
       <h4>{ja?"価格の調査結果":"Price research results"} — {material.name}</h4>
       {status&&<p>{researchLabel(status,ja)}</p>}
       {provisional&&<p><strong>{provisional.currency==="JPY"?"¥":provisional.currency+" "}{provisional.price_jpy} / {provisional.price_unit}</strong> ・ {provisional.observation_count}{ja?"件の価格を比較":" comparable offers"}</p>}
       {provisional?.samples?.length?<ul>{provisional.samples.map((sample,i)=><li key={i}>{sample.seller}: {provisional.currency==="JPY"?"¥":provisional.currency+" "}{sample.amount} / {sample.package} {sample.url&&sourceUrl(sample.url)&&<a href={sourceUrl(sample.url)!} target="_blank" rel="noopener noreferrer">{ja?"販売ページ":"Seller"}</a>}</li>)}</ul>:null}
       {reference&&<p>{reference.text}</p>}
       {provisional?.fetched_at&&<p className="muted">{ja?"調査日時":"Researched at"}: {provisional.fetched_at}</p>}
       {sources.length>0&&<details><summary>{ja?"出典リンク":"Sources"}</summary><ul>{sources.map((source,i)=>sourceUrl(source.url)?<li key={i}><a href={sourceUrl(source.url)!} target="_blank" rel="noopener noreferrer">{source.title||source.url}</a></li>:null)}</ul></details>}
       <button type="button" onClick={()=>setPriceDetailIndex(null)}>{ja?"閉じる":"Close"}</button>
      </section>
    </div>;
   })()}
   {Boolean(draft.price_references?.some(ref=>ref.material_index===-1))&&<details>
    <summary>{ja?"食材に紐づいていない調査結果":"Unmatched research results"}</summary>
    <ul>{draft.price_references?.map((ref,index)=>ref.material_index===-1?<li key={index}>
     <span>{ref.material_name}</span> <button type="button" onClick={()=>setUnmatchedDetailIndex(index)}>{ja?"調査結果を見る":"View research"}</button>
    </li>:null)}</ul>
   </details>}
   {unmatchedDetailIndex!==null&&(()=>{
    const ref=draft.price_references?.[unmatchedDetailIndex];
    if(!ref||ref.material_index!==-1)return null;
    const state=draft.research_status?.find(item=>item.material_index===-1&&item.material_name===ref.material_name);
    return <div className="name-choice-overlay" onClick={()=>setUnmatchedDetailIndex(null)}>
     <section role="dialog" aria-modal="true" aria-label={ja?"未対応の価格調査":"Unmatched price research"} className="name-choice-dialog" onClick={event=>event.stopPropagation()}>
      <h4>{ref.material_name}</h4>
      {state&&<p>{researchLabel(state,ja)}</p>}
      <p>{ref.text}</p>
      {ref.fetched_at&&<p className="muted">{ja?"調査日時":"Researched at"}: {ref.fetched_at}</p>}
      {ref.sources?.length? <ul>{ref.sources.map((source,i)=>sourceUrl(source.url)?<li key={i}><a href={sourceUrl(source.url)!} target="_blank" rel="noopener noreferrer">{source.title||source.url}</a></li>:null)}</ul>:null}
      <button type="button" onClick={()=>setUnmatchedDetailIndex(null)}>{ja?"閉じる":"Close"}</button>
     </section>
    </div>;
   })()}
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
