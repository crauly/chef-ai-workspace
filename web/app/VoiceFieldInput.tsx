"use client";
import {useState} from "react";
import {type Locale} from "./i18n";
import {useVoiceProcessingStatus} from "./VoiceProcessingStatus";
import {useVoiceCapture} from "./useVoiceCapture";

/**
 * Voice transcription is input only. It never writes a master record.
 * The existing form displays the recognized text for explicit human review.
 */
export default function VoiceFieldInput({locale,label,onTranscript,disabled=false}:{
 locale:Locale;label:string;onTranscript:(value:string)=>void;disabled?:boolean;
}){
 const ja=locale==="ja";
 const [lastHeard,setLastHeard]=useState("");
 const [acknowledged,setAcknowledged]=useState(false);
 const mic=useVoiceCapture(locale,text=>{
  const value=text.trim();
  if(!value)return;
  setLastHeard(value);
  setAcknowledged(false);
  onTranscript(value);
 },false);
 useVoiceProcessingStatus(locale,[...(mic.recording?[{key:"listen" as const}]:[]),...(mic.busy?[{key:"transcribe" as const}]:[]),...(mic.error?[{key:"transcribe" as const,error:true}]:[])]);
 const inactive=disabled||(!mic.recording&&(mic.supported===false||mic.busy));
 return <div className="voice-field-input">
  <button type="button" disabled={inactive} aria-pressed={mic.recording}
   onClick={()=>mic.recording?mic.stop():void mic.start()}>
   {mic.recording?(ja?"■ 音声入力を停止":"■ Stop voice input"):(ja?`🎙 ${label}を音声入力`:`🎙 Dictate ${label}`)}
  </button>
  {lastHeard&&!acknowledged&&<p role="status">{ja?"認識結果を入力欄に反映しました。内容を確認してから登録してください。":"Transcribed into the form. Review before saving."} <button type="button" onClick={()=>setAcknowledged(true)}>{ja?"確認":"OK"}</button></p>}
  {mic.error&&<p role="alert">{mic.error}</p>}

 </div>;
}
