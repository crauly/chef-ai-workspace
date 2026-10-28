"use client";
import {useEffect, useRef, useState} from "react";
import type {Locale} from "./i18n";

export type VoiceMode = "idle" | "create" | "browse" | "edit";
type Cue = Exclude<VoiceMode, "idle"> | "error";
export function classifyVoiceCommand(input: string): VoiceMode | "unknown" {
  const text = input.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  if (/^(新規(登録|作成)?|新しいレシピ|レシピ(を)?作(成|って)|create(new)?recipe)/.test(text)) return "create";
  if (/^(レシピ(を)?(見せて|見たい|参照|検索|開いて)|一覧(を)?(見せて|開いて)|show(recipes|recipe)|findrecipe|openrecipe)/.test(text)) return "browse";
  if (/^(レシピ(を)?(編集|修正)|編集(して|する)?|修正(して|する)?|材料(を)?(追加|変更)|数量(を)?変更|単価(を)?変更|editrecipe|modifyrecipe)/.test(text)) return "edit";
  return "unknown";
}

export function playVoiceCue(kind: Cue, volume: number): void {
  if (volume <= 0) return;
  type AudioWindow = Window & {AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext};
  const w = window as AudioWindow;
  const Ctx = w.AudioContext || w.webkitAudioContext;
  if (!Ctx) return;
  const context = new Ctx();
  const notes: Record<Cue, Array<[number, number]>> = {
    create: [[523.25, 0], [659.25, 0.13]],
    browse: [[392, 0], [523.25, 0.16]],
    edit: [[587.33, 0], [440, 0.11], [587.33, 0.22]],
    error: [[220, 0], [196, 0.19]],
  };
  try {
    for (const [frequency, delay] of notes[kind]) {
      const osc = context.createOscillator(), gain = context.createGain();
      const start = context.currentTime + delay;
      osc.type = "sine"; osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.12), start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
      osc.connect(gain); gain.connect(context.destination);
      osc.start(start); osc.stop(start + 0.12);
    }
    window.setTimeout(() => {void context.close();}, 650);
  } catch {void context.close();}
}

export default function VoiceModePanel({locale, onMode}: {
  locale: Locale; onMode: (mode: VoiceMode, command: string) => void;
}) {
  const [mode, setMode] = useState<VoiceMode>("idle");
  const [volume, setVolume] = useState(0.5);
  const [error, setError] = useState("");
  const [command, setCommand] = useState("");
  const ja = locale === "ja";
  const modeLabels: Record<VoiceMode, string> = ja
    ? {idle:"待機",create:"新規作成",browse:"レシピ参照",edit:"編集"}
    : {idle:"Idle",create:"Create",browse:"Browse",edit:"Edit"};
  function dispatch(value: string) {
    const next = classifyVoiceCommand(value);
    setCommand(value);
    if (next === "unknown") {
      setError(ja ? "操作を判断できませんでした。『新規作成』『レシピ参照』『編集』などと話してください。" : "Command unclear. Try create recipe, show recipes, or edit recipe.");
      playVoiceCue("error", volume);
      return;
    }
    setError("");
    if (next !== mode && next !== "idle") playVoiceCue(next, volume);
    setMode(next);
    onMode(next, value);
  }
  return <section aria-label={ja ? "音声操作モード" : "Voice command mode"} className="card voice-mode-panel">
    <h2>{ja ? "音声で操作を切り替える" : "Navigate by voice"}</h2>
    <p className="muted">{ja ? "『新規作成』『レシピ参照』『編集』と話してください。録音した言葉に応じて画面が切り替わります。" : "Say Create recipe, Show recipes, or Edit recipe."}</p>
    <p aria-live="polite">{ja ? "現在のモード" : "Current mode"}: <strong>{modeLabels[mode]}</strong></p>
    <ModeMicrophone locale={locale} onCommand={dispatch} />
    <label>{ja ? "通知音の音量" : "Cue volume"} <input type="range" min="0" max="1" step="0.1" value={volume} onChange={e => setVolume(Number(e.target.value))} aria-label={ja ? "通知音の音量" : "Cue volume"}/></label>
    <button type="button" onClick={() => setVolume(volume ? 0 : 0.5)}>{volume ? (ja ? "通知音をミュート" : "Mute cues") : (ja ? "通知音をオン" : "Unmute cues")}</button>
    {command && <p className="muted">{ja ? "認識した指示" : "Recognized"}: {command}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}

type SpeechEvent = {resultIndex:number;results:ArrayLike<ArrayLike<{transcript:string}> & {isFinal:boolean}>};
type Recognition = {
 lang:string;continuous:boolean;interimResults:boolean;
 onresult:((e:SpeechEvent)=>void)|null;onerror:((e:{error:string})=>void)|null;onend:(()=>void)|null;
 start:()=>void;stop:()=>void;abort:()=>void;
};
type SpeechWindow = Window & {SpeechRecognition?:new()=>Recognition;webkitSpeechRecognition?:new()=>Recognition};
function ModeMicrophone({locale,onCommand}:{locale:Locale;onCommand:(text:string)=>void}) {
 const [listening,setListening]=useState(false),[supported,setSupported]=useState<boolean|null>(null),[message,setMessage]=useState("");
 const ref=useRef<Recognition|null>(null), final=useRef("");
 useEffect(()=>{const w=window as SpeechWindow;setSupported(Boolean(w.SpeechRecognition||w.webkitSpeechRecognition));return()=>{ref.current?.abort();ref.current=null;};},[]);
 function start() {
  const w=window as SpeechWindow;const C=w.SpeechRecognition||w.webkitSpeechRecognition;
  if(!C)return;
  const r=new C();ref.current=r;final.current="";setMessage("");
  r.lang=locale==="ja"?"ja-JP":"en-US";r.continuous=false;r.interimResults=true;
  r.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal)final.current+=e.results[i][0].transcript+" ";};
  r.onerror=e=>{if(e.error!=="aborted")setMessage(locale==="ja"?"マイクまたは音声認識に問題が発生しました。":"Microphone or recognition failed.");};
  r.onend=()=>{setListening(false);if(ref.current===r){ref.current=null;if(final.current.trim())onCommand(final.current.trim());}};
  try{r.start();setListening(true);}catch{setMessage(locale==="ja"?"マイクを開始できませんでした。":"Could not start microphone.");}
 }
 return <div>
   <button type="button" disabled={supported===false} onClick={()=>listening?ref.current?.stop():start()} aria-pressed={listening}>{listening?(locale==="ja"?"■ 指示の聞き取りを終了":"■ Stop listening"):(locale==="ja"?"🎙 音声コマンドを話す":"🎙 Say command")}</button>
   {message&&<p role="alert">{message}</p>}
   {supported===false&&<p className="muted">{locale==="ja"?"このブラウザは音声認識に対応していません。":"Speech recognition unavailable."}</p>}
 </div>;
}
