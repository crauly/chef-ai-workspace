"use client";
import {useCallback,useEffect,useState} from "react";
type Item={id:string;title:string;revision:number;updated_at?:string};
type Recipe={id:string;title:{value:string|null};revision:number;materials:{id:string;material_name:{value:string|null};quantity:{value:string|null;status:string};unit:string|null}[];selling_price_jpy:{value:string|null;status:string}};
async function request<T>(path:string,init?:RequestInit):Promise<T>{
 const r=await fetch(path,{...init,headers:{"Content-Type":"application/json",...(init?.headers||{})},cache:"no-store"});
 if(!r.ok)throw new Error("通信に失敗しました（HTTP "+r.status+"）");
 return r.json();
}
export default function Library(){
 const [items,setItems]=useState<Item[]>([]),[selected,setSelected]=useState<Recipe|null>(null);
 const [draft,setDraft]=useState(""),[rename,setRename]=useState(""),[error,setError]=useState("");
 const [busy,setBusy]=useState(false),[page,setPage]=useState(1);
 const reload=useCallback(async()=>{try{setItems((await request<{items:Item[]}>(`/api/recipes?page=${page}&page_size=20`)).items);setError("");}catch(e){setError(String(e));}},[page]);
 useEffect(()=>{void reload();},[reload]);
 async function create(e:React.FormEvent){e.preventDefault();if(!draft.trim())return;setBusy(true);
 try{const recipe=await request<Recipe>("/api/recipes",{method:"POST",body:JSON.stringify({title:draft.trim()})});setDraft("");if(page===1){await reload();}else{setPage(1);}setSelected(recipe);setRename(recipe.title.value||"");}
 catch(e){setError(String(e));}finally{setBusy(false);}}
 async function open(id:string){if(busy)return;try{const recipe=await request<Recipe>(`/api/recipes/${id}`);setSelected(recipe);setRename(recipe.title.value||"");setError("");}catch(e){setError(String(e));}}
 async function change(e:React.FormEvent){e.preventDefault();if(!selected||!rename.trim())return;setBusy(true);
 try{const result=await request<{recipe:Recipe}>(`/api/recipes/${selected.id}/confirm`,{method:"POST",body:JSON.stringify({base_revision:selected.revision,request_id:crypto.randomUUID(),operations:[{op:"set_title",value:rename.trim()}],save_version:true})});setSelected(result.recipe);await reload();}
 catch(e){setError(String(e));}finally{setBusy(false);}}
 return <main><header><p className="tag">CHEF AI WORKSPACE · RECIPE LIBRARY</p><h1>レシピライブラリ</h1><p className="muted">料理のレシピをストックし、変更・保存できます。</p></header>
 <form onSubmit={create}><input aria-label="新しいレシピ名" placeholder="新しいレシピ名" value={draft} onChange={e=>setDraft(e.target.value)}/><button disabled={busy||!draft.trim()}>レシピを作成</button></form>
 {error&&<p role="alert" className="error">{error}</p>}
 <div className="grid">{items.map(item=><section className="card" key={item.id}><h2>{item.title}</h2><p className="muted">Version {item.revision}</p><button disabled={busy} onClick={()=>void open(item.id)}>詳細を見る</button></section>)}</div>
 {items.length===0&&!error&&<p className="muted">まだレシピがありません。上のフォームから追加できます。</p>}
 <div className="toolbar"><button disabled={page===1} onClick={()=>setPage(p=>p-1)}>前へ</button><span>Page {page}</span><button disabled={items.length<20} onClick={()=>setPage(p=>p+1)}>次へ</button></div>
 {selected&&<section className="card"><div className="toolbar"><h2>レシピ詳細</h2><button disabled={busy} onClick={()=>setSelected(null)}>閉じる</button></div>
 <p className="tag">Revision {selected.revision}</p>
 <form onSubmit={change}><input aria-label="料理名を変更" value={rename} onChange={e=>setRename(e.target.value)}/><button disabled={busy||!rename.trim()}>変更して保存</button></form>
 <h2>食材・分量</h2>{selected.materials.length===0?<p className="muted">食材はまだ登録されていません。</p>:<ul>{selected.materials.map(m=><li key={m.id}><strong>{m.material_name.value?.trim() || "食材名未設定"}</strong> — {m.quantity.value??"未設定"} {m.unit??""}{m.quantity.status==="assumed"?"（推定）":m.quantity.status==="unresolved"?"（要確認）":""}</li>)}</ul>}
 <p className="muted">売価：{selected.selling_price_jpy.value??"未設定"}{selected.selling_price_jpy.status==="assumed"?"（推定）":selected.selling_price_jpy.status==="unresolved"?"（要確認）":""}</p>
 </section>}</main>;
}
