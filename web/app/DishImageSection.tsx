"use client";
import {useEffect,useRef,useState} from "react";
import type {Locale} from "./i18n";
import {request} from "./types";
import {dishImagePrompt,isAbortError} from "./dish-image";
import {loadPlates,PLATE_LIBRARY_CHANGED,type Plate} from "./plate-library";

// Saved-recipe detail dish illustration (Block 3 reuse, ADR-014).
// Same POST /api/dish-image contract as the voice-draft flow: the API key
// stays server-side, the result is a temporary preview (never persisted,
// never recipe evidence, Human Gate untouched). When a default plate is
// registered on this device, its photo is attached to the request and the
// route uses the images/edits endpoint; otherwise the text-only generations
// endpoint is used (shared dishImagePrompt contract either way — no second
// prompt system). State is keyed to the open recipe id: switching recipes
// aborts the flight and drops its result, so a stale response can never
// land on another recipe.
export default function DishImageSection({recipeId,title,names,locale,disabled}:{
 recipeId:string;title:string;names:string[];locale:Locale;disabled?:boolean}){
 const [image,setImage]=useState<string|null>(null);
 const [generating,setGenerating]=useState(false);
 const [failed,setFailed]=useState(false);
 const [enlarged,setEnlarged]=useState(false);
 const [plates,setPlates]=useState<Plate[]>([]);
 const [defaultId,setDefaultId]=useState<string|null>(null);
 const [selectedPlateId,setSelectedPlateId]=useState<string>("auto");
 const flight=useRef<AbortController|null>(null);
 const owner=useRef(recipeId);
 const plateSelectionInitialized=useRef(false);
 // Recipe switch: abort the in-flight request and drop its state. The
 // abort is a normal cancellation, never surfaced as an API failure.
 useEffect(()=>{
  owner.current=recipeId;
  flight.current?.abort();flight.current=null;
  setImage(null);setGenerating(false);setFailed(false);setEnlarged(false);
  return()=>{flight.current?.abort();flight.current=null;};
 },[recipeId]);
 // Default-plate status only (no form here): re-read when the settings
 // section saves, deletes, or another tab changes the same key.
 useEffect(()=>{
  let active=true;
  const sync=async()=>{try{const data=await loadPlates();if(!active)return;setPlates(data.plates);setDefaultId(data.defaultId);setSelectedPlateId(previous=>{if(!plateSelectionInitialized.current){plateSelectionInitialized.current=true;return data.defaultId??"auto";}return previous==="auto"||data.plates.some(p=>p.id===previous)?previous:data.defaultId??"auto";});}catch{/* local storage unavailable: generate without plate */}};
  void sync();
  window.addEventListener(PLATE_LIBRARY_CHANGED,sync);
  return()=>{active=false;window.removeEventListener(PLATE_LIBRARY_CHANGED,sync);};
 },[]);
 // Lock background scroll while the enlarged dialog is open.
 useEffect(()=>{
  if(!enlarged)return;
  const prev=document.body.style.overflow;
  document.body.style.overflow="hidden";
  const onKey=(e:KeyboardEvent)=>{if(e.key==="Escape")setEnlarged(false);};
  window.addEventListener("keydown",onKey);
  return()=>{document.body.style.overflow=prev;window.removeEventListener("keydown",onKey);};
 },[enlarged]);
 async function generate(){
  // Explicit user action only; a running flight returns silently
  // (double-submit guard via disabled button + this check).
  if(generating||disabled)return;
  const started=recipeId;
  const chosen=plates.find(p=>p.id===selectedPlateId);
  const prompt=dishImagePrompt(title,names,chosen?.note??"");
  flight.current?.abort();
  const controller=new AbortController();flight.current=controller;
  setFailed(false);setGenerating(true);
  try{
   const out=await request<{image:string;mode?:string}>("/api/dish-image",
    {method:"POST",body:JSON.stringify(chosen?{prompt,image:chosen.image}:{prompt}),signal:controller.signal});
   if(owner.current!==started||controller.signal.aborted)return;
   setImage(out.image);
  }catch(err){
   if(owner.current!==started||controller.signal.aborted||isAbortError(err))return;
   setFailed(true);
  }finally{
   if(owner.current===started)setGenerating(false);
  }
 }
 const ja=locale==="ja";
 return <section className="dish-image" aria-label={ja?"料理イメージ":"Dish illustration"}>
  <div className="dish-image-header"><div><h3>{ja?"料理イメージ":"Dish image"}</h3><p>{ja?"レシピから料理写真を生成":"Generate from this recipe"}</p></div>{image&&<span className="dish-image-label">{ja?"生成済み":"Generated"}</span>}</div>
  <label className="dish-plate-picker">{ja?"使用する皿":"Plate for this image"}<select disabled={generating} value={selectedPlateId} onChange={e=>setSelectedPlateId(e.target.value)}><option value="auto">{ja?"皿を指定しない（AIに任せる）":"No plate (AI chooses)"}</option>{plates.map(p=><option value={p.id} key={p.id}>{p.name}{p.id===defaultId?" ★":""}</option>)}</select></label>
  {!image&&<div className="dish-image-empty" aria-hidden="true"><span className="dish-image-placeholder-symbol">◇</span><span>{ja?"料理画像はまだありません":"No dish image yet"}</span></div>}
  {image&&<button type="button" className="dish-image-open" disabled={generating}
    aria-label={ja?"料理イメージを拡大表示":"Enlarge dish illustration"}
    onClick={()=>setEnlarged(true)}>
   <img src={image} alt={ja?"生成した料理イメージ":"Generated dish illustration"}/>
  </button>}
  {generating&&<p className="dish-image-status" role="status"><span className="voice-spin" aria-hidden="true"/>{ja?"画像を生成中…":"Generating image…"}</p>}
  {failed&&!generating&&<p className="dish-image-fail" role="alert">{ja?"画像の生成に失敗しました。レシピは変更されていません。":"Image generation failed. The recipe is unchanged."}</p>}
  <div className="dish-image-actions">
   <button type="button" className="dish-image-primary" disabled={disabled||generating} onClick={()=>void generate()}>
    {generating?(ja?"生成中…":"Generating…"):image?(ja?"↻ 再生成":"↻ Regenerate"):failed?(ja?"再試行":"Retry"):(ja?"✦ 料理画像を生成":"✦ Generate dish image")}</button>
  </div>
  <p className="dish-image-note">{ja?"一時プレビュー · レシピには保存されません":"Temporary preview · Not saved to the recipe"}</p>
  {enlarged&&image&&<div className="dish-image-overlay" onClick={()=>setEnlarged(false)}>
   <section role="dialog" aria-modal="true" aria-label={ja?"料理イメージの拡大表示":"Enlarged dish illustration"} className="dish-image-dialog" onClick={e=>e.stopPropagation()}>
    <img src={image} alt={ja?"生成した料理イメージの拡大表示":"Enlarged generated dish illustration"}/>
    <button type="button" className="dish-image-close" autoFocus onClick={()=>setEnlarged(false)} aria-label={ja?"拡大表示を閉じる":"Close enlarged image"}>×</button>
   </section>
  </div>}
 </section>;
}
