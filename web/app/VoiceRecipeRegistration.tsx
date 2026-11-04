"use client";
import {draftNumber,registrationIssues,type DraftIssue} from "../recipe-draft-parse";
import MasterMatchReview,{type MasterMatch} from "./MasterMatchReview";
import {useEffect,useImperativeHandle,useRef,useState,type Ref} from "react";
import {useVoiceProcessingStatus,type VoiceStatusRow} from "./VoiceProcessingStatus";
import type {Locale} from "./i18n";
import {request,type Recipe} from "./types";
import {useVoiceCapture,type VoiceCaptureMeta} from "./useVoiceCapture";
import {voiceCommand,type VoiceCommand} from "./voice-commands";
import {logVoiceEvent} from "./voice-diagnostics";
import {dishImagePrompt,isAbortError,dishCompletionKept} from "./dish-image";
import {storeDishPreview} from "./dish-image-cache";
import {prepareRecipeTurns} from "../recipe-turns";
import {loadWorkingDraft,saveWorkingDraft,type WorkingDraftSnapshot} from "./working-draft-cache";

type Ingredient={name:string;quantity:string;unit:string;price_jpy:string;price_quantity:string;price_unit:string;supplier:string};
type Interpretation={source:string;suggestion:string;reason:string};
type NameCorrection={material_name:string;heard:string;candidates:{name:string;reason:string}[]};
type PriceReference={material_name:string;material_index?:number;status:string;origin?:"ledger"|"external";ingredient_name?:string;currency?:string;unit_basis?:string;average_unit_price?:string;observation_count?:number;observed_to?:string|null;sources?:{url:string;title:string}[];fetched_at?:string;text:string};
type ProvisionalPrice={auto_apply?:boolean;material_index:number;material_name:string;origin:"ledger"|"external";price_jpy:string;price_quantity:string;price_unit:string;currency:string;observation_count:number;sources:{url:string;title:string}[];samples?:{name:string;seller:string;amount:string;package:string;url?:string}[];fetched_at:string|null;status:"provisional";approval:"unapproved";text:string};
type ResearchStatus={material_name:string;material_index:number;request:string;trigger:"muse"|"heuristic";ledger:string;web:"not_attempted"|"available"|"empty"|"not_searched"|"provider_error"|"timeout"|"misconfigured";provisional:boolean};
type PendingResearch={material_name:string;material_index:number;row_name?:string|null;request:string;trigger:"muse"|"heuristic"};
type UnitProposal={symbol:string;dimension:"mass"|"volume"|"count"|"other"};
type Draft={unitProposals?:UnitProposal[];research_state?:"deferred"|"complete";pending_research?:PendingResearch[];title:string;materials:Ingredient[];selling_price_jpy:string;notes:string[];missing:string[];interpretations?:Interpretation[];price_references?:PriceReference[];provisional_prices?:Array<ProvisionalPrice|null>;research_status?:ResearchStatus[];nameCorrections?:NameCorrection[]};
const standardDimension=(symbol:string)=>({g:"mass",kg:"mass",mg:"mass",ml:"volume",l:"volume"} as Record<string,string>)[symbol.toLowerCase()]??"";
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
type Input={text:string;command:VoiceCommand;revision:number;captureEpoch:number;manual:boolean;staleVoice:boolean;traceId:string};
export type SaveMode="confirmed"|"unconfirmed";
// Identity is required. Optional use quantities and purchase facts may remain
// unresolved; completeness never substitutes for explicit human approval.
const PRICE_SUFFIX="の仕入単価・基準数量・単位";
export function saveModeFor(draft:Draft):SaveMode|null{
 // Named materials are required. An empty title gets a display placeholder
 // on save; unknown quantities and prices stay unresolved.
 if(draft.materials.some(m=>!m.name.trim()))return null;
 return !draft.title.trim()||registrationIssues(draft).length||draft.missing.length||draft.notes.length||
   draft.materials.some(m=>!m.quantity||!m.unit||!m.price_jpy||!m.price_quantity||!m.price_unit)
   ?"unconfirmed":"confirmed";
}
export function priceMissingNames(draft:Draft):string[]{
 const names=new Set<string>();
 draft.materials.forEach((m,i)=>{
  if(!(m.price_jpy&&m.price_quantity&&m.price_unit))
   names.add(m.name.trim()||`食材${i+1}`);
 });
 return [...names];
}
// Explicit approval projects the complete supplier name with the existing
// all-or-nothing price trio. Supplier/offer identity is resolved atomically
// on the server; the model never chooses owner IDs or adopts before this gate.
// Block 3 (dish image) pure helpers live in ./dish-image (shared with the
// saved-recipe detail section). Re-exported here so existing imports keep
// working; the generated image stays a preview, never recipe evidence.
export {dishImagePrompt,isAbortError,dishCompletionKept} from "./dish-image";
export function toSaveMaterials(draft:Draft){
 return draft.materials.map(m=>{
  // The API accepts either quantity+unit together, or neither. An incomplete
  // purchase-price trio must be represented as unresolved, never zero.
  const validUnit=(v:string)=>Boolean(v.trim())&&v.trim().length<=32;
  const quantity=validUnit(m.unit)?draftNumber(m.quantity):null;
  const unit=quantity!==null?m.unit.normalize("NFKC").trim():null;
  const amount=draftNumber(m.price_jpy),basis=draftNumber(m.price_quantity,true);
  const priced=amount!==null&&basis!==null&&validUnit(m.price_unit);
  return {name:m.name.trim(),quantity,unit,supplier:m.supplier?.trim()||null,
   price_jpy:priced?amount:null,price_quantity:priced?basis:null,
   price_unit:priced?m.price_unit.normalize("NFKC").trim():null};
 });
}

export function registrationError(error:unknown,ja:boolean){
 const e=error as {message?:string;issues?:DraftIssue[]};
 const detail=e.issues?.map(i=>`${i.path}: ${i.reason}`).join(' / ');
 if(e.message==='422')return (ja?'入力契約を確認してください。':'Check the input contract. ')+(detail??'')+(ja?' 下書きは保持しています。':' Draft retained.');
 if(e.message==='409')return ja?'マスターの重複・保存内容の競合があります。下書きを保持しています。':'Master or save conflict. Draft retained.';
 if(e.message==='503')return ja?'サービス障害で処理を完了できません。下書きと保存IDを保持しています。':'Service unavailable. Draft and request ID retained.';
 return ja?'通信失敗により結果未確認です。下書きと同じ保存IDを保持しています。一覧を確認してから再試行してください。':'Communication failed; result unconfirmed. Draft and request ID retained. Check the list before retrying.';
}

function applyFoundPrices(draft:Draft):Draft{
 const applied=new Set<number>();
 const materials=draft.materials.map((m,index)=>{
  const p=draft.provisional_prices?.[index];
  if(!p||p.auto_apply===false||p.material_index!==index||p.material_name.trim()!==m.name.trim()||
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
// Live microphone signals owned by the workspace (single mic). Display only:
// recording = mic open, transcribing = batch transcription in flight/backlogged.
export type SharedMicStatus={recording:boolean;transcribing:boolean;queued:number};
export default function VoiceRecipeRegistration({locale,onCreated,onDiscarded,control,sharedVoice}:{locale:Locale;onCreated:(recipe:Recipe,mode:SaveMode,suppliers:string[])=>void;onDiscarded?:()=>void;control?:Ref<RegistrationHandle>;sharedVoice?:{markReview:()=>number;cancel:()=>void;captureMessage:string;mic?:SharedMicStatus}}){
 const ja=locale==="ja";
 const [prefixPreview,setPrefixPreview]=useState(false);
 const [busy,setBusy]=useState(false),[turns,setTurns]=useState<string[]>([]),[draft,setDraft]=useState<Draft|null>(null);
 const [unitCatalog,setUnitCatalog]=useState<Array<{id:string;symbol:string;dimension:string;base_factor:string|null;aliases:string[]}>|null>(null);
 const [unitDimensionChoices,setUnitDimensionChoices]=useState<Record<string,string>>({});
 useEffect(()=>{let cancelled=false;setUnitCatalog(null);
  request<{items:Array<{id:string;symbol:string;dimension:string;base_factor:string|null;aliases:string[]}>}>("/api/units").then(result=>{if(!cancelled)setUnitCatalog(result.items);}).catch(()=>{if(!cancelled)setUnitCatalog(null);});
  return ()=>{cancelled=true;};
 },[]);
 type MasterReview={already_saved?:boolean;ingredients:(MasterMatch&{price_action?:string})[];units:{symbol:string;dimension:string}[];suppliers:{name:string;action:string}[]};
 const [masterReview,setMasterReviewState]=useState<MasterReview|null>(null);
 const masterReviewRef=useRef<MasterReview|null>(null);
 function setMasterReview(value:MasterReview|null){masterReviewRef.current=value;setMasterReviewState(value);}
 const [reviewLoading,setReviewLoading]=useState(false);
 const saveEpochFloor=useRef(0),seenSaves=useRef(new Set<string>());
 const reviewFlight=useRef(false);
 const [phase,setPhase]=useState<"dictating"|"review"|"saving">("dictating");
 const [message,setMessage]=useState(ja?"料理名・食材・分量・仕入単価を話してください。":"Describe the recipe, quantities and purchase prices.");
 const [manual,setManual]=useState("");
 const [correctionIndex,setCorrectionIndex]=useState<number|null>(null);
 const [priceDetailIndex,setPriceDetailIndex]=useState<number|null>(null);
 const [unmatchedDetailIndex,setUnmatchedDetailIndex]=useState<number|null>(null);
 const [priceLoading,setPriceLoading]=useState(false);
 // Photo analysis (Block 2): file + optional memo -> POST /api/image-recipe.
 // photoAnalyzing mirrors its own flight only; photoFailed latches the last
 // failure. The result lands in the same draft state as voice parses, so
 // review/approval/saving stay on the single formal path.
 const [photoMemo,setPhotoMemo]=useState("");
 const [photoAnalyzing,setPhotoAnalyzing]=useState(false),[photoFailed,setPhotoFailed]=useState(false);
 const photoFile=useRef<HTMLInputElement|null>(null),photoAbort=useRef<AbortController|null>(null);
 // Dish image (Block 3): explicit "generate" only, never auto-run on parse or
 // save. dishGenerating mirrors its own flight; dishFailed latches the last
 // failure; dishImageUrl is a preview (illustration, never saved as evidence).
 const [dishHint,setDishHint]=useState("");
 const [dishModalOpen,setDishModalOpen]=useState(false);
 const [dishImageUrl,setDishImageUrl]=useState<string|null>(null);
 const dishPreviewRef=useRef<string|null>(null);
 const [restored,setRestored]=useState(false);
 const [dishGenerating,setDishGenerating]=useState(false),[dishFailed,setDishFailed]=useState(false);
 const dishAbort=useRef<AbortController|null>(null);
 // Pipeline status (drives the status list; each flag is set only while its
 // own stage actually runs, and failure latches clear on retry/success):
 // parsing = Muse voice-recipe in flight, parseFailed = last parse failed,
 // priceFailed = last price research failed while the draft was retained.
 const [parsing,setParsing]=useState(false),[parseFailed,setParseFailed]=useState(false),[priceFailed,setPriceFailed]=useState(false);
 const [recoveredPending,setRecoveredPending]=useState(false);
 const dataTurns=useRef<string[]>([]),draftRef=useRef<Draft|null>(null),reviewed=useRef<Draft|null>(null);
 const phaseRef=useRef<"dictating"|"review"|"saving">("dictating");
 const approvalEpoch=useRef(0);
 const reviewMode=useRef<SaveMode|null>(null);
 const inbox=useRef<Input[]>([]),draining=useRef(false),revision=useRef(0),epoch=useRef(0);
 const requestId=useRef<string|null>(null),semanticAbort=useRef<AbortController|null>(null),priceAbort=useRef<AbortController|null>(null),priceEpoch=useRef(0),alive=useRef(true);
 type RegistrationPayload={request_id:string;title:string;materials:(ReturnType<typeof toSaveMaterials>[number]&{ingredient_id?:string;new_master?:boolean;spec?:string|null})[];unit_candidates:{symbol:string;dimension:string}[];selling_price_jpy:string|null};
 const registrationPayload=useRef<RegistrationPayload|null>(null);
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
  if(draftRef.current||dataTurns.current.length)saveEpochFloor.current=voice.markReview();reviewed.current=null;inbox.current=inbox.current.filter(input=>input.command==="data");setStage("dictating");
 }}));
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;semanticAbort.current?.abort();priceAbort.current?.abort();photoAbort.current?.abort();dishAbort.current?.abort();inbox.current=[];};},[]);
 // Restore only working data, never approval or saving state. A restored draft
 // must pass the ordinary review/Human Gate again.
 useEffect(()=>{
  let cancelled=false;
  void loadWorkingDraft<Draft>().then(snapshot=>{
   if(cancelled||!alive.current||!snapshot||draftRef.current||dataTurns.current.length)return;
   const count=Number.isInteger(snapshot.parsedTurnCount)?Math.max(0,Math.min(snapshot.parsedTurnCount!,snapshot.turns.length)):snapshot.turns.length;
   draftRef.current=count===snapshot.turns.length?snapshot.draft:null;parseBase.current=snapshot.draft;
   dataTurns.current=snapshot.turns;parsedTurns.current=count;
   // A pending snapshot may come from an interrupted or superseded parse.
   // Offer recovery without claiming that a request actually failed.
   setRecoveredPending(count<snapshot.turns.length);
   setTurns(snapshot.turns.slice(-30));setDraft(snapshot.draft);
   dishPreviewRef.current=snapshot.image;setDishImageUrl(snapshot.image);
   requestId.current=snapshot.requestId??null;
   const payload=snapshot.registrationPayload as RegistrationPayload|undefined;
   if(payload&&typeof payload.request_id==='string'&&payload.request_id===requestId.current&&typeof payload.title==='string'&&
      Array.isArray(payload.materials)&&Array.isArray(payload.unit_candidates))registrationPayload.current=payload;
   if(draftRef.current&&snapshot.draft?.research_state==="deferred"&&snapshot.draft.pending_research?.length){
    void enrichPrices(snapshot.draft,revision.current,epoch.current,"restored-draft");
   }
  }).catch(()=>{}).finally(()=>{if(!cancelled)setRestored(true);});
  return()=>{cancelled=true;};
 },[]);
 useEffect(()=>{
  if(!restored||prefixPreview)return;
  const snapshot:WorkingDraftSnapshot<Draft>|null=(draft||dataTurns.current.length)?{draft,parsedTurnCount:parsedTurns.current,turns:[...dataTurns.current],image:dishPreviewRef.current,requestId:requestId.current,registrationPayload:registrationPayload.current}:null;
  void saveWorkingDraft(snapshot).catch(()=>{if(alive.current)say(ja?"下書きを端末に保存できませんでした。":"Could not persist the working draft on this device.");});
 },[draft,restored,dishImageUrl,prefixPreview]);

 function setStage(next:"dictating"|"review"|"saving"){phaseRef.current=next;setPhase(next);}
 const englishMessages:Record<string,string>={"下書きを破棄しました。新しいレシピを話してください。":"Draft discarded. Describe a new recipe.","Museが料理の文脈・数量・価格を解釈しています…":"Muse is interpreting the dish, quantities and prices…","料理の解釈に失敗しました。保存していません。「解析を再試行」か補助入力で再開できます。":"Could not interpret the recipe. Nothing was saved. Retry analysis or use manual input.","保存内容を確認しました。「保存」と話すか、保存ボタンで現在の内容を保存できます。":"Draft ready to review. Check the dish, ingredients, quantities and prices, then explicitly approve saving.","承認された内容を保存しています…":"Saving approved recipe…","保存済みです。":"Already saved.","レシピを保存しました。":"Recipe saved.","価格未確定として保存しました。未確定の仕入単価はゼロにせず、部分原価のみ表示されます。":"Saved with unconfirmed purchase prices. Unknown prices are not set to zero; only partial costs are shown.","保存結果を確認できませんでした。再送時も同じ登録IDを使います。一覧を確認してから再試行してください。":"Could not confirm the save result. The same request ID is used for retries; check the recipe list first.","保存せず、下書きを保持します。":"Not saved. Draft preserved."};
 function say(text:string){if(alive.current)setMessage(ja?text:(englishMessages[text]??text));}
 const photoMessages:Record<string,string>={"既存の下書きがあります。破棄してから写真を解析してください。":"A draft already exists. Discard it before analyzing a photo.","写真を選択してください。":"Choose a photo first.","写真の解析に失敗しました。下書きは作成していません。":"Photo analysis failed. No draft was created.","解析中に音声の下書きが作成されたため、写真の結果は破棄しました。下書きは保持しています。":"A voice draft was created during photo analysis, so the photo result was discarded. The draft is kept."};
 function sayPhoto(text:string){if(alive.current)setMessage(ja?text:(photoMessages[text]??text));}
 function clear(){
  if(phaseRef.current==="saving")return;
  setRecoveredPending(false);
  saveEpochFloor.current=voice.markReview();epoch.current++;revision.current++;semanticAbort.current?.abort();priceAbort.current?.abort();photoAbort.current?.abort();priceEpoch.current++;priceFlight.current=null;priceStash.current=null;priceDone.current.clear();setPriceLoading(false);setParsing(false);setParseFailed(false);setPriceFailed(false);setPhotoAnalyzing(false);setPhotoFailed(false);dishAbort.current?.abort();setDishGenerating(false);setDishFailed(false);dishPreviewRef.current=null;setDishImageUrl(null);voice.cancel();inbox.current=[];
  setCorrectionIndex(null);setPriceDetailIndex(null);setUnmatchedDetailIndex(null);dataTurns.current=[];setTurns([]);parsedTurns.current=0;parseBase.current=null;draftRef.current=null;reviewed.current=null;reviewMode.current=null;setDraft(null);setPrefixPreview(false);requestId.current=null;registrationPayload.current=null;
  // Speech-only snapshots do not change the persistence effect's dependencies.
  // Queue deletion after outstanding writes, even when draft/image were null.
  void saveWorkingDraft(null).catch(()=>{if(alive.current)say(ja?"端末の下書きを削除できませんでした。もう一度「破棄」と指示してください。":"Could not delete the device draft. Request discarding again.");});
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
  return draft.materials.map(m=>`${m.name.trim()}|${m.supplier?.trim()??""}`);
 }
 function flightMatches(flight:{key:string;rows:string[]},entries:PendingResearch[],draft:Draft):boolean{
  if(flight.key!==researchKey(entries))return false;
  const rows=rowNamesOf(draft);
  // Every in-flight row must still exist by name+index; otherwise the
  // request condition changed and the result must not be carried over.
  return flight.rows.every((name,index)=>rows[index]===name);
 }
 async function parse(next:string[],version:number,traceId=""){
  setRecoveredPending(false);
  const current=epoch.current,aborter=new AbortController();semanticAbort.current=aborter;
  // Incremental revision: resend only turns not yet parsed, with the last
  // successfully parsed draft as context, instead of reprocessing history.
  const previous=parseBase.current;
  const fresh=next.slice(parsedTurns.current);
  // Without a previously parsed draft there is no revision context, so a
  // follow-up that arrived mid-parse must resend full history (up to the
  // 30-turn window), never just its own delta. Otherwise the earlier
  // utterance is never interpreted at all.
  const turnsToSend=fresh.length&&previous?fresh:next;
  const usePrevious=previous&&fresh.length?previous:null;
  logVoiceEvent("muse.start",`${turnsToSend.length} new turns${usePrevious?"+draft":""}`,traceId);if(alive.current){setParseFailed(false);setParsing(true);}say(ja?"レシピを解析中です。価格調査を依頼した場合は続けて検索します…":"Interpreting recipe and checking requested prices…");
  const parseStarted=performance.now();
  try{
   const packedTurns=prepareRecipeTurns(turnsToSend);
   // Send recipe facts and outstanding requests, not search evidence/caches.
   // Ten sourced candidates can be much larger than the actual revision.
   const context=usePrevious?{title:usePrevious.title,materials:usePrevious.materials,
    selling_price_jpy:usePrevious.selling_price_jpy,notes:usePrevious.notes,
    interpretations:usePrevious.interpretations,nameCorrections:usePrevious.nameCorrections,
    unitProposals:usePrevious.unitProposals,pending_research:usePrevious.pending_research}:null;
   const out=await request<Draft>("/api/voice-recipe",{method:"POST",body:JSON.stringify(usePrevious?{turns:packedTurns,previous:context,defer_prices:true}:{turns:packedTurns,defer_prices:true}),signal:aborter.signal});
   logVoiceEvent("muse.ok",`${Math.round(performance.now()-parseStarted)}ms; structured response`,traceId);
   if(!alive.current||epoch.current!==current){logVoiceEvent("muse.ok","discarded session ignored",traceId);return;}
   if(revision.current!==version){
    // Display a complete validated prefix while later dictation is pending.
    // This response covers exactly next: keep its cursor/base so the queued
    // correction sends only its delta. Approval still requires the latest revision.
    parsedTurns.current=next.length;parseBase.current=applyFoundPrices(out);
    setDraft(applyFoundPrices(out));setPrefixPreview(true);
    logVoiceEvent("draft.preview","validated prefix; later turns pending",traceId);
    return;
   }
   setPrefixPreview(false);
   // An audio save that started before this complete draft was presented
   // must not authorize it after waiting in either ASR or the input queue.
   approvalEpoch.current=voice.markReview();
   // Advance only for the applied result: a stale response must not move the
   // cursor, or the next parse would skip turns the stale one never applied.
   parsedTurns.current=next.length;
   if(previous){
    const kept=(index:number,name:string)=>out.materials[index]?.name===name&&
     (out.materials[index]?.supplier??"")===(previous.materials[index]?.supplier??"");
    out.price_references=[...(previous.price_references??[]).filter(r=>typeof r.material_index==='number'&&kept(r.material_index,previous.materials[r.material_index]?.name)),...(out.price_references??[])];
    out.research_status=[...(previous.research_status??[]).filter(r=>kept(r.material_index,previous.materials[r.material_index]?.name)),...(out.research_status??[])];
    out.provisional_prices=out.materials.map((m,index)=>{
     const prior=previous.materials[index];
     const candidate=out.provisional_prices?.[index]??(kept(index,prior?.name)?previous.provisional_prices?.[index]??null:null);
     // A cleared price is a revision, not permission to apply the old candidate
     // again. Keep it available for the chef's explicit manual adoption.
     const cleared=prior?.price_jpy&&prior.price_quantity&&prior.price_unit&&
      !(m.price_jpy&&m.price_quantity&&m.price_unit)&&!out.pending_research?.some(e=>e.material_index===index);
     return candidate&&cleared?{...candidate,auto_apply:false}:candidate;
    });
   }
   const enriched=applyFoundPrices(out);
   parseBase.current=enriched;
   logVoiceEvent(draftRef.current?"draft.updated":"draft.created", "voice-recipe",traceId);
   setCorrectionIndex(null);setPriceDetailIndex(null);setUnmatchedDetailIndex(null);draftRef.current=enriched;setDraft(enriched);reviewed.current=null;reviewMode.current=null;requestId.current=null;registrationPayload.current=null;setStage("dictating");
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
     reviewed.current=null;reviewMode.current=null;requestId.current=null;registrationPayload.current=null;setStage("dictating");
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
      reviewed.current=null;reviewMode.current=null;requestId.current=null;registrationPayload.current=null;setStage("dictating");
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
    // can never land on this draft. Stale stash is discarded with it, and a
    // previous failure is cleared with the research it belonged to: the new
    // draft needs no search, so the old warning must not linger (or suppress
    // the completion row). A still-running search cannot exist here because
    // its flight is aborted above; its late failure is suppressed by the
    // abort/epoch guards in enrichPrices.
    priceAbort.current?.abort();priceAbort.current=null;
    priceFlight.current=null;priceStash.current=null;setPriceLoading(false);setPriceFailed(false);
   }
   say(enriched.missing.length||enriched.notes.length?(ja?"確認が必要です："+[...enriched.missing,...enriched.notes].join("、"):"Needs review: "+[...enriched.missing,...enriched.notes].join(", ")):
    (ja?"下書きを更新しました。「保存」で現在の内容を保存できます。不足情報は後から編集できます。":"Draft updated. Review it, then explicitly approve saving."));
  }catch{
   if(alive.current&&epoch.current===current&&revision.current===version&&!aborter.signal.aborted){
    logVoiceEvent("muse.fail","voice-recipe failed; draft kept",traceId);
    setParseFailed(true);
    say("料理の解釈に失敗しました。保存していません。「解析を再試行」か補助入力で再開できます。");
    const stash=priceStash.current;
    const candidate=draftRef.current ?? parseBase.current;
    if(stash&&candidate&&researchKey(candidate.pending_research??[])===stash.key&&
       stash.rows.every((name,index)=>rowNamesOf(candidate)[index]===name)){
     const merged=applyFoundPrices({...candidate,...stash.response,pending_research:[]});
     priceDone.current.set(stash.key+"@"+rowNamesOf(candidate).join("|"),stash.response);
     draftRef.current=merged;parseBase.current=merged;setDraft(merged);
     reviewed.current=null;reviewMode.current=null;requestId.current=null;registrationPayload.current=null;setStage("dictating");
     logVoiceEvent("price.ok","stashed research applied after parse failure",traceId);
    }
    if(stash||!(priceAbort.current&&!priceAbort.current.signal.aborted)){
     // Clear only a finished flight/stash. A still-running search keeps its
     // own flight and loading flag; its completion path owns the outcome.
     priceStash.current=null;priceFlight.current=null;priceAbort.current=null;setPriceLoading(false);
    }
   }
  }finally{
   // Display flag only: button disabling stays on busy/draining.
   if(alive.current&&epoch.current===current&&semanticAbort.current===aborter)setParsing(false);
  }
 }
 function contentKey(d:Draft){return JSON.stringify({title:d.title.trim(),materials:toSaveMaterials(d),selling_price_jpy:draftNumber(d.selling_price_jpy,true),unitProposals:d.unitProposals??[]});}
 function applyResearchDraft(next:Draft){
  const before=draftRef.current;
  const unchanged=before&&contentKey(before)===contentKey(next);
  draftRef.current=next;parseBase.current=next;setDraft(next);
  if(unchanged){if(reviewed.current===before)reviewed.current=next;return;}
  reviewed.current=null;reviewMode.current=null;requestId.current=null;registrationPayload.current=null;
  setStage("dictating");say(ja?"下書きの価格を更新しました。「保存」で現在の内容を保存できます。":"Draft prices updated. Say save to save the current content.");
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
  setPriceLoading(true);setPriceFailed(false);
  logVoiceEvent("price.start",`${entries.length} entries`,traceId);
  let stashed=false;
  try{
   // Keep each HTTP request within one search timeout. One user request,
   // batches of two targets, incremental results, no dropped targets.
   const response:DonePrices={price_references:[],research_status:[],provisional_prices:base.materials.map(()=>null),research_state:"complete"};
   for(let offset=0;offset<entries.length;offset+=2){
    if(controller.signal.aborted)return;
    const batch=entries.slice(offset,offset+2);
    let part:DonePrices;
    try{part=await request<DonePrices>("/api/voice-recipe/prices",{
     method:"POST",body:JSON.stringify({materials:base.materials,entries:batch.map(e=>({...e,material_index:e.material_index===-1?null:e.material_index}))}),signal:controller.signal});}
    catch(error){
     if(controller.signal.aborted)throw error;
     part={research_status:batch.map(e=>({...e,ledger:"unavailable",web:"provider_error",provisional:false}))};
    }
    response.price_references!.push(...(part.price_references??[]));
    response.research_status!.push(...(part.research_status??[]));
    part.provisional_prices?.forEach((price,index)=>{if(price)response.provisional_prices![index]=price;});
    const live=draftRef.current;
    if(alive.current&&epoch.current===requestEpoch&&priceEpoch.current===sequence&&
       !controller.signal.aborted&&phaseRef.current!=="saving"&&live&&rows.every((name,index)=>rowNamesOf(live)[index]===name)){
     const partial=applyFoundPrices({...live,...response,research_state:"deferred",pending_research:entries});
     applyResearchDraft(partial);
    }
   }
   if(!alive.current||controller.signal.aborted||priceEpoch.current!==sequence||epoch.current!==requestEpoch)return;
   if(phaseRef.current==="saving")return;
   setPriceFailed(response.research_status?.some(s=>["provider_error","timeout","misconfigured","not_searched"].includes(s.web))??false);
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
    applyResearchDraft(merged);logVoiceEvent("price.ok","research returned",traceId);
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
    applyResearchDraft(fallback);setPriceFailed(true);
    logVoiceEvent("price.fail","price research failed; draft retained",traceId);
   }
  }finally{
   if(stashed){
    // Retrieval is finished even when applying its result awaits a parse.
    if(alive.current&&priceEpoch.current===sequence)setPriceLoading(false);
    return;
   }
   if(alive.current&&priceEpoch.current===sequence){setPriceLoading(false);priceAbort.current=null;priceFlight.current=null;}
  }
 }
 function savePayload(d:Draft):RegistrationPayload{
  if(registrationPayload.current?.request_id===requestId.current)return registrationPayload.current;
  const materials=toSaveMaterials(d);
  const dimension=(symbol:string)=>unitDimensionChoices[symbol]??d.unitProposals?.find(item=>item.symbol===symbol)?.dimension??standardDimension(symbol);
  const resolvable=(symbol:string)=>unitCatalog?.some(u=>[u.symbol,...(u.aliases||[])].some(a=>a.toLocaleLowerCase()===symbol.toLocaleLowerCase()))||["mass","volume","count","other"].includes(dimension(symbol));
  // A missing classification is unresolved data, not a reason to block saving.
  // Never guess a dimension or persist a partial quantity/price tuple.
  for(const material of materials){
   if(material.unit&&!resolvable(material.unit)){material.quantity=null;material.unit=null;}
   if(material.price_unit&&!resolvable(material.price_unit)){material.price_jpy=null;material.price_quantity=null;material.price_unit=null;}
  }
  const symbols=[...new Set(materials.flatMap(m=>[m.unit,m.price_unit]).filter((x):x is string=>Boolean(x)))];
  const unit_candidates=symbols.filter(symbol=>!unitCatalog?.some(u=>[u.symbol,...(u.aliases||[])].some(a=>a.toLocaleLowerCase()===symbol.toLocaleLowerCase())))
   .map(symbol=>({symbol,dimension:dimension(symbol)}));
  const unresolved=unit_candidates.filter(c=>!["mass","volume","count","other"].includes(c.dimension));
  if(unresolved.length)throw Object.assign(new Error('422'),{issues:unresolved.map(c=>({path:`unit_candidates.${c.symbol}`,reason:ja?'新規単位の分類を選択してください':'Choose a new unit dimension'}))});
  if(!requestId.current)requestId.current=crypto.randomUUID();
  const payload={request_id:requestId.current,title:d.title.trim()||(ja?"無題のレシピ":"Untitled recipe"),materials,unit_candidates,selling_price_jpy:draftNumber(d.selling_price_jpy,true)};
  registrationPayload.current=payload;return payload;
 }
 async function showReview(traceId=""){
  if(priceLoading){say(ja?"価格調査中ですが、下書きの確認は先にできます。検索結果は確定後に反映されます。":"Price research is running; you can still review the draft now.")} 
  const d=draftRef.current;
  if(!unitCatalog){say(ja?"単位マスターを取得できません。承認前に再試行してください。":"Unit catalog is unavailable; retry before approval.");return;}
  if(!d||parsedTurns.current<dataTurns.current.length){say(dataTurns.current.length?(ja?"最新の入力を解釈中、または解釈に失敗しています。解析が終わるまで保存しません。":"The latest input is processing or failed. Saving is blocked until analysis finishes."):(ja?"新しいレシピを登録します。料理名・食材・分量・仕入単価を話してください。":"Describe the dish, ingredients, quantities and purchase prices."));return;}
  let mode=saveModeFor(d);
  if(!mode){
   say((ja?"まだ登録できません：":"Cannot save yet: ")+[...(!d.title.trim()?[ja?"料理名":"Recipe name"]:[]),...d.missing,...d.notes].join(ja?"、":", "));return;
  }
  if(reviewFlight.current){say(ja?"レビューを照合中です。完了後に保存してください。":"Review is in progress. Save after it completes.");return;}
  const reviewEpoch=epoch.current,reviewRevision=revision.current,key=contentKey(d);
  reviewFlight.current=true;setReviewLoading(true);setMasterReview(null);
  say(ja?"保存内容と食材・単位・仕入先マスターを照合しています…":"Checking recipe and master records…");
  try{
   const payload=savePayload(d);
   if(payload.materials.some(m=>m.quantity===null||m.price_jpy===null))mode="unconfirmed";
   const result=await request<MasterReview>("/api/recipes/full/review",{method:"POST",body:JSON.stringify(payload)});
   if(!alive.current)return;
   if(epoch.current!==reviewEpoch||revision.current!==reviewRevision||!draftRef.current||contentKey(draftRef.current)!==key||requestId.current!==payload.request_id){say(ja?"照合中に下書きが変更されました。最新の内容を再レビューしてください。":"Draft changed during review. Review the latest content.");return;}
   setMasterReview(result);
  }catch(error){say(registrationError(error,ja));return;}
  finally{reviewFlight.current=false;setReviewLoading(false);}
  reviewed.current=draftRef.current;reviewMode.current=mode;approvalEpoch.current=voice.markReview();setStage("review");
  if(masterReviewRef.current?.ingredients.some(m=>m.action==="choose")){say(ja?"食材マスターの関連付けが未確定です。候補を選択して再照合できます。":"Ingredient master choices are available. Choose and apply a link when resolved.");return;}
  if(mode==="confirmed")
   say("保存内容を確認しました。「保存」と話すか、保存ボタンで現在の内容を保存できます。");
  else
   say((registrationIssues(d).map(i=>`${i.path}: ${i.reason}`).join(" / "))+" "+(ja?"仕入単価が不明の項目があります（"+priceMissingNames(d).join("、")+"）。未確定の数量・価格は未確定のまま保存できます。価格を推測やゼロ埋めで補いません。「保存」と話すか、保存ボタンで未確定のまま保存できます。":"Missing purchase prices: "+priceMissingNames(d).join(", ")+". You may explicitly approve saving with unresolved quantities or prices; no price will be guessed or set to zero."));
 }
 // The chef's explicit save is the approval gate. The formal POST validates
 // masters atomically; optional preflight never requires a second save turn.
 async function register(){
  if(phaseRef.current==="saving"){say(ja?"保存処理中です。完了をお待ちください。":"Saving. Please wait.");return;}
  if(!draftRef.current){say(ja?"保存する内容がまだありません。解析できた内容は下書きに保持しています。":"No parsed content to save yet. Your draft is retained.");return;}
  if(!draftRef.current.title.trim()){
   const next={...draftRef.current,title:ja?"無題のレシピ":"Untitled recipe"};
   draftRef.current=next;parseBase.current=next;setDraft(next);reviewed.current=null;registrationPayload.current=null;requestId.current=null;
  }
  if(parsedTurns.current!==dataTurns.current.length||inbox.current.some(i=>i.command==="data")){say(ja?"未解析の発話があります。最新の内容の解析後に保存してください。":"Unparsed speech remains. Save after parsing finishes.");return;}
  // Save the current facts without waiting for price research or adopting its
  // later results during the approved save.
  priceEpoch.current++;priceAbort.current?.abort();priceAbort.current=null;priceFlight.current=null;priceStash.current=null;setPriceLoading(false);
  await save();
 }
 async function save(){
  const d=draftRef.current;
  let mode=d?saveModeFor(d):null;
  if(!d||!mode){say(ja?"保存する食材名を確認してください。下書きは保持しています。":"Check the ingredient names. Draft retained.");return;}
  if(parsedTurns.current!==dataTurns.current.length||inbox.current.some(i=>i.command==="data")){say(ja?"未解析の発話があります。解析完了後に保存してください。":"Unparsed speech remains. Save after parsing completes.");return;}
  let payload:ReturnType<typeof savePayload>;
  try{payload=savePayload(d);}catch{
   say(ja?"新規単位の分類を確認してください。":"Review the dimension of every proposed new unit.");return;
  }
  if(payload.materials.some(m=>m.quantity===null||m.price_jpy===null))mode="unconfirmed";
  voice.cancel();setStage("saving");if(!draining.current)setBusy(true);say("承認された内容を保存しています…");
  if(!requestId.current)requestId.current=crypto.randomUUID();
  // Persist the stable idempotency key before invoking the remote mutation.
  try{
   try{await saveWorkingDraft({draft:d,turns:[...dataTurns.current],image:dishPreviewRef.current,requestId:requestId.current,registrationPayload:registrationPayload.current});}
   catch{setStage("review");say("保存IDを端末に保持できません。下書きと同じ保存IDを保持しています。再試行してください。");return;}
   const recipe=await request<Recipe>("/api/recipes/full",{method:"POST",body:JSON.stringify(payload)});
   if(!alive.current)return;
   // Associate the optional preview only after the formal save succeeded.
   // Local cache failure must never retry or roll back the confirmed recipe.
   const preview=dishPreviewRef.current;
   let imageRetained=true;
   if(preview){
    try{imageRetained=await storeDishPreview(recipe.id,preview);}
    catch{imageRetained=false;}
    logVoiceEvent(imageRetained?"dish-image.persisted":"dish-image.persist.fail",
      imageRetained?"saved-recipe local cache":"browser cache unavailable");
   }
   if(!alive.current)return;
   saveEpochFloor.current=voice.markReview();epoch.current++;revision.current++;inbox.current=[];
   dataTurns.current=[];setTurns([]);parsedTurns.current=0;parseBase.current=null;draftRef.current=null;reviewed.current=null;reviewMode.current=null;setDraft(null);setPrefixPreview(false);requestId.current=null;registrationPayload.current=null;setStage("dictating");
   // Spoken purchase sources travel with the save callback: the workspace
   // announces them after its browse transition (this panel hides then).
   const suppliers=[...new Set(d.materials.map(m=>(m.supplier||"").trim()).filter(Boolean))];
   priceAbort.current?.abort();priceAbort.current=null;priceFlight.current=null;priceStash.current=null;priceDone.current.clear();setPriceLoading(false);setPriceFailed(false);
   // Dish preview belongs to the saved recipe only: abort its flight and
   // clear preview/failure so neither survives into the next recipe (this
   // panel stays mounted while hidden). The saved draft itself is untouched.
   dishAbort.current?.abort();dishAbort.current=null;setDishGenerating(false);setDishFailed(false);dishPreviewRef.current=null;setDishImageUrl(null);setDishHint("");
   // The workspace owns the visible success notification after switching to browse.
   // Do not leave a second, hidden success message inside the registration panel.
   if(!sharedVoice)say((mode==="confirmed"?"レシピを保存しました。":"価格未確定として保存しました。未確定の仕入単価はゼロにせず、部分原価のみ表示されます。")+(imageRetained?"":" 料理画像はこのブラウザに保存できませんでした。"));
   onCreated(recipe,mode,suppliers);
  }catch(error){setStage("review");say(registrationError(error,ja));}
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
     const sourceEpoch=epoch.current;const sourceTurns=[...dataTurns.current];
     try{await saveWorkingDraft({draft:parseBase.current,parsedTurnCount:parsedTurns.current,turns:[...dataTurns.current],image:dishPreviewRef.current,requestId:requestId.current,registrationPayload:registrationPayload.current});}
     catch{say(ja?"発話を端末に保持できません。画面の入力内容を確認してください。":"Could not retain speech on this device. Check the transcript.");}
     if(!alive.current||epoch.current!==sourceEpoch)continue;
     await parse(sourceTurns,batch[batch.length-1].revision,batch[batch.length-1].traceId);
    }else if(input.revision===revision.current){
     if(input.command==="review")await showReview(input.traceId);
     else if(input.command==="save"){
      // Reject earlier draft/mode audio, not speech recorded while this draft
      // was being parsed. The FIFO completes that parse before saving.
      if(input.staleVoice||(!input.manual&&input.captureEpoch<saveEpochFloor.current)){say(ja?"別の下書きの前に収録された保存指示は実行しません。現在の内容に新しく保存を指示してください。":"Ignored a save recorded for an earlier draft. Request saving the current draft.");}else await register();
     }else if(input.command==="hold"){
      reviewed.current=null;setStage("dictating");say("保存せず、下書きを保持します。");
     }
    }else{say(ja?"別の下書きへの指示は実行しません。最新の内容を確認してください。":"Ignored a request for another draft. Review the latest content.");}
   }
  }finally{draining.current=false;if(alive.current)setBusy(false);}
 }
 function enqueue(text:string,meta?:VoiceCaptureMeta){
  if(!text.trim())return;
  if(phaseRef.current==="saving"){say(ja?"保存処理中です。同じ指示を重ねず完了をお待ちください。":"Saving. Please wait without repeating the request.");return;}
  const command=voiceCommand(text);
  if(command==="save"&&meta?.utteranceId){if(seenSaves.current.has(meta.utteranceId)){say(ja?"同じ保存指示は受付済みです。":"This save request was already received.");return;}seenSaves.current.add(meta.utteranceId);}
  if(command==="cancel"){clearTrace.current=meta?.traceId??"";clear();return;}
  setTurns(previous=>[...previous,text].slice(-30));
  if(command==="data"){
   if(draftRef.current)parseBase.current=draftRef.current;
   // Keep a running price search alive across follow-up utterances; parse()
   // adopts it when the searched rows are unchanged, or restarts it when the
   // condition changed. Never abort here (avoids cancelling unchanged rows).
   revision.current++;reviewed.current=null;reviewMode.current=null;draftRef.current=null;requestId.current=null;registrationPayload.current=null;setStage("dictating");
  }
  const manual=!meta||meta.source==="manual";
  const captureEpoch=manual?approvalEpoch.current:meta.reviewEpoch;
  const staleVoice=!manual&&captureEpoch<saveEpochFloor.current;
  inbox.current.push({text,command,revision:revision.current,captureEpoch,manual,staleVoice,traceId:meta?.traceId??""});
  if(command==="data")void saveWorkingDraft({draft:parseBase.current,parsedTurnCount:parsedTurns.current,
   turns:[...dataTurns.current,...inbox.current.filter(item=>item.command==="data").map(item=>item.text)],
   image:dishPreviewRef.current,requestId:requestId.current,registrationPayload:registrationPayload.current}).catch(()=>say(ja?"発話を端末に保持できません。画面の入力内容を確認してください。":"Could not retain speech on this device. Check the transcript."));
  void drain();
 }
 function retry(){
  if(!dataTurns.current.length||draining.current)return;
  // Retry the same source, without fabricating another spoken turn.
  draining.current=true;setBusy(true);
  void parse(dataTurns.current,revision.current).finally(()=>{
   draining.current=false;if(alive.current)setBusy(false);if(inbox.current.length)void drain();
  });
 }
 function readAsDataURL(file:File){
  return new Promise<string>((resolve,reject)=>{
   const reader=new FileReader();
   reader.onload=()=>resolve(String(reader.result??""));
   reader.onerror=()=>reject(reader.error??new Error("read failed"));
   reader.readAsDataURL(file);
  });
 }
 async function analyzePhoto(){
  if(phaseRef.current==="saving"||photoAnalyzing)return;
  // Never overwrite: an existing draft must be explicitly discarded first.
  // No request is sent in that case, so the draft cannot be clobbered.
  if(draftRef.current){sayPhoto("既存の下書きがあります。破棄してから写真を解析してください。");return;}
  const file=photoFile.current?.files?.[0];
  if(!file){sayPhoto("写真を選択してください。");return;}
  setPhotoFailed(false);setPhotoAnalyzing(true);
  const traceId=`photo-${Date.now().toString(36)}`;
  logVoiceEvent("photo.start",file.name||"photo",traceId);
  try{
   const dataUrl=await readAsDataURL(file);
   const memo=photoMemo.trim();
   const controller=new AbortController();photoAbort.current=controller;
   const out=await request<Draft>("/api/image-recipe",{method:"POST",body:JSON.stringify(memo?{image:dataUrl,text:memo}:{image:dataUrl}),signal:controller.signal});
   if(!alive.current||controller.signal.aborted)return;
   // Completion guard (mirrors the start guard): a voice draft created
   // while the photo was in flight wins. Applying the photo here would
   // clobber spoken turns the chef already banked, so the photo result
   // is discarded with an explicit message and no revision/epoch bump.
   // Unparsed voice turns are untouched; only this photo response is lost.
   // NOTE: the "saving" read needs a widening cast: the start guard above
   // narrows phaseRef.current for the rest of this closure, so a direct
   // === "saving" comparison looks unintentional to tsc (TS2367).
   if(draftRef.current||(phaseRef.current as "dictating"|"review"|"saving")==="saving"){
    logVoiceEvent("draft.kept","photo result discarded; voice draft present",traceId);
    sayPhoto("解析中に音声の下書きが作成されたため、写真の結果は破棄しました。下書きは保持しています。");
    return;
   }
   // New revision source: invalidate in-flight voice parse/enrichment so a
   // stale voice result can never overwrite the photo draft. Still-unparsed
   // voice turns are not dropped; they re-parse against this draft later.
   revision.current++;epoch.current++;
   // The accepted photo is authoritative, not a voice prefix. Its epoch
   // invalidates the old parse, whose finally must not clear newer work.
   setPrefixPreview(false);setParsing(false);
   const version=revision.current,current=epoch.current;
   const enriched=applyFoundPrices(out);
   parseBase.current=enriched;
   logVoiceEvent("draft.created","image-recipe",traceId);
   setCorrectionIndex(null);setPriceDetailIndex(null);setUnmatchedDetailIndex(null);draftRef.current=enriched;setDraft(enriched);reviewed.current=null;reviewMode.current=null;requestId.current=null;registrationPayload.current=null;setStage("dictating");
   say(enriched.missing.length||enriched.notes.length?(ja?"写真から下書きを作りました。確認が必要です："+[...enriched.missing,...enriched.notes].join("、"):"Photo draft created. Needs review: "+[...enriched.missing,...enriched.notes].join(", ")):(ja?"写真から下書きを作りました。内容を確認してください。":"Photo draft created. Review it."));
   const pending=enriched.pending_research??[];
   if(out.research_state==="deferred"&&pending.length)void enrichPrices(enriched,version,current,traceId);
  }catch{
   if(alive.current){setPhotoFailed(true);logVoiceEvent("photo.fail","image-recipe failed; no draft created",traceId);sayPhoto("写真の解析に失敗しました。下書きは作成していません。");}
  }finally{
   if(alive.current)setPhotoAnalyzing(false);
  }
 }
 async function generateDishImage(){
  // Explicit user action only: no auto-run from parse/save flows.
  // Double-submit guard: a running flight returns silently.
  if(phaseRef.current==="saving"||dishGenerating)return;
  const current=draftRef.current;
  if(!current){say(ja?"先に下書きを作成してください。":"Create a draft first.");return;}
  const started=current;
  const prompt=dishImagePrompt(current.title,current.materials.map(m=>m.name),dishHint);
  setDishFailed(false);setDishGenerating(true);
  const traceId=`dish-image-${Date.now().toString(36)}`;
  logVoiceEvent("dish-image.start",prompt.slice(0,80),traceId);
  const controller=new AbortController();dishAbort.current=controller;
  try{
   const out=await request<{image:string}>("/api/dish-image",{method:"POST",body:JSON.stringify({prompt}),signal:controller.signal});
   // Completion guard: a discarded/saved/replaced draft never receives
   // a stale preview or failure — only the exact draft object this flight
   // started from. (clear()/save() null draftRef.current and abort, so an
   // already-settled fetch cannot leak into the next recipe either.)
   if(!alive.current||!dishCompletionKept(started,draftRef.current,controller.signal.aborted))return;
   // Preview only: the draft object is untouched (no revision/epoch bump),
   // so a late voice/price result can never be clobbered by an image.
   dishPreviewRef.current=out.image;
   setDishImageUrl(out.image);
   logVoiceEvent("dish-image.ok","preview ready; draft kept",traceId);
   say(ja?"料理イメージを生成しました。":"Dish image generated.");
  }catch(err){
   // Abort (draft discarded/saved mid-flight) is a normal cancellation:
   // never surface it as an API failure. HTTP/timeouts arrive as
   // Error("<status>") from request(), so genuine failures still display.
   if(!alive.current||controller.signal.aborted||isAbortError(err))return;
   setDishFailed(true);logVoiceEvent("dish-image.fail",err instanceof Error?err.message:"failed",traceId);say(ja?"画像の生成に失敗しました。下書きは保持しています。":"Image generation failed. The draft is kept.");
  }finally{
   if(alive.current)setDishGenerating(false);
  }
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
  reviewed.current=null;reviewMode.current=null;requestId.current=null;registrationPayload.current=null;setStage("dictating");setCorrectionIndex(null);
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
  reviewed.current=null;reviewMode.current=null;requestId.current=null;registrationPayload.current=null;setStage("dictating");
  say(ja?"参考価格を下書きに採用しました。内容を確認してから保存してください。":"Reference price applied to the draft. Review before saving.");
 }
 const eligible=draftRef.current&&parsedTurns.current===dataTurns.current.length?saveModeFor(draftRef.current):null;
 const blocked=busy?(ja?"受信済みの指示を処理中です。":"Processing received instructions."):reviewLoading?(ja?"レビューを照合中です。":"Checking review."):!eligible?(ja?"最新の下書きの解析完了と料理名・食材名を確認してください。":"Wait for parsing and check recipe and ingredient names."):"";
 const statusRows:VoiceStatusRow[]=[];
 if(!sharedVoice){if(capture.recording)statusRows.push({key:"listen"});if(capture.busy||capture.queued>0)statusRows.push({key:"transcribe"});}
 if(parsing||parseFailed)statusRows.push({key:"parse",error:!parsing&&parseFailed});
 if(priceLoading||priceFailed)statusRows.push({key:"price",error:!priceLoading&&priceFailed});
 if(photoAnalyzing||photoFailed)statusRows.push({key:"photo",error:!photoAnalyzing&&photoFailed});
 if(dishGenerating||dishFailed)statusRows.push({key:"dish-image",error:!dishGenerating&&dishFailed});
 if(phase==="saving")statusRows.push({key:"save"});
 useVoiceProcessingStatus(locale,statusRows);
 return <section className="card" aria-label={ja?"音声レシピ一括登録":"Voice recipe registration"}>
  {prefixPreview&&draft&&<p className="muted" aria-label={ja?"未反映の発話":"Pending dictation"}>{ja?"続きの発話は未反映です。":"Later dictation has not been applied yet."}</p>}
  <h2>{ja?"音声でレシピを一括登録":"Full recipe by voice"}</h2>
  <details className="voice-help"><summary>{ja?"登録の使い方":"How to register"}</summary>
  <p>{ja?"料理名、食材、分量、仕入単価、売価を自然な言葉で伝えてください。料理の文脈を解釈し、変更案を下書きで確認できます。":"Describe the dish, ingredients, quantities, purchase prices and selling price naturally. Review the interpreted recipe as a draft."}</p>
  <p>{ja?"下書きは自動保存されます。「保存」で現在の内容を保存します。数量・価格などの不足は未確定のまま残り、保存後に編集できます。「破棄」で下書きを削除します。":"Ask to review the draft before saving. An explicit approval is required to save; discarding removes the draft."}</p>
  <p>{ja?"仕入単価だけが不明でも、価格を推測・ゼロ埋めせず、価格未確定のレシピとして登録できます。":"If only purchase prices are missing, you can register with unconfirmed costs. Missing prices are never guessed or set to zero."}</p>
  <p>{ja?"音声はMetaへ送信して文字起こしします。録音は保存しません。発話の間を約1秒空けると解釈します。":"Audio is sent to Meta and not stored. Pause for about one second between turns."}</p>
  </details>
  {!sharedVoice&&<><button type="button" disabled={!voice.recording&&(voice.supported===false||voice.busy||phase==="saving")} onClick={voice.recording?voice.stop:()=>void voice.start()} aria-pressed={voice.recording}>{voice.recording?(ja?"■ マイクを停止":"■ Stop microphone"):(ja?"🎙 音声操作を開始":"🎙 Start voice control")}</button>
  <p aria-live="polite">{voice.recording?"聞き取り中… ":""}{voice.busy?"音声を文字にしています…":""}</p>
  {voice.error&&<p role="alert">{voice.error}</p>}
  {voice.supported===false&&<p>{ja?"音声入力を利用できません。補助入力を使用してください。":"Voice input is unavailable. Use manual input."}</p>}</>}
  <details open className="voice-detail-message"><summary>{ja?"処理メッセージ":"Processing details"}</summary><p aria-live="polite" role="status">{busy?(ja?"処理中 ⏳ ":"Working ⏳ "):""}{message}</p></details>
  {!sharedVoice&&<form onSubmit={event=>{event.preventDefault();if(manual.trim()){enqueue(manual);setManual("");}}}>
   <input aria-label={ja?"音声認識できない場合の入力":"Manual input when voice recognition is unavailable"} value={manual} onChange={event=>setManual(event.target.value)} placeholder={ja?"音声認識できないときの補助入力":"Type when voice recognition is unavailable"} disabled={phase==="saving"}/>
   <button type="submit" disabled={!manual.trim()||phase==="saving"}>{ja?"反映":"Apply"}</button>
  </form>}
  {!unitCatalog&&<button type="button" disabled={busy} onClick={()=>void request<{items:Array<{id:string;symbol:string;dimension:string;base_factor:string|null;aliases:string[]}>}>("/api/units").then(result=>{setUnitCatalog(result.items);say(ja?"単位マスターを再取得しました。内容を確認してください。":"Unit catalog reloaded. Review the draft.");}).catch(()=>say(ja?"単位マスターを取得できません。下書きは保持しています。":"Unit catalog unavailable. Draft retained."))}>{ja?"単位マスターを再取得":"Reload unit catalog"}</button>}
  {recoveredPending&&<p>{ja?"未解析の発話を復元しました。再解析してから内容を確認してください。":"Restored pending dictation. Retry analysis before reviewing."}</p>}
  {(parseFailed||recoveredPending)&&<button type="button" disabled={busy||!dataTurns.current.length||phase==="saving"} onClick={retry}>{ja?"解析を再試行":"Retry analysis"}</button>}


  {draft&&<div id="draft" aria-label="未保存のレシピ下書き">
   {priceLoading&&<p role="status" aria-live="polite">{ja?`価格を検索しています… ${draft.research_status?.length??0} / ${draft.pending_research?.length??0}件完了。下書きは先に確認できます。`:"Searching prices… You can inspect the draft now."}</p>}
   {!priceLoading&&(draft.research_status?.length??0)>0&&(()=>{
    const hasResult=(draft.provisional_prices?.some(Boolean)??false)||(draft.research_status?.some(item=>item.provisional)??false);
    return <p role="status" aria-live="polite">{hasResult?(ja?"検索結果を取得しました。価格の詳細・出典で内容を確認できます。":"Search results ready. Check price details and sources."):(ja?"価格を確認できませんでした。下書きは保持しています。":"Could not confirm prices. The draft is kept.")}</p>;
   })()}
   <h3>{ja?"未保存の下書き：":"Unsaved draft: "}{draft.title||(ja?"料理名未設定":"Untitled recipe")}</h3>
   {!unitCatalog&&<p role="status">{ja?"単位マスターを照合中です。分類が未確定の数量・価格は未確定のまま保存できます。":"Loading units. Unknown quantity and price units may remain unresolved when saving."}</p>}
   {unitCatalog&&(()=>{const projected=toSaveMaterials(draft);
     const names=[...new Set(projected.flatMap(m=>[m.unit,m.price_unit]).filter((x):x is string=>Boolean(x)))];
     const unknown=names.filter(symbol=>!unitCatalog.some(u=>[u.symbol,...(u.aliases||[])].some(a=>a.toLocaleLowerCase()===symbol.toLocaleLowerCase())));
     return unknown.length?<fieldset><legend>{ja?"保存時に作成する単位マスター":"Unit Master entries created with this recipe"}</legend>
       {unknown.map(symbol=><label key={symbol}>{symbol}
        <select aria-label={ja?symbol+"の単位分類":symbol+" unit dimension"}
         value={unitDimensionChoices[symbol]??draft.unitProposals?.find(item=>item.symbol===symbol)?.dimension??standardDimension(symbol)}
         onChange={e=>{setUnitDimensionChoices(state=>({...state,[symbol]:e.target.value}));reviewed.current=null;reviewMode.current=null;requestId.current=null;registrationPayload.current=null;setStage("dictating");}}>
         <option value="">{ja?"分類を選択":"Select dimension"}</option>
         <option value="mass">{ja?"質量":"Mass"}</option><option value="volume">{ja?"体積":"Volume"}</option>
         <option value="count">{ja?"個数":"Count"}</option><option value="other">{ja?"その他":"Other"}</option>
        </select>
       </label>)}
       <p>{ja?"新規単位はレシピ保存の承認時だけ登録されます。":"New units are created only with the approved recipe save."}</p>
      </fieldset>:null;})()}
   {draft.interpretations?.map((item,index)=><p key={index}>料理の文脈からの解釈案：{item.source} → {item.suggestion}（{item.reason}）</p>)}
   {(()=>{
    let partial=0,missing=0;
    const findUnit=(symbol:string)=>unitCatalog?.find(u=>[u.symbol,...(u.aliases||[])].some(a=>a.toLocaleLowerCase()===symbol.toLocaleLowerCase()));
    for(const material of draft.materials){
     const qty=Number(material.quantity),price=Number(material.price_jpy),basis=Number(material.price_quantity);
     const use=findUnit(material.unit),quoted=findUnit(material.price_unit);
     const compatible=Boolean(use&&quoted&&(use.id===quoted.id||
       (use.dimension===quoted.dimension&&use.base_factor!=null&&quoted.base_factor!=null)));
     const a=use&&quoted&&use.id===quoted.id?1:use?.base_factor!=null?Number(use.base_factor):null;
     const b=use&&quoted&&use.id===quoted.id?1:quoted?.base_factor!=null?Number(quoted.base_factor):null;
     if(material.quantity.trim()&&material.price_jpy.trim()&&material.price_quantity.trim()&&compatible&&a!==null&&b!==null&&Number.isFinite(qty)&&Number.isFinite(price)&&Number.isFinite(basis)&&basis>0&&qty>=0&&price>=0)partial+=qty*a!*price/(basis*b!);
     else missing++;
    }
    const yen=(value:number)=>new Intl.NumberFormat(ja?"ja-JP":"en-US",{style:"currency",currency:"JPY",maximumFractionDigits:0}).format(value);
    return <details className="draft-cost-summary" aria-label={ja?"下書き原価サマリー":"Draft cost summary"}>
     <summary>{ja?"原価サマリー":"Cost summary"} — {yen(partial)}{missing?(ja?"（部分原価）":" (partial)"):""}</summary>
     <div className="draft-cost-values"><span>{ja?(missing?"部分原価合計":"原価合計"):(missing?"Partial cost":"Total cost")}<b>{yen(partial)}</b></span><span>{ja?"売価":"Selling price"}<b>{draft.selling_price_jpy?yen(Number(draft.selling_price_jpy)):"—"}</b></span><span>{ja?"原価率":"Cost rate"}<b>{!missing&&partial>=0&&Number(draft.selling_price_jpy)>0?((partial/Number(draft.selling_price_jpy))*100).toFixed(1)+"%":(ja?"未確定":"Unconfirmed")}</b></span></div>
     {missing>0&&<p>{ja?`価格または換算条件が未確定の食材が${missing}件あるため、部分原価です。`:`${missing} ingredients have unresolved costs or conversions; showing partial cost.`}</p>}
    </details>;
   })()}
   <div className="draft-image-actions">
    <button type="button" className="draft-image-launch" onClick={()=>setDishModalOpen(true)} disabled={phase==="saving"||dishGenerating}>{dishImageUrl?(ja?"✦ 料理画像を再生成":"✦ Regenerate dish image"):(ja?"✦ 料理画像を生成":"✦ Generate dish image")}</button>
    {dishImageUrl&&<div><img src={dishImageUrl} alt={ja?"生成した料理イメージ":"Generated dish image"} style={{maxWidth:"100%"}}/><p className="muted">{ja?"生成画像はイメージです。数量・価格・完成写真の証拠にはなりません。":"Generated image is an illustration, not evidence for quantities, prices, or the finished dish."}</p></div>}
   </div>
   {dishModalOpen&&<div className="draft-image-modal-backdrop" onClick={()=>{if(!dishGenerating)setDishModalOpen(false);}}>
    <section role="dialog" aria-modal="true" aria-label={ja?"料理イメージを生成":"Generate dish image"} className="draft-image-modal" onClick={event=>event.stopPropagation()}>
     <div className="draft-image-modal-head"><h3>{ja?"✦ 料理イメージを生成":"✦ Generate dish image"}</h3><button type="button" aria-label={ja?"閉じる":"Close"} disabled={dishGenerating} onClick={()=>setDishModalOpen(false)}>×</button></div>
     <p>{ja?"レシピの内容をもとに完成料理のイメージを生成します。":"Generate a plated dish image from the recipe."}</p>
     <label>{ja?"料理イメージの指示（任意）":"Dish image hint (optional)"}<textarea value={dishHint} onChange={event=>setDishHint(event.target.value)} maxLength={200} rows={3} placeholder={ja?"例：赤ワインソースは控えめ、白い皿に美しく盛り付ける":"e.g. Elegant plating on a white plate"} disabled={dishGenerating}/></label>
     <div className="draft-image-modal-actions"><button type="button" disabled={dishGenerating} onClick={()=>setDishModalOpen(false)}>{ja?"キャンセル":"Cancel"}</button><button type="button" disabled={dishGenerating} onClick={()=>{setDishModalOpen(false);void generateDishImage();}}>{ja?"✦ 画像を生成":"✦ Generate image"}</button></div>
    </section>
   </div>}
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
   <p>{ja?"下書きは自動保存されています。「保存」で不足情報を未確定のまま保存し、後から編集できます。":"Say save once to save the current recipe. Fill missing information later."}</p>
   {sharedVoice&&<><p role="status">{sharedVoice.captureMessage}</p><a href="#voice-controls">音声操作・再開へ戻る</a></>}
   {phase==="review"&&masterReview&&<div aria-label={ja?"正式登録の確認":"Registration review"}>
    {masterReview.already_saved&&<p>{ja?"この登録は保存済みです。承認後に同じ登録IDで保存結果を再取得します。":"This registration is already saved. Approval retrieves its result with the same request ID."}</p>}
    <p>{ja?"以下のマスター変更と上のレシピ内容を確認して承認してください。価格候補の採用も承認に含まれます。":"Review these master changes and the recipe above before approving, including any selected price candidates."}</p>
    <MasterMatchReview items={masterReview.ingredients} ja={ja} disabled={busy} onChoose={(match,choice,spec)=>{
     const payload=registrationPayload.current;if(!payload)return;
     registrationPayload.current={...payload,materials:payload.materials.map(m=>m.name===match.name?{...m,ingredient_id:choice==='new'?undefined:choice,new_master:choice==='new',spec:spec.trim()||null}:m)};
     reviewed.current=null;reviewMode.current=null;setStage("dictating");void showReview();
    }}/>
    <p>{ja?"表示した価格は各食材の仕入れ先・購入条件に対する採用価格として登録します。":"Displayed prices are adopted for their supplier and purchase terms."}</p>
    <ul>{masterReview.suppliers.map((m,i)=><li key={i}>{m.name}：{m.action==="reuse"?(ja?"既存仕入先を使用":"Use existing supplier"):(ja?"仕入先を新規登録":"Create supplier")}</li>)}</ul>
    <ul>{masterReview.units.map((u,i)=><li key={i}>{ja?"単位を新規登録：":"Create unit: "}{u.symbol}（{u.dimension}）</li>)}</ul>
   </div>}
   {blocked&&<p role="status">{blocked}</p>}
   <button type="button" disabled={busy||reviewLoading||!eligible||phase==="saving"} onClick={()=>void register()}>{phase==="review"?(ja?"承認して保存":"Approve and save"):(ja?"レシピを登録":"Register recipe")}</button>
   <button type="button" disabled={phase==="saving"} onClick={clear}>{ja?"下書きを破棄":"Discard draft"}</button>
  </div>}
  <details className="voice-transcript"><summary>{ja?"認識した発話":"Recognized utterances"}（{turns.length}{ja?"件":" turns"}）</summary>{turns.length>0?<ol aria-label={ja?"認識した発話の一覧":"Recognized utterances"}>{[...turns].reverse().map((turn,index)=><li key={`${turns.length-index}`}>{turn}</li>)}</ol>:<p>{ja?"まだ発話はありません。":"No utterances yet."}</p>}</details>
  <details className="voice-photo-option"><summary>{ja?"写真からレシピを読み取る（オプション）":"Import recipe from photo (optional)"}</summary>
  <div>
   <label>{ja?"写真から下書き":"Draft from photo"}<input ref={photoFile} type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/x-icon" aria-label={ja?"解析する写真":"Photo to analyze"} disabled={phase==="saving"||photoAnalyzing}/></label>
   <input aria-label={ja?"写真のメモ（任意）":"Photo note (optional)"} value={photoMemo} onChange={event=>setPhotoMemo(event.target.value)} maxLength={1000} placeholder={ja?"分量・価格が分かる場合のみ記入":"Quantities/prices only if known"} disabled={phase==="saving"||photoAnalyzing}/>
   <button type="button" onClick={()=>void analyzePhoto()} disabled={phase==="saving"||photoAnalyzing}>{ja?"写真を解析":"Analyze photo"}</button>
  </div>
  </details>
 </section>;
}
