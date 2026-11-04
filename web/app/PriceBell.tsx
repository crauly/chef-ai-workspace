"use client";
import {useCallback,useEffect,useRef,useState} from "react";
type Notification={id:string;observation_id:string;ingredient_id:string;change_jpy:string|null;unit_basis:string|null;currency:string|null;status:string;created_at:string};
type ImpactItem={recipe_id:string;title:string|null;current_total:string|null;hypo_total:string|null;diff:string|null};
type Detail={notification:Notification;observation:{id:string;amount_jpy:string;currency:string;observed_at:string;supplier_id:string|null}|null;basis_observation_id:string|null;comparable:boolean;comparison:{unit_basis:string|null;currency:string|null;diff:string|null;rate_pct:string|null}|null;reasons:string[];items:ImpactItem[]};
async function read<T>(path:string,init?:RequestInit):Promise<T>{
 const response=await fetch(path,{...init,headers:{"Content-Type":"application/json",...(init?.headers||{})}});
 if(!response.ok){const err=new Error(`request failed: ${response.status}`);(err as {status?:number}).status=response.status;throw err;}
 return response.json() as Promise<T>;
}
function changeLabel(n:Notification,ja:boolean):string{
 if(n.change_jpy===null||n.change_jpy===undefined)return ja?"変動なし":"No change";
 const sign=Number(n.change_jpy)>=0?"+":"";
 const unit=n.unit_basis?`円/${n.unit_basis}`:(ja?"円":" JPY");
 return `${sign}${n.change_jpy}${unit}`;
}
export default function PriceBell({locale}:{locale:string}){
 const [researchCount,setResearchCount]=useState(0);
 const [items,setItems]=useState<Notification[]>([]);
 const [openId,setOpenId]=useState<string|null>(null);
 const [detail,setDetail]=useState<Detail|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const [observationId,setObservationId]=useState("");
 const [open,setOpen]=useState(false);
 const [animate,setAnimate]=useState(false);
 const previousUnread=useRef<number|null>(null);
 const ja=locale==="ja";
 const reload=useCallback(async()=>{
  try{const result=await read<{items:Notification[]}>("/api/notifications");
   setItems(result.items);setError("");
   try{const research=await read<{candidates:unknown[]}>("/api/price-research");setResearchCount(research.candidates.length);}catch{}
  }catch{setError(ja?"通知を取得できませんでした。":"Could not load notifications.");}
 },[ja]);
 useEffect(()=>{void reload();},[reload]);
 useEffect(()=>{
  if(!openId){setDetail(null);return;}
  let active=true;
  read<Detail>(`/api/notifications/${openId}`).then(d=>{if(active){setDetail(d);setError("");}}).catch(()=>{if(active)setError(ja?"詳細を取得できませんでした。":"Could not load detail.");});
  return ()=>{active=false;};
 },[openId,ja]);
 async function move(id:string,status:string){
  setBusy(true);
  try{await read(`/api/notifications/${id}`,{method:"PATCH",body:JSON.stringify({status})});
   setError("");await reload();
   if(openId===id){const d=await read<Detail>(`/api/notifications/${id}`);setDetail(d);}
  }catch(e){const code=(e as {status?:number}).status;
   if(code===409){setError(ja?"他の操作と競合しました。一覧を更新しました。":"Conflicted with another update. List refreshed.");await reload();}
   else setError(ja?"状態を更新できませんでした。":"Could not update status.");}
  finally{setBusy(false);}
 }
 async function confirm(e:React.FormEvent){
  e.preventDefault();
  const id=observationId.trim();
  if(!id)return;
  setBusy(true);
  try{await read("/api/notifications",{method:"POST",body:JSON.stringify({observation_id:id})});
   setObservationId("");setError("");await reload();
  }catch(e){const code=(e as {status?:number}).status;
   if(code===422)setError(ja?"比較できない価格のため通知を作成しませんでした。":"Not comparable; no notification created.");
   else setError(ja?"確認を作成できませんでした。":"Could not confirm the observation.");}
  finally{setBusy(false);}
 }
 const unread=items.filter(i=>i.status==="unread").length+researchCount;
 useEffect(()=>{
  if(previousUnread.current!==null&&unread>previousUnread.current)setAnimate(true);
  previousUnread.current=unread;
 },[unread]);
 return <div className="price-bell-wrap">
  <button type="button" className={"price-bell-trigger"+(animate?" price-bell-ring":"")} aria-label={ja?"価格通知を開く":"Open price notifications"} aria-expanded={open} aria-controls="price-notifications-panel" onAnimationEnd={()=>setAnimate(false)} onClick={()=>setOpen(value=>!value)}>
   <svg width="22" height="22" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
   {unread>0&&<span className="price-bell-count" aria-hidden="true">{unread>99?"99+":unread}</span>}
   {error&&<span className="price-bell-error" aria-hidden="true">!</span>}
  </button>
  {open&&<section id="price-notifications-panel" className="price-bell-panel" aria-label={ja?"価格通知":"Price notifications"}>
  <div className="toolbar"><h2>{ja?"価格通知":"Price notifications"} {unread>0&&<span role="status">({unread}{ja?"件の未読":" unread"})</span>}</h2>
  <button type="button" disabled={busy} onClick={()=>void reload()}>{ja?"更新":"Refresh"}</button><button type="button" onClick={()=>setOpen(false)} aria-label={ja?"通知を閉じる":"Close notifications"}>×</button></div>
  <div className="toolbar"><h2>{ja?"価格通知":"Price notifications"} 🔔 {unread>0&&<span role="status">({unread}{ja?"件の未読":" unread"})</span>}</h2>
  <button type="button" disabled={busy} onClick={()=>void reload()}>{ja?"更新":"Refresh"}</button></div>
  {error&&<p role="alert" className="error">{error}</p>}
  <a href="/settings?section=research">{ja?`未採用の定期調査候補（${researchCount}件）`:`Scheduled price candidates (${researchCount})`}</a>
  <details className="price-bell-advanced"><summary>{ja?"価格観測から通知を作成":"Create notification from observation"}</summary><form onSubmit={confirm}>
   <input aria-label={ja?"価格観測ID":"Price observation ID"} placeholder={ja?"価格観測ID":"Price observation ID"} value={observationId} onChange={e=>setObservationId(e.target.value)} required/>
   <button type="submit" disabled={busy||!observationId.trim()}>{ja?"価格を確認して通知":"Confirm price"}</button>
  </form></details>
  {items.length===0?<p className="muted">{ja?"通知はありません。":"No notifications."}</p>:
  <ul>{items.map(n=><li key={n.id}>
   <button type="button" disabled={busy} onClick={()=>setOpenId(openId===n.id?null:n.id)}>
    {n.status==="unread"?ja?"未読": "Unread":n.status==="acknowledged"?(ja?"既読":"Read"):(ja?"対応済み":"Done")} — {changeLabel(n,ja)}
   </button>
   {openId===n.id&&detail&&detail.notification.id===n.id&&<div>
    <p className="muted">{ja?"対象食材":"Ingredient"}: {detail.notification.ingredient_id} / {ja?"観測":"Observation"}: {detail.observation?.amount_jpy}円 ({detail.observation?.observed_at})</p>
    {detail.comparable?<ul>{detail.items.map(i=><li key={i.recipe_id}>{i.title||i.recipe_id}: {i.current_total??"—"} → {i.hypo_total??"—"} ({i.diff===null?(ja?"要確認":"Review"):i.diff})</li>)}</ul>
    :<p className="muted">{detail.reasons.join("; ")}</p>}
    <div className="toolbar">
     {n.status==="unread"&&<button type="button" disabled={busy} onClick={()=>void move(n.id,"acknowledged")}>{ja?"既読にする":"Mark read"}</button>}
     {n.status!=="resolved"&&<button type="button" disabled={busy} onClick={()=>void move(n.id,"resolved")}>{ja?"対応済みにする":"Mark done"}</button>}
     {n.status==="acknowledged"&&<button type="button" disabled={busy} onClick={()=>void move(n.id,"unread")}>{ja?"未読に戻す":"Back to unread"}</button>}
    </div>
   </div>}
  </li>)}</ul>}
 </section>}
 </div>;
}
