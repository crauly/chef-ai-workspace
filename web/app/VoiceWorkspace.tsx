"use client";
import {isPriceResearchRequest} from "../recipe-price-research";
import {useVoiceProcessingStatus} from "./VoiceProcessingStatus";
import NavIcon from "./NavIcon";

import {useEffect,useRef,useState,type RefObject} from "react";
import type {Locale} from "./i18n";
import {request,type Recipe} from "./types";
import type {EditorHandle} from "./AIEditor";
import VoiceRecipeRegistration,{type RegistrationHandle} from "./VoiceRecipeRegistration";
import {playVoiceCue,type VoiceMode} from "./VoiceModePanel";
import {voiceNavigation,explicitEditRequest,type Navigation} from "./voice-navigation";
import {voiceCommand,editVoiceCommand} from "./voice-commands";
import {useVoiceCapture,type VoiceCaptureMeta} from "./useVoiceCapture";
import {useRealtimeVoiceCapture} from "./useRealtimeVoiceCapture";
import {logVoiceEvent,getVoiceEvents,subscribeVoiceEvents,type VoiceDiagEvent} from "./voice-diagnostics";
import {resolveTransport,isTerminalRealtimeFailure} from "./voice-transport";

function MicrophoneGlyph(){return <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></svg>;}
function ListeningWave({active}:{active:boolean}){return <div className={"listening-wave"+(active?" is-active":"")} aria-hidden="true">{[.32,.65,1,.55,.88,.42,.7,.96,.6,.35,.72,.4].map((v,i)=><span key={i} style={{"--bar-scale":v,"--bar-delay":`${i*65}ms`} as React.CSSProperties}/>)}</div>;}

const voiceMessagesEn:Record<string,string> = {"参照モードです。表示中のレシピの変更内容を話すと編集へ進みます。":"Browse mode. Describe a change to edit the displayed recipe.","保存・変更処理中です。完了後に切り替えてください。":"Saving or editing is in progress. Switch modes after it finishes.","未保存の変更案があります。保存するか、「変更案を破棄」と話してから切り替えてください。":"You have unsaved proposed changes. Save or discard them before switching.","編集対象のレシピを検索しています。":"Searching for the recipe to edit.","編集対象を一つに絞れませんでした。検索結果から選んでください。":"Could not identify a unique recipe. Select one from the search results.","編集するレシピを先に呼び出してください。":"Open a recipe before editing.","登録モードです。保持していた下書きを続けます。":"Create mode. Continuing your saved draft.","登録モードです。料理名・食材・分量・仕入単価をどうぞ。":"Create mode. Tell me the dish, ingredients, quantities and purchase prices.","編集モードです。変更内容を話してください。保存には変更案の確認と明示承認が必要です。":"Edit mode. Describe the changes. Review and explicitly approve proposals before saving.","承認された下書きを保存中です。完了後に続きをお願いします。":"Saving the approved draft. Continue after it finishes.","切り替え前の承認は適用していません。現在のモードを確認して、もう一度お願いします。":"Approval from a previous mode was not applied. Check the current mode and try again.","処理待ちの発話が多すぎます。処理完了後に再度お願いします。":"Too many queued utterances. Try again when processing completes.","切り替え前の承認は適用していません。もう一度お願いします。":"An earlier approval was ignored. Please repeat the request.","保持していた下書きを確認します。":"Reviewing your preserved draft.","変更案を破棄しました。レシピ自体は変更していません。":"Proposed changes discarded. The recipe was not changed.","切り替えずに現在の内容を保持しています。希望する操作をもう一度教えてください。":"Kept the current mode and content. Please clarify your request.","切り替え先を確認できませんでした。登録・参照・編集のどれかを教えてください。":"Could not determine the requested mode. Choose create, browse or edit.","登録モードです。料理の内容を下書きにします。":"Create mode. Starting a recipe draft.","対象のレシピを呼び出してください。候補が複数なら画面で選んでください。":"Open the target recipe. If several match, select one on screen.","参照中です。変更内容を話すと編集へ進みます。保存はしません。":"Browsing. Describe a change to enter edit mode; nothing will be saved yet.","変更せず、参照モードのままです。":"No changes made. Staying in browse mode.","参照モードのままです。変更する場合は、対象と変更内容を教えてください。":"Still in browse mode. Specify the target and desired change to edit.","編集モードです。変更案を作成します。":"Edit mode. Preparing a proposed change.","操作を完了できませんでした。現在の内容を確認して、もう一度お願いします。":"Could not complete the operation. Check the current state and try again."};
export default function VoiceWorkspace({locale,selected,editor,onBrowse,setEditTargetSelectionPending,onCreated,reviewBoundary,editRequest,detailOnly=false,onMicControl}:{
 onMicControl:(control:import("./EditProposalDialog").MicControl|null)=>void;
 locale:Locale;selected:Recipe|null;editor:RefObject<EditorHandle|null>;onBrowse:(target:string,openVoiceEdit?:boolean)=>Promise<Recipe|null>;
 setEditTargetSelectionPending:(pending:boolean)=>void;
 onCreated:(recipe:Recipe)=>void;reviewBoundary:RefObject<(()=>number)|null>;editRequest:number;detailOnly?:boolean;
}){
 const [mode,setMode]=useState<VoiceMode>(selected?"browse":"idle"),[volume,setVolume]=useState(.5),[manual,setManual]=useState("");
 const [message,setMessage]=useState(locale==="ja"?"登録・呼び出し・修正を一つのマイクで続けられます。":"Create, browse and edit with one microphone."),[heard,setHeard]=useState("");
 const [routing,setRouting]=useState(false);
 const [checkingIntent,setCheckingIntent]=useState(false);
 const [feedbackError,setFeedbackError]=useState(false);
 const [supplierMemo,setSupplierMemo]=useState("");
 const [settingsOpen,setSettingsOpen]=useState(false);
 // The initial guidance is state, so changing locale must update it explicitly.
 useEffect(()=>{setMessage(previous=>previous==="登録・呼び出し・修正を一つのマイクで続けられます。"||previous==="Create, browse and edit with one microphone."?(locale==="ja"?"登録・呼び出し・修正を一つのマイクで続けられます。":"Create, browse and edit with one microphone."):previous);},[locale]);
 const [draftPending,setDraftPending]=useState(false);
 const [diag,setDiag]=useState<VoiceDiagEvent[]>([]);
 useEffect(()=>subscribeVoiceEvents(()=>setDiag(getVoiceEvents())),[]);
 const currentMode=useRef<VoiceMode>(selected?"browse":"idle"),boundary=useRef(0),modeBoundary=useRef(0);
 const registration=useRef<RegistrationHandle|null>(null);
 const selectedRef=useRef(selected);selectedRef.current=selected;
 const previousTarget=useRef(selected?.id);
 const queue=useRef<Array<{text:string;meta:VoiceCaptureMeta}>>([]),running=useRef(false);
 const traceCounter=useRef(0);
 function newTrace(){traceCounter.current++;return `${Date.now().toString(36)}-${traceCounter.current}`;}
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;queue.current=[];reviewBoundary.current=null;};},[reviewBoundary]);
 const voice=useVoiceCapture(locale,receive,true);
 const realtime=useRealtimeVoiceCapture(locale,receive,{getEpoch:()=>boundary.current});
 const realtimeConfigured=Boolean(process.env.NEXT_PUBLIC_DEMO_WS_URL); // One mic UI; realtime when configured, legacy REST transport otherwise.
 // A realtime failure falls back to REST for the rest of the session (no
 // flapping). The realtime hook already stopped its own microphone on failure,
 // so starting REST next cannot double-open the mic or double-send audio.
 const [realtimeFailed,setRealtimeFailed]=useState(false);
 const realtimeActive=resolveTransport(realtimeConfigured,realtimeFailed)==="realtime";
 const micRecording=realtimeActive?realtime.recording:voice.recording;
 const micBusy=realtimeActive?realtime.state==="draining":voice.busy;
 const micError=realtimeActive?realtime.error:voice.error;
 const micNotice=realtimeActive?realtime.notice:voice.notice;
 useEffect(()=>{
  if(realtimeConfigured&&!realtimeFailed&&isTerminalRealtimeFailure(realtime.state)){
   setRealtimeFailed(true);
   logVoiceEvent("capture.error","realtime failed; REST transport",realtime.error);
   feedback(locale==="ja"
    ?`リアルタイム音声に接続できませんでした。通常の音声入力に切り替えました。下書きは保持しています。${realtime.error}`
    :`Realtime voice failed. Switched to standard voice input; the draft is retained. ${realtime.error}`);
  }
 },[realtimeConfigured,realtimeFailed,realtime.state,realtime.error,locale]);
 const wasRecording=useRef(false);
 // Keyed by failure event (hook tick), not message text: repeated failures
 // with identical wording each raise their own audible cue while the mic
 // stays open. The stop cue below skips a repeat of the announced failure.
 const announcedFailure=useRef("");
 const failureKey=micError?`${realtimeActive?"realtime":"rest"}#${realtimeActive?realtime.errorTick:voice.errorTick}#${micError}`:"";
 useEffect(()=>{
  // A transcription failure while the mic stays open is audible at once;
  // the stop cue below skips a repeat of the same announced failure.
  if(micRecording&&failureKey&&failureKey!==announcedFailure.current&&volume>0){
   announcedFailure.current=failureKey;playVoiceCue("error",volume);
  }
  if(!micError)announcedFailure.current="";
 },[micRecording,failureKey,micError,volume]);
 useEffect(()=>{
  if(wasRecording.current&&!micRecording&&
   !(failureKey&&failureKey===announcedFailure.current))playVoiceCue(micError?"error":"stop",volume);
  wasRecording.current=micRecording;
 },[micRecording,failureKey,micError,volume]);
 useEffect(()=>{
  if(selected?.id!==previousTarget.current){
   if(selected?.id){if(currentMode.current==="browse")modeBoundary.current=mark();else transition("browse");feedback("参照モードです。表示中のレシピの変更内容を話すと編集へ進みます。");}
   else if(currentMode.current!=="create"){transition("idle");}
  }
  previousTarget.current=selected?.id;
 },[selected?.id]);
 function mark(){boundary.current=voice.markReview();return boundary.current;}
 reviewBoundary.current=mark;
 // A detail-page edit request uses the same guarded transition as the mode button.
 // The first render is not a request; later increments are user initiated.
 const lastEditRequest=useRef(editRequest);
 useEffect(()=>{
  if(editRequest===lastEditRequest.current)return;
  lastEditRequest.current=editRequest;
  void navigate({mode:"edit",target:""}).then(()=>{
   document.getElementById("voice-controls")?.scrollIntoView({behavior:"smooth",block:"start"});
  });
 },[editRequest]);
 const labels={idle:"待機",create:"登録",browse:"参照",edit:"編集"};
 function feedback(text:string,error=false){setFeedbackError(error);setMessage(locale==="ja"?text:(voiceMessagesEn[text]??text));if(error&&volume>0)playVoiceCue("error",volume);}
 function transition(next:VoiceMode,traceId=""){
  if(currentMode.current===next)return;
  if(next==="create")setSupplierMemo("");
  logVoiceEvent("mode.transition",`${currentMode.current}->${next}`,traceId);
  const firstCreate=currentMode.current==="idle"&&next==="create";
  registration.current?.suspend();editor.current?.invalidate();
  const nextBoundary=mark();if(!firstCreate)modeBoundary.current=nextBoundary;currentMode.current=next;setMode(next);
  if(next!=="idle"&&volume>0)playVoiceCue(next,volume);
 }
 async function navigate(nav:Navigation,source?:string,traceId=""){
  if(registration.current?.isSaving()||editor.current?.isBusy()){logVoiceEvent("mode.transition.rejected","busy saving",traceId);feedback("保存・変更処理中です。完了後に切り替えてください。",true);return;}
  if(nav.mode!=="edit")setEditTargetSelectionPending(false);
  if(editor.current?.hasPending()&&(nav.mode!=="edit"||nav.target)){
   logVoiceEvent("mode.transition.rejected","unsaved edit proposal",traceId);feedback("未保存の変更案があります。保存するか、「変更案を破棄」と話してから切り替えてください。",true);return;
  }
  // In-app mode changes preserve the capture and the requested target.
  if(detailOnly&&nav.mode==="create")await onBrowse("");
  if(nav.mode==="edit"&&nav.target&&selectedRef.current?.title.value!==nav.target){
   const previousRecipe=selectedRef.current;
   transition("browse");feedback("編集対象のレシピを検索しています。");
   const match=await onBrowse(nav.target,true);
   if(!match){
    selectedRef.current=previousRecipe;
    feedback("編集対象を一つに絞れませんでした。検索結果から選んでください。",true);return;
   }
   selectedRef.current=match;
  }
  if(nav.mode==="edit"&&!selectedRef.current){
   if(!detailOnly){
    setEditTargetSelectionPending(true);transition("browse",traceId);
    feedback(locale==="ja"?"編集するレシピを検索して選択してください。":"Search for and select a recipe to edit.");
    return;
   }
   feedback("編集するレシピを先に呼び出してください。",true);return;
  }
  transition(nav.mode,traceId);
  setDraftPending(Boolean(registration.current?.hasPending()));
  if(nav.mode==="browse"){
   feedback(locale==="ja"?"参照モードです。"+(registration.current?.hasPending()?"登録途中の下書きは保持しています。":"")+"検索結果が複数なら、画面から対象を選んでください。":"Browse mode. "+(registration.current?.hasPending()?"Your draft is preserved. ":"")+"If multiple recipes match, select one on screen.");
   selectedRef.current=await onBrowse(nav.target);
  }else if(nav.mode==="create"){
   feedback(registration.current?.hasPending()?"登録モードです。保持していた下書きを続けます。":"登録モードです。料理名・食材・分量・仕入単価をどうぞ。");
   if(nav.target&&!registration.current?.hasPending())registration.current?.submit(source??nav.target);
  }else feedback("編集モードです。変更内容を話してください。保存には変更案の確認と明示承認が必要です。");
 }
 // One mic state drives both the panel button and the fixed bottom control,
 // so recording/stop/processing can never disagree between the two.
 const micDisabled=realtimeActive?realtime.state==="draining":!voice.recording&&(voice.supported===false||voice.busy);
 const toggleMicRef=useRef(()=>{});toggleMicRef.current=toggleMic;
 useEffect(()=>{onMicControl({recording:micRecording,disabled:micDisabled,toggle:()=>toggleMicRef.current()});},[onMicControl,micRecording,micDisabled]);
 useEffect(()=>()=>onMicControl(null),[onMicControl]);
 function toggleMic(){
  if(micRecording){if(realtimeActive)realtime.stop();else voice.stop();}
  else void (realtimeActive?realtime.start():voice.start());
 }
 // Draft stays reachable from any mode: route through the guarded create
 // transition first (never a bare anchor jump), then scroll to the draft.
 async function revealDraft(){
  await navigate({mode:"create",target:""});
  if(currentMode.current!=="create")return;
  document.getElementById("draft")?.scrollIntoView({block:"start"});
 }
 useEffect(()=>{
  if(window.location.hash!=="#open-draft")return;
  let active=true;
  const scrollWhenRestored=()=>{
   if(!active||window.location.hash!=="#open-draft")return;
   const draft=document.getElementById("draft");
   if(!draft)return;
   draft.scrollIntoView({block:"start"});
   window.history.replaceState(null,"",window.location.pathname+window.location.search);
   observer.disconnect();
  };
  const observer=new MutationObserver(scrollWhenRestored);
  observer.observe(document.body,{childList:true,subtree:true});
  void revealDraft().then(scrollWhenRestored);
  return()=>{active=false;observer.disconnect();};
 },[]);

 function commandForMode(text:string){return currentMode.current==="edit"?editVoiceCommand(text):voiceCommand(text);}
 function receive(text:string,meta?:VoiceCaptureMeta){
  if(!text.trim())return;
  setHeard(text);
  logVoiceEvent("transcript.received","queued for interpretation",meta?.traceId??"");
  if(registration.current?.isSaving()){feedback("承認された下書きを保存中です。完了後に続きをお願いします。",true);return;}
  const captured:VoiceCaptureMeta={reviewEpoch:meta?.reviewEpoch??boundary.current,traceId:meta?.traceId??newTrace(),source:meta?.source,utteranceId:meta?.utteranceId};
  // Approval/navigation from an earlier mode must never affect a new target.
  if(captured.reviewEpoch<modeBoundary.current&&commandForMode(text)!=="data"){feedback("切り替え前の承認は適用していません。現在のモードを確認して、もう一度お願いします。",true);return;}
  if(currentMode.current==="edit"&&commandForMode(text)==="data"&&!voiceNavigation(text))editor.current?.invalidate();
  if(queue.current.length>=30){logVoiceEvent("queue.dropped","30 utterances pending",captured.traceId??"");feedback("処理待ちの発話が多すぎます。処理完了後に再度お願いします。",true);return;}
  queue.current.push({text,meta:captured});void drain();
 }
 async function checkIntent(utterance:string,current_mode:VoiceMode){
  setCheckingIntent(true);
  try{return await request<{intent:string;target:string}>("/api/intent",{method:"POST",body:JSON.stringify({utterance,current_mode})});}
  finally{if(alive.current)setCheckingIntent(false);}
 }
 async function drain(){
  if(running.current)return;running.current=true;setRouting(true);
  try{while(alive.current&&queue.current.length){
   const input=queue.current.shift()!;
   try{
   if(input.meta.reviewEpoch<modeBoundary.current&&commandForMode(input.text)!=="data"){feedback("切り替え前の承認は適用していません。もう一度お願いします。",true);continue;}
   const control=commandForMode(input.text);
   // A pending registration draft stays reachable from idle/browse: an explicit
   // review/save request with no navigation meaning routes to the draft instead
   // of starting a new search. Navigation-shaped requests keep normal routing so
   // a mode change never presents an approval the user did not ask for.
   if((control==="review"||control==="save")&&!voiceNavigation(input.text)&&registration.current?.hasPending()&&currentMode.current!=="create"&&currentMode.current!=="edit"){
    transition("create",input.meta.traceId??"");feedback("保持していた下書きを確認します。");
    registration.current?.submit(input.text,input.meta);
    setDraftPending(Boolean(registration.current?.hasPending()));
    continue;
   }
   // In an active task, a human's explicit save/review is a control first.
   // “レシピを登録してください” must not be swallowed as create navigation.
   if(commandForMode(input.text)!=="data"&&(currentMode.current==="create"||currentMode.current==="edit")){
    if(currentMode.current==="create"){registration.current?.submit(input.text,input.meta);setDraftPending(Boolean(registration.current?.hasPending()));}
    else await editor.current?.submit(input.text,input.meta);
    continue;
   }
   if(/^(?:変更案を破棄|変更を取り消す)[。！! ]*$/.test(input.text)){
    if(currentMode.current==="edit")await editor.current?.submit("キャンセル",input.meta);
    feedback("変更案を破棄しました。レシピ自体は変更していません。");continue;
   }
   let nav=voiceNavigation(input.text);
   // Only navigation paraphrases need an intent call. Material dictation and
   // approval controls stay on their existing paths without another model hop.
   if(!nav&&!isPriceResearchRequest(input.text)&&commandForMode(input.text)==="data"&&!explicitEditRequest(input.text)&&/(?:モード|レシピ|メニュー|参照|呼び出|検索|見たい|開い|探したい)/.test(input.text)){
    if(/しない|しません|ではなく|じゃなく|やめ/.test(input.text)){feedback("切り替えずに現在の内容を保持しています。希望する操作をもう一度教えてください。",true);continue;}
    const result=await checkIntent(input.text,currentMode.current);
    if(!["create","browse","edit"].includes(result.intent)||typeof result.target!=="string"){
     feedback("切り替え先を確認できませんでした。登録・参照・編集のどれかを教えてください。",true);continue;
    }
    logVoiceEvent("intent.fallback",`${currentMode.current}->${result.intent}`,input.meta.traceId??"");
    nav={mode:result.intent as Navigation["mode"],target:result.target};
   }
   if(nav){await navigate(nav,input.text,input.meta.traceId??"");continue;}
   if(currentMode.current==="idle"){
    // Direct dictation is also a supported new-recipe entry, announced audibly.
    transition("create");feedback("登録モードです。料理の内容を下書きにします。");
   }
   if(currentMode.current==="create")registration.current?.submit(input.text,input.meta);
   else if(currentMode.current==="browse"||currentMode.current==="edit"){
    if(!selectedRef.current||!editor.current){feedback("対象のレシピを呼び出してください。候補が複数なら画面で選んでください。",true);continue;}
    if(currentMode.current==="browse"){
     if(commandForMode(input.text)!=="data"){feedback("参照中です。変更内容を話すと編集へ進みます。保存はしません。");continue;}
     if(!explicitEditRequest(input.text)){
      if(/(?:変更|修正|訂正|追加)(?:は)?(?:しない|しません)/.test(input.text)){feedback("変更せず、参照モードのままです。");continue;}
      const intent=await checkIntent(input.text,"browse");
      if(intent.intent!=="edit"||intent.target){feedback("参照モードのままです。変更する場合は、対象と変更内容を教えてください。");continue;}
     }
     transition("edit");feedback("編集モードです。変更案を作成します。");
    }
    await editor.current.submit(input.text,input.meta);
   }
   }catch{feedback("操作を完了できませんでした。現在の内容を確認して、もう一度お願いします。",true);}
  }}
  finally{running.current=false;if(alive.current)setRouting(false);}
 }
 useVoiceProcessingStatus(locale,[
  ...(micRecording?[{key:"listen" as const}]:[]),
  ...(micBusy||(realtimeActive&&Boolean(realtime.partial))?[{key:"transcribe" as const}]:[]),
  ...(checkingIntent?[{key:"intent" as const}]:[]),
 ]);
 return <>
  {/* No role=status here: the root floating status panel is the single
   announcer for the same recording/processing state. This block keeps only
   the stop control to avoid double announcements. */}
  {selected&&(micRecording||micBusy)&&mode!=="edit"&&<div className="recipe-voice-capture-status">
    <span>{micRecording?(locale==="ja"?"音声録音中":"Microphone recording"):(locale==="ja"?"音声処理中":"Processing audio")}</span>
    {micRecording&&<button type="button" onClick={toggleMic}>{locale==="ja"?"マイクを停止":"Stop microphone"}</button>}
   </div>}
  {(heard||(realtimeActive&&realtime.partial))&&<p aria-live="polite" aria-label={locale==="ja"?"認識した発話":"Recognized speech"} className="mx-0 my-2 line-clamp-2 break-words text-sm text-inherit">{realtimeActive&&realtime.partial?<><span>{locale==="ja"?"認識中：":"Recognizing: "}</span>{realtime.partial}</>:heard}</p>}
  <section id="voice-controls" aria-label={locale==="ja"?"音声操作モード":"Voice operation mode"} className="voice-mode-panel">
   <div className="voice-heading"><h2>{locale==="ja"?"音声操作":"Voice control"}</h2><button type="button" className="voice-settings-button" aria-label={locale==="ja"?"設定を開く":"Open settings"} aria-expanded={settingsOpen} onClick={()=>setSettingsOpen(v=>!v)}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M10 2h4l.7 2.5 2 1.1 2.5-.6 2 3.5-1.8 1.9v2.2l1.8 1.9-2 3.5-2.5-.6-2 1.1L14 22h-4l-.7-2.5-2-1.1-2.5.6-2-3.5 1.8-1.9v-2.2L2.8 9.5l2-3.5 2.5.6 2-1.1L10 2z"/></svg></button></div>
   <p>{locale==="ja"?"現在のモード: ":"Current mode: "}<strong>{locale==="ja"?labels[mode]:({idle:"Idle",create:"Create",browse:"Browse",edit:"Edit"} as const)[mode]}</strong>{mode==="edit"&&selected?` — ${selected.title.value}`:""}</p>
   {draftPending&&mode!=="create"&&<p role="status">{locale==="ja"?"登録途中の下書きを保持しています。":"Your unfinished recipe draft is preserved."}<button type="button" onClick={()=>void (async()=>{await navigate({mode:"create",target:""});if(currentMode.current!=="create")return;registration.current?.requestReview();feedback("保持していた下書きを確認します。");})()}>{locale==="ja"?"下書きに戻る":"Return to draft"}</button></p>}
   <button type="button" className="mic-primary" disabled={micDisabled} onClick={toggleMic} aria-pressed={micRecording} aria-label={micRecording?(locale==="ja"?"■ マイクを停止":"■ Stop microphone"):(micError||micNotice)?(locale==="ja"?"🎙 音声操作を再開":"🎙 Resume voice control"):(locale==="ja"?"🎙 音声操作を開始":"🎙 Start voice control")}>{micRecording?<span aria-hidden="true" className="stop-glyph"/>:<MicrophoneGlyph/>}<span aria-hidden="true">{micRecording?(locale==="ja"?"マイクを停止":"Stop microphone"):(micError||micNotice)?(locale==="ja"?"音声操作を再開":"Resume voice control"):(locale==="ja"?"音声操作を開始":"Start voice control")}</span></button>
   <ListeningWave active={micRecording}/>
   <p role="status">{micRecording?(locale==="ja"?"音声受付中":"Listening"):micBusy?(locale==="ja"?"音声受付は一時停止・受信済みの音声を処理中":"Processing recorded audio; microphone paused"):(micError||micNotice)?(locale==="ja"?"音声受付は停止中・再開できます":"Microphone stopped; you can resume"):(locale==="ja"?"音声受付は停止中":"Microphone stopped")}</p>
   {micNotice&&<p role="status">{micNotice}</p>}

   {supplierMemo&&<p className="muted">{supplierMemo}</p>}
   {<p role={feedbackError?"alert":undefined} aria-live="polite">{micRecording?(locale==="ja"?"聞き取り中… ":"Listening… "):""}{micBusy?(locale==="ja"?"音声を文字にしています… ":"Transcribing… "):""}{routing?(locale==="ja"?"操作を処理中… ":"Processing… "):""}{message}</p>}
   {micError&&<p role="alert">{micError}</p>}
   <form onSubmit={event=>{event.preventDefault();receive(manual,{reviewEpoch:boundary.current,source:"manual"});setManual("");}}>
    <input aria-label={locale==="ja"?"音声認識できない場合の入力":"Manual input when voice recognition is unavailable"} value={manual} onChange={event=>setManual(event.target.value)} placeholder={locale==="ja"?"音声認識できないときの補助入力":"Type when voice recognition is unavailable"}/>
    <button type="submit" disabled={!manual.trim()}>{locale==="ja"?"反映":"Apply"}</button>
   </form>
   <div className="voice-quick-modes" role="group" aria-label={locale==="ja"?"操作モード":"Operation mode"}>
    {<button type="button" aria-pressed={mode==="create"} onClick={()=>void navigate({mode:"create",target:""})}>{locale==="ja"?"登録":"Create"}</button>}
    {<button type="button" aria-pressed={mode==="browse"} onClick={()=>void navigate({mode:"browse",target:""})}>{locale==="ja"?"参照":"Browse"}</button>}
    <button type="button" aria-pressed={mode==="edit"} onClick={()=>void navigate({mode:"edit",target:""})}>{locale==="ja"?"編集":"Edit"}</button>
   </div>
   {settingsOpen&&<section className="voice-settings-panel" aria-label={locale==="ja"?"音声設定":"Voice settings"}>
    <h3>{locale==="ja"?"設定":"Settings"}</h3>
    <label>{locale==="ja"?"通知音の音量 ":"Notification volume "}<input aria-label={locale==="ja"?"通知音の音量":"Notification volume"} type="range" min="0" max="1" step="0.1" value={volume} onChange={event=>setVolume(Number(event.target.value))}/></label>
    <button type="button" onClick={()=>setVolume(volume?0:.5)}>{volume?(locale==="ja"?"通知音をミュート":"Mute sounds"):(locale==="ja"?"通知音をオン":"Enable sounds")}</button>
    <details><summary>{locale==="ja"?"使い方を確認":"How to use"}</summary>
     <p>{locale==="ja"?"「レシピを登録します」「〇〇を見せて」「パスタを150gに変更」のように話してください。":"Speak naturally to create, find or edit a recipe."}</p>
     <p>{locale==="ja"?"音声はMetaへ送信して文字起こしします。録音は保存しません。切り替え音の後に話してください。":"Audio is sent to Meta for transcription. Recordings are not saved. Speak after the cue."}</p>
     <p>{locale==="ja"?"保存・変更には内容確認と明示承認が必要です。":"Saving changes requires review and explicit approval."}</p>
    </details>
    {heard&&<details><summary>{locale==="ja"?"最後に認識した指示":"Last recognized instruction"}</summary><p>{heard}</p></details>}
    <details><summary>{locale==="ja"?"音声の状態履歴（直近の動作）":"Recent voice activity"}</summary>
     <ul>{diag.slice(-10).map(event=><li key={event.seq}>{new Date(event.at).toLocaleTimeString()} {event.kind}{event.trace?` [${event.trace}]`:""}{event.detail?`：${event.detail}`:""}</li>)}</ul>
    </details>
   </section>}
  </section>
  <div hidden={mode!=="create"}><VoiceRecipeRegistration locale={locale} control={registration} onDiscarded={()=>setDraftPending(false)} sharedVoice={{markReview:mark,cancel:()=>{},mic:realtimeActive?{recording:realtime.recording,transcribing:false,queued:0}:{recording:voice.recording,transcribing:voice.busy||voice.queued>0,queued:voice.queued},captureMessage:micRecording?"音声受付中です。「保存」と話すと、数量・価格などが未確定でも現在の内容を保存します。":micBusy?"音声受付は一時停止しています。受信済みの音声を処理中です。下書きは保持しています。":`音声受付は停止中です。下書きは保持しています。${micError||micNotice||""}`}} onCreated={(recipe,mode,suppliers)=>{
   // The formal save has already committed supplier links. Keep their names
   // for feedback when the registration panel switches back to browse.
  setSupplierMemo(suppliers.length?(locale==="ja"?`保存した仕入れ先：${suppliers.join("／")}`:`Saved suppliers: ${suppliers.join(", ")}`):"");
  setDraftPending(false);transition("browse");feedback(mode==="unconfirmed"?(locale==="ja"?"価格未確定として保存しました。未確定の仕入単価はゼロにせず、部分原価のみ表示されます。":"Saved with unconfirmed prices. Only partial food costs are shown."):(locale==="ja"?"レシピを保存しました。":"Recipe saved."));onCreated(recipe);
  }}/></div>
  <nav aria-label={locale==="ja"?"主要":"Primary"} className="bottom-nav">
   <a href="/" onClick={event=>{event.preventDefault();void navigate({mode:"browse",target:""});}}><NavIcon name="home"/><span>{locale==="ja"?"ホーム":"Home"}</span></a>
   <a href="/#recipes" onClick={event=>{event.preventDefault();void navigate({mode:"browse",target:""});}}><NavIcon name="recipes"/><span>{locale==="ja"?"レシピ":"Recipes"}</span></a>
   <button type="button" className="bottom-nav-mic" aria-label={locale==="ja"?"下部の音声操作":"Bottom voice control"} aria-pressed={micRecording} disabled={micDisabled} onClick={toggleMic}>{micRecording?<span aria-hidden="true" className="stop-glyph"/>:<MicrophoneGlyph/>}</button>
   {<button type="button" onClick={()=>void revealDraft()}><NavIcon name="draft"/><span>{locale==="ja"?"下書き":"Draft"}</span></button>}
   <a href="/settings" aria-label={locale==="ja"?"管理・設定":"Management and settings"}><NavIcon name="settings"/><span>{locale==="ja"?"設定":"Settings"}</span></a>
  </nav>
 </>;
}
