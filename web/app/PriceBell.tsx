"use client";
import {useCallback,useEffect,useState} from "react";
type Notification={id:string;observation_id:string;ingredient_id:string;change_jpy:string|null;status:string;created_at:string};
type ImpactItem={recipe_id:string;title:string|null;current_total:string|null;hypo_total:string|null;diff:string|null};
type Detail={notification:Notification;observation:{id:string;amount_jpy:string;currency:string;observed_at:string;supplier_id:string|null}|null;basis_observation_id:string|null;comparable:boolean;reasons:string[];items:ImpactItem[]};
async function read<T>(path:string,init?:RequestInit):Promise<T>{
 const response=await fetch(path,{...init,headers:{"Content-Type":"application/json",...(init?.headers||{})}});
 if(!response.ok)throw new Error(`request failed: ${response.status}`);
 return response.json() as Promise<T>;
}
export default function PriceBell({locale}:{locale:string}){
 const [items,setItems]=useState<Notification[]>([]);
 const [openId,setOpenId]=useState<string|null>(null);
 const [detail,setDetail]=useState<Detail|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const ja=locale==="ja";
 const reload=useCallback(async()=>{
  try{const result=await read<{items:Notification[]}>("/api/notifications");
   setItems(result.items);setError("");
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
  }catch{setError(ja?"状態を更新できませんでした。":"Could not update status.");}
  finally{setBusy(false);}
 }
 const unread=items.filter(i=>i.status==="unread").length;
 return <section className="card" aria-label={ja?"価格通知":"Price notifications"}>
  <div className="toolbar"><h2>{ja?"価格通知":"Price notifications"} 🔔 {unread>0&&<span role="status">({unread}{ja?"件の未読":" unread"})</span>}</h2>
  <button type="button" disabled={busy} onClick={()=>void reload()}>{ja?"更新":"Refresh"}</button></div>
  {error&&<p role="alert" className="error">{error}</p>}
  {items.length===0?<p className="muted">{ja?"通知はありません。":"No notifications."}</p>:
  <ul>{items.map(n=><li key={n.id}>
   <button type="button" disabled={busy} onClick={()=>setOpenId(openId===n.id?null:n.id)}>
    {n.status==="unread"?ja?"未読": "Unread":n.status==="acknowledged"?(ja?"既読":"Read"):(ja?"対応済み":"Done")} — {n.change_jpy===null?(ja?"変動なし":"No change"):`${Number(n.change_jpy)>=0?"+":""}${n.change_jpy}円/g`}
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
 </section>;
}
