"use client";
import {useCallback,useEffect,useState} from "react";
import {type Locale} from "./i18n";
type Unit={id:string;symbol:string;dimension:string;base_factor:string|null;aliases:string[]};
export default function UnitManager({locale}:{locale:Locale}){
 const ja=locale==="ja";
 const [items,setItems]=useState<Unit[]>([]);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const [editing,setEditing]=useState<string|null>(null);
 const [newSymbol,setNewSymbol]=useState("");
 const [newDimension,setNewDimension]=useState("other");
 const [aliases,setAliases]=useState("");
 const [symbol,setSymbol]=useState("");
 const [dimension,setDimension]=useState("other");
 const [factor,setFactor]=useState("");
 const load=useCallback(async()=>{
  try{
   const r=await fetch("/api/units",{cache:"no-store"});
   if(!r.ok)throw new Error("load");
   const data=await r.json() as {items:Unit[]};
   setItems(data.items);setError("");
  }catch{setError(ja?"単位一覧を取得できませんでした。":"Unable to load units.");}
 },[ja]);
 useEffect(()=>{void load();},[load]);
 async function save(id:string){
  if(busy)return;
  const values=aliases.split(",").map(x=>x.trim()).filter(Boolean);
  if(!symbol.trim()||symbol.trim().length>32||values.length>20||values.some(x=>x.length>32)){
   setError(ja?"別名は20件まで、各32文字以内です。":"Up to 20 aliases of 32 characters each.");return;
  }
  setBusy(true);
  try{
   const r=await fetch("/api/units/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbol:symbol.trim(),dimension,base_factor:factor.trim()||null,aliases:values})});
   if(!r.ok)throw new Error("save");
   setEditing(null);await load();
  }catch{setError(ja?"別名の保存に失敗しました。":"Failed to save aliases.");}
  finally{setBusy(false);}
 }
 async function create(){
  if(busy||!newSymbol.trim())return;
  setBusy(true);
  try{
   const r=await fetch("/api/units",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbol:newSymbol.trim(),dimension:newDimension})});
   if(!r.ok)throw new Error("create");
   setNewSymbol("");setNewDimension("other");await load();
  }catch{setError(ja?"単位を登録できません。重複する単位や別名を確認してください。":"Could not create unit. Check duplicate symbols and aliases.");}
  finally{setBusy(false);}
 }
 async function remove(u:Unit){
  if(busy||!window.confirm(ja?`単位「${u.symbol}」を削除しますか？使用中の単位は削除できません。`:`Delete unit ${u.symbol}? Units in use cannot be deleted.`))return;
  setBusy(true);
  try{
   const r=await fetch("/api/units/"+u.id,{method:"DELETE"});
   if(!r.ok)throw new Error("delete");
   await load();
  }catch{setError(ja?"削除できません。レシピや食材価格で使用中の可能性があります。":"Cannot delete a unit that is in use.");}
  finally{setBusy(false);}
 }

 function startEdit(u:Unit){setEditing(u.id);setAliases(u.aliases.join(", "));setSymbol(u.symbol);setDimension(u.dimension);setFactor(u.base_factor??"");setError("");}
 return <section className="workspace-section settings-manager-unit" aria-label={ja?"単位マスター":"Unit master"}>
  <p>{ja?"レシピで使用する単位と別名を確認・編集します。新規単位はレシピ保存時に一括承認されます。":"Review unit names and aliases. New units are approved with recipe saving."}</p>
  <section className="unit-create-panel" aria-label={ja?"新しい単位を登録":"Register a new unit"}>
   <h3><span className="unit-plus-mark" aria-hidden="true">＋</span>{ja?"新しい単位を登録":"Register a new unit"}</h3>
   <div className="unit-create-fields">
    <label>{ja?"単位名":"Unit name"}<input maxLength={32} value={newSymbol} disabled={busy} placeholder={ja?"例：ml、パック、束":"e.g. ml, pack, bunch"} onChange={e=>setNewSymbol(e.target.value)}/></label>
    <label>{ja?"単位分類":"Dimension"}<select value={newDimension} disabled={busy} onChange={e=>setNewDimension(e.target.value)}><option value="mass">Mass</option><option value="volume">Volume</option><option value="count">Count</option><option value="other">Other</option></select></label>
   </div>
   <div className="unit-create-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>{setNewSymbol("");setNewDimension("other");}}>{ja?"クリア":"Clear"}</button><button type="button" disabled={busy||!newSymbol.trim()} onClick={()=>void create()}>{ja?"登録する":"Register"}</button></div>
  </section>
  {error&&<p role="alert">{error}</p>}
  <section className="unit-list-panel" aria-label={ja?"登録済みの単位":"Registered units"}>
   <div className="unit-list-heading"><h3>{ja?"登録済みの単位":"Registered units"}</h3><span className="unit-count">{items.length}{ja?"件":" units"}</span></div>
   <ul className="unit-card-list">{items.map(u=><li key={u.id} className={editing===u.id?"unit-card unit-card-editing":"unit-card"}>
    {editing===u.id?<div className="unit-inline-edit">
      <div className="unit-inline-heading"><strong>{ja?"単位を編集":"Edit unit"} — {u.symbol}</strong><button type="button" className="secondary" aria-label={ja?"編集を閉じる":"Close editor"} onClick={()=>setEditing(null)} disabled={busy}>×</button></div>
      <div className="unit-inline-fields">
       <label>{ja?"正式単位名":"Canonical unit name"}<input value={symbol} maxLength={32} onChange={e=>setSymbol(e.target.value)} disabled={busy}/></label>
       <label>{ja?"単位の分類":"Dimension"}<select value={dimension} onChange={e=>setDimension(e.target.value)} disabled={busy}><option value="mass">Mass</option><option value="volume">Volume</option><option value="count">Count</option><option value="other">Other</option></select></label>
       <label>{ja?"基準単位への換算係数（未確認なら空欄）":"Factor to base unit (leave blank if unknown)"}<input inputMode="decimal" value={factor} onChange={e=>setFactor(e.target.value)} disabled={busy}/></label>
       <label>{ja?"別名（カンマ区切り）":"Aliases (comma separated)"}<input value={aliases} onChange={e=>setAliases(e.target.value)} disabled={busy}/></label>
      </div>
      <div className="unit-card-actions"><button type="button" className="secondary" onClick={()=>setEditing(null)} disabled={busy}>{ja?"キャンセル":"Cancel"}</button><button type="button" onClick={()=>void save(u.id)} disabled={busy}>{ja?"変更を保存":"Save changes"}</button></div>
     </div>:
     <><div className="unit-card-info"><strong>{u.symbol}</strong> <span>({u.dimension}{u.base_factor?", ×"+u.base_factor:""})</span>{u.aliases.length>0&&<small>{u.aliases.join(", ")}</small>}</div>
      <div className="unit-card-actions">
       <button type="button" className="secondary" disabled={busy} onClick={()=>startEdit(u)} aria-label={ja?u.symbol+"を編集":"Edit "+u.symbol}><span aria-hidden="true">✎</span> {ja?"編集":"Edit"}</button>
       <button type="button" className="secondary" disabled={busy} onClick={()=>void remove(u)}><span aria-hidden="true">🗑</span> {ja?"削除":"Delete"}</button>
      </div></>}
   </li>)}</ul>
  </section>
 </section>;
}
