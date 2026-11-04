"use client";
import {useVoiceProcessingStatus} from "./VoiceProcessingStatus";
import type {Locale} from "./i18n";
import {useVoiceCapture} from "./useVoiceCapture";

export default function VoiceInput({locale, onTranscript, disabled = false}: {
  locale: Locale; onTranscript: (text: string) => void; disabled?: boolean;
}) {
  const voice = useVoiceCapture(locale, onTranscript);
  useVoiceProcessingStatus(locale,[...(voice.recording?[{key:"listen" as const}]:[]),...(voice.busy?[{key:"transcribe" as const}]:[])]);
  const ja = locale === "ja";
  return <div className="voice-input">
    <button type="button" disabled={!voice.recording && (disabled || voice.busy || voice.supported === false)}
      onClick={voice.recording ? voice.stop : () => void voice.start()} aria-pressed={voice.recording}
      aria-label={voice.recording ? "音声入力を停止" : "音声入力を開始"}>
      {voice.recording ? (ja ? "■ 録音終了" : "■ Stop microphone") : (ja ? "🎙 マイクで話す" : "🎙 Speak")}
    </button>
    <span aria-live="polite">{voice.recording ? (ja ? "聞き取り中…終了して内容を確認してください" : "Listening… stop and review the transcript")
      : voice.busy ? (ja ? "音声を文字にしています…" : "Transcribing…")
      : voice.supported === false ? (ja ? "このブラウザでは音声入力を利用できません" : "Audio input not supported") : ""}</span>
    <p className="muted">{ja ? "音声はMetaへ送信して文字起こしします。アプリには録音を保存しません。" : "Audio is sent to Meta for transcription. The app does not store recordings."}</p>
    {voice.error && <p role="alert" className="error">{voice.error}</p>}
  </div>;
}
