"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {type Locale} from "./i18n";
import VoiceFieldInput from "./VoiceFieldInput";
import {ingredientSaveMessage,type IngredientSavePayload} from "../ingredient-save-contract";

type Price={amount_jpy?:{value?:string|null};per_quantity?:string;per_unit?:string};
type ApprovedPrice={offer_id:string;supplier_id:string|null;supplier_name:string|null;amount_jpy:string;quantity:string|null;unit:string|null;observed_at?:string};
type Unit={id:string;symbol:string;aliases?:string[]};
const normalizedNumber=(value:string)=>{if(!value.trim())return "";const [a,b=""]=value.trim().split(".");return (a.replace(/^0+(?=\d)/,"")||"0")+(b.replace(/0+$/,"")?"."+b.replace(/0+$/,""):"");};
const latest=(prices:ApprovedPrice[])=>[...prices].sort((a,b)=>(b.observed_at??"").localeCompare(a.observed_at??""))[0];
type Ingredient={selected_offer_id?:string|null;selected_supplier_id?:string|null;price_research_enabled?:boolean;last_research_error?:string|null;id:string;name:string;spec?:string|null;current_price?:Price|null};
export default function IngredientManager({locale}:{locale:Locale}){
 const ja=locale==="ja";
 const [items,setItems]=useState<Ingredient[]>([]);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [selectedIds,setSelectedIds]=useState<string[]>([]);
 const [deleteResult,setDeleteResult]=useState("");
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
 const [units,setUnits]=useState<Unit[]>([]);
 const [allPrices,setAllPrices]=useState<Record<string,ApprovedPrice[]>>({});
 const [confirmation,setConfirmation]=useState<IngredientSavePayload|null>(null);
 const attempted=useRef<{key:string;payload:IngredientSavePayload}|null>(null);
 const uncertain=useRef(false);
 const baseline=useRef({supplier:"",price:"",quantity:"",unit:""});
 const editEpoch=useRef(0);
 const [page,setPage]=useState(1);
 const [sort,setSort]=useState<"name"|"price"|"supplier">("name");
 const [descending,setDescending]=useState(false);
 const pageSize=10;
 const [name,setName]=useState("");
 const [price,setPrice]=useState("");
 const [quantity,setQuantity]=useState("");
 const [unit,setUnit]=useState("");
 const [priceSupplier,setPriceSupplier]=useState("");
 const [approvedPrices,setApprovedPrices]=useState<ApprovedPrice[]>([]);
 useEffect(()=>{
  if(!editing)return;
  const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!busy){if(confirmation)setConfirmation(null);else setEditing(null);}};
  document.addEventListener("keydown",onKey);
  return()=>document.removeEventListener("keydown",onKey);
 },[editing,busy,confirmation]);
 const load=useCallback(async()=>{
  setLoading(true);
  try{
   const r=await fetch("/api/ingredients",{cache:"no-store"});
   if(!r.ok)throw new Error("load");
   const data=await r.json() as {items:Ingredient[];suppliers_by_ingredient?:Record<string,string[]>|null;approved_prices_by_ingredient?:Record<string,ApprovedPrice[]>};
   if(!Array.isArray(data.items))throw new Error("shape");
   setItems(data.items);setAllPrices(data.approved_prices_by_ingredient??{});setSupplierMap(data.suppliers_by_ingredient??null);setError("");
  }catch{setError(ja?"食材一覧を取得できません。":"Unable to load ingredients.");}
  finally{setLoading(false);}
 },[ja]);
 useEffect(()=>{void load();},[load]);
 async function begin(item:Ingredient){
  const version=++editEpoch.current;setConfirmation(null);attempted.current=null;uncertain.current=false;
  setEditing(item.id);setResearch(item.price_research_enabled??false);setName(item.name);setSpec(item.spec??"");setPriceSupplier("");
  setPrice(item.current_price?.amount_jpy?.value??"");
  setQuantity(item.current_price?.per_quantity??"");
  setUnit(item.current_price?.per_unit??"");
  baseline.current={supplier:"",price:item.current_price?.amount_jpy?.value??"",quantity:item.current_price?.per_quantity??"",unit:item.current_price?.per_unit??""};
  setUnits([]);setAvailableSuppliers([]);setError("");setSupplierLoading(true);setApprovedPrices([]);
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

   const pricesResponse=await fetch(`/api/ingredients/${item.id}/offer-prices`,{cache:"no-store"});
   if(!pricesResponse.ok)throw new Error("approved prices");
   const pricing=await pricesResponse.json() as {items?:typeof approvedPrices};
   if(!Array.isArray(pricing.items))throw new Error("approved prices shape");
   const unitResponse=await fetch("/api/units",{cache:"no-store"});
   if(!unitResponse.ok)throw new Error("units");
   const catalog=await unitResponse.json() as {items:Unit[]};
   if(!Array.isArray(catalog.items))throw new Error("units");
   if(version!==editEpoch.current)return;
   setUnits(catalog.items);setAvailableSuppliers(collected);setApprovedPrices(pricing.items);
   const quote=item.selected_offer_id?pricing.items.find(q=>q.offer_id===item.selected_offer_id):latest(pricing.items);
   const supplier=item.selected_supplier_id??quote?.supplier_id??collected.find(s=>s.is_market_reference)?.id??"";
   const legacy=item.selected_offer_id?null:item.current_price;
   const value=quote?.amount_jpy??legacy?.amount_jpy?.value??"";
   const qty=quote?.quantity??legacy?.per_quantity??"";
   const enteredUnit=quote?.unit??legacy?.per_unit??"";
   const u=catalog.items.find(item=>item.symbol===enteredUnit||item.aliases?.includes(enteredUnit))?.symbol??enteredUnit;
   setPriceSupplier(supplier);setPrice(value);setQuantity(qty);setUnit(u);
   baseline.current={supplier,price:value,quantity:qty,unit:u};
  }catch{if(version===editEpoch.current)setError(ingredientSaveMessage("api_unavailable",ja));}
  finally{if(version===editEpoch.current)setSupplierLoading(false);}
 }
 async function commit(id:string,payload:IngredientSavePayload){
  if(busy)return;setBusy(true);setError("");
  try{
   const r=await fetch("/api/ingredients/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
   if(!r.ok){uncertain.current=r.status>=500;let data:{error?:unknown}={};try{data=await r.json();}catch{}setError(ingredientSaveMessage(data.error??"database_error",ja));setConfirmation(null);return;}
   setConfirmation(null);setEditing(null);attempted.current=null;uncertain.current=false;await load();
  }catch{uncertain.current=true;setError(ingredientSaveMessage("api_unavailable",ja));setConfirmation(null);}
  finally{setBusy(false);}
 }
 async function save(id:string){
  if(busy||supplierLoading)return;
  if(uncertain.current&&attempted.current){
   const pending=attempted.current.payload;
   const purchase=pending.purchase;
   const previous=purchase?{supplier:pending.supplier_id??"",price:purchase.amount_jpy,quantity:purchase.quantity,unit:purchase.unit}:baseline.current;
   const sameInput=name.trim()===pending.name&&(spec.trim()||null)===pending.spec&&research===pending.price_research_enabled&&
    priceSupplier===(purchase||pending.supplier_id?pending.supplier_id??"":previous.supplier)&&
    normalizedNumber(price)===normalizedNumber(previous.price)&&normalizedNumber(quantity)===normalizedNumber(previous.quantity)&&unit===previous.unit;
   if(sameInput){if(purchase)setConfirmation(pending);else void commit(id,pending);return;}
   // Resolve the earlier approved write before interpreting edits against its old baseline.
   // Replaying its ID waits on the existing transaction/receipt; a GET alone could race it.
   setBusy(true);setError("");
   try{
    const response=await fetch("/api/ingredients/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(pending)});
    if(!response.ok&&response.status>=500){let data:{error?:unknown}={};try{data=await response.json();}catch{}setError(ingredientSaveMessage(data.error??"database_error",ja));return;}
    const refreshed=await fetch("/api/ingredients",{cache:"no-store"});
    if(!refreshed.ok)throw new Error("refresh");
    const data=await refreshed.json() as {items:Ingredient[];approved_prices_by_ingredient?:Record<string,ApprovedPrice[]>};
    const item=data.items.find(item=>item.id===id);if(!item)throw new Error("ingredient");
    const prices=data.approved_prices_by_ingredient?.[id]??[];
    const quote=item.selected_offer_id?prices.find(q=>q.offer_id===item.selected_offer_id):latest(prices);
    const legacy=item.selected_offer_id?null:item.current_price;
    const enteredUnit=quote?.unit??legacy?.per_unit??"";
    baseline.current={supplier:item.selected_supplier_id??quote?.supplier_id??availableSuppliers.find(s=>s.is_market_reference)?.id??"",
     price:quote?.amount_jpy??legacy?.amount_jpy?.value??"",quantity:quote?.quantity??legacy?.per_quantity??"",
     unit:units.find(u=>u.symbol===enteredUnit||u.aliases?.includes(enteredUnit))?.symbol??enteredUnit};
    setApprovedPrices(prices);uncertain.current=false;attempted.current=null;
   }catch{setError(ingredientSaveMessage("api_unavailable",ja));return;}
   finally{setBusy(false);}
  }
  if(!name.trim()||name.trim().length>200){setError(ingredientSaveMessage("invalid_input",ja));return;}
  const value=price.trim(),qty=quantity.trim(),u=unit.trim();
  const original=baseline.current;
  const changed=priceSupplier!==original.supplier||normalizedNumber(value)!==normalizedNumber(original.price)||
   normalizedNumber(qty)!==normalizedNumber(original.quantity)||u!==original.unit;
  const hasPrice=Boolean(value||qty||u);
  if(changed&&hasPrice&&(!/^(?:\d+)(?:\.\d+)?$/.test(value)||!/^(?:\d+)(?:\.\d+)?$/.test(qty)||
   !Number.isFinite(Number(value))||!Number.isFinite(Number(qty))||Number(qty)<=0||!u)){
   setError(ingredientSaveMessage("invalid_price",ja));return;
  }
  if(changed&&!hasPrice&&priceSupplier===original.supplier&&original.price){setError(ingredientSaveMessage("invalid_price",ja));return;}
  if(changed&&hasPrice&&!units.some(item=>item.symbol===u||item.aliases?.includes(u))){setError(ingredientSaveMessage("unit_unknown",ja));return;}
  if(priceSupplier&&!availableSuppliers.some(item=>item.id===priceSupplier)){setError(ingredientSaveMessage("supplier_unavailable",ja));return;}
  const values={name:name.trim(),spec:spec.trim()||null,price_research_enabled:research,
   supplier_id:changed?priceSupplier||null:null,purchase:changed&&hasPrice?{amount_jpy:value,quantity:qty,unit:u}:null,
   price_confirmed:changed&&hasPrice};
  const key=JSON.stringify(values);
  if(attempted.current?.key!==key)attempted.current={key,payload:{request_id:crypto.randomUUID(),...values}};
  setError("");
  if(values.purchase)setConfirmation(attempted.current.payload);
  else void commit(id,attempted.current.payload);
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
 async function removeSelected(){
  const selected=items.filter(item=>selectedIds.includes(item.id));
  if(busy||!selected.length)return;
  if(!window.confirm(ja?`選択した${selected.length}件の食材を削除しますか？この操作は取り消せません。使用中の食材は削除できません。`:`Delete ${selected.length} selected ingredients? This cannot be undone. Ingredients in use cannot be deleted.`))return;
  setBusy(true);setError("");setDeleteResult("");
  const succeeded:string[]=[],failed:string[]=[];
  for(const item of selected){
   try{const r=await fetch("/api/ingredients/"+encodeURIComponent(item.id),{method:"DELETE"});if(!r.ok)throw new Error("delete");succeeded.push(item.id);}
   catch{failed.push(item.name);}
  }
  setSelectedIds(ids=>ids.filter(id=>!succeeded.includes(id)));
  try{await load();}
  catch{setError(ja?"削除後の食材一覧を更新できませんでした。":"Unable to reload ingredients after deleting.");}
  setDeleteResult(ja?`${succeeded.length}件を削除しました。${failed.length?` ${failed.length}件は削除できませんでした：${failed.join("、")}`:""}`:`Deleted ${succeeded.length} ingredients.${failed.length?` Failed (${failed.length}): ${failed.join(", ")}`:""}`);
  setBusy(false);
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
 const displayedPrice=(item:Ingredient)=>item.selected_offer_id?(allPrices[item.id]??[]).find(q=>q.offer_id===item.selected_offer_id):latest(allPrices[item.id]??[]);
 const compare=(a:Ingredient,b:Ingredient)=>{
  if(sort==="price")return Number(displayedPrice(a)?.amount_jpy??(!a.selected_offer_id?a.current_price?.amount_jpy?.value:null)??-1)-Number(displayedPrice(b)?.amount_jpy??(!b.selected_offer_id?b.current_price?.amount_jpy?.value:null)??-1);
  if(sort==="supplier")return (supplierMap?.[a.id]?.join("、")??"").localeCompare(supplierMap?.[b.id]?.join("、")??"",locale);
  return a.name.localeCompare(b.name,locale);
 };
 const ordered=[...filtered].sort((a,b)=>(descending?-1:1)*compare(a,b));
 const sortBy=(field:"name"|"price"|"supplier")=>{setDescending(sort===field?!descending:false);setSort(field);setPage(1);};
 const pages=Math.max(1,Math.ceil(ordered.length/pageSize));
 const effectivePage=Math.min(page,pages);
 const visible=ordered.slice((effectivePage-1)*pageSize,effectivePage*pageSize);
 const visibleSelected=visible.length>0&&visible.every(item=>selectedIds.includes(item.id));
 const toggleSelected=(id:string,checked:boolean)=>setSelectedIds(ids=>checked?[...new Set([...ids,id])]:ids.filter(x=>x!==id));
 const toggleVisible=(checked:boolean)=>setSelectedIds(ids=>checked?[...new Set([...ids,...visible.map(item=>item.id)])]:ids.filter(id=>!visible.some(item=>item.id===id)));
 const formatAmount=(raw:string)=>{const [whole,...fraction]=raw.split(".");return whole.replace(/\B(?=(\d{3})+(?!\d))/g,",")+(fraction.length?"."+fraction.join("."):"");};
 const priceLabel=(item:Ingredient)=>{
  const quote=displayedPrice(item);
  if(quote)return `${quote.supplier_name??""}: ¥${formatAmount(quote.amount_jpy)} / ${quote.quantity} ${quote.unit}`;
  return !item.selected_offer_id&&item.current_price?.amount_jpy?.value!=null
   ?`${ja?"共通価格 ":"Shared price "}¥${formatAmount(item.current_price.amount_jpy.value)} / ${item.current_price.per_quantity??""} ${item.current_price.per_unit??""}`
   :(ja?"未設定":"Not set");
 };
 const suppliers=(item:Ingredient)=>supplierMap===null
  ? (ja?"確認できません":"Unavailable")
  : (supplierMap[item.id]?.join("、")||(ja?"仕入れ先未設定":"Not set"));
 const editor=(item:Ingredient)=><div className="name-choice-overlay ingredient-edit-overlay" key={item.id} onMouseDown={e=>{if(e.target===e.currentTarget&&!busy){if(confirmation)setConfirmation(null);else setEditing(null);}}}><section role="dialog" aria-modal="true" aria-label={confirmation?(ja?"食材と価格の保存確認":"Confirm ingredient and price save"):ja?`${item.name}を編集`:`Edit ${item.name}`} className="name-choice-dialog ingredient-editor">
  {confirmation?<>
   <h4>{ja?"食材と仕入価格を確認":"Review ingredient and purchase price"}</h4>
   <p>{confirmation.name} {confirmation.spec}</p>
   <p>{ja?"仕入れ先：":"Supplier: "}{availableSuppliers.find(s=>s.id===confirmation.supplier_id)?.name??(ja?"相場参考価格":"Market reference price")}</p>
   <p>¥{confirmation.purchase?.amount_jpy} / {confirmation.purchase?.quantity} {confirmation.purchase?.unit}</p>
   <p>{ja?"定期価格調査：":"Scheduled research: "}{confirmation.price_research_enabled?"ON":"OFF"}</p>
   <p>{ja?"承認すると食材情報と仕入価格をまとめて保存します。同じ仕入条件を使うレシピの現在原価に反映されます。":"Approval saves ingredient details and purchase price together, updating current costs for recipes using these purchase terms."}</p>
   <div className="ingredient-actions"><button type="button" disabled={busy} onClick={()=>void commit(item.id,confirmation)}>{ja?"承認して保存":"Approve and save"}</button><button type="button" className="secondary" disabled={busy} onClick={()=>setConfirmation(null)}>{ja?"戻る":"Back"}</button></div>
  </>:<>

  <div className="ingredient-editor-head"><h4>{ja?"食材を編集":"Edit Ingredient"} — {item.name}</h4><button type="button" className="secondary" aria-label={ja?"閉じる":"Close"} title={ja?"閉じる":"Close"} disabled={busy} onClick={()=>setEditing(null)}><span aria-hidden="true">×</span></button></div>
  <label><input type="checkbox" role="switch" checked={research} disabled={busy} onChange={e=>setResearch(e.target.checked)}/>{ja?"この食材を定期価格調査の対象にする":"Research this ingredient periodically"}</label>
  {item.last_research_error&&<p role="status">{ja?"前回の定期調査で価格を取得できませんでした。次回の調査で再試行します。":"The last scheduled research could not obtain a price. It will retry on the next interval."}</p>}
  <div className="ingredient-editor-fields">
   <label>{ja?"食材名":"Ingredient name"}<input autoFocus value={name} maxLength={200} disabled={busy} onChange={e=>setName(e.target.value)}/></label>
   <label>{ja?"規格（商品の識別用）":"Specification (identity only)"}<input value={spec} maxLength={200} disabled={busy} placeholder={ja?"例：1号缶、10個入り":"e.g. No.1 can, 10-count"} onChange={e=>setSpec(e.target.value)}/></label>
   <label>{ja?"仕入れ先（採用価格）":"Supplier (adopted price)"}<select value={priceSupplier} disabled={busy||supplierLoading} onChange={e=>{const id=e.target.value;setPriceSupplier(id);const q=latest(approvedPrices.filter(p=>p.supplier_id===id));setPrice(q?.amount_jpy??"");setQuantity(q?.quantity??"");setUnit(q?.unit??"");}}>{!availableSuppliers.some(s=>s.is_market_reference)&&<option value="">{ja?"相場参考価格":"Market reference price"}</option>}{availableSuppliers.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
   <label>{ja?"仕入価格（円）":"Purchase price (JPY)"}<input inputMode="decimal" value={price} disabled={busy||supplierLoading} onChange={e=>setPrice(e.target.value)}/></label>
   <label>{ja?"仕入数量":"Purchase quantity"}<input inputMode="decimal" value={quantity} disabled={busy||supplierLoading} onChange={e=>setQuantity(e.target.value)}/></label>
   <label>{ja?"仕入単位":"Purchase unit"}<select value={unit} disabled={busy||supplierLoading} onChange={e=>setUnit(e.target.value)}><option value="">{ja?"単位を選択":"Select a unit"}</option>{unit&&!units.some(u=>u.symbol===unit)&&<option value={unit}>{unit}（{ja?"未登録":"unregistered"}）</option>}{units.map(u=><option key={u.id} value={u.symbol}>{u.symbol}</option>)}</select></label>
  </div>
  {error&&<p role="alert" className="error">{error}</p>}
  <div className="ingredient-supplier-prices"><strong>{ja?"採用価格の比較":"Approved price comparison"}</strong>
   {approvedPrices.length===0?<p className="ingredient-muted">{ja?"採用価格はありません。":"No approved prices."}</p>:
   <ul>{approvedPrices.map(quote=><li key={quote.offer_id}>{quote.supplier_name??(ja?"相場参考価格":"Market reference price")}：¥{formatAmount(quote.amount_jpy)} / {quote.quantity} {quote.unit}</li>)}</ul>}
   <p className="ingredient-muted">{ja?"購入数量・単位が異なる価格は、そのまま高安比較しません。":"Different package quantities or units are not directly comparable."}</p>
  </div>
  <p className="ingredient-muted">{ja?"保存で食材情報と価格をまとめて更新します。価格を変更する場合は確認画面で承認してください。規格による自動単位換算はしません。":"Save updates ingredient details and price together. Price changes require confirmation. Specifications do not convert units."}</p>
  <p><a href="/settings?section=unit" target="_blank" rel="noopener noreferrer">{ja?"単位管理で未登録単位を登録":"Register missing units in Units"}</a> <button type="button" className="secondary" disabled={busy} onClick={()=>void fetch("/api/units",{cache:"no-store"}).then(async r=>{if(!r.ok)throw new Error();setUnits((await r.json()).items);}).catch(()=>setError(ingredientSaveMessage("api_unavailable",ja)))}>{ja?"単位一覧を更新":"Refresh units"}</button></p>
  <div className="ingredient-actions"><button type="button" disabled={busy||supplierLoading} onClick={()=>save(item.id)}>{ja?"保存":"Save"}</button><button type="button" className="secondary" disabled={busy} onClick={()=>setEditing(null)}>{ja?"キャンセル":"Cancel"}</button></div>
 </>}
 </section></div>;
 return <section className="ingredient-manager" aria-label={ja?"食材マスター":"Ingredient master"}>
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
  <div className="ingredient-actions">
   <button type="button" className="secondary ingredient-delete" disabled={busy||loading||selectedIds.length===0} onClick={()=>void removeSelected()}>{ja?`選択した${selectedIds.length}件を削除`:`Delete selected (${selectedIds.length})`}</button>
   <label><input type="checkbox" checked={visibleSelected} disabled={busy||loading||visible.length===0} onChange={e=>toggleVisible(e.target.checked)}/>{ja?"このページをすべて選択":"Select all on this page"}</label>
  </div>
  {deleteResult&&<p role="status">{deleteResult}</p>}
  {(query||supplierFilter!=="all")&&<button type="button" className="secondary" onClick={()=>{setQuery("");setSupplierFilter("all");setPage(1);}}>{ja?"絞り込みを解除":"Clear filters"}</button>}
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
    <thead><tr><th scope="col">{ja?"選択":"Select"}</th><th scope="col">{ja?"No.":"No."}</th><th scope="col" aria-sort={sort==="name"?(descending?"descending":"ascending"):"none"}><button type="button" className="ingredient-sort" onClick={()=>sortBy("name")}>{ja?"食材名":"Ingredient"} ↕</button></th><th scope="col" aria-sort={sort==="price"?(descending?"descending":"ascending"):"none"}><button type="button" className="ingredient-sort" onClick={()=>sortBy("price")}>{ja?"採用価格・単位":"Adopted price / Unit"} ↕</button></th><th scope="col" aria-sort={sort==="supplier"?(descending?"descending":"ascending"):"none"}><button type="button" className="ingredient-sort" onClick={()=>sortBy("supplier")}>{ja?"仕入れ先":"Supplier"} ↕</button></th><th scope="col">{ja?"備考":"Notes"}</th><th scope="col">{ja?"操作":"Actions"}</th></tr></thead>
    <tbody>{visible.map((item,i)=><tr key={item.id}>
     <td><input type="checkbox" aria-label={ja?`${item.name}を選択`:`Select ${item.name}`} checked={selectedIds.includes(item.id)} disabled={busy} onChange={e=>toggleSelected(item.id,e.target.checked)}/></td>
     <td>{(effectivePage-1)*pageSize+i+1}</td>
     <td><strong>{item.name}</strong>{item.spec&&<div className="ingredient-muted">{item.spec}</div>}</td>
     <td><span className={item.current_price?.amount_jpy?.value==null?"ingredient-unset":""}>{priceLabel(item)}</span></td>
     <td><span className={supplierMap&&!(supplierMap[item.id]?.length)?"ingredient-muted":""}>{suppliers(item)}</span></td>
     <td className="ingredient-muted">{item.price_research_enabled?(ja?"定期調査ON":"Research ON"):"—"}{item.last_research_error&&<span>{ja?" · 前回調査失敗":" · Last research failed"}</span>}</td>
     <td><div className="ingredient-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>void begin(item)}>{ja?"編集":"Edit"}</button><button type="button" className="secondary ingredient-delete" disabled={busy} onClick={()=>void remove(item)}>{ja?"削除":"Delete"}</button></div></td>
    </tr>)}</tbody>
   </table></div>
   <div className="ingredient-cards">{visible.map(item=><article key={item.id} className="ingredient-item-card">
    <div className="ingredient-item-head"><label><input type="checkbox" aria-label={ja?`${item.name}を選択`:`Select ${item.name}`} checked={selectedIds.includes(item.id)} disabled={busy} onChange={e=>toggleSelected(item.id,e.target.checked)}/></label><strong>{item.name}{item.spec&&<span className="ingredient-muted"> · {item.spec}</span>}</strong><button type="button" className="secondary" disabled={busy} onClick={()=>void begin(item)} aria-label={ja?`${item.name}を編集`:`Edit ${item.name}`}>›</button></div>
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
