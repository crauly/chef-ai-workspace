"use client";
import {useEffect,useRef,useState,type RefObject} from "react";
import type {Locale} from "./i18n";
import {request,type Recipe} from "./types";
import type {EditorHandle} from "./AIEditor";
import VoiceRecipeRegistration,{type RegistrationHandle} from "./VoiceRecipeRegistration";
import {playVoiceCue,type VoiceMode} from "./VoiceModePanel";
import {voiceNavigation,explicitEditRequest,type Navigation} from "./voice-navigation";
import {voiceCommand} from "./voice-commands";
import {useVoiceCapture,type VoiceCaptureMeta} from "./useVoiceCapture";

export default function VoiceWorkspace({locale,selected,editor,onBrowse,onCreated,reviewBoundary}:{
 locale:Locale;selected:Recipe|null;editor:RefObject<EditorHandle|null>;onBrowse:(target:string)=>Promise<Recipe|null>;
 onCreated:(recipe:Recipe)=>void;reviewBoundary:RefObject<(()=>number)|null>;
}){
 const [mode,setMode]=useState<VoiceMode>("idle"),[volume,setVolume]=useState(.5),[manual,setManual]=useState("");
 const [message,setMessage]=useState("登録・呼び出し・修正を一つのマイクで続けられます。"),[heard,setHeard]=useState("");
 const [routing,setRouting]=useState(false);
 const currentMode=useRef<VoiceMode>("idle"),boundary=useRef(0),modeBoundary=useRef(0);
 const registration=useRef<RegistrationHandle|null>(null);
 const selectedRef=useRef(selected);selectedRef.current=selected;
 const previousTarget=useRef(selected?.id);
 const queue=useRef<Array<{text:string;meta:VoiceCaptureMeta}>>([]),running=useRef(false);
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;queue.current=[];reviewBoundary.current=null;};},[reviewBoundary]);
 const voice=useVoiceCapture(locale,receive,true);
 useEffect(()=>{
  if(selected?.id&&selected.id!==previousTarget.current&&currentMode.current==="idle"){
   transition("browse");feedback("参照モードです。表示中のレシピの変更内容を話すと編集へ進みます。");
  }
  previousTarget.current=selected?.id;
 },[selected?.id]);
 function mark(){boundary.current=voice.markReview();return boundary.current;}
 reviewBoundary.current=mark;
 const labels={idle:"待機",create:"登録",browse:"参照",edit:"編集"};
 function feedback(text:string,error=false){setMessage(text);if(error&&volume>0)playVoiceCue("error",volume);}
 function transition(next:VoiceMode){
  if(currentMode.current===next)return;
  registration.current?.suspend();editor.current?.invalidate();
  modeBoundary.current=mark();currentMode.current=next;setMode(next);
  if(next!=="idle"&&volume>0)playVoiceCue(next,volume);
 }
 async function navigate(nav:Navigation,source?:string){
  if(registration.current?.isSaving()||editor.current?.isBusy()){feedback("保存・変更処理中です。完了後に切り替えてください。",true);return;}
  if(editor.current?.hasPending()&&(nav.mode!=="edit"||nav.target)){
   feedback("未保存の変更案があります。保存するか、「変更案を破棄」と話してから切り替えてください。",true);return;
  }
  if(nav.mode==="edit"&&nav.target&&selectedRef.current?.title.value!==nav.target){
   transition("browse");feedback("編集対象のレシピを検索しています。");selectedRef.current=await onBrowse(nav.target);
   if(!selectedRef.current){feedback("編集対象を一つに絞れませんでした。検索結果から選んでください。",true);return;}
  }
  if(nav.mode==="edit"&&!selectedRef.current){feedback("編集するレシピを先に呼び出してください。",true);return;}
  transition(nav.mode);
  if(nav.mode==="browse"){
   feedback("参照モードです。"+(registration.current?.hasPending()?"登録途中の下書きは保持しています。":"")+"検索結果が複数なら、画面から対象を選んでください。");
   selectedRef.current=await onBrowse(nav.target);
  }else if(nav.mode==="create"){
   feedback(registration.current?.hasPending()?"登録モードです。保持していた下書きを続けます。":"登録モードです。料理名・食材・分量・仕入単価をどうぞ。");
   if(nav.target&&!registration.current?.hasPending())registration.current?.submit(source??nav.target);
  }else feedback("編集モードです。変更内容を話してください。保存には変更案の確認と明示承認が必要です。");
 }
 function receive(text:string,meta?:VoiceCaptureMeta){
  if(!text.trim())return;
  if(registration.current?.isSaving()){feedback("承認された下書きを保存中です。完了後に続きをお願いします。",true);return;}
  const captured=meta??{reviewEpoch:boundary.current};
  // Approval/navigation from an earlier mode must never affect a new target.
  if(captured.reviewEpoch<modeBoundary.current&&voiceCommand(text)!=="data"){feedback("切り替え前の承認は適用していません。現在のモードを確認して、もう一度お願いします。",true);return;}
  if(currentMode.current==="edit"&&voiceCommand(text)==="data"&&!voiceNavigation(text))editor.current?.invalidate();
  if(queue.current.length>=30){feedback("処理待ちの発話が多すぎます。処理完了後に再度お願いします。",true);return;}
  queue.current.push({text,meta:captured});void drain();
 }
 async function drain(){
  if(running.current)return;running.current=true;setRouting(true);
  try{while(alive.current&&queue.current.length){
   const input=queue.current.shift()!;
   if(input.meta.reviewEpoch<modeBoundary.current&&voiceCommand(input.text)!=="data"){feedback("切り替え前の承認は適用していません。もう一度お願いします。",true);continue;}
   setHeard(input.text);
   if(/^(?:変更案を破棄|変更を取り消す)[。！! ]*$/.test(input.text)){
    if(currentMode.current==="edit")await editor.current?.submit("キャンセル",input.meta);
    feedback("変更案を破棄しました。レシピ自体は変更していません。");continue;
   }
   let nav=voiceNavigation(input.text);
   // Only navigation paraphrases need an intent call. Material dictation and
   // approval controls stay on their existing paths without another model hop.
   if(!nav&&voiceCommand(input.text)==="data"&&/(?:モード|レシピ.*(?:登録|参照|呼び出|検索|見たい|編集)|メニュー.*(?:登録|作成)|探したい|呼び出したい)/.test(input.text)&&!/[0-9０-９]/.test(input.text)){
    if(/しない|しません|ではなく|じゃなく|やめ/.test(input.text)){feedback("切り替えずに現在の内容を保持しています。希望する操作をもう一度教えてください。",true);continue;}
    const result=await request<{intent:string;target:string}>("/api/intent",{method:"POST",body:JSON.stringify({utterance:input.text,current_mode:currentMode.current})});
    if(!["create","browse","edit"].includes(result.intent)||typeof result.target!=="string"){
     feedback("切り替え先を確認できませんでした。登録・参照・編集のどれかを教えてください。",true);continue;
    }
    nav={mode:result.intent as Navigation["mode"],target:result.target};
   }
   if(nav){await navigate(nav,input.text);continue;}
   if(currentMode.current==="idle"){
    // Direct dictation is also a supported new-recipe entry, announced audibly.
    transition("create");feedback("登録モードです。料理の内容を下書きにします。");
   }
   if(currentMode.current==="create")registration.current?.submit(input.text,input.meta);
   else if(currentMode.current==="browse"||currentMode.current==="edit"){
    if(!selectedRef.current||!editor.current){feedback("対象のレシピを呼び出してください。候補が複数なら画面で選んでください。",true);continue;}
    if(currentMode.current==="browse"){
     if(voiceCommand(input.text)!=="data"){feedback("参照中です。変更内容を話すと編集へ進みます。保存はしません。");continue;}
     if(!explicitEditRequest(input.text)){
      if(/(?:変更|修正|訂正|追加)(?:は)?(?:しない|しません)/.test(input.text)){feedback("変更せず、参照モードのままです。");continue;}
      const intent=await request<{intent:string;target:string}>("/api/intent",{method:"POST",body:JSON.stringify({utterance:input.text,current_mode:"browse"})});
      if(intent.intent!=="edit"||intent.target){feedback("参照モードのままです。変更する場合は、対象と変更内容を教えてください。");continue;}
     }
     transition("edit");feedback("編集モードです。変更案を作成します。");
    }
    await editor.current.submit(input.text,input.meta);
   }
  }}catch{feedback("操作を完了できませんでした。現在の内容を確認して、もう一度お願いします。",true);}
  finally{running.current=false;if(alive.current)setRouting(false);}
 }
 return <>
  <section aria-label="音声操作モード" className="voice-mode-panel">
   <h2>音声操作</h2>
   <p>現在のモード: <strong>{labels[mode]}</strong>{mode==="edit"&&selected?` — ${selected.title.value}`:""}</p>
   <p>「レシピを登録します」「〇〇を見せて」「パスタを150gに変更」のように続けて話してください。</p>
   <button type="button" disabled={!voice.recording&&(voice.supported===false||voice.busy)} onClick={voice.recording?voice.stop:()=>void voice.start()} aria-pressed={voice.recording}>{voice.recording?"■ マイクを停止":"🎙 音声登録を開始"}</button>
   <p>音声はMetaへ送信して文字起こしします。録音は保存しません。切り替え音の後に話してください。</p>
   <p aria-live="polite">{voice.recording?"聞き取り中… ":""}{voice.busy?"音声を文字にしています… ":""}{routing?"操作を処理中… ":""}{message}</p>
   {voice.error&&<p role="alert">{voice.error}</p>}
   {heard&&<p>認識した指示：{heard}</p>}
   <form onSubmit={event=>{event.preventDefault();receive(manual);setManual("");}}>
    <input aria-label="音声認識できない場合の入力" value={manual} onChange={event=>setManual(event.target.value)} placeholder="音声認識できないときの補助入力"/>
    <button type="submit" disabled={!manual.trim()}>反映</button>
   </form>
   <label>通知音の音量 <input aria-label="通知音の音量" type="range" min="0" max="1" step="0.1" value={volume} onChange={event=>setVolume(Number(event.target.value))}/></label>
   <button type="button" onClick={()=>setVolume(volume?0:.5)}>{volume?"通知音をミュート":"通知音をオン"}</button>
   <button type="button" onClick={()=>void navigate({mode:"create",target:""})}>新規登録・下書きを再開</button>
   <button type="button" onClick={()=>void navigate({mode:"browse",target:""})}>レシピを参照</button>
   <button type="button" onClick={()=>void navigate({mode:"edit",target:""})}>選択レシピを編集</button>
  </section>
  <div hidden={mode!=="create"}><VoiceRecipeRegistration locale={locale} control={registration} sharedVoice={{markReview:mark,cancel:()=>{}}} onCreated={recipe=>{
   transition("browse");feedback("レシピを保存しました。");onCreated(recipe);
  }}/></div>
 </>;
}
