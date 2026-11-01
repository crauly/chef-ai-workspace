// Shared ledger-first price enrichment (SSOT for row binding + lookup).
// Used by POST /api/voice-recipe (inline enrichment) and
// POST /api/voice-recipe/prices (deferred enrichment). Stateless: the
// caller supplies the current materials snapshot, so every entry is
// (re-)bound against fresh rows and a stale index can never attach a
// price to the wrong row.
import {runGroundedSearch} from "./price-web-search";
import type {GroundedSample} from "./price-web-search";
import {detectPriceResearch} from "./price-research-intent";
import {backendUrl} from "./app/api/backend-url";

export type ReferenceSummary={available:boolean;currency?:string;unit_basis?:string;average_unit_price?:string;observation_count?:number;observed_to?:string|null};
export type ReferenceCandidate={ingredient_id:string;ingredient_name:string;reference:ReferenceSummary;observations?:unknown[]};
export type LedgerLookup={kind:"ok";candidates:ReferenceCandidate[]}|{kind:"unavailable"|"unauthorized"|"invalid_response"};
export type ResearchStatus={material_name:string;material_index:number;request:string;trigger:"muse"|"heuristic";
 ledger:"available"|"none"|"unavailable"|"unauthorized"|"invalid_response";
 web:"not_attempted"|"available"|"empty"|"not_searched"|"provider_error"|"timeout"|"misconfigured";
 provisional:boolean};
export type ProvisionalPrice={material_index:number;material_name:string;origin:"ledger"|"external";
 price_jpy:string;price_quantity:string;price_unit:string;currency:string;observation_count:number;
 sources:{url:string;title:string}[];samples:GroundedSample[];fetched_at:string|null;
 status:"provisional";approval:"unapproved";text:string};
export type PriceReferenceEntry={material_name:string;material_index:number;status:"available"|"none"|"unavailable"|"unauthorized"|"invalid_response";origin:"ledger"|"external";ingredient_name:string|null;currency:string|null;unit_basis:string|null;average_unit_price:string|null;observation_count:number|null;observed_to:string|null;sources?:{url:string;title:string}[];fetched_at?:string;samples?:{name:string;seller:string;source:string;amount:string;package:string;url?:string;fetched_at?:string;tax_note?:string;shipping_note?:string;maker?:string;spec?:string}[];text:string};
export type ResearchEntry={material_name:string;request:string;trigger:"muse"|"heuristic";material_index:number};
export type DraftMaterial={name:string;price_jpy:string;price_quantity:string;price_unit:string};

// Canonical row key: an exact row-name match beats a contradictory
// in-range material_index (the name is hard evidence against that
// pointer); otherwise a valid material_index wins (it names the row even
// when the spoken product wording drifts); otherwise the entry stays
// rowless (-1) and is still searched by name but can never bind a
// provisional to a row it might miss.
// Identity-checked binding for deferred entries: the caller echoes the
// row name the entry was created against (row_name). A pointer is honored
// only while the row still carries that name; a deletion, reorder, or
// rename that moves another ingredient under the old number discards the
// pointer and falls back to an exact searched-name match, else rowless.
// Without a row_name (legacy callers) the historical rule applies.
export function bindRow(materials:{name:string}[],materialName:string,
 rowName:string|null|undefined,idx:number|null|undefined){
 if(idx===-1)return -1;
 if(typeof idx==="number"&&idx>=0&&idx<materials.length&&
  typeof rowName==="string"&&rowName.trim()&&
  (materials[idx].name||"").trim()===rowName.trim())return idx;
 if(typeof rowName==="string"&&rowName.trim()){
  return materials.findIndex(m=>(m.name||"").trim()===materialName.trim());
 }
 return rowIndexFor(materials,materialName,idx);
}

export function rowIndexFor(materials:{name:string}[],name:string,idx:number|null|undefined){
 const at=materials.findIndex(m=>(m.name||"").trim()===name.trim());
 const valid=typeof idx==="number"&&Number.isInteger(idx)&&idx>=0&&idx<materials.length?idx:-1;
 if(at>=0&&valid>=0&&at!==valid)return at;
 if(valid>=0)return valid;
 return at;
}

export async function lookupCandidates(name:string):Promise<LedgerLookup>{
 const url=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN;
 // No connection means configured: the ledger cannot be reached, which is
 // NOT the same as "no history". Never report this as not-found.
 if(!url||!token)return {kind:"unavailable"};
 try{
  const target=new URL("/demo/price-reference",url);
  target.searchParams.set("name",name);
  const response=await fetch(target,{headers:{"X-Demo-Access":token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});
  if(response.status===401||response.status===403)return {kind:"unauthorized"};
  if(!response.ok)return response.status>=500?{kind:"unavailable"}:{kind:"invalid_response"};
  const data:unknown=await response.json();
  if(!data||typeof data!=="object"||!Array.isArray((data as {candidates?:unknown}).candidates))return {kind:"invalid_response"};
  const list=(data as {candidates:unknown}).candidates as ReferenceCandidate[];
  if(!list.every(c=>c&&typeof c==="object"&&typeof (c as ReferenceCandidate).ingredient_name==="string"&&
    (c as ReferenceCandidate).reference&&typeof (c as ReferenceCandidate).reference==="object"&&
    typeof (c as ReferenceCandidate).reference.available==="boolean"))return {kind:"invalid_response"};
  return {kind:"ok",candidates:list};
 }catch{return {kind:"unavailable"};}
}

function formatAmount(average:string,basis:string,currency:string):string{
 // JPY contract only for yen; other currencies shown verbatim, never converted.
 return currency==="JPY"?`${basis}あたり平均${average}円`:`${basis}あたり平均${average} ${currency}`;
}

function lookupFailure(materialName:string,materialIndex:number,kind:"unavailable"|"unauthorized"|"invalid_response"):PriceReferenceEntry{
 // Failure states stay distinct from "no history" and never leak connection
 // or credential details. The draft path is unaffected: the chef can still
 // save with unconfirmed prices.
 const wanted=materialName.trim();
 const reason=kind==="unauthorized"?"認証に失敗したため":
  kind==="invalid_response"?"応答が不正だったため":"接続・設定の問題で";
 return {material_name:wanted,material_index:materialIndex,status:kind,origin:"ledger",ingredient_name:null,currency:null,unit_basis:null,
  average_unit_price:null,observation_count:null,observed_to:null,
  text:`確認できません：${wanted}の仕入履歴は${reason}参照できませんでした（価格未確定のまま保存できます）`};
}

export function selectReference(materialName:string,materialIndex:number,lookup:LedgerLookup):PriceReferenceEntry{
 if(lookup.kind!=="ok")return lookupFailure(materialName,materialIndex,lookup.kind);
 const wanted=materialName.trim();
 const available=lookup.candidates.filter(c=>c.reference.available);
 const exact=available.find(c=>c.ingredient_name.trim()===wanted);
 const chosen=exact||available[0];
 if(!chosen||typeof chosen.reference.average_unit_price!=="string"||
    typeof chosen.reference.unit_basis!=="string"||typeof chosen.reference.currency!=="string"){
  return {material_name:wanted,material_index:materialIndex,status:"none",origin:"ledger",ingredient_name:null,currency:null,unit_basis:null,
   average_unit_price:null,observation_count:null,observed_to:null,
   text:`参考価格なし：${wanted}の仕入履歴がありません（価格未確定のまま保存できます）`};
 }
 const ref=chosen.reference;
 const currency=ref.currency as string,basis=ref.unit_basis as string,average=ref.average_unit_price as string;
 const count=typeof ref.observation_count==="number"?ref.observation_count:0;
 const when=typeof ref.observed_to==="string"&&ref.observed_to?`・${ref.observed_to}時点`:"";
 // A non-exact candidate is only ever a named suggestion for the chef to
 // judge; its ingredient is stated explicitly, never merged silently.
 const prefix=chosen.ingredient_name.trim()===wanted?`参考価格：${chosen.ingredient_name}は`:
  `参考価格（完全一致なし・${chosen.ingredient_name}の履歴を参考）：`;
 return {material_name:wanted,material_index:materialIndex,status:"available",origin:"ledger",ingredient_name:chosen.ingredient_name,
  currency,unit_basis:basis,average_unit_price:average,
  observation_count:count,observed_to:typeof ref.observed_to==="string"?ref.observed_to:null,
  text:`${prefix}${formatAmount(average,basis,currency)}（あなたの仕入履歴${count}件${when}・推定・要確認）`};
}

// Row binding is index-based: refs carry the materials[] index resolved
// at request time, and the provisional is labeled with the ROW name so the
// UI row gate (index + name) holds even when the searched product wording
// differs. The searched name survives in price_references/research_status.
export function provisionalFor(index:number,material:{name:string},refs:PriceReferenceEntry[]):ProvisionalPrice|null{
 const ref=refs.find(r=>r.material_index===index);
 if(!ref||ref.status!=="available"||typeof ref.average_unit_price!=="string"||
  typeof ref.unit_basis!=="string"||typeof ref.currency!=="string"||typeof ref.observation_count!=="number")return null;
 return {material_index:index,material_name:(material.name||"").trim(),origin:ref.origin,
  price_jpy:ref.average_unit_price,price_quantity:"1",price_unit:ref.unit_basis,currency:ref.currency,
  observation_count:ref.observation_count,sources:ref.sources??[],samples:ref.samples??[],
  fetched_at:ref.fetched_at??ref.observed_to??null,status:"provisional",approval:"unapproved",
  text:`（未承認の仮設定候補）${ref.text}`};
}

// Muse entries first, then the narrow heuristic gap-fill for
// still-unconfirmed lines (stated prices never match). Cap stays 3.
export function assembleEntries(materials:DraftMaterial[],
 priceResearch:{material_name:string;request:string;material_index?:number|null}[],
 turns:string[]):ResearchEntry[]{
 const museEntries=priceResearch.map(e=>({...e,trigger:"muse" as const,
  material_index:rowIndexFor(materials,e.material_name,e.material_index)}));
 const coveredNames=new Set(museEntries.map(e=>e.material_name.trim()));
 const coveredRows=new Set(museEntries.map(e=>e.material_index).filter(i=>i>=0));
 const heuristicEntries=detectPriceResearch(turns,materials)
  .filter(h=>!coveredNames.has(h.material_name.trim())&&!coveredRows.has(h.material_index))
  .map(h=>({...h,trigger:"heuristic" as const}));
 return [...museEntries,...heuristicEntries].slice(0,3);
}

// Ledger-first per entry; grounding failures keep the ledger entry and
// are reported in research_status, so the draft never fails and the
// failure reason is never lost. Entries run concurrently (cap 3 bounds
// the fan-out); result order follows entry order, never completion order.
export async function enrichEntries(apiKey:string,entries:ResearchEntry[]){
 const settled=await Promise.all(entries.map(async entry=>{
  const row=entry.material_index;
  const ledgerEntry=selectReference(entry.material_name,row,await lookupCandidates(entry.material_name));
  if(ledgerEntry.status==="available"){
   // Owned ledger wins: no web search when usable history exists.
   return {ref:ledgerEntry,
    status:{material_name:entry.material_name,material_index:row,request:entry.request,
     trigger:entry.trigger,ledger:ledgerEntry.status,web:"not_attempted",provisional:true} as ResearchStatus};
  }
  const outcome=await runGroundedSearch({apiKey,materialName:entry.material_name,request:entry.request});
  if(outcome.kind==="found"||outcome.kind==="empty"){
   return {ref:{...outcome.entry,material_index:row} as PriceReferenceEntry,
    status:{material_name:entry.material_name,material_index:row,request:entry.request,
     trigger:entry.trigger,ledger:ledgerEntry.status,web:outcome.kind==="found"?"available":"empty",
     provisional:outcome.kind==="found"} as ResearchStatus};
  }
  return {ref:ledgerEntry,
   status:{material_name:entry.material_name,material_index:row,request:entry.request,
    trigger:entry.trigger,ledger:ledgerEntry.status,web:outcome.kind,provisional:false} as ResearchStatus};
 }));
 return {priceReferences:settled.map(s=>s.ref),
  researchStatus:settled.map(s=>s.status)};
}
