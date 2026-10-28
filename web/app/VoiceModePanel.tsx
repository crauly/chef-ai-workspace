"use client";
import {useEffect, useRef, useState} from "react";
import type {Locale} from "./i18n";

export type VoiceMode = "idle" | "create" | "browse" | "edit";
type Cue = Exclude<VoiceMode, "idle"> | "error";

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
  const [busy, setBusy] = useState(false);
  const [diagnostic, setDiagnostic] = useState("");
  const [checking, setChecking] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const [error, setError] = useState("");
  const [command, setCommand] = useState("");
  const ja = locale === "ja";
  const modeLabels: Record<VoiceMode, string> = ja
    ? {idle:"待機",create:"新規作成",browse:"レシピ参照",edit:"編集"}
    : {idle:"Idle",create:"Create",browse:"Browse",edit:"Edit"};
  async function checkModel() {
    setChecking(true);setDiagnostic("");
    const models = ["muse-spark-1.3","muse-spark-1.2","muse-spark-1.1"];
    try {
      const results = await Promise.all(models.map(async (model) => {
        try {
          const response = await fetch("/api/model-inference-check",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model})});
          const data: {status?:string;reason?:string} = await response.json();
          return model + ": " + [data.status || "unknown",data.reason && data.reason !== "unspecified" ? data.reason : ""].filter(Boolean).join(" / ");
        } catch {return model + ": proxy_transport_error";}
      }));
      setDiagnostic(results.join(" | "));
    } finally {setChecking(false);}
  }
  async function dispatch(value: string) {
    if (busy) return;
    setBusy(true);setCommand(value);setError("");
    try {
      const response = await fetch("/api/intent", {
        method: "POST",headers: {"Content-Type":"application/json"},
        body:JSON.stringify({utterance:value,current_mode:mode}),
      });
      if (!response.ok) throw new Error("model");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object") throw new Error("model");
      const {intent,target} = result as {intent?:unknown;target?:unknown};
      if (!["create","browse","edit","clarify"].includes(String(intent)) || typeof target !== "string") throw new Error("model");
      if (intent === "clarify") {
        setError(ja ? "指示を確認できませんでした。別の言い方でお願いします。" : "Please rephrase the request.");
        playVoiceCue("error",volume);return;
      }
      const next = intent as Exclude<VoiceMode, "idle">;
      if (next !== mode) playVoiceCue(next,volume);
      setMode(next);onMode(next,target);
    } catch {
      setError(ja ? "Museの意図判定に接続できません。しばらくしてから再度お試しください。" : "Muse intent recognition is unavailable. Try again.");
      playVoiceCue("error",volume);
    } finally {setBusy(false);}
  }
  return <section aria-label={ja ? "音声操作モード" : "Voice command mode"} className="voice-mode-panel">
    <h2>{ja ? "音声操作" : "Voice assistant"}</h2>
    <p className="muted">{ja ? "やりたいことを自然に話してください。Museが操作を判断します。" : "Describe what you want to do. Muse will identify the action."}</p>
    <p aria-live="polite">{ja ? "現在のモード" : "Current mode"}: <strong>{modeLabels[mode]}</strong></p>
    <ModeMicrophone locale={locale} onCommand={dispatch} disabled={busy} />
    {busy && <p aria-live="polite">{ja ? "Museが内容を確認しています…" : "Muse is interpreting…"}</p>}
    <label>{ja ? "通知音の音量" : "Cue volume"} <input type="range" min="0" max="1" step="0.1" value={volume} onChange={e => setVolume(Number(e.target.value))} aria-label={ja ? "通知音の音量" : "Cue volume"}/></label>
    <button type="button" onClick={() => setVolume(volume ? 0 : 0.5)}>{volume ? (ja ? "通知音をミュート" : "Mute cues") : (ja ? "通知音をオン" : "Unmute cues")}</button>
    <button type="button" disabled={checking} onClick={()=>void checkModel()}>{ja ? "Muse 1.3 / 1.2 / 1.1 比較テスト" : "Compare Muse 1.3 / 1.2 / 1.1"}</button>
    {diagnostic && <p role="status">Meta inference: <strong>{diagnostic}</strong></p>}
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
function ModeMicrophone({locale,onCommand,disabled}:{locale:Locale;onCommand:(text:string)=>void;disabled:boolean}) {
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
   <button type="button" disabled={supported===false || disabled} onClick={()=>listening?ref.current?.stop():start()} aria-pressed={listening}>{listening?(locale==="ja"?"■ 指示の聞き取りを終了":"■ Stop listening"):(locale==="ja"?"🎙 音声コマンドを話す":"🎙 Say command")}</button>
   {message&&<p role="alert">{message}</p>}
   {supported===false&&<p className="muted">{locale==="ja"?"このブラウザは音声認識に対応していません。":"Speech recognition unavailable."}</p>}
 </div>;
}
