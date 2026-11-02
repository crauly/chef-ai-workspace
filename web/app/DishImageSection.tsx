"use client";
import {useEffect,useRef,useState} from "react";
import type {Locale} from "./i18n";
import {request} from "./types";
import {dishImagePrompt,isAbortError} from "./dish-image";

// Saved-recipe detail dish illustration (Block 3 reuse, ADR-014).
// Same POST /api/dish-image contract as the voice-draft flow: the API key
// stays server-side, the result is a temporary preview (never persisted,
// never recipe evidence, Human Gate untouched). State is keyed to the open
// recipe id: switching recipes aborts the flight and drops its result, so a
// stale response can never land on another recipe.
export default function DishImageSection({recipeId,title,names,locale,disabled}:{
 recipeId:string;title:string;names:string[];locale:Locale;disabled?:boolean}){
 const [image,setImage]=useState<string|null>(null);
 const [generating,setGenerating]=useState(false);
 const [failed,setFailed]=useState(false);
 const [enlarged,setEnlarged]=useState(false);
 const flight=useRef<AbortController|null>(null);
 const owner=useRef(recipeId);
 // Recipe switch: abort the in-flight request and drop its state. The
 // abort is a normal cancellation, never surfaced as an API failure.
 useEffect(()=>{
  owner.current=recipeId;
  flight.current?.abort();flight.current=null;
  setImage(null);setGenerating(false);setFailed(false);setEnlarged(false);
  return()=>{flight.current?.abort();flight.current=null;};
 },[recipeId]);
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
  const prompt=dishImagePrompt(title,names,"");
  flight.current?.abort();
  const controller=new AbortController();flight.current=controller;
  setFailed(false);setGenerating(true);
  try{
   const out=await request<{image:string}>("/api/dish-image",
    {method:"POST",body:JSON.stringify({prompt}),signal:controller.signal});
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
  {!image&&<div className="dish-image-empty" aria-hidden="true">🍽️</div>}
  {image&&<button type="button" className="dish-image-open" disabled={generating}
    aria-label={ja?"料理イメージを拡大表示":"Enlarge dish illustration"}
    onClick={()=>setEnlarged(true)}>
   <img src={image} alt={ja?"生成した料理イメージ":"Generated dish illustration"}/>
  </button>}
  <p className="dish-image-note">{ja?"生成画像は一時プレビューです。保存されません。":"Generated image is a temporary preview and is not saved."}</p>
  {generating&&<p className="dish-image-status" role="status"><span className="voice-spin" aria-hidden="true"/>{ja?"画像を生成中…":"Generating image…"}</p>}
  {failed&&!generating&&<p className="dish-image-fail" role="alert">{ja?"画像の生成に失敗しました。レシピは変更されていません。":"Image generation failed. The recipe is unchanged."}</p>}
  <div className="dish-image-actions">
   <button type="button" disabled={disabled||generating} onClick={()=>void generate()}>
    {image?(ja?"再生成":"Regenerate"):(ja?"料理画像を生成":"Generate dish image")}</button>
   {failed&&!generating&&<button type="button" className="secondary" disabled={disabled} onClick={()=>void generate()}>{ja?"再試行":"Retry"}</button>}
  </div>
  {enlarged&&image&&<div className="dish-image-overlay" onClick={()=>setEnlarged(false)}>
   <section role="dialog" aria-modal="true" aria-label={ja?"料理イメージの拡大表示":"Enlarged dish illustration"} className="dish-image-dialog" onClick={e=>e.stopPropagation()}>
    <img src={image} alt={ja?"生成した料理イメージの拡大表示":"Enlarged generated dish illustration"}/>
    <button type="button" autoFocus onClick={()=>setEnlarged(false)}>{ja?"閉じる":"Close"}</button>
   </section>
  </div>}
 </section>;
}
