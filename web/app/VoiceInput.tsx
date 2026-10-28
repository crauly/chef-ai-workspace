"use client";
import {useEffect, useRef, useState} from "react";
import type {Locale} from "./i18n";

type SpeechAlternative = {transcript: string};
type SpeechEvent = {resultIndex: number; results: ArrayLike<ArrayLike<SpeechAlternative> & {isFinal: boolean}>};
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: {error: string}) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};
type SpeechWindow = Window & {SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition};

export default function VoiceInput({locale, onTranscript, disabled = false}: {
  locale: Locale; onTranscript: (text: string) => void; disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const recognition = useRef<Recognition | null>(null);
  const finalText = useRef("");
  useEffect(() => {
    const w = window as SpeechWindow;
    setSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    return () => {recognition.current?.abort(); recognition.current = null;};
  }, []);
  function stop() {recognition.current?.stop();}
  function start() {
    if (disabled || recording) return;
    const w = window as SpeechWindow;
    const Constructor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Constructor) {setError(locale === "ja" ? "このブラウザは音声認識に対応していません。Chromeなどでお試しください。" : "Speech recognition is not available in this browser."); return;}
    recognition.current?.abort();
    const recognizer = new Constructor();
    recognizer.lang = locale === "ja" ? "ja-JP" : "en-US";
    recognizer.continuous = true;
    recognizer.interimResults = true;
    finalText.current = "";
    setError("");
    recognizer.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText.current += result[0].transcript + " ";
        else interim += result[0].transcript;
      }
      onTranscript((finalText.current + interim).trim());
    };
    recognizer.onerror = (event) => {
      if (event.error !== "no-speech" && event.error !== "aborted")
        setError(locale === "ja" ? `音声認識エラー: ${event.error}。マイク権限と通信状態を確認してください。` : `Speech recognition error: ${event.error}`);
    };
    recognizer.onend = () => {setRecording(false); if (recognition.current === recognizer) recognition.current = null;};
    recognition.current = recognizer;
    try {recognizer.start(); setRecording(true);} catch {setRecording(false); setError(locale === "ja" ? "マイクを開始できませんでした。" : "Could not start microphone.");}
  }
  return <div className="voice-input">
    <button type="button" disabled={disabled || supported === false} onClick={recording ? stop : start} aria-pressed={recording} aria-label={recording ? "音声入力を停止" : "音声入力を開始"}>
      {recording ? (locale === "ja" ? "■ 録音終了" : "■ Stop microphone") : (locale === "ja" ? "🎙 マイクで話す" : "🎙 Speak")}
    </button>
    <span aria-live="polite">{recording ? (locale === "ja" ? "聞き取り中…終了して内容を確認してください" : "Listening… stop and review the transcript") : supported === false ? (locale === "ja" ? "このブラウザでは音声入力を利用できません" : "Speech input not supported") : ""}</span>
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
