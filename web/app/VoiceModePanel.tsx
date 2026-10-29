"use client";
import {useState} from "react";
import {useVoiceCapture} from "./useVoiceCapture";
import type {Locale} from "./i18n";

export type VoiceMode = "idle" | "create" | "browse" | "edit";
type Cue = Exclude<VoiceMode, "idle"> | "error" | "stop";

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
    stop: [[330, 0], [262, 0.12], [196, 0.24]],
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
    {command && <p className="muted">{ja ? "認識した指示" : "Recognized"}: {command}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}

function ModeMicrophone({locale,onCommand,disabled}:{locale:Locale;onCommand:(text:string)=>void;disabled:boolean}) {
 const voice=useVoiceCapture(locale,onCommand);
 return <div>
   <button type="button" disabled={!voice.recording&&(voice.supported===false||voice.busy||disabled)} onClick={()=>voice.recording?voice.stop():void voice.start()} aria-pressed={voice.recording}>{voice.recording?(locale==="ja"?"■ 指示の聞き取りを終了":"■ Stop listening"):(locale==="ja"?"🎙 音声コマンドを話す":"🎙 Say command")}</button>
   <p className="muted">{locale==="ja"?"音声はMetaへ送信して文字起こしします。アプリには録音を保存しません。":"Audio is sent to Meta for transcription. The app does not store recordings."}</p>
   {voice.busy&&<p aria-live="polite">{locale==="ja"?"音声を文字にしています…":"Transcribing…"}</p>}
   {voice.error&&<p role="alert">{voice.error}</p>}
   {voice.supported===false&&<p className="muted">{locale==="ja"?"このブラウザでは音声入力を利用できません。":"Audio input unavailable."}</p>}
 </div>;
}
