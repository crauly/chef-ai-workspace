"use client";
import {useRef,useState} from "react";
type Comparison={comparable:boolean;reasons:string[];currency:string|null;unit_basis:string|null;diff:string|null;rate_pct:string|null};
type Candidate={kind:string;ingredient_id:string;ingredient_name:string|null;offer_id:string|null;supplier_name:string|null;product_url:string|null;amount:string|null;currency:string|null;package_quantity:string|null;package_unit:string|null;shipping_note:string|null;tax_note:string|null;source:string|null;observed_at:string|null;data_origin:string;unknowns:string[];comparison:Comparison|null};
type Result={ingredient_id:string;ingredient_name:string|null;candidates:Candidate[];total_found:number;returned:number;shortage_note:string|null;provider:{available:boolean;reason:string}};
type AxisPick={axis:string;candidate_index:number;candidate:Candidate;reason:string;reason_source:string;confidence:string|null};
type AxisSlot={pick:AxisPick|null;label:string;empty_reason?:string};
type AxisResult={ingredient_id:string;ingredient_name:string|null;axes:{cost:AxisSlot;compatibility:AxisSlot;quality:AxisSlot};picks:AxisPick[];returned:number;shortage_note:string|null;provider:{external:{available:boolean;reason:string};muse:{used:boolean;evaluated:number;skipped:number;error:string|null}}};
async function read<T>(path:string):Promise<T>{
 const response=await fetch(path,{headers:{"Content-Type":"application/json"}});
 if(!response.ok){const err=new Error(`request failed: ${response.status}`);(err as {status?:number}).status=response.status;throw err;}
 return response.json() as Promise<T>;
}
function verdict(c:Candidate,ja:boolean):string{
 if(!c.comparison)return ja?"採用価格なしのため比較なし":"No adopted basis; no comparison";
 if(!c.comparison.comparable)return (c.comparison.reasons.join("; ")||(ja?"比較不可":"Not comparable"));
 const sign=Number(c.comparison.diff)>=0?"+":"";
 const currency=c.comparison.currency||"JPY";
 const shown=c.comparison.unit_basis?(currency==="JPY"?`${sign}${c.comparison.diff}${ja?"円":" JPY"}/${c.comparison.unit_basis}`:`${sign}${c.comparison.diff} ${currency}/${c.comparison.unit_basis}`):`${sign}${c.comparison.diff} ${currency}`;
 return `${shown}${c.comparison.rate_pct?` (${c.comparison.rate_pct}%)`:""}`;
}
export default function SourcingSuggestions({locale}:{locale:string}){
 const [ingredientId,setIngredientId]=useState("");
 const [result,setResult]=useState<Result|null>(null);
 const [axes,setAxes]=useState<AxisResult|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const [axisBusy,setAxisBusy]=useState(false);
 const axisSeq=useRef(0);
 const ja=locale==="ja";
 async function lookup(e:React.FormEvent){
  e.preventDefault();
  const id=ingredientId.trim();
  if(!id)return;
  setBusy(true);
  try{
   const data=await read<Result>(`/api/sourcing-suggestions?ingredient_id=${encodeURIComponent(id)}`);
   // A retargeted search invalidates any in-flight axis request: the
   // late response is ignored by sequence, and busy is released here
   // so the button never wedges on an orphaned request.
   axisSeq.current++;setAxisBusy(false);
   setResult(data);setAxes(null);setError("");
  }catch(e){const code=(e as {status?:number}).status;
   if(code===404)setError(ja?"食材が見つかりません。":"Ingredient not found.");
   else setError(ja?"候補を取得できませんでした。":"Could not load suggestions.");}
  finally{setBusy(false);}
 }
 async function lookupAxes(){
  // Bind to the displayed candidate result, never the live input: a
  // retargeted search or a late response must not mix ingredients.
  const target=result?.ingredient_id;
  if(!target||axisBusy)return;
  const seq=++axisSeq.current;setAxisBusy(true);
  try{
   const data=await read<AxisResult>(`/api/axis-suggestions?ingredient_id=${encodeURIComponent(target)}&max_candidates=3`);
   if(axisSeq.current!==seq)return;
   setAxes(data);setError("");
  }catch{if(axisSeq.current===seq)setError(ja?"軸別候補を取得できませんでした。":"Could not load axis picks.");}
  finally{if(axisSeq.current===seq)setAxisBusy(false);}
 }
 function extraPicks(axes:AxisResult,ja:boolean){
  const slotted=new Set([axes.axes.cost.pick,axes.axes.compatibility.pick,axes.axes.quality.pick].filter((p):p is AxisPick=>p!==null).map(p=>p.candidate_index));
  const rest=axes.picks.filter(p=>!slotted.has(p.candidate_index));
  if(rest.length===0)return null;
  return <div><p className="muted">{ja?"その他の候補（コスト順の予備）":"Other candidates (cost-ordered backups)"}</p>
   <ul>{rest.map((p,i)=>{const c=p.candidate;return <li key={`extra-${p.candidate_index}-${i}`}>
    <span>{c.ingredient_name||c.ingredient_id}{c.supplier_name?` / ${c.supplier_name}`:""}</span>
    <br/><span>{c.amount!==null?`${c.amount}${c.currency||""}`:(ja?"価格情報なし":"No price")} {c.package_quantity&&c.package_unit?`(${c.package_quantity}${c.package_unit})`:""}</span>
    <br/><span className="muted">{ja?"比較":"Comparison"}: {verdict(c,ja)}</span>
    {c.product_url&&<span> <a href={c.product_url} target="_blank" rel="noreferrer">{ja?"出典":"Source"}</a></span>}
    {c.unknowns.length>0&&<span className="muted"> [{c.unknowns.join("; ")}]</span>}
   </li>;})}</ul></div>;
 }
 function axisSlot(slot:AxisSlot,ja:boolean){
  if(!slot.pick)return <p className="muted">{slot.label}: {slot.empty_reason||(ja?"選定なし":"No pick")}</p>;
  const c=slot.pick.candidate;
  return <div><p><strong>{slot.label}</strong> — {c.ingredient_name||c.ingredient_id}{c.supplier_name?` / ${c.supplier_name}`:""}</p>
   <p className="muted">{ja?"理由":"Reason"}: {slot.pick.reason}{slot.pick.reason_source==="muse"&&slot.pick.confidence?` (${ja?"確信度":"confidence"}: ${slot.pick.confidence})`:""}</p>
   <p className="muted">{ja?"比較":"Comparison"}: {verdict(c,ja)}{c.source?` / ${ja?"出典":"Source"}: ${c.source}`:""}{c.observed_at?` (${c.observed_at})`:""}{c.unknowns.length>0?` [${c.unknowns.join("; ")}]`:""}</p></div>;
 }
 return <section className="card" aria-label={ja?"代替・購入先候補":"Sourcing suggestions"}>
  <div className="toolbar"><h2>{ja?"代替・購入先候補":"Substitute sourcing"}</h2></div>
  <p className="muted">{ja?"提案のみ。食材・仕入先・価格の変更は行いません。":"Proposals only. Nothing is changed."}</p>
  {error&&<p role="alert" className="error">{error}</p>}
  <form onSubmit={lookup}>
   <input aria-label={ja?"食材ID":"Ingredient ID"} placeholder={ja?"食材ID":"Ingredient ID"} value={ingredientId} onChange={e=>setIngredientId(e.target.value)} required/>
   <button type="submit" disabled={busy||!ingredientId.trim()}>{ja?"候補を探す":"Find candidates"}</button>
  </form>
  {result&&<div>
   <p className="muted">{result.ingredient_name||result.ingredient_id} — {ja?"候補":"candidates"}: {result.returned}/{result.total_found}</p>
   {result.shortage_note&&<p className="muted">{result.shortage_note}</p>}
   {!result.provider.available&&<p className="muted">{ja?"外部Web取得は未利用":"External web retrieval unavailable"}: {result.provider.reason}</p>}
   {result.candidates.length===0?<p className="muted">{ja?"候補がありません。":"No candidates."}</p>:
   <ul>{result.candidates.map((c,i)=><li key={`${c.kind}-${c.offer_id||c.ingredient_id}-${i}`}>
    <strong>{c.kind==="same_product_same_supplier"?(ja?"同商品・同仕入先の別条件":"Same product, same supplier"):c.kind==="same_product_other_supplier"?(ja?"同商品・別仕入先":"Same product, other supplier"):c.kind==="same_product_unknown_supplier"?(ja?"仕入先不明の別購入条件":"Unknown-supplier purchase term"):(ja?"類似商品（要確認）":"Similar product (review needed)")}</strong>
    <span> — {c.ingredient_name||c.ingredient_id}{c.supplier_name?` / ${c.supplier_name}`:""}</span>
    <br/><span>{c.amount!==null?`${c.amount}${c.currency||""}`:(ja?"価格情報なし":"No price")} {c.package_quantity&&c.package_unit?`(${c.package_quantity}${c.package_unit})`:""}
    {c.shipping_note?` / ${c.shipping_note}`:""} {c.tax_note?` / ${c.tax_note}`:""}</span>
    <br/><span className="muted">{ja?"比較":"Comparison"}: {verdict(c,ja)}</span>
    {c.product_url&&<span> <a href={c.product_url} target="_blank" rel="noreferrer">{ja?"出典":"Source"}</a></span>}
    {c.observed_at&&<span className="muted"> ({c.observed_at})</span>}
    {c.unknowns.length>0&&<span className="muted"> [{c.unknowns.join("; ")}]</span>}
   </li>)}</ul>}
   <div className="toolbar"><button type="button" onClick={lookupAxes} disabled={axisBusy||!ingredientId.trim()}>{ja?"3軸で比べる（コスト・互換性・品質）":"Compare on 3 axes"}</button></div>
   {axes&&axes.ingredient_id===result?.ingredient_id&&<div>
    <p className="muted">{ja?"軸別選定":"Axis picks"} ({axes.ingredient_name||axes.ingredient_id}): {axes.returned}{axes.shortage_note?` — ${axes.shortage_note}`:""}</p>
    {!axes.provider.external.available&&<p className="muted">{ja?"外部Web取得は未利用":"External web retrieval unavailable"}: {axes.provider.external.reason}</p>}
    {!axes.provider.muse.used&&<p className="muted">{ja?"Muse評価なし（コスト軸のみ確定計算）":"No Muse evaluation (cost axis only)"}{axes.provider.muse.error?`: ${axes.provider.muse.error}`:""}</p>}
    {axisSlot(axes.axes.cost,ja)}
    {axisSlot(axes.axes.compatibility,ja)}
    {axisSlot(axes.axes.quality,ja)}
    {extraPicks(axes,ja)}
   </div>}
  </div>}
 </section>;
}
