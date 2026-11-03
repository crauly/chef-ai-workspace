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
 const [newName,setNewName]=useState("");
 const [query,setQuery]=useState("");
 const [page,setPage]=useState(1);
 const pageSize=10;
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
 async function create(){
  if(busy||!newName.trim())return;
  setBusy(true);
  try{
   const r=await fetch("/api/ingredients",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:newName.trim()})});
   if(!r.ok)throw new Error("create");
   setNewName("");await load();
  }catch{setError(ja?"食材を登録できませんでした。重複名を確認してください。":"Could not create ingredient. Check for duplicate names.");}
  finally{setBusy(false);}
 }
 async function remove(item:Ingredient){
  if(busy||!window.confirm(ja?`「${item.name}」を削除しますか？使用中の食材は削除できません。`:`Delete ${item.name}? Ingredients in use cannot be deleted.`))return;
  setBusy(true);
  try{
   const r=await fetch("/api/ingredients/"+item.id,{method:"DELETE"});
   if(!r.ok)throw new Error("delete");
   await load();
  }catch{setError(ja?"削除できません。レシピや仕入履歴から参照されている可能性があります。":"Unable to delete. This ingredient may be referenced.");}
  finally{setBusy(false);}
 }

 const filtered=items.filter(item=>item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 const pages=Math.max(1,Math.ceil(filtered.length/pageSize));
 const visible=filtered.slice((Math.min(page,pages)-1)*pageSize,Math.min(page,pages)*pageSize);
 const priceLabel=(item:Ingredient)=>item.current_price?.amount_jpy?.value!=null
  ? `¥${Number(item.current_price.amount_jpy.value).toLocaleString("ja-JP")} / ${item.current_price.per_quantity??""} ${item.current_price.per_unit??""}`
  : (ja?"価格未設定":"Price not set");
 const editor=(item:Ingredient)=><div className="ingredient-editor" key={item.id}>
  <h4>{ja?"食材を編集":"Edit ingredient"}</h4>
  <div className="ingredient-editor-fields">
   <label>{ja?"食材名":"Ingredient name"}<input value={name} maxLength={200} disabled={busy} onChange={e=>setName(e.target.value)}/></label>
   <label>{ja?"仕入価格（円）":"Purchase price (JPY)"}<input inputMode="decimal" value={price} disabled={busy} onChange={e=>setPrice(e.target.value)}/></label>
   <label>{ja?"仕入数量":"Purchase quantity"}<input inputMode="decimal" value={quantity} disabled={busy} onChange={e=>setQuantity(e.target.value)}/></label>
   <label>{ja?"仕入単位":"Purchase unit"}<input value={unit} maxLength={32} disabled={busy} onChange={e=>setUnit(e.target.value)}/></label>
  </div>
  <div className="ingredient-actions">
   <button type="button" disabled={busy} onClick={()=>void save(item.id)}>{ja?"変更を保存":"Save changes"}</button>
   <button type="button" className="secondary" disabled={busy} onClick={()=>setEditing(null)}>{ja?"キャンセル":"Cancel"}</button>
  </div>
 </div>;
 return <section className="workspace-section ingredient-manager" aria-label={ja?"食材ライブラリ":"Ingredient library"}>
  <div className="workspace-section-head"><h3>{ja?"食材ライブラリ":"Ingredient Library"}</h3></div>
  <p>{ja?"食材名と仕入単価を管理します。変更は関連レシピの現在原価に反映されます。":"Manage ingredient names and purchase prices. Changes affect current recipe costs."}</p>
  <div className="ingredient-create">
   <label>{ja?"新規食材名":"New ingredient name"}<input value={newName} maxLength={200} disabled={busy} onChange={e=>setNewName(e.target.value)}/></label>
   <button type="button" disabled={busy||!newName.trim()} onClick={()=>void create()}>{ja?"食材を登録":"Add ingredient"}</button>
  </div>
  {error&&<p role="alert">{error}</p>}
  <div className="ingredient-controls">
   <label>{ja?"食材を検索":"Search ingredients"}<input type="search" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}} placeholder={ja?"食材名で検索":"Search by name"}/></label>
   <button type="button" className="secondary" disabled={busy||loading} onClick={()=>void load()}>{ja?"更新":"Refresh"}</button>
  </div>
  {loading?<p>{ja?"読み込み中":"Loading"}</p>:items.length===0?<p>{ja?"登録済み食材はありません。":"No ingredients registered."}</p>:<>
   <div className="ingredient-table-wrap"><table className="ingredient-table">
    <thead><tr><th scope="col">{ja?"食材名":"Ingredient"}</th><th scope="col">{ja?"価格・規格":"Price / unit"}</th><th scope="col">{ja?"仕入れ先":"Supplier"}</th><th scope="col">{ja?"操作":"Actions"}</th></tr></thead>
    <tbody>{visible.map(item=><tr key={item.id}>
     <td><strong>{item.name}</strong></td>
     <td><span className={item.current_price?.amount_jpy?.value==null?"ingredient-unset":""}>{priceLabel(item)}</span></td>
     <td><span className="ingredient-muted">{ja?"購入条件で管理":"Managed in purchase offers"}</span></td>
     <td><div className="ingredient-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>begin(item)}>{ja?"編集":"Edit"}</button><button type="button" className="secondary ingredient-delete" disabled={busy} onClick={()=>void remove(item)}>{ja?"削除":"Delete"}</button></div></td>
    </tr>)}</tbody>
   </table></div>
   <div className="ingredient-cards">{visible.map(item=><article key={item.id} className="ingredient-item-card">
    <div className="ingredient-item-head"><strong>{item.name}</strong><button type="button" className="secondary" disabled={busy} onClick={()=>begin(item)}>{ja?"編集":"Edit"}</button></div>
    <dl><div><dt>{ja?"価格・規格":"Price / unit"}</dt><dd className={item.current_price?.amount_jpy?.value==null?"ingredient-unset":""}>{priceLabel(item)}</dd></div>
    <div><dt>{ja?"仕入れ先":"Supplier"}</dt><dd>{ja?"購入条件で管理":"Managed in purchase offers"}</dd></div></dl>
    <button type="button" className="secondary ingredient-delete" disabled={busy} onClick={()=>void remove(item)}>{ja?"削除":"Delete"}</button>
   </article>)}</div>
   {visible.length===0&&<p>{ja?"該当する食材がありません。":"No matching ingredients."}</p>}
   <div className="ingredient-pagination"><span>{ja?`全${filtered.length}件`:`${filtered.length} ingredients`}</span><div className="ingredient-actions">
    <button type="button" className="secondary" disabled={page<=1} onClick={()=>setPage(p=>Math.max(1,p-1))}>{ja?"前へ":"Previous"}</button>
    <span>{Math.min(page,pages)} / {pages}</span>
    <button type="button" className="secondary" disabled={page>=pages} onClick={()=>setPage(p=>Math.min(pages,p+1))}>{ja?"次へ":"Next"}</button>
   </div></div>
  </>}
  {editing&&items.find(item=>item.id===editing)&&editor(items.find(item=>item.id===editing)!)}
 </section>;
}
