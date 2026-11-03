"use client";
import {useCallback,useEffect,useState} from "react";
import {type Locale} from "./i18n";

type Price={amount_jpy?:{value?:string|null};per_quantity?:string;per_unit?:string};
type Ingredient={id:string;name:string;current_price?:Price|null};
export default function IngredientManager({locale}:{locale:Locale}){
 const ja=locale==="ja";
 const [items,setItems]=useState<Ingredient[]>([]);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [editing,setEditing]=useState<string|null>(null);
 const [name,setName]=useState("");
 const [price,setPrice]=useState("");
 const [quantity,setQuantity]=useState("");
 const [unit,setUnit]=useState("");
 const load=useCallback(async()=>{
  setLoading(true);
  try{
   const r=await fetch("/api/ingredients",{cache:"no-store"});
   if(!r.ok)throw new Error("load");
   const data=await r.json() as {items:Ingredient[]};
   if(!Array.isArray(data.items))throw new Error("shape");
   setItems(data.items);setError("");
  }catch{setError(ja?"食材マスターを取得できません。":"Unable to load ingredient master.");}
  finally{setLoading(false);}
 },[ja]);
 useEffect(()=>{void load();},[load]);
 function begin(item:Ingredient){
  setEditing(item.id);setName(item.name);
  setPrice(item.current_price?.amount_jpy?.value??"");
  setQuantity(item.current_price?.per_quantity??"");
  setUnit(item.current_price?.per_unit??"");
  setError("");
 }
 async function save(id:string){
  if(busy)return;
  const values=[price.trim(),quantity.trim(),unit.trim()];
  if(!name.trim()||name.trim().length>200||values.some(Boolean)&&!values.every(Boolean)||
     (values.every(Boolean)&&(!Number.isFinite(Number(price))||Number(price)<0||!Number.isFinite(Number(quantity))||Number(quantity)<=0))){
   setError(ja?"食材名と仕入価格・数量・単位を正しく入力してください。価格を未設定にする場合は3項目とも空欄にしてください。":"Enter a valid name and complete price, quantity and unit, or leave all three blank.");return;
  }
  setBusy(true);
  try{
   const r=await fetch("/api/ingredients/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({name:name.trim(),price_jpy:values[0]||null,price_quantity:values[1]||null,price_unit:values[2]||null})});
   if(!r.ok)throw new Error("save");
   setEditing(null);await load();
  }catch{setError(ja?"食材マスターを保存できませんでした。":"Failed to save ingredient master.");}
  finally{setBusy(false);}
 }
 return <section className="workspace-section" aria-label={ja?"食材マスター":"Ingredient master"}>
  <div className="workspace-section-head"><h3>{ja?"食材マスター":"Ingredient master"}</h3></div>
  <p>{ja?"共通食材の名称と仕入単価を管理します。変更は関連レシピの現在原価に反映されます。":"Manage shared ingredient names and purchase prices. Updates affect current recipe costs."}</p>
  {error&&<p role="alert">{error}</p>}
  <button type="button" className="secondary" disabled={busy||loading} onClick={()=>void load()}>{ja?"更新":"Refresh"}</button>
  {loading?<p>{ja?"読み込み中":"Loading"}</p>:items.length===0?<p>{ja?"登録済み食材はありません。食材はレシピ保存時に登録されます。":"No ingredients yet. Ingredients are registered when saving recipes."}</p>:
  <ul>{items.map(item=><li key={item.id}>
   {editing===item.id?<div>
    <label>{ja?"食材名":"Ingredient name"}<input value={name} maxLength={200} disabled={busy} onChange={e=>setName(e.target.value)}/></label>
    <label>{ja?"仕入価格（円）":"Purchase price (JPY)"}<input inputMode="decimal" value={price} disabled={busy} onChange={e=>setPrice(e.target.value)}/></label>
    <label>{ja?"仕入数量":"Purchase quantity"}<input inputMode="decimal" value={quantity} disabled={busy} onChange={e=>setQuantity(e.target.value)}/></label>
    <label>{ja?"仕入単位":"Purchase unit"}<input value={unit} maxLength={32} disabled={busy} onChange={e=>setUnit(e.target.value)}/></label>
    <button type="button" disabled={busy} onClick={()=>void save(item.id)}>{ja?"変更を保存":"Save changes"}</button>
    <button type="button" className="secondary" disabled={busy} onClick={()=>setEditing(null)}>{ja?"取消":"Cancel"}</button>
   </div>:<>
    <strong>{item.name}</strong>{" "}
    <span>{item.current_price?.amount_jpy?.value!=null?`¥${item.current_price.amount_jpy.value} / ${item.current_price.per_quantity??""} ${item.current_price.per_unit??""}`:(ja?"価格未設定":"Price not set")}</span>{" "}
    <button type="button" className="secondary" disabled={busy} onClick={()=>begin(item)}>{ja?"編集":"Edit"}</button>
   </>}
  </li>)}</ul>}
 </section>;
}
