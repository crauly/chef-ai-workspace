"use client";
import {useCallback,useEffect,useState} from "react";
import {label, type Locale} from "./i18n";
type Item={id:string;title:string;revision:number;updated_at?:string};
type Recipe={id:string;title:{value:string|null};revision:number;materials:{id:string;material_name:{value:string|null};quantity:{value:string|null;status:string};unit:string|null}[];selling_price_jpy:{value:string|null;status:string}};
async function request<T>(path:string,init?:RequestInit):Promise<T>{
 const r=await fetch(path,{...init,headers:{"Content-Type":"application/json",...(init?.headers||{})},cache:"no-store"});
 if(!r.ok)throw new Error("HTTP "+r.status);
 return r.json();
}
export default function Library(){
 const [items,setItems]=useState<Item[]>([]),[selected,setSelected]=useState<Recipe|null>(null);
 const [draft,setDraft]=useState(""),[rename,setRename]=useState(""),[error,setError]=useState("");
 const [busy,setBusy]=useState(false),[page,setPage]=useState(1);
 const [locale,setLocale]=useState<Locale>("ja");
 const t=(key:Parameters<typeof label>[1])=>label(locale,key);
 useEffect(()=>{const current=localStorage.getItem("chef-ui-locale");if(current==="ja"||current==="en-US")setLocale(current);},[]);
 function switchLocale(next:Locale){setLocale(next);localStorage.setItem("chef-ui-locale",next);document.documentElement.lang=next;}
 const reload=useCallback(async()=>{try{setItems((await request<{items:Item[]}>(`/api/recipes?page=${page}&page_size=20`)).items);setError("");}catch(e){setError(String(e));}},[page]);
 useEffect(()=>{void reload();},[reload]);
 async function create(e:React.FormEvent){e.preventDefault();if(!draft.trim())return;setBusy(true);
 try{const recipe=await request<Recipe>("/api/recipes",{method:"POST",body:JSON.stringify({title:draft.trim()})});setDraft("");if(page===1){await reload();}else{setPage(1);}setSelected(recipe);setRename(recipe.title.value||"");}
 catch(e){setError(String(e));}finally{setBusy(false);}}
 async function open(id:string){if(busy)return;try{const recipe=await request<Recipe>(`/api/recipes/${id}`);setSelected(recipe);setRename(recipe.title.value||"");setError("");}catch(e){setError(String(e));}}
 async function change(e:React.FormEvent){e.preventDefault();if(!selected||!rename.trim())return;setBusy(true);
 try{const result=await request<{recipe:Recipe}>(`/api/recipes/${selected.id}/confirm`,{method:"POST",body:JSON.stringify({base_revision:selected.revision,request_id:crypto.randomUUID(),operations:[{op:"set_title",value:rename.trim()}],save_version:true})});setSelected(result.recipe);await reload();}
 catch(e){setError(String(e));}finally{setBusy(false);}}
 return <main><header><div className="toolbar"><p className="tag">CHEF AI WORKSPACE</p><label className="language-picker"><span>Language</span><select aria-label="Display language" value={locale} onChange={e=>switchLocale(e.target.value as Locale)}><option value="ja">日本語</option><option value="en-US">English (US)</option></select></label></div><h1>{t("library")}</h1><p className="muted">{t("intro")}</p></header>
 <form onSubmit={create}><input aria-label={t("newName")} placeholder={t("newName")} value={draft} onChange={e=>setDraft(e.target.value)}/><button disabled={busy||!draft.trim()}>{t("create")}</button></form>
 {error&&<p role="alert" className="error">{error}</p>}
 <div className="grid">{items.map(item=><section className="card" key={item.id}><h2>{item.title}</h2><p className="muted">Version {item.revision}</p><button disabled={busy} onClick={()=>void open(item.id)}>{t("details")}</button></section>)}</div>
 {items.length===0&&!error&&<p className="muted">{t("empty")}</p>}
 <div className="toolbar"><button disabled={page===1} onClick={()=>setPage(p=>p-1)}>{t("previous")}</button><span>{t("page")} {page}</span><button disabled={items.length<20} onClick={()=>setPage(p=>p+1)}>{t("next")}</button></div>
 {selected&&<section className="card"><div className="toolbar"><h2>{t("detail")}</h2><button disabled={busy} onClick={()=>setSelected(null)}>{t("close")}</button></div>
 <p className="tag">Revision {selected.revision}</p>
 <form onSubmit={change}><input aria-label={t("rename")} value={rename} onChange={e=>setRename(e.target.value)}/><button disabled={busy||!rename.trim()}>{t("save")}</button></form>
 <h2>{t("ingredients")}</h2>{selected.materials.length===0?<p className="muted">{t("noIngredients")}</p>:<ul>{selected.materials.map(m=><li key={m.id}><strong>{m.material_name.value?.trim() || t("unnamed")}</strong> — {m.quantity.value??t("missing")} {m.unit??""}{m.quantity.status==="assumed"?` (${t("assumed")})`:m.quantity.status==="unresolved"?` (${t("unresolved")})`:""}</li>)}</ul>}
 <p className="muted">{t("price")}: {selected.selling_price_jpy.value??t("missing")}{selected.selling_price_jpy.status==="assumed"?` (${t("assumed")})`:selected.selling_price_jpy.status==="unresolved"?` (${t("unresolved")})`:""}</p>
 </section>}</main>;
}
