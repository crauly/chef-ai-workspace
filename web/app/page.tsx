"use client";
import {useCallback,useEffect,useState} from "react";
import {label, type Locale} from "./i18n";
import AIEditor from "./AIEditor";
import {request, type Recipe} from "./types";
type Item={id:string;title:string;revision:number;updated_at?:string};
export default function Library(){
 const [items,setItems]=useState<Item[]>([]),[selected,setSelected]=useState<Recipe|null>(null);
 const [draft,setDraft]=useState(""),[rename,setRename]=useState(""),[error,setError]=useState("");
 const [busy,setBusy]=useState(false),[page,setPage]=useState(1);
 const [cost,setCost]=useState<{partial:boolean;total_cost_jpy:string|null;cost_rate_pct:string|null;estimated:boolean}|null>(null);
 const [food,setFood]=useState(""),[qty,setQty]=useState(""),[unit,setUnit]=useState("g"),[price,setPrice]=useState(""),[priceQty,setPriceQty]=useState("1"),[priceUnit,setPriceUnit]=useState("kg");
 const [locale,setLocale]=useState<Locale>("ja");
 const t=(key:Parameters<typeof label>[1])=>label(locale,key);
 useEffect(()=>{const current=localStorage.getItem("chef-ui-locale");if(current==="ja"||current==="en-US"){setLocale(current);document.documentElement.lang=current;}},[]);
 function switchLocale(next:Locale){setLocale(next);localStorage.setItem("chef-ui-locale",next);document.documentElement.lang=next;}
 useEffect(()=>{let active=true;setCost(null);if(selected){void request<{partial:boolean;total_cost_jpy:string|null;cost_rate_pct:string|null;estimated:boolean}>(`/api/recipes/${selected.id}/cost`).then(result=>{if(active)setCost(result);}).catch(()=>{if(active)setCost(null);});}return()=>{active=false;};},[selected?.id,selected?.revision]);
 const reload=useCallback(async()=>{try{setItems((await request<{items:Item[]}>(`/api/recipes?page=${page}&page_size=20`)).items);setError("");}catch(e){setError(String(e));}},[page]);
 useEffect(()=>{void reload();},[reload]);
 async function create(e:React.FormEvent){e.preventDefault();if(!draft.trim())return;setBusy(true);
 try{const recipe=await request<Recipe>("/api/recipes",{method:"POST",body:JSON.stringify({title:draft.trim()})});setDraft("");if(page===1){await reload();}else{setPage(1);}setSelected(recipe);setRename(recipe.title.value||"");}
 catch(e){setError(String(e));}finally{setBusy(false);}}
 async function open(id:string){if(busy)return;setBusy(true);try{const recipe=await request<Recipe>(`/api/recipes/${id}`);setSelected(recipe);setRename(recipe.title.value||"");setError("");}catch(e){setError(String(e));}finally{setBusy(false);}}
 async function change(e:React.FormEvent){e.preventDefault();if(!selected||!rename.trim())return;setBusy(true);
 try{const result=await request<{recipe:Recipe}>(`/api/recipes/${selected.id}/confirm`,{method:"POST",body:JSON.stringify({base_revision:selected.revision,request_id:crypto.randomUUID(),operations:[{op:"set_title",value:rename.trim()}],save_version:true})});setSelected(result.recipe);await reload();}
 catch(e){setError(String(e));}finally{setBusy(false);}}

 async function saveOperations(operations:Record<string,string>[]) {
   if(!selected||busy)return;
   setBusy(true);
   try {
     const result=await request<{recipe:Recipe}>(`/api/recipes/${selected.id}/confirm`,{
       method:"POST",body:JSON.stringify({base_revision:selected.revision,
         request_id:crypto.randomUUID(),operations,save_version:true})});
     setSelected(result.recipe);await reload();setError("");
   }catch(e){setError(String(e));}finally{setBusy(false);}
 }
 async function addFood(e:React.FormEvent){e.preventDefault();
   if(!food.trim()||!qty.trim()||!price.trim()||!priceQty.trim())return;
   await saveOperations([{op:"add_material",material_id:crypto.randomUUID(),name:food.trim(),
     quantity:qty,unit,price_jpy:price,price_quantity:priceQty,price_unit:priceUnit}]);
   setFood("");setQty("");setPrice("");
 }
 async function updateQuantity(materialId:string,quantity:string,measure:string){
   await saveOperations([{op:"set_material_quantity",material_id:materialId,value:quantity,unit:measure}]);
 }
 async function updatePrice(materialId:string,newPrice:string,perQuantity:string,perUnit:string){
   await saveOperations([{op:"set_material_price",material_id:materialId,
     price_jpy:newPrice,price_quantity:perQuantity,price_unit:perUnit}]);
 }
 return <main><header><div className="toolbar"><p className="tag">CHEF AI WORKSPACE</p><label className="language-picker"><span>Language</span><select aria-label="Display language" value={locale} onChange={e=>switchLocale(e.target.value as Locale)}><option value="ja">日本語</option><option value="en-US">English (US)</option></select></label></div><h1>{t("library")}</h1><p className="muted">{t("intro")}</p></header>
 <form onSubmit={create}><input aria-label={t("newName")} placeholder={t("newName")} value={draft} onChange={e=>setDraft(e.target.value)}/><button disabled={busy||!draft.trim()}>{t("create")}</button></form>
 {error&&<p role="alert" className="error">{error}</p>}
 <div className="grid">{items.map(item=><section className="card" key={item.id}><h2>{item.title}</h2><p className="muted">Version {item.revision}</p><button disabled={busy} onClick={()=>void open(item.id)}>{t("details")}</button></section>)}</div>
 {items.length===0&&!error&&<p className="muted">{t("empty")}</p>}
 <div className="toolbar"><button disabled={page===1} onClick={()=>setPage(p=>p-1)}>{t("previous")}</button><span>{t("page")} {page}</span><button disabled={items.length<20} onClick={()=>setPage(p=>p+1)}>{t("next")}</button></div>
 {selected&&<section className="card"><div className="toolbar"><h2>{t("detail")}</h2><button disabled={busy} onClick={()=>setSelected(null)}>{t("close")}</button></div>
 <p className="tag">Revision {selected.revision}</p>
 <AIEditor key={selected.id} recipe={selected} locale={locale} onBusy={setBusy} onSaved={recipe=>{setSelected(recipe);setRename(recipe.title.value||"");void reload();}} />
 <form onSubmit={change}><input aria-label={t("rename")} value={rename} onChange={e=>setRename(e.target.value)}/><button disabled={busy||!rename.trim()}>{t("save")}</button></form>
 <h2>{t("ingredients")}</h2>{selected.materials.length===0?<p className="muted">{t("noIngredients")}</p>:<ul>{selected.materials.map(m=><li key={m.id}><strong>{m.material_name.value?.trim() || t("unnamed")}</strong> — {m.quantity.value??t("missing")} {m.unit??""}{m.quantity.status==="assumed"?` (${t("assumed")})`:m.quantity.status==="unresolved"?` (${t("unresolved")})`:""} <button disabled={busy} type="button" onClick={()=>{const v=prompt(locale==="ja"?"新しい数量":"New quantity",m.quantity.value||"");if(v!==null&&v.trim())void updateQuantity(m.id,v,m.unit||"g");}}>{locale==="ja"?"数量変更":"Edit qty"}</button> <button disabled={busy} type="button" onClick={()=>{const p=m.price_override;const v=prompt(locale==="ja"?"新しい仕入単価（円）":"New price JPY",p?.amount_jpy.value||"");if(v!==null&&v.trim())void updatePrice(m.id,v,p?.per_quantity||"1",p?.per_unit||m.unit||"g");}}>{locale==="ja"?"単価変更":"Edit price"}</button></li>)}</ul>}
 <form onSubmit={addFood} className="material-form">
 <input aria-label={locale==="ja"?"食材名":"Ingredient name"} placeholder={locale==="ja"?"食材名（例：片栗粉）":"Ingredient name"} value={food} onChange={e=>setFood(e.target.value)} required/>
 <input aria-label={locale==="ja"?"数量":"Quantity"} placeholder={locale==="ja"?"数量":"Quantity"} inputMode="decimal" value={qty} onChange={e=>setQty(e.target.value)} required/>
 <select aria-label="Unit" value={unit} onChange={e=>setUnit(e.target.value)}><option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="L">L</option></select>
 <input aria-label={locale==="ja"?"仕入単価（円）":"Price (JPY)"} placeholder={locale==="ja"?"仕入単価 ¥":"Price ¥"} inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)} required/>
 <input aria-label={locale==="ja"?"単価の基準数量":"Price per quantity"} placeholder="1" inputMode="decimal" value={priceQty} onChange={e=>setPriceQty(e.target.value)} required/>
 <select aria-label="Price unit" value={priceUnit} onChange={e=>setPriceUnit(e.target.value)}><option value="kg">kg</option><option value="g">g</option><option value="L">L</option><option value="ml">ml</option></select>
 <button disabled={busy||!food.trim()||!qty.trim()||!price.trim()}>{locale==="ja"?"食材を追加":"Add ingredient"}</button>
 </form>
 {cost&&<section aria-label="Recipe cost summary" className="cost-summary"><strong>{locale==="ja"?"現在の原価":"Current food cost"}: {cost.total_cost_jpy===null?(locale==="ja"?"要確認":"Needs review"):`¥${cost.total_cost_jpy}`}</strong><span>{locale==="ja"?"原価率":"Food cost %"}: {cost.cost_rate_pct===null?"—":`${cost.cost_rate_pct}%`}{cost.estimated?` (${t("assumed")})`:""}</span></section>}
 <p className="muted">{t("price")}: {selected.selling_price_jpy.value??t("missing")}{selected.selling_price_jpy.status==="assumed"?` (${t("assumed")})`:selected.selling_price_jpy.status==="unresolved"?` (${t("unresolved")})`:""}</p>
 </section>}</main>;
}
