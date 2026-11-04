"use client";
import {useEffect,useState} from 'react';
import type {Locale} from './i18n';
import {request} from './types';
type Candidate={stale:boolean;id:string;name:string;amount_jpy:string;quantity:string;unit:string;observed_at:string;source_url:string;tax_note:string|null;shipping_note:string|null;evidence:{name?:string;seller?:string;spec?:string};current_price?:{amount_jpy?:{value?:string};per_quantity?:string;per_unit?:string};offer_price:string|null;offer_adopted_id:string|null;basis_offer_id:string|null;ingredient_adopted_id:string|null;basis_ingredient_id:string|null;supplier_name:string};
export default function PriceResearchSettings({locale}:{locale:Locale}){
 const [loaded,setLoaded]=useState(false);
 const ja=locale==='ja';const [enabled,setEnabled]=useState(false),[hours,setHours]=useState(24),[items,setItems]=useState<Candidate[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState('');
 async function load(){const data=await request<{settings:{enabled:boolean;interval_hours:number};candidates:Candidate[]}>('/api/price-research');setLoaded(true);setEnabled(data.settings.enabled);setHours(data.settings.interval_hours);setItems(data.candidates);}
 useEffect(()=>{let active=true;void request<{settings:{enabled:boolean;interval_hours:number};candidates:Candidate[]}>('/api/price-research').then(d=>{if(active){setLoaded(true);setEnabled(d.settings.enabled);setHours(d.settings.interval_hours);setItems(d.candidates);}}).catch(()=>{if(active)setError(ja?'価格調査設定を取得できません。':'Could not load research settings.');}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[ja]);
 async function action(run:()=>Promise<unknown>){setBusy(true);setError('');try{await run();await load();}catch{setError(ja?'更新できません。最新状態を再取得して確認してください。':'Update rejected. Reload and review current data.');}finally{setBusy(false);}}
 return <section aria-label={ja?'定期価格調査の設定と候補':'Scheduled research settings and candidates'} className="space-y-4">
  <form onSubmit={e=>{e.preventDefault();void action(()=>request('/api/price-research',{method:'PATCH',body:JSON.stringify({enabled,interval_hours:hours})}));}}>
   <label className="flex items-center gap-2"><input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={e=>setEnabled(e.target.checked)}/>{ja?'定期価格調査を有効にする':'Enable scheduled price research'}</label>
   <label>{ja?'調査間隔（時間）':'Research interval (hours)'}<input type="number" min={1} max={8760} required value={hours} disabled={busy} onChange={e=>setHours(Number(e.target.value))}/></label>
   <p>{ja?'全体ONかつ食材ONの対象だけを調査します。結果は未採用の参考価格です。':'Only ingredients with both switches enabled are researched. Results remain unadopted references.'}</p>
   <button disabled={busy||!loaded}>{ja?'設定を保存':'Save settings'}</button>
  </form>
  <button type="button" disabled={busy} onClick={()=>void action(async()=>{})}>{ja?'最新状態を再取得':'Reload'}</button>
  {error&&<p role="alert">{error}</p>}
  <h3>{ja?'未採用の価格候補':'Unadopted price candidates'}</h3>
  <p>{ja?'規格・数量・税・送料を確認して採用してください。同じ採用Offerまたは共通価格を参照するレシピに反映されます。別の仕入れ先・購入条件は変わりません。':'Review specification, quantity, tax and shipping. Adoption updates recipes using this offer or the shared price; other suppliers and terms stay separate.'}</p>
  {items.length===0&&<p>{ja?'価格候補はありません。':'No price candidates.'}</p>}
  {items.map(c=>{const stale=c.stale||c.offer_adopted_id!==c.basis_offer_id||c.ingredient_adopted_id!==c.basis_ingredient_id;return <article key={c.id} className="rounded-xl border border-emerald-800 p-3 space-y-2">
   <h4>{c.name}</h4><p>{ja?'現在の採用価格':'Current shared price'}: {c.current_price?.amount_jpy?.value??'—'} / {c.current_price?.per_quantity??'—'} {c.current_price?.per_unit??''}</p>
   <p>{ja?'同じ購入条件の採用価格':'Adopted price for these terms'}: ¥{c.offer_price??'—'} / {c.quantity} {c.unit}</p>
   <p><strong>{ja?'参考候補':'Reference candidate'}: ¥{c.amount_jpy} / {c.quantity} {c.unit}</strong> · {c.supplier_name}</p>
   <p>{c.evidence.name} / {c.evidence.seller} / {c.evidence.spec} · {c.tax_note??(ja?'税不明':'Tax unknown')} · {c.shipping_note??(ja?'送料不明':'Shipping unknown')}</p>
   <p>{new Date(c.observed_at).toLocaleString(locale)}</p><a href={c.source_url} target="_blank" rel="noopener noreferrer">{ja?'調査元を確認':'View source'}</a>
   {stale&&<p>{ja?'採用価格が変わりました。再調査が必要です。':'Adopted price changed. Research again.'}</p>}
   <button type="button" disabled={busy||stale} onClick={()=>{if(window.confirm(ja?`${c.name}: ¥${c.amount_jpy} / ${c.quantity} ${c.unit} を採用しますか？`:`Adopt ${c.name}: ¥${c.amount_jpy} / ${c.quantity} ${c.unit}?`))void action(()=>request('/api/price-research/adopt',{method:'POST',body:JSON.stringify({observation_id:c.id})}));}}>{ja?'条件を確認して価格を採用':'Review terms and adopt price'}</button>
  </article>;})}
 </section>;
}
