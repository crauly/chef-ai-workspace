"use client";
import {useEffect,useRef,type ReactNode} from "react";
import {createPortal} from "react-dom";
import type {Locale} from "./i18n";
export type MicControl={recording:boolean;disabled:boolean;toggle:()=>void};
export default function EditProposalDialog({children,locale,busy,micControl,onPresented,onClose}:{children:ReactNode;locale:Locale;busy:boolean;micControl?:MicControl|null;onPresented:()=>void;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 const presented=useRef(onPresented);presented.current=onPresented;
 useEffect(()=>{const node=dialog.current;if(!node)return;node.showModal();presented.current();return()=>node.close();},[]);
 return createPortal(<dialog ref={dialog} aria-label={locale==="ja"?"変更案の確認":"Review recipe changes"} onCancel={event=>{event.preventDefault();if(!busy)onClose();}} className="m-auto max-h-[85dvh] w-[calc(100%-1.5rem)] max-w-2xl overflow-y-auto rounded-2xl border border-emerald-800 bg-white p-4 text-slate-900 shadow-xl backdrop:bg-black/60 sm:p-6">
  <div className="flex flex-wrap items-center justify-between gap-2"><h2>{locale==="ja"?"変更案の確認":"Review recipe changes"}</h2><button type="button" disabled={busy} onClick={onClose}>{locale==="ja"?"戻る":"Back"}</button></div>
  {micControl&&<button type="button" disabled={micControl.disabled} aria-pressed={micControl.recording} onClick={micControl.toggle}>{micControl.recording?(locale==="ja"?"マイクを停止":"Stop microphone"):(locale==="ja"?"音声で承認する":"Approve by voice")}</button>}
  {children}
 </dialog>,document.body);
}
