"use client";
import {useCallback,useEffect,useState} from "react";
import {type Locale} from "./i18n";
import VoiceFieldInput from "./VoiceFieldInput";

type Price={amount_jpy?:{value?:string|null};per_quantity?:string;per_unit?:string};
type Ingredient={price_research_enabled?:boolean;last_research_error?:string|null;id:string;name:string;spec?:string|null;current_price?:Price|null};
export default function IngredientManager({locale}:{locale:Locale}){
 const ja=locale==="ja";
 const [items,setItems]=useState<Ingredient[]>([]);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [editing,setEditing]=useState<string|null>(null);
 const [newName,setNewName]=useState("");
 const [newSpec,setNewSpec]=useState("");
 const [newResearch,setNewResearch]=useState(false),[research,setResearch]=useState(false);
 const [spec,setSpec]=useState("");
 const [query,setQuery]=useState("");
 const [supplierFilter,setSupplierFilter]=useState("all");
 const [supplierMap,setSupplierMap]=useState<Record<string,string[]>|null>(null);
 const [showCreate,setShowCreate]=useState(false);
 const [availableSuppliers,setAvailableSuppliers]=useState<{id:string;name:string;is_market_reference?:boolean}[]>([]);
 const [supplierLoading,setSupplierLoading]=useState(false);
 const [page,setPage]=useState(1);
 const [sort,setSort]=useState<"name"|"price"|"supplier">("name");
 const [descending,setDescending]=useState(false);
 const pageSize=10;
 const [name,setName]=useState("");
 const [price,setPrice]=useState("");
 const [quantity,setQuantity]=useState("");
 const [unit,setUnit]=useState("");
 const [priceSupplier,setPriceSupplier]=useState("");
 const [approvedPrices,setApprovedPrices]=useState<Array<{offer_id:string;supplier_id:string|null;supplier_name:string|null;amount_jpy:string;quantity:string|null;unit:string|null}>>([]);
 useEffect(()=>{
  if(!editing)return;
  const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!busy)setEditing(null);};
  document.addEventListener("keydown",onKey);
  return()=>document.removeEventListener("keydown",onKey);
 },[editing,busy]);
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
 async function begin(item:Ingredient){
  setEditing(item.id);setResearch(item.price_research_enabled??false);setName(item.name);setSpec(item.spec??"");setPriceSupplier("");
  setPrice(item.current_price?.amount_jpy?.value??"");
  setQuantity(item.current_price?.per_quantity??"");
  setUnit(item.current_price?.per_unit??"");
  setError("");setSupplierLoading(true);setApprovedPrices([]);
  try{
   const collected:{id:string;name:string;is_market_reference?:boolean}[]=[];
   for(let page=1;page<=100;page++){
    const response=await fetch(`/api/suppliers?page=${page}&page_size=100`,{cache:"no-store"});
    if(!response.ok)throw new Error("suppliers");
    const data=await response.json() as {items?:{id:string;name:string;is_market_reference?:boolean}[]};
    if(!Array.isArray(data.items))throw new Error("shape");
    collected.push(...data.items);
    if(data.items.length<100)break;
   }
   setAvailableSuppliers(collected);
   setPriceSupplier(collected.find(s=>s.is_market_reference)?.id??"");
   const pricesResponse=await fetch(`/api/ingredients/${item.id}/offer-prices`,{cache:"no-store"});
   if(!pricesResponse.ok)throw new Error("approved prices");
   const pricing=await pricesResponse.json() as {items?:typeof approvedPrices};
   if(!Array.isArray(pricing.items))throw new Error("approved prices shape");
   setApprovedPrices(pricing.items);
  }catch{setError(ja?"仕入れ先一覧を取得できません。":"Could not load suppliers.");}
  finally{setSupplierLoading(false);}
 }
 async function save(id:string){
  if(busy)return;
  if(!name.trim()||name.trim().length>200){
   setError(ja?"食材名を正しく入力してください。":"Enter a valid ingredient name.");return;
  }
  setBusy(true);
  try{
   const r=await fetch("/api/ingredients/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({name:name.trim(),spec:spec.trim()||null,price_research_enabled:research})});
   if(!r.ok)throw new Error("save");
   setEditing(null);await load();
  }catch{setError(ja?"食材を保存できませんでした。":"Could not save ingredient.");}
  finally{setBusy(false);}
 }
 async function approvePrice(id:string){
  if(busy)return;
  const value=price.trim(),qty=quantity.trim(),u=unit.trim();
  if(!value||!qty||!u||!Number.isFinite(Number(value))||Number(value)<0||
     !Number.isFinite(Number(qty))||Number(qty)<=0){
   setError(ja?"価格・数量・単位をすべて正しく入力してください。":"Enter a valid price, quantity and unit.");return;
  }
  const supplier=availableSuppliers.find(s=>s.id===priceSupplier);
  const target=supplier?.name??(ja?"相場参考価格":"Market reference price");
  if(!window.confirm(ja?`${target}の価格 ¥${value} / ${qty} ${u} を採用しますか？`:`Adopt ${target}: JPY ${value} / ${qty} ${u}?`))return;
  setBusy(true);
  try{
   const r=await fetch("/api/offer-prices",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ingredient_id:id,supplier_id:priceSupplier||null,
                         amount_jpy:value,quantity:qty,unit:u})});
   if(!r.ok)throw new Error("adopt");
   setEditing(null);await load();
  }catch{setError(ja?"価格を採用できませんでした。単位マスターと仕入れ条件を確認してください。":"Could not adopt price. Check units and purchase terms.");}
  finally{setBusy(false);}
 }
 async function create(){
  if(busy||!newName.trim())return;
  setBusy(true);
  try{
   const r=await fetch("/api/ingredients",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:newName.trim(),spec:newSpec.trim()||null,price_research_enabled:newResearch})});
   if(!r.ok)throw new Error("create");
   setNewName("");setNewSpec("");setNewResearch(false);setShowCreate(false);await load();
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
  const nameMatches=`${item.name} ${item.spec??""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  if(supplierFilter==="all")return nameMatches;
  if(!supplierMap)return nameMatches;
  const linked=supplierMap[item.id]??[];
  return nameMatches&&(supplierFilter==="unset"?linked.length===0:linked.includes(supplierFilter));
 });
 const compare=(a:Ingredient,b:Ingredient)=>{
  if(sort==="price")return Number(a.current_price?.amount_jpy?.value??-1)-Number(b.current_price?.amount_jpy?.value??-1);
  if(sort==="supplier")return (supplierMap?.[a.id]?.join("、")??"").localeCompare(supplierMap?.[b.id]?.join("、")??"",locale);
  return a.name.localeCompare(b.name,locale);
 };
 const ordered=[...filtered].sort((a,b)=>(descending?-1:1)*compare(a,b));
 const sortBy=(field:"name"|"price"|"supplier")=>{setDescending(sort===field?!descending:false);setSort(field);setPage(1);};
 const pages=Math.max(1,Math.ceil(ordered.length/pageSize));
 const effectivePage=Math.min(page,pages);
 const visible=ordered.slice((effectivePage-1)*pageSize,effectivePage*pageSize);
 const formatAmount=(raw:string)=>{const [whole,...fraction]=raw.split(".");return whole.replace(/\B(?=(\d{3})+(?!\d))/g,",")+(fraction.length?"."+fraction.join("."):"");};
 const priceLabel=(item:Ingredient)=>item.current_price?.amount_jpy?.value!=null
  ? `¥${formatAmount(item.current_price.amount_jpy.value)} / ${item.current_price.per_quantity??""} ${item.current_price.per_unit??""}`
  : (ja?"未設定":"Not set");
 const suppliers=(item:Ingredient)=>supplierMap===null
  ? (ja?"確認できません":"Unavailable")
  : (supplierMap[item.id]?.join("、")||(ja?"仕入れ先未設定":"Not set"));
 const editor=(item:Ingredient)=><div className="name-choice-overlay ingredient-edit-overlay" key={item.id} onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setEditing(null);}}><section role="dialog" aria-modal="true" aria-label={ja?`${item.name}を編集`:`Edit ${item.name}`} className="name-choice-dialog ingredient-editor">
  <div className="ingredient-editor-head"><h4>{ja?"食材を編集":"Edit Ingredient"} — {item.name}</h4><button type="button" className="secondary" aria-label={ja?"閉じる":"Close"} title={ja?"閉じる":"Close"} disabled={busy} onClick={()=>setEditing(null)}><span aria-hidden="true">×</span></button></div>
  <label><input type="checkbox" role="switch" checked={research} disabled={busy} onChange={e=>setResearch(e.target.checked)}/>{ja?"この食材を定期価格調査の対象にする":"Research this ingredient periodically"}</label>
  {item.last_research_error&&<p role="status">{ja?"前回の定期調査で価格を取得できませんでした。次回の調査で再試行します。":"The last scheduled research could not obtain a price. It will retry on the next interval."}</p>}
  <div className="ingredient-editor-fields">
   <label>{ja?"食材名":"Ingredient name"}<input autoFocus value={name} maxLength={200} disabled={busy} onChange={e=>setName(e.target.value)}/></label>
   <label>{ja?"規格（商品の識別用）":"Specification (identity only)"}<input value={spec} maxLength={200} disabled={busy} placeholder={ja?"例：1号缶、10個入り":"e.g. No.1 can, 10-count"} onChange={e=>setSpec(e.target.value)}/></label>
   <label>{ja?"仕入れ先（採用価格）":"Supplier (adopted price)"}<select value={priceSupplier} disabled={busy||supplierLoading} onChange={e=>{setPriceSupplier(e.target.value);setPrice("");setQuantity("");setUnit("");}}>{!availableSuppliers.some(s=>s.is_market_reference)&&<option value="">{ja?"相場参考価格":"Market reference price"}</option>}{availableSuppliers.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
   <label>{ja?"仕入価格（円）":"Purchase price (JPY)"}<input inputMode="decimal" value={price} disabled={busy} onChange={e=>setPrice(e.target.value)}/></label>
   <label>{ja?"仕入数量":"Purchase quantity"}<input inputMode="decimal" value={quantity} disabled={busy} onChange={e=>setQuantity(e.target.value)}/></label>
   <label>{ja?"仕入単位":"Purchase unit"}<input value={unit} maxLength={32} disabled={busy} onChange={e=>setUnit(e.target.value)}/></label>
  </div>
  {error&&<p role="alert" className="error">{error}</p>}
  <div className="ingredient-supplier-prices"><strong>{ja?"採用価格の比較":"Approved price comparison"}</strong>
   {approvedPrices.length===0?<p className="ingredient-muted">{ja?"採用価格はありません。":"No approved prices."}</p>:
   <ul>{approvedPrices.map(quote=><li key={quote.offer_id}>{quote.supplier_name??(ja?"相場参考価格":"Market reference price")}：¥{formatAmount(quote.amount_jpy)} / {quote.quantity} {quote.unit}</li>)}</ul>}
   <p className="ingredient-muted">{ja?"購入数量・単位が異なる価格は、そのまま高安比較しません。":"Different package quantities or units are not directly comparable."}</p>
  </div>
  <p className="ingredient-muted">{ja?"「保存」は食材名・規格のみを更新します。価格は「価格を登録・採用」で履歴に記録して反映します。規格による自動単位換算はしません。":"Save updates identity only. Adopt price explicitly to record an observation. Specifications do not convert units."}</p>
  <div className="ingredient-actions"><button type="button" disabled={busy||supplierLoading} onClick={()=>void approvePrice(item.id)}>{ja?"価格を登録・採用":"Record and adopt price"}</button></div>
  <div className="ingredient-actions"><button type="button" disabled={busy} onClick={()=>void save(item.id)}>{ja?"保存":"Save"}</button><button type="button" className="secondary" disabled={busy} onClick={()=>setEditing(null)}>{ja?"キャンセル":"Cancel"}</button></div>
 </section></div>;
 return <section className="ingredient-manager" aria-label={ja?"食材ライブラリ":"Ingredient library"}>
  <p className="settings-panel-description">{ja?"レシピで使用する食材と、価格・仕入れ先を管理します。":"Manage ingredients, prices and suppliers used in recipes."}</p>
  <div className="ingredient-controls">
   <button type="button" className="ingredient-add-button" aria-expanded={showCreate} onClick={()=>setShowCreate(v=>!v)}>{showCreate?(ja?"登録フォームを閉じる":"Close form"):(ja?"+ 新規登録":"+ Add Ingredient")}</button>
   <label className="ingredient-search"><span className="sr-only">{ja?"食材名と規格で検索":"Search ingredients and specifications"}</span><input type="search" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}} placeholder={ja?"食材名・規格で検索…":"Search ingredient / specification…"}/></label>
   <label className="ingredient-supplier-filter"><span>{ja?"仕入れ先":"Supplier"}</span><select value={supplierFilter} disabled={!supplierMap} onChange={e=>{setSupplierFilter(e.target.value);setPage(1);}}>
    <option value="all">{ja?"すべて":"All"}</option>
    {supplierMap&&<option value="unset">{ja?"未設定":"Not set"}</option>}
    {supplierNames.map(n=><option value={n} key={n}>{n}</option>)}
   </select></label>
  </div>
  {showCreate&&<div className="ingredient-create">
   <label>{ja?"新規食材名":"New ingredient name"}<input value={newName} maxLength={200} disabled={busy} onChange={e=>setNewName(e.target.value)}/></label>
   <VoiceFieldInput locale={locale} label={ja?"食材名":"ingredient name"} disabled={busy} onTranscript={value=>setNewName(value.slice(0,200))}/>
   <label>{ja?"規格（任意）":"Specification (optional)"}<input value={newSpec} maxLength={200} disabled={busy} onChange={e=>setNewSpec(e.target.value)}/></label>
   <VoiceFieldInput locale={locale} label={ja?"規格":"specification"} disabled={busy} onTranscript={value=>setNewSpec(value.slice(0,200))}/>
   <label><input type="checkbox" role="switch" checked={newResearch} disabled={busy} onChange={e=>setNewResearch(e.target.checked)}/>{ja?"この食材を定期価格調査の対象にする":"Research this ingredient periodically"}</label><button type="button" disabled={busy||!newName.trim()} onClick={()=>void create()}>{ja?"食材を登録":"Add ingredient"}</button>
  </div>}
  {error&&<p role="alert" className="error">{error}</p>}
  {loading?<p>{ja?"読み込み中":"Loading"}</p>:items.length===0?<p>{ja?"登録済み食材はありません。":"No ingredients registered."}</p>:<>
   <div className="ingredient-table-wrap"><table className="ingredient-table">
    <thead><tr><th scope="col">{ja?"No.":"No."}</th><th scope="col" aria-sort={sort==="name"?(descending?"descending":"ascending"):"none"}><button type="button" className="ingredient-sort" onClick={()=>sortBy("name")}>{ja?"食材名":"Ingredient"} ↕</button></th><th scope="col" aria-sort={sort==="price"?(descending?"descending":"ascending"):"none"}><button type="button" className="ingredient-sort" onClick={()=>sortBy("price")}>{ja?"採用価格・単位":"Adopted price / Unit"} ↕</button></th><th scope="col" aria-sort={sort==="supplier"?(descending?"descending":"ascending"):"none"}><button type="button" className="ingredient-sort" onClick={()=>sortBy("supplier")}>{ja?"仕入れ先":"Supplier"} ↕</button></th><th scope="col">{ja?"備考":"Notes"}</th><th scope="col">{ja?"操作":"Actions"}</th></tr></thead>
    <tbody>{visible.map((item,i)=><tr key={item.id}>
     <td>{(effectivePage-1)*pageSize+i+1}</td>
     <td><strong>{item.name}</strong>{item.spec&&<div className="ingredient-muted">{item.spec}</div>}</td>
     <td><span className={item.current_price?.amount_jpy?.value==null?"ingredient-unset":""}>{priceLabel(item)}</span></td>
     <td><span className={supplierMap&&!(supplierMap[item.id]?.length)?"ingredient-muted":""}>{suppliers(item)}</span></td>
     <td className="ingredient-muted">{item.price_research_enabled?(ja?"定期調査ON":"Research ON"):"—"}{item.last_research_error&&<span>{ja?" · 前回調査失敗":" · Last research failed"}</span>}</td>
     <td><div className="ingredient-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>void begin(item)}>{ja?"編集":"Edit"}</button><button type="button" className="secondary ingredient-delete" disabled={busy} onClick={()=>void remove(item)}>{ja?"削除":"Delete"}</button></div></td>
    </tr>)}</tbody>
   </table></div>
   <div className="ingredient-cards">{visible.map(item=><article key={item.id} className="ingredient-item-card">
    <div className="ingredient-item-head"><strong>{item.name}{item.spec&&<span className="ingredient-muted"> · {item.spec}</span>}</strong><button type="button" className="secondary" disabled={busy} onClick={()=>void begin(item)} aria-label={ja?`${item.name}を編集`:`Edit ${item.name}`}>›</button></div>
    <dl><div><dt>{ja?"採用価格・単位":"Adopted price / Unit"}</dt><dd className={item.current_price?.amount_jpy?.value==null?"ingredient-unset":""}>{priceLabel(item)}</dd></div>
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
