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
 const [supplierFilter,setSupplierFilter]=useState("all");
 const [supplierMap,setSupplierMap]=useState<Record<string,string[]>|null>(null);
 const [showCreate,setShowCreate]=useState(false);
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
   const data=await r.json() as {items:Ingredient[];suppliers_by_ingredient?:Record<string,string[]>|null};
   if(!Array.isArray(data.items))throw new Error("shape");
   setItems(data.items);setSupplierMap(data.suppliers_by_ingredient??null);setError("");
  }catch{setError(ja?"食材一覧を取得できません。":"Unable to load ingredients.");}
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
  }catch{setError(ja?"食材を保存できませんでした。":"Could not save ingredient.");}
  finally{setBusy(false);}
 }
 async function create(){
  if(busy||!newName.trim())return;
  setBusy(true);
  try{
   const r=await fetch("/api/ingredients",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:newName.trim()})});
   if(!r.ok)throw new Error("create");
   setNewName("");setShowCreate(false);await load();
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


 const supplierNames=Array.from(new Set(Object.values(supplierMap??{}).flat())).sort((a,b)=>a.localeCompare(b,locale));
 const filtered=items.filter(item=>{
  const nameMatches=item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  if(supplierFilter==="all")return nameMatches;
  if(!supplierMap)return nameMatches;
  const linked=supplierMap[item.id]??[];
  return nameMatches&&(supplierFilter==="unset"?linked.length===0:linked.includes(supplierFilter));
 });
 const pages=Math.max(1,Math.ceil(filtered.length/pageSize));
 const effectivePage=Math.min(page,pages);
 const visible=filtered.slice((effectivePage-1)*pageSize,effectivePage*pageSize);
 const priceLabel=(item:Ingredient)=>item.current_price?.amount_jpy?.value!=null
  ? `¥${Number(item.current_price.amount_jpy.value).toLocaleString("ja-JP")} / ${item.current_price.per_quantity??""} ${item.current_price.per_unit??""}`
  : (ja?"未設定":"Not set");
 const suppliers=(item:Ingredient)=>supplierMap===null
  ? (ja?"確認できません":"Unavailable")
  : (supplierMap[item.id]?.join("、")||(ja?"仕入れ先未設定":"Not set"));
 const editor=(item:Ingredient)=><div className="ingredient-editor" key={item.id}>
  <div className="ingredient-editor-head"><h4>{ja?"食材を編集":"Edit Ingredient"} — {item.name}</h4><button type="button" className="secondary" onClick={()=>setEditing(null)}>{ja?"閉じる":"Close"}</button></div>
  <div className="ingredient-editor-fields">
   <label>{ja?"食材名":"Ingredient name"}<input value={name} maxLength={200} disabled={busy} onChange={e=>setName(e.target.value)}/></label>
   <label>{ja?"仕入価格（円）":"Purchase price (JPY)"}<input inputMode="decimal" value={price} disabled={busy} onChange={e=>setPrice(e.target.value)}/></label>
   <label>{ja?"仕入数量":"Purchase quantity"}<input inputMode="decimal" value={quantity} disabled={busy} onChange={e=>setQuantity(e.target.value)}/></label>
   <label>{ja?"仕入単位":"Purchase unit"}<input value={unit} maxLength={32} disabled={busy} onChange={e=>setUnit(e.target.value)}/></label>
  </div>
  <p className="ingredient-muted">{ja?"仕入れ先の紐付けは購入条件で管理します。":"Supplier links are managed through purchase offers."}</p>
  <div className="ingredient-actions"><button type="button" disabled={busy} onClick={()=>void save(item.id)}>{ja?"保存":"Save"}</button><button type="button" className="secondary" disabled={busy} onClick={()=>setEditing(null)}>{ja?"キャンセル":"Cancel"}</button></div>
 </div>;
 return <section className="ingredient-manager" aria-label={ja?"食材ライブラリ":"Ingredient library"}>
  <p className="settings-panel-description">{ja?"レシピで使用する食材と、価格・仕入れ先を管理します。":"Manage ingredients, prices and suppliers used in recipes."}</p>
  <div className="ingredient-controls">
   <button type="button" className="ingredient-add-button" aria-expanded={showCreate} onClick={()=>setShowCreate(v=>!v)}>{showCreate?(ja?"登録フォームを閉じる":"Close form"):(ja?"+ 新規登録":"+ Add Ingredient")}</button>
   <label className="ingredient-search"><span className="sr-only">{ja?"食材名で検索":"Search ingredients"}</span><input type="search" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}} placeholder={ja?"食材名で検索…":"Search ingredients…"}/></label>
   <label className="ingredient-supplier-filter"><span>{ja?"仕入れ先":"Supplier"}</span><select value={supplierFilter} disabled={!supplierMap} onChange={e=>{setSupplierFilter(e.target.value);setPage(1);}}>
    <option value="all">{ja?"すべて":"All"}</option>
    {supplierMap&&<option value="unset">{ja?"未設定":"Not set"}</option>}
    {supplierNames.map(n=><option value={n} key={n}>{n}</option>)}
   </select></label>
  </div>
  {showCreate&&<div className="ingredient-create">
   <label>{ja?"新規食材名":"New ingredient name"}<input value={newName} maxLength={200} disabled={busy} onChange={e=>setNewName(e.target.value)}/></label>
   <button type="button" disabled={busy||!newName.trim()} onClick={()=>void create()}>{ja?"食材を登録":"Add ingredient"}</button>
  </div>}
  {error&&<p role="alert" className="error">{error}</p>}
  {loading?<p>{ja?"読み込み中":"Loading"}</p>:items.length===0?<p>{ja?"登録済み食材はありません。":"No ingredients registered."}</p>:<>
   <div className="ingredient-table-wrap"><table className="ingredient-table">
    <thead><tr><th scope="col">{ja?"No.":"No."}</th><th scope="col">{ja?"食材名":"Ingredient"}</th><th scope="col">{ja?"価格・規格":"Price / Unit"}</th><th scope="col">{ja?"仕入れ先":"Supplier"}</th><th scope="col">{ja?"備考":"Notes"}</th><th scope="col">{ja?"操作":"Actions"}</th></tr></thead>
    <tbody>{visible.map((item,i)=><tr key={item.id}>
     <td>{(effectivePage-1)*pageSize+i+1}</td>
     <td><strong>{item.name}</strong></td>
     <td><span className={item.current_price?.amount_jpy?.value==null?"ingredient-unset":""}>{priceLabel(item)}</span></td>
     <td><span className={supplierMap&&!(supplierMap[item.id]?.length)?"ingredient-muted":""}>{suppliers(item)}</span></td>
     <td className="ingredient-muted">—</td>
     <td><div className="ingredient-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>begin(item)}>{ja?"編集":"Edit"}</button><button type="button" className="secondary ingredient-delete" disabled={busy} onClick={()=>void remove(item)}>{ja?"削除":"Delete"}</button></div></td>
    </tr>)}</tbody>
   </table></div>
   <div className="ingredient-cards">{visible.map(item=><article key={item.id} className="ingredient-item-card">
    <div className="ingredient-item-head"><strong>{item.name}</strong><button type="button" className="secondary" disabled={busy} onClick={()=>begin(item)} aria-label={ja?`${item.name}を編集`:`Edit ${item.name}`}>›</button></div>
    <dl><div><dt>{ja?"価格・規格":"Price / Unit"}</dt><dd className={item.current_price?.amount_jpy?.value==null?"ingredient-unset":""}>{priceLabel(item)}</dd></div>
    <div><dt>{ja?"仕入れ先":"Supplier"}</dt><dd>{suppliers(item)}</dd></div></dl>
    <button type="button" className="secondary ingredient-delete" disabled={busy} onClick={()=>void remove(item)}>{ja?"削除":"Delete"}</button>
   </article>)}</div>
   {visible.length===0&&<p>{ja?"該当する食材がありません。":"No matching ingredients."}</p>}
   <div className="ingredient-pagination"><span>{ja?`全 ${filtered.length} 件`:`${filtered.length} ingredients`}</span><div className="ingredient-actions">
    <button type="button" className="secondary" disabled={effectivePage<=1} onClick={()=>setPage(p=>Math.max(1,p-1))} aria-label={ja?"前のページ":"Previous page"}>‹</button>
    <span>{effectivePage} / {pages}</span>
    <button type="button" className="secondary" disabled={effectivePage>=pages} onClick={()=>setPage(p=>Math.min(pages,p+1))} aria-label={ja?"次のページ":"Next page"}>›</button>
   </div></div>
  </>}
  {editing&&items.find(item=>item.id===editing)&&editor(items.find(item=>item.id===editing)!)}
 </section>;
}
