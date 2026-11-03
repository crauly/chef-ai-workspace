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
 return <section className="workspace-section" aria-label={ja?"単位マスター":"Unit master"}>
  <div className="workspace-section-head"><h3>{ja?"単位マスター":"Unit master"}</h3></div>
  <p>{ja?"レシピで使用する単位と別名を確認・編集します。新規単位はレシピ保存時に一括承認されます。":"Review unit names and aliases. New units are approved with recipe saving."}</p>
  {error&&<p role="alert">{error}</p>}
  <button type="button" className="secondary" onClick={()=>void load()} disabled={busy}>{ja?"更新":"Refresh"}</button>
  <ul>
   {items.map(u=><li key={u.id}>
    <strong>{u.symbol}</strong> <span>({u.dimension}{u.base_factor?`, ×${u.base_factor}`:""})</span>
    {editing===u.id?<div>
     <label>{ja?"正式単位名":"Canonical unit name"}<input value={symbol} onChange={e=>setSymbol(e.target.value)} disabled={busy}/></label>
     <label>{ja?"単位の分類":"Dimension"}<select value={dimension} onChange={e=>setDimension(e.target.value)} disabled={busy}><option value="mass">Mass</option><option value="volume">Volume</option><option value="count">Count</option><option value="other">Other</option></select></label>
     <label>{ja?"基準単位への換算係数（未確認なら空欄）":"Factor to base unit (leave blank if unknown)"}<input inputMode="decimal" value={factor} onChange={e=>setFactor(e.target.value)} disabled={busy}/></label>
     <label>{ja?"別名（カンマ区切り）":"Aliases (comma separated)"}
      <input value={aliases} onChange={e=>setAliases(e.target.value)} disabled={busy}/>
     </label>
     <button type="button" onClick={()=>void save(u.id)} disabled={busy}>{ja?"保存":"Save"}</button>
     <button type="button" className="secondary" onClick={()=>setEditing(null)} disabled={busy}>{ja?"取消":"Cancel"}</button>
    </div>:<>
     <span> {u.aliases.join(", ")}</span>{" "}
     <button type="button" className="secondary" onClick={()=>{setEditing(u.id);setAliases(u.aliases.join(", "));setSymbol(u.symbol);setDimension(u.dimension);setFactor(u.base_factor??"");}}>{ja?"単位を編集":"Edit unit"}</button>
    </>}
   </li>)}
  </ul>
 </section>;
}
