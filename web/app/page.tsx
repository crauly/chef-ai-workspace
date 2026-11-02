"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {label, type Locale} from "./i18n";
import AIEditor,{type EditorHandle} from "./AIEditor";
import DishImageSection from "./DishImageSection";
import {getDishPreview} from "./dish-image-cache";
import {recipeGaps} from "./recipe-gaps";
import VoiceWorkspace from "./VoiceWorkspace";
import PriceBell from "./PriceBell";
import {request, startupRead, type Recipe} from "./types";
type Item={id:string;title:string;revision:number;updated_at?:string};
export default function Library(){
 const [items,setItems]=useState<Item[]>([]),[selected,setSelected]=useState<Recipe|null>(null);
 const [thumbnails,setThumbnails]=useState<Record<string,string>>({});
 useEffect(()=>{
  if(selected)return;
  let active=true;
  const ids=items.map(item=>item.id);
  setThumbnails({});
  void Promise.all(ids.map(async id=>{
   try{return [id,await getDishPreview(id)] as const;}
   catch{return [id,null] as const;}
  })).then(images=>{
   if(active)setThumbnails(Object.fromEntries(images.filter((entry):entry is readonly [string,string]=>entry[1]!==null)));
  });
  return()=>{active=false;};
 },[items,selected]);
 const [draft,setDraft]=useState(""),[rename,setRename]=useState(""),[error,setError]=useState("");
 const [busy,setBusy]=useState(false),[page,setPage]=useState(1);
 const [query,setQuery]=useState(""),[searchInput,setSearchInput]=useState("");
 const listRequest=useRef(0);
 const voiceTarget=useRef<string|null>(null);
 const editor=useRef<EditorHandle|null>(null),reviewBoundary=useRef<(()=>number)|null>(null);
 const browseWaiter=useRef<((recipe:Recipe|null)=>void)|null>(null);
 useEffect(()=>{if(selected&&browseWaiter.current){browseWaiter.current(selected);browseWaiter.current=null;}},[selected]);
 const [loadingList,setLoadingList]=useState(false);
 const [waking,setWaking]=useState(false);
 const [cost,setCost]=useState<{partial:boolean;total_cost_jpy:string|null;cost_rate_pct:string|null;estimated:boolean}|null>(null);
 const [food,setFood]=useState(""),[qty,setQty]=useState(""),[unit,setUnit]=useState("g"),[price,setPrice]=useState(""),[priceQty,setPriceQty]=useState("1"),[priceUnit,setPriceUnit]=useState("kg");
 // Recipe detail editing (modal) + AI consult toggle. The modal only calls
 // the existing /confirm path (saveOperations); the AI editor stays mounted
 // while collapsed so the voice edit flow keeps working.
 const [editingId,setEditingId]=useState<string|null>(null);
 const [editQty,setEditQty]=useState(""),[editUnit,setEditUnit]=useState("g");
 const [editPrice,setEditPrice]=useState(""),[editPriceQty,setEditPriceQty]=useState("1"),[editPriceUnit,setEditPriceUnit]=useState("g");
 const [aiOpen,setAiOpen]=useState(false);
 const [confirmQty,setConfirmQty]=useState(false),[confirmPrice,setConfirmPrice]=useState(false);
 const detailRef=useRef<HTMLElement|null>(null);
 useEffect(()=>{
  let active=true;
  const sync=async()=>{
   const match=window.location.pathname.match(/^\/recipes\/([^/]+)\/?$/);
   if(!match){setSelected(null);return;}
   try{const recipe=await request<Recipe>(`/api/recipes/${encodeURIComponent(decodeURIComponent(match[1]))}`);
    if(active&&window.location.pathname===`/recipes/${encodeURIComponent(recipe.id)}`){setSelected(recipe);setRename(recipe.title.value||"");setError("");}}
   catch(e){if(active)setError(String(e));}
  };
  void sync();window.addEventListener("popstate",sync);
  return()=>{active=false;window.removeEventListener("popstate",sync);};
 },[]);
 function showDetail(recipe:Recipe){setSelected(recipe);setRename(recipe.title.value||"");window.history.pushState(null,"",`/recipes/${encodeURIComponent(recipe.id)}`);window.scrollTo({top:0,behavior:"instant"});}
 function backToLibrary(){setEditingId(null);setAiOpen(false);setSelected(null);window.history.pushState(null,"","/");window.scrollTo({top:0,behavior:"instant"});}

 const [locale,setLocale]=useState<Locale>("ja");
 const t=(key:Parameters<typeof label>[1])=>label(locale,key);
 useEffect(()=>{const current=localStorage.getItem("chef-ui-locale");if(current==="ja"||current==="en-US"){setLocale(current);document.documentElement.lang=current;}},[]);
 function switchLocale(next:Locale){setLocale(next);localStorage.setItem("chef-ui-locale",next);document.documentElement.lang=next;}
 useEffect(()=>{let active=true;setCost(null);if(selected){void request<{partial:boolean;total_cost_jpy:string|null;cost_rate_pct:string|null;estimated:boolean}>(`/api/recipes/${selected.id}/cost`).then(result=>{if(active)setCost(result);}).catch(()=>{if(active)setCost(null);});}return()=>{active=false;};},[selected?.id,selected?.revision]);
 const reload=useCallback(async()=>{
   const current=++listRequest.current;setWaking(false);setLoadingList(true);
   try{
     const result=await startupRead<{items:Item[]}>(`/api/recipes?page=${page}&page_size=20&q=${encodeURIComponent(query)}`,()=>{if(current===listRequest.current)setWaking(true);});
     if(current===listRequest.current){
       setItems(result.items);setError("");
       const fromVoice=voiceTarget.current===query;
       if(fromVoice)voiceTarget.current=null;
       if(fromVoice&&page===1&&result.items.length===1){
         const recipe=await request<Recipe>(`/api/recipes/${result.items[0].id}`);
         if(current===listRequest.current){showDetail(recipe);}
       }
       if(fromVoice&&result.items.length!==1){browseWaiter.current?.(null);browseWaiter.current=null;}
     }
   }catch(e){if(current===listRequest.current){setError(String(e));browseWaiter.current?.(null);browseWaiter.current=null;}}
   finally{if(current===listRequest.current){setWaking(false);setLoadingList(false);}}
 },[page,query]);
 useEffect(()=>{void reload();return()=>{listRequest.current++;};},[reload]);
 function search(name:string,fromVoice=false){
   if(!fromVoice){browseWaiter.current?.(null);browseWaiter.current=null;}
   voiceTarget.current=fromVoice?name.trim():null;
   listRequest.current++;setItems([]);setSelected(null);setPage(1);setLoadingList(true);
   setSearchInput(name.trim());setQuery(name.trim());
   if(page===1&&query===name.trim())void reload();
 }
 async function create(e:React.FormEvent){e.preventDefault();if(!draft.trim())return;setBusy(true);
 try{const recipe=await request<Recipe>("/api/recipes",{method:"POST",body:JSON.stringify({title:draft.trim()})});setDraft("");if(page===1){await reload();}else{setPage(1);}showDetail(recipe);}
 catch(e){setError(String(e));}finally{setBusy(false);}}
 async function open(id:string){if(busy)return;setBusy(true);try{const recipe=await request<Recipe>(`/api/recipes/${id}`);showDetail(recipe);setError("");}catch(e){setError(String(e));}finally{setBusy(false);}}
 async function change(e:React.FormEvent){e.preventDefault();if(!selected||!rename.trim())return;setBusy(true);
 try{const result=await request<{recipe:Recipe}>(`/api/recipes/${selected.id}/confirm`,{method:"POST",body:JSON.stringify({base_revision:selected.revision,request_id:crypto.randomUUID(),operations:[{op:"set_title",value:rename.trim()}],save_version:true})});setSelected(result.recipe);await reload();}
 catch(e){setError(String(e));}finally{setBusy(false);}}

 async function saveOperations(operations:Record<string,string>[]):Promise<boolean> {
   if(!selected||busy)return false;
   setBusy(true);
   try {
     const result=await request<{recipe:Recipe}>(`/api/recipes/${selected.id}/confirm`,{
       method:"POST",body:JSON.stringify({base_revision:selected.revision,
         request_id:crypto.randomUUID(),operations,save_version:true})});
     setSelected(result.recipe);await reload();setError("");return true;
   }catch(e){setError(String(e));return false;}finally{setBusy(false);}
 }
 async function addFood(e:React.FormEvent){e.preventDefault();
   if(!food.trim()||!qty.trim()||!price.trim()||!priceQty.trim())return;
   await saveOperations([{op:"add_material",material_id:crypto.randomUUID(),name:food.trim(),
     quantity:qty,unit,price_jpy:price,price_quantity:priceQty,price_unit:priceUnit}]);
   setFood("");setQty("");setPrice("");
 }
 function openEdit(materialId:string){
   const line=selected?.materials.find(m=>m.id===materialId);
   if(!line||busy)return;
   setEditQty(line.quantity.value||"");setEditUnit(line.unit||"g");
   setEditPrice(line.price_override?.amount_jpy.value||"");
   setEditPriceQty(line.price_override?.per_quantity||"1");
   setEditPriceUnit(line.price_override?.per_unit||line.unit||"g");
   setConfirmQty(false);setConfirmPrice(false);setEditingId(materialId);
 }
 async function submitEdit(){
   const line=selected?.materials.find(m=>m.id===editingId);
   if(!line)return;
   const operations:Record<string,string>[]=[];
   if((editQty.trim()&&editQty.trim()!==line.quantity.value)||editUnit!==(line.unit||"g")||(confirmQty&&line.quantity.status==="assumed"))
     operations.push({op:"set_material_quantity",material_id:line.id,value:editQty.trim()||line.quantity.value||"",unit:editUnit});
   if(!line.ingredient_id&&((editPrice.trim()&&editPrice.trim()!==(line.price_override?.amount_jpy.value||""))||editPriceQty!==(line.price_override?.per_quantity||"1")||editPriceUnit!==(line.price_override?.per_unit||line.unit||"g")||(confirmPrice&&line.price_override?.amount_jpy.status==="assumed")))
     operations.push({op:"set_material_price",material_id:line.id,
       price_jpy:editPrice.trim()||line.price_override?.amount_jpy.value||"",
       price_quantity:editPriceQty,price_unit:editPriceUnit});
   if(!operations.length){setEditingId(null);return;}
   if(await saveOperations(operations))setEditingId(null);
 }
 function browseByVoice(target:string):Promise<Recipe|null>{
  browseWaiter.current?.(null);
  return new Promise(resolve=>{browseWaiter.current=resolve;search(target,true);});
 }
 return <main id="top" className={selected?"recipe-detail-page":""}><div><header className="chef-header"><div className="toolbar"><p className="tag">CHEF AI WORKSPACE</p><PriceBell locale={locale}/><label className="language-picker"><span>Language</span><select aria-label="Display language" value={locale} onChange={e=>switchLocale(e.target.value as Locale)}><option value="ja">Japanese</option><option value="en-US">English</option></select></label></div><div className="chef-brand"><img src="/chef-ai-mark.svg" alt="" width="58" height="58"/><h1>Chef AI</h1></div><p className="muted">{t("intro")}</p></header>
 </div><div><VoiceWorkspace locale={locale} selected={selected} editor={editor} reviewBoundary={reviewBoundary} onBrowse={browseByVoice} onCreated={recipe=>{showDetail(recipe);setError("");void reload();}}/></div>
 <div hidden={Boolean(selected)}>
 <section className="workspace-section recipe-library-section" aria-labelledby="recipe-library-heading">
 <div className="workspace-section-head"><div><h2 id="recipe-library-heading">{locale==="ja"?"レシピ一覧":"Recipes"}</h2><p>{locale==="ja"?"保存したレシピを検索・閲覧":"Search and browse saved recipes"}</p></div></div>
 <div className="recipe-library-controls"><form onSubmit={create}><input aria-label={t("newName")} placeholder={t("newName")} value={draft} onChange={e=>setDraft(e.target.value)}/><button disabled={busy||!draft.trim()}>{t("create")}</button></form>
 <form onSubmit={e=>{e.preventDefault();search(searchInput);}}>
  <input aria-label={locale==="ja"?"レシピ名で検索":"Search recipes by name"} maxLength={200} value={searchInput} onChange={e=>setSearchInput(e.target.value)}/>
  <button type="submit" disabled={busy}>{locale==="ja"?"検索":"Search"}</button>
  {query&&<button type="button" disabled={busy} onClick={()=>search("")}>{locale==="ja"?"検索を解除":"Clear search"}</button>}
 </form></div>
 {query&&<p role="status">{locale==="ja"?"検索中の料理名":"Recipe search"}: {query}</p>}
 {waking&&<p role="status" aria-live="polite">{locale==="ja"?"サーバーを起動しています。接続を再試行しています…":"Starting the server. Retrying connection…"}</p>}
 {error&&<p role="alert" className="error">{error}</p>}
 <div id="recipes" className="recipe-list" aria-busy={loadingList}>{items.map(item=><button key={item.id} className="recipe-list-item" disabled={busy} onClick={()=>void open(item.id)} aria-label={locale==="ja"?`${item.title}の詳細を開く`:`View ${item.title}`}>
  <span className="recipe-list-thumbnail" aria-hidden="true">{thumbnails[item.id]?<img src={thumbnails[item.id]} alt="" loading="lazy" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<span>♨</span>}</span>
  <span className="recipe-list-copy"><strong>{item.title}</strong><small>{locale==="ja"?"レシピ":"Recipe"} · Rev {item.revision}</small></span>
  <span className="recipe-list-chevron" aria-hidden="true">›</span>
 </button>)}</div>
 {items.length===0&&!error&&!loadingList&&<p className="muted">{query?(locale==="ja"?"一致するレシピがありません。":"No recipes match this name."):t("empty")}</p>}
 <div className="toolbar"><button disabled={page===1} onClick={()=>setPage(p=>p-1)}>{t("previous")}</button><span>{t("page")} {page}</span><button disabled={items.length<20} onClick={()=>setPage(p=>p+1)}>{t("next")}</button></div>
 </section>

 </div>
 {selected&&<section className="recipe-detail" ref={detailRef} aria-label={t("detail")}> 
 <div className="detail-topbar"><button type="button" className="detail-back" onClick={backToLibrary}>{locale==="ja"?"← レシピ一覧":"← Recipes"}</button><span className="detail-revision">REV {selected.revision}</span></div>
 <div className="detail-heading"><p className="detail-eyebrow">{locale==="ja"?"RECIPE DETAIL":"RECIPE DETAIL"}</p><h2>{selected.title.value||t("detail")}</h2></div>
 {recipeGaps(selected).length>0&&<details className="recipe-gap-disclosure">
  <summary title={locale==="ja"?"不足情報を確認":"View incomplete fields"}><span aria-hidden="true">⚠</span> {locale==="ja"?"未確定情報":"Incomplete details"} · {recipeGaps(selected).length}{locale==="ja"?"件":""}</summary>
  <ul>{recipeGaps(selected).map((gap,index)=><li key={index}>{gap}</li>)}</ul>
  <p>{locale==="ja"?"内容は保存されています。編集画面で後から補完できます。":"The recipe is saved. You can fill in these fields later."}</p>
 </details>}
 <DishImageSection key={selected.id} recipeId={selected.id} title={selected.title.value||""} names={selected.materials.map(m=>selected.display_names?.[m.id]?.display?.trim()||m.material_name.value||"")} locale={locale} disabled={busy}/>
 <div className="detail-metrics" role="region" aria-label="Recipe cost summary">
  <div><span>{locale==="ja"?"販売価格":"Selling price"}</span><strong>{selected.selling_price_jpy.value===null?"—":`¥${selected.selling_price_jpy.value}`}</strong></div>
  <div><span>{locale==="ja"?"材料原価":"Food cost"}</span><strong>{cost?.total_cost_jpy==null?"—":`¥${cost.total_cost_jpy}`}</strong></div>
  <div><span>{locale==="ja"?"原価率":"Cost rate"}</span><strong>{cost?.cost_rate_pct==null?"—":`${cost.cost_rate_pct}%`}</strong></div>
 </div>

 <div className="detail-section-heading"><h3>{t("ingredients")}</h3><span>{selected.materials.length}{locale==="ja"?"品目":" items"}</span></div>{selected.materials.length===0?<p className="muted">{t("noIngredients")}</p>:<ul className="detail-ingredients">{selected.materials.map(m=>{
  const name=selected.display_names?.[m.id]?.display?.trim()||m.material_name.value?.trim()||t("unnamed");
  const qtyMark=m.quantity.status==="assumed"?` (${t("assumed")})`:m.quantity.status==="unresolved"?` (${t("unresolved")})`:"";
  const price=m.price_override;
  const priceText=price?`${locale==="ja"?"仕入単価":"Purchase"} ¥${price.amount_jpy.value} / ${price.per_quantity}${price.per_unit}${price.amount_jpy.status==="assumed"?` (${t("assumed")})`:price.amount_jpy.status==="unresolved"?` (${t("unresolved")})`:""}`:m.price_mode==="inherit"?(locale==="ja"?"共通食材の継承価格（詳細値は未取得）":"Inherited ingredient price (not loaded)"):(locale==="ja"?"仕入単価 未設定":"Purchase price not set");
  return <li key={m.id} className="ingredient-row"><div className="ingredient-main"><strong>{name}</strong><div className="detail-ingredient-data"><span className="detail-ingredient-qty">{m.quantity.value??t("missing")} {m.unit??""}{qtyMark}</span><span className="ingredient-price">{priceText}</span></div></div><button className="icon-button" disabled={busy} type="button" aria-label={locale==="ja"?`${name}を編集`:`Edit ${name}`} onClick={()=>openEdit(m.id)}>✏️</button></li>;})}</ul>}
 {editingId!==null&&(()=>{
  const line=selected.materials.find(m=>m.id===editingId);
  if(!line)return null;
  const name=selected.display_names?.[line.id]?.display?.trim()||line.material_name.value?.trim()||t("unnamed");
  const qtyChanged=editQty.trim()!==line.quantity.value||editUnit!==(line.unit||"g");
  const priceChanged=!line.ingredient_id&&(editPrice.trim()!==(line.price_override?.amount_jpy.value||"")||editPriceQty!==(line.price_override?.per_quantity||"1")||editPriceUnit!==(line.price_override?.per_unit||line.unit||"g"));
  return <div className="name-choice-overlay" onClick={()=>setEditingId(null)}>
   <section role="dialog" aria-modal="true" aria-label={locale==="ja"?`${name}を編集`:`Edit ${name}`} className="name-choice-dialog" onClick={e=>e.stopPropagation()}>
    <h4>{name}</h4>
    <p className="muted">{locale==="ja"?"現在":"Current"}: {line.quantity.value??t("missing")} {line.unit??""} ／ {line.price_override?`¥${line.price_override.amount_jpy.value} / ${line.price_override.per_quantity}${line.price_override.per_unit}`:line.price_mode==="inherit"?(locale==="ja"?"共通食材から継承（単価はここでは未取得）":"Inherited from shared ingredient (price not loaded)"):(locale==="ja"?"仕入単価 未設定":"Purchase price not set")}</p>
    {(qtyChanged||priceChanged)&&<p className="edit-diff">{locale==="ja"?"変更後":"After"}: {editQty.trim()||"?"} {editUnit}{priceChanged?` ／ ¥${editPrice.trim()||"?"} / ${editPriceQty}${editPriceUnit}`:""}</p>}
    <div className="edit-modal-fields">
     <label>{locale==="ja"?"数量":"Quantity"}<input inputMode="decimal" value={editQty} onChange={e=>setEditQty(e.target.value)} disabled={busy}/></label>
     <label>Unit<select value={editUnit} onChange={e=>setEditUnit(e.target.value)} disabled={busy}><option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="L">L</option>{editUnit&&!["g","kg","ml","L"].includes(editUnit)&&<option value={editUnit}>{editUnit}</option>}</select></label>
     {!line.ingredient_id&&<>
     <label>{locale==="ja"?"仕入単価（円）":"Price (JPY)"}<input inputMode="decimal" value={editPrice} onChange={e=>setEditPrice(e.target.value)} disabled={busy}/></label>
     <label>{locale==="ja"?"単価の基準数量":"Price per quantity"}<input inputMode="decimal" value={editPriceQty} onChange={e=>setEditPriceQty(e.target.value)} disabled={busy}/></label>
     <label>Price unit<select value={editPriceUnit} onChange={e=>setEditPriceUnit(e.target.value)} disabled={busy}><option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="L">L</option>{editPriceUnit&&!["g","kg","ml","L"].includes(editPriceUnit)&&<option value={editPriceUnit}>{editPriceUnit}</option>}</select></label>
     </>}
     {line.quantity.status==="assumed"&&<label><input type="checkbox" checked={confirmQty} onChange={e=>setConfirmQty(e.target.checked)}/> {locale==="ja"?"現在の数量を明示確定":"Confirm current quantity"}</label>}
     {!line.ingredient_id&&line.price_override?.amount_jpy.status==="assumed"&&<label><input type="checkbox" checked={confirmPrice} onChange={e=>setConfirmPrice(e.target.checked)}/> {locale==="ja"?"現在の仕入価格を明示確定":"Confirm current price"}</label>}
    </div>
    <div className="actions"><button type="button" disabled={busy} onClick={()=>void submitEdit()}>{t("save")}</button>
    <button className="secondary" type="button" disabled={busy} onClick={()=>setEditingId(null)}>{t("close")}</button></div>
   </section>
  </div>;})()}
 <details className="detail-action"><summary>{locale==="ja"?"＋ 食材を追加":"＋ Add ingredient"}</summary><form onSubmit={addFood} className="material-form">
 <fieldset><legend>{locale==="ja"?"食材":"Ingredient"}</legend>
 <input aria-label={locale==="ja"?"食材名":"Ingredient name"} placeholder={locale==="ja"?"食材名（例：片栗粉）":"Ingredient name"} value={food} onChange={e=>setFood(e.target.value)} required/>
 </fieldset>
 <fieldset><legend>{locale==="ja"?"分量":"Quantity"}</legend>
 <input aria-label={locale==="ja"?"数量":"Quantity"} placeholder={locale==="ja"?"数量":"Quantity"} inputMode="decimal" value={qty} onChange={e=>setQty(e.target.value)} required/>
 <select aria-label="Unit" value={unit} onChange={e=>setUnit(e.target.value)}><option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="L">L</option></select>
 </fieldset>
 <fieldset><legend>{locale==="ja"?"仕入単価":"Unit price"}</legend>
 <input aria-label={locale==="ja"?"仕入単価（円）":"Price (JPY)"} placeholder={locale==="ja"?"仕入単価 ¥":"Price ¥"} inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)} required/>
 <input aria-label={locale==="ja"?"単価の基準数量":"Price per quantity"} placeholder="1" inputMode="decimal" value={priceQty} onChange={e=>setPriceQty(e.target.value)} required/>
 <select aria-label="Price unit" value={priceUnit} onChange={e=>setPriceUnit(e.target.value)}><option value="kg">kg</option><option value="g">g</option><option value="L">L</option><option value="ml">ml</option></select>
 </fieldset>
 <button disabled={busy||!food.trim()||!qty.trim()||!price.trim()}>{locale==="ja"?"食材を追加":"Add ingredient"}</button>
 </form></details>
 {cost?.estimated&&<p className="detail-estimate">{locale==="ja"?"原価に推定値が含まれます":"Cost includes estimates"}</p>}
 <details className="detail-action"><summary>{locale==="ja"?"✎ 料理名を変更":"✎ Rename recipe"}</summary><form onSubmit={change}><input aria-label={t("rename")} value={rename} onChange={e=>setRename(e.target.value)}/><button disabled={busy||!rename.trim()}>{t("save")}</button></form></details>
 <button type="button" disabled={busy} aria-expanded={aiOpen} onClick={()=>setAiOpen(v=>!v)} className="detail-ai-button">{locale==="ja"?"◇ AIに変更相談":"◇ Ask AI to edit"}</button>
 <div hidden={!aiOpen}><AIEditor key={selected.id} recipe={selected} locale={locale} control={editor} markReview={()=>reviewBoundary.current?.()??-1} onBusy={b=>{setBusy(b);if(b)setAiOpen(true);}} onSaved={recipe=>{setSelected(recipe);setRename(recipe.title.value||"");void reload();}} /></div>
 </section>}</main>;
}
