"use client";
import {useEffect,useRef,useState} from "react";
import VoiceFieldInput from "./VoiceFieldInput";
import {type Locale} from "./i18n";
type Supplier={id:string;name:string;note:string|null;is_market_reference?:boolean};
export default function SupplierManager({locale}:{locale:Locale}){
 const ja=locale==="ja";
 const [items,setItems]=useState<Supplier[]>([]);
 const [name,setName]=useState(""),[note,setNote]=useState("");
 const [editName,setEditName]=useState(""),[editNote,setEditNote]=useState("");
 const [editing,setEditing]=useState<string|null>(null);
 const [showCreate,setShowCreate]=useState(true),[query,setQuery]=useState("");
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const [page,setPage]=useState(1);
 const readSeq=useRef(0);
 const pageSize=50;
 async function load(targetPage=page,signal?:AbortSignal){
  const seq=++readSeq.current;
  try{
   const res=await fetch(`/api/suppliers?page=${targetPage}&page_size=${pageSize}`,{cache:"no-store",signal});
   if(!res.ok)throw new Error(String(res.status));
   const data=await res.json() as {items?:unknown};
   if(!Array.isArray(data.items))throw new Error("bad supplier payload");
   if(seq===readSeq.current){setItems(data.items as Supplier[]);setError("");}
   return true;
  }catch(e){
   if(seq===readSeq.current && !(e instanceof Error&&e.name==="AbortError"))
    setError(ja?"仕入先の一覧を更新できませんでした":"Could not refresh the supplier list");
   return false;
  }
 }
 useEffect(()=>{
  const controller=new AbortController();
  void load(page,controller.signal);
  return ()=>{controller.abort();readSeq.current++;};
 },[locale,page]);
 function edit(item:Supplier){setEditing(item.id);setEditName(item.name);setEditNote(item.note??"");setError("");}
 function reset(){setEditing(null);setEditName("");setEditNote("");}
 function clearCreate(){setName("");setNote("");}
 async function save(e:React.FormEvent){
  e.preventDefault();if(!name.trim()||busy)return;
  setBusy(true);setError("");
  let saved=false;
  try{
   const res=await fetch("/api/suppliers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.trim(),note:note.trim()||null})});
   if(!res.ok)throw new Error(String(res.status));
   saved=true;clearCreate();
  }catch{setError(ja?"仕入先を保存できませんでした":"Could not save supplier");}
  if(saved)await load();
  setBusy(false);
 }
 async function saveEdit(e:React.FormEvent){
  e.preventDefault();if(!editing||!editName.trim()||busy)return;
  setBusy(true);setError("");
  let saved=false;
  try{
   const res=await fetch("/api/suppliers/"+editing,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:editName.trim(),note:editNote.trim()||null})});
   if(!res.ok)throw new Error(String(res.status));
   saved=true;reset();
  }catch{setError(ja?"仕入先の変更を保存できませんでした":"Could not update supplier");}
  if(saved)await load();
  setBusy(false);
 }
 async function remove(item:Supplier){
  if(busy||!window.confirm(ja?`仕入先「${item.name}」を削除しますか？使用中の場合は削除できません。`:`Delete supplier "${item.name}"? Suppliers linked to purchase offers cannot be deleted.`))return;
  setBusy(true);setError("");
  try{const res=await fetch("/api/suppliers/"+item.id,{method:"DELETE"});if(!res.ok)throw new Error(String(res.status));if(editing===item.id)reset();await load();}
  catch{setError(ja?"削除できません。購入条件に使用されている仕入先は保持されます。":"Could not delete. Suppliers linked to purchase offers are retained.");}
  finally{setBusy(false);}
 }
 const filtered=items.filter(item=>[item.name,item.note??""].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 return <section className="card supplier-manager" aria-label={ja?"仕入れ先管理":"Suppliers"}>
  <p className="muted">{ja?"登録済み仕入先を管理します。購入条件や価格履歴は削除しません。":"Manage suppliers without changing purchase offers or price history."}</p>
  {error&&<p role="alert">{error}</p>}
  <section className="supplier-create-section" aria-label={ja?"新規登録":"New supplier"}>
   <button type="button" className="supplier-create-toggle" aria-expanded={showCreate} onClick={()=>setShowCreate(v=>!v)}>
    <span aria-hidden="true">{showCreate?"⊖":"⊕"}</span><span>{ja?"新規登録":"Add supplier"}</span><span className="supplier-create-chevron" aria-hidden="true">{showCreate?"⌃":"⌄"}</span>
   </button>
   {showCreate&&<form className="supplier-create-form" onSubmit={save}>
    <label>{ja?"仕入れ先名":"Supplier name"} <span aria-hidden="true">*</span><input value={name} maxLength={200} onChange={e=>setName(e.target.value)} placeholder={ja?"例：みずほファーム":"e.g. Local farm"} required/></label>
    <VoiceFieldInput locale={locale} label={ja?"仕入れ先名":"supplier name"} disabled={busy} onTranscript={value=>setName(value.slice(0,200))}/>
    <label>{ja?"メモ（任意）":"Notes (optional)"}<textarea value={note} maxLength={1000} onChange={e=>setNote(e.target.value)} placeholder={ja?"例：有機野菜・週1回納品":"e.g. Organic vegetables, weekly delivery"}/></label>
    <div className="toolbar supplier-create-actions"><button type="button" className="secondary" disabled={busy} onClick={clearCreate}>{ja?"クリア":"Clear"}</button><button type="submit" disabled={busy||!name.trim()}>{ja?"＋ 登録する":"+ Add supplier"}</button></div>
   </form>}
  </section>
  <div className="supplier-list-head">
   <h3>{ja?"登録済みの仕入れ先":"Registered suppliers"} ({items.length}{ja?"件":""})</h3>
   <input type="search" aria-label={ja?"仕入れ先を検索":"Search suppliers"} value={query} onChange={e=>setQuery(e.target.value)} placeholder={ja?"仕入れ先を検索…":"Search suppliers…"}/>
  </div>
  <ul className="supplier-manager-list">{filtered.map(item=><li key={item.id} className={editing===item.id?"supplier-inline-active":""}>
   {editing===item.id?
    <form className="supplier-inline-edit" onSubmit={saveEdit} aria-label={ja?item.name+"を編集":"Edit "+item.name}>
     <div className="supplier-inline-title"><strong>{ja?"仕入れ先を編集":"Edit supplier"} — {item.name}</strong><button type="button" className="secondary" onClick={reset} disabled={busy} aria-label={ja?"編集を閉じる":"Close editor"}>×</button></div>
     <label>{ja?"仕入れ先名":"Supplier name"}<input autoFocus required maxLength={200} disabled={busy} value={editName} onChange={e=>setEditName(e.target.value)}/></label>
     <label>{ja?"メモ（任意）":"Notes (optional)"}<textarea maxLength={1000} disabled={busy} value={editNote} onChange={e=>setEditNote(e.target.value)}/></label>
     <div className="toolbar"><button type="button" className="secondary" onClick={reset} disabled={busy}>{ja?"キャンセル":"Cancel"}</button><button type="submit" disabled={busy||!editName.trim()}>{ja?"変更を保存":"Save changes"}</button></div>
    </form>:
    <><div className="supplier-list-info"><strong>{item.name}</strong>{item.note&&<small>{item.note}</small>}</div><div className="toolbar"><button type="button" disabled={busy||item.is_market_reference} onClick={()=>edit(item)}>{ja?"編集":"Edit"}</button><button type="button" disabled={busy||item.is_market_reference} onClick={()=>void remove(item)}>{ja?"削除":"Delete"}</button></div></>}
  </li>)}</ul>
  {filtered.length===0&&!error&&<p className="muted">{items.length?(ja?"該当する仕入れ先がありません。":"No matching suppliers."):(ja?"登録済み仕入先はありません。":"No suppliers registered.")}</p>}
  <div className="toolbar supplier-pagination"><button type="button" disabled={busy||page===1} onClick={()=>setPage(v=>v-1)}>{ja?"前へ":"Previous"}</button><span>{page}</span><button type="button" disabled={busy||items.length<pageSize} onClick={()=>setPage(v=>v+1)}>{ja?"次へ":"Next"}</button></div>
 </section>;
}
