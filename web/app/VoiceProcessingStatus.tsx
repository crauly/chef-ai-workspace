"use client";
import {createContext,useCallback,useContext,useEffect,useId,useMemo,useState,type ReactNode} from "react";
import type {Locale} from "./i18n";

export type VoiceStatusKey="listen"|"transcribe"|"intent"|"parse"|"price"|"propose"|"save"|"photo"|"dish-image";
const labels:Record<VoiceStatusKey,[string,string]>={
 listen:["音声受付中","Listening"],transcribe:["文字起こし中","Transcribing"],intent:["指示を確認中","Checking instruction"],
 parse:["レシピ解析中","Analyzing recipe"],price:["価格検索中","Searching prices"],propose:["変更案を作成中","Preparing changes"],
 save:["レシピ保存中","Saving recipe"],photo:["写真を解析中","Analyzing photo"],"dish-image":["料理画像を生成中","Generating dish image"],
};
export type VoiceStatusRow={key:VoiceStatusKey;error?:boolean};
type Source={locale:Locale;rows:VoiceStatusRow[]};
type Publish=(id:string,source:Source|null)=>void;
const StatusContext=createContext<Publish|null>(null);

// Producers publish real flags only. One root owns the floating surface,
// including settings fields and work continuing inside a collapsed panel.
export function useVoiceProcessingStatus(locale:Locale,rows:VoiceStatusRow[]){
 const publish=useContext(StatusContext),id=useId();
 const signature=JSON.stringify(rows);
 useEffect(()=>{publish?.(id,{locale,rows:JSON.parse(signature)});},[publish,id,locale,signature]);
 useEffect(()=>()=>publish?.(id,null),[publish,id]);
}
export function VoiceProcessingProvider({children}:{children:ReactNode}){
 const [sources,setSources]=useState<Record<string,Source>>({});
 const publish=useCallback<Publish>((id,source)=>setSources(previous=>{
  if(source)return {...previous,[id]:source};
  const next={...previous};delete next[id];return next;
 }),[]);
 const active=Object.values(sources).filter(source=>source.rows.length);
 const rows=useMemo(()=>{
  const combined=new Map<VoiceStatusKey,VoiceStatusRow>();
  for(const source of Object.values(sources))for(const row of source.rows){
   // A retry in progress takes precedence over another source's old error.
   const previous=combined.get(row.key);
   if(!previous||previous.error)combined.set(row.key,row);
  }
  return [...combined.values()];
 },[sources]);
 return <StatusContext.Provider value={publish}>{children}<VoiceProcessingPanel locale={active[0]?.locale??"ja"} rows={rows}/></StatusContext.Provider>;
}

// Display only: no timers, synthetic percentages, callbacks or persistence.
export function VoiceProcessingPanel({locale,rows}:{locale:Locale;rows:VoiceStatusRow[]}){
 if(!rows.length)return null;
 const ja=locale==="ja";
 const failures:Record<VoiceStatusKey,string>={listen:"音声受付に失敗",transcribe:"文字起こしに失敗",intent:"指示の確認に失敗",parse:"レシピ解析に失敗",price:"価格検索に失敗",propose:"変更案の作成に失敗",save:"レシピ保存に失敗",photo:"写真解析に失敗","dish-image":"画像生成に失敗"};
 return <ul role="status" aria-live="polite" aria-label={ja?"音声処理状況":"Voice processing status"}
  className="voice-status-list pointer-events-auto fixed right-3.5 bottom-[calc(100px+env(safe-area-inset-bottom,0px))] z-[90] m-0 flex flex-col max-h-[50dvh] w-[min(240px,calc(100vw-28px))] list-none gap-2 overflow-y-auto rounded-[19px] border border-solid border-white/25 bg-[#21292c]/90 px-3 py-2.5 text-[#ecf3ef] shadow-xl backdrop-blur-md min-[721px]:bottom-5">
  {rows.map(row=><li key={row.key} data-stage={row.key} data-state={row.error?"error":"active"} className="m-0 flex min-w-0 items-center gap-2.5 p-0">
   <span aria-hidden="true" className={`flex size-7 shrink-0 items-center justify-center rounded-full text-base font-bold ${row.error?"bg-orange-900/30 text-orange-300":row.key==="price"?"bg-emerald-900/30 text-emerald-300":"bg-sky-900/30 text-sky-300"}`}>{row.error?"!":row.key==="price"?"⌕":"♩"}</span>
   <span className="flex min-w-0 flex-1 flex-col gap-1">
    <span className="truncate text-xs leading-4 font-semibold">{row.error?(ja?failures[row.key]:`${labels[row.key][1]} failed`):labels[row.key][ja?0:1]}</span>
    {!row.error&&<span aria-hidden="true" className="block h-0.5 overflow-hidden rounded bg-white/20"><span className={`block h-full w-1/3 rounded motion-safe:animate-pulse ${row.key==="price"?"bg-emerald-400":"bg-sky-400"}`}/></span>}
   </span>
  </li>)}
 </ul>;
}
