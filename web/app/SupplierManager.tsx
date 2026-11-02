"use client";
import {useEffect,useState} from "react";
type Supplier={id:string;name:string;note:string|null};
export default function SupplierManager({locale}:{locale:string}){
 const ja=locale==="ja";
 const [items,setItems]=useState<Supplier[]>([]);
 const [name,setName]=useState(""),[note,setNote]=useState("");
 const [editing,setEditing]=useState<string|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const [page,setPage]=useState(1);
 async function load(){
  const res=await fetch(`/api/suppliers?page=${page}&page_size=50`,{cache:"no-store"});
  if(!res.ok)throw new Error(String(res.status));
  const data=await res.json() as {items:Supplier[]};setItems(data.items);
 }
 useEffect(()=>{void load().catch(()=>setError(ja?"仕入先を取得できません":"Could not load suppliers"));},[locale,page]);
 function edit(item:Supplier){setEditing(item.id);setName(item.name);setNote(item.note??"");}
 function reset(){setEditing(null);setName("");setNote("");}
 async function save(e:React.FormEvent){
  e.preventDefault();if(!name.trim()||busy)return;
  setBusy(true);setError("");
  try{
   const res=await fetch(editing?"/api/suppliers/"+editing:"/api/suppliers",{method:editing?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.trim(),note:note.trim()||null})});
   if(!res.ok)throw new Error(String(res.status));
   reset();await load();
  }catch{setError(ja?"仕入先を保存できませんでした":"Could not save supplier");}
  finally{setBusy(false);}
 }
 async function remove(item:Supplier){
  if(busy||!window.confirm(ja?`仕入先「${item.name}」を削除しますか？使用中の場合は削除できません。`:`Delete supplier "${item.name}"? Suppliers linked to purchase offers cannot be deleted.`))return;
  setBusy(true);setError("");
  try{const res=await fetch("/api/suppliers/"+item.id,{method:"DELETE"});if(!res.ok)throw new Error(String(res.status));await load();if(editing===item.id)reset();}
  catch{setError(ja?"削除できません。購入条件に使用されている仕入先は保持されます。":"Could not delete. Suppliers linked to purchase offers are retained.");}
  finally{setBusy(false);}
 }
 return <section className="card supplier-manager" aria-label={ja?"仕入先マスター":"Supplier master"}>
  <h2>{ja?"仕入先マスター":"Supplier Master"}</h2>
  <p className="muted">{ja?"登録済み仕入先を管理します。購入条件や価格履歴は削除しません。":"Manage suppliers without changing purchase offers or price history."}</p>
  {error&&<p role="alert">{error}</p>}
  <form onSubmit={save}>
   <label>{ja?"仕入先名":"Supplier name"}<input value={name} maxLength={200} onChange={e=>setName(e.target.value)} required/></label>
   <label>{ja?"メモ（任意）":"Notes (optional)"}<input value={note} maxLength={1000} onChange={e=>setNote(e.target.value)}/></label>
   <div className="toolbar"><button disabled={busy||!name.trim()}>{editing?(ja?"変更を保存":"Save changes"):(ja?"仕入先を登録":"Add supplier")}</button>{editing&&<button type="button" onClick={reset}>{ja?"キャンセル":"Cancel"}</button>}</div>
  </form>
  <ul className="supplier-manager-list">{items.map(item=><li key={item.id}><div><strong>{item.name}</strong>{item.note&&<small>{item.note}</small>}</div><div className="toolbar"><button type="button" disabled={busy} onClick={()=>edit(item)}>{ja?"編集":"Edit"}</button><button type="button" disabled={busy} onClick={()=>void remove(item)}>{ja?"削除":"Delete"}</button></div></li>)}</ul>
  <div className="toolbar"><button type="button" disabled={busy||page===1} onClick={()=>setPage(v=>v-1)}>{ja?"前へ":"Previous"}</button><span>{page}</span><button type="button" disabled={busy||items.length<50} onClick={()=>setPage(v=>v+1)}>{ja?"次へ":"Next"}</button></div>
  {!items.length&&!error&&<p className="muted">{ja?"登録済み仕入先はありません。":"No suppliers registered."}</p>}
 </section>;
}
