"use client";
import {useEffect,useRef,useState} from "react";
import type {Locale} from "./i18n";
import {request,type Recipe} from "./types";

type Ingredient={name:string;quantity:string;unit:string;price_jpy:string;price_quantity:string;price_unit:string};
type Draft={title:string;materials:Ingredient[];selling_price_jpy:string;notes:string[];missing:string[]};
type RecognitionEvent={resultIndex:number;results:ArrayLike<ArrayLike<{transcript:string}> & {isFinal:boolean}>};
type Recognizer={lang:string;continuous:boolean;interimResults:boolean;onresult:((e:RecognitionEvent)=>void)|null;onend:(()=>void)|null;onerror:((e:{error:string})=>void)|null;start:()=>void;stop:()=>void;abort:()=>void};
type SpeechBrowser=Window&{SpeechRecognition?:new()=>Recognizer;webkitSpeechRecognition?:new()=>Recognizer};

export default function VoiceRecipeRegistration({locale,onCreated}:{locale:Locale;onCreated:(recipe:Recipe)=>void}){
 const ja=locale==="ja";
 const [listening,setListening]=useState(false),[busy,setBusy]=useState(false);
 const [turns,setTurns]=useState<string[]>([]),[draft,setDraft]=useState<Draft|null>(null);
 const [phase,setPhase]=useState<"dictating"|"review"|"saving">("dictating");
 const [message,setMessage]=useState(ja?"マイクを開始し、料理名・食材・分量・仕入単価を話してください。":"Start the microphone and dictate a full recipe.");
 const [manual,setManual]=useState("");
 const active=useRef(false),recognition=useRef<Recognizer|null>(null),lastIndex=useRef(0);
 const turnsRef=useRef<string[]>([]),draftRef=useRef<Draft|null>(null),phaseRef=useRef<"dictating"|"review"|"saving">("dictating");
 const pending=useRef<Promise<void>>(Promise.resolve()),requestId=useRef<string|null>(null);
 const speechChunks=useRef<string[]>([]),speechTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const alive=useRef(true);
 useEffect(()=>{return()=>{alive.current=false;active.current=false;if(speechTimer.current)clearTimeout(speechTimer.current);recognition.current?.abort();};},[]);
 function setStage(next:"dictating"|"review"|"saving"){phaseRef.current=next;setPhase(next);}
 function say(s:string){if(alive.current)setMessage(s);}
 function clear(){if(phaseRef.current==="saving")return;if(speechTimer.current)clearTimeout(speechTimer.current);speechChunks.current=[];turnsRef.current=[];setTurns([]);draftRef.current=null;setDraft(null);requestId.current=null;setStage("dictating");say("下書きを破棄しました。新しいレシピを話してください。");}
 async function parse(next:string[]){
  setBusy(true);
  try{
   const out=await request<Draft>("/api/voice-recipe",{method:"POST",body:JSON.stringify({turns:next})});
   if(!alive.current)return;
   draftRef.current=out;setDraft(out);requestId.current=null;setStage("dictating");
   say(out.missing.length?("不足している情報: "+out.missing.join("、")+"。続けて話してください。"):"下書きを更新しました。「内容を確認」と話してください。");
  }catch{say("Museの解析に失敗しました。下書きは保存されていません。もう一度話してください。");}
  finally{if(alive.current)setBusy(false);}
 }
 async function save(){
  const d=draftRef.current;
  if(phaseRef.current!=="review"||!d||!d.title.trim()||d.missing.length||d.notes.length)return;
  setStage("saving");setBusy(true);say("確認済みの内容を保存しています。");
  if(!requestId.current)requestId.current=crypto.randomUUID();
  try{
   const recipe=await request<Recipe>("/api/recipes/full",{method:"POST",body:JSON.stringify({request_id:requestId.current,title:d.title,materials:d.materials,selling_price_jpy:d.selling_price_jpy||null})});
   if(!alive.current)return;
   active.current=false;recognition.current?.stop();setListening(false);if(speechTimer.current)clearTimeout(speechTimer.current);speechChunks.current=[];
   say("レシピを保存しました。");onCreated(recipe);
   turnsRef.current=[];setTurns([]);draftRef.current=null;setDraft(null);requestId.current=null;setStage("dictating");
  }catch{setStage("review");say("保存結果を確認できませんでした。再送しても同じ登録IDを使用します。レシピ一覧を確認してから再試行してください。");}
  finally{if(alive.current)setBusy(false);}
 }
 async function handle(utterance:string){
  const value=utterance.trim().replace(/[。．.!！?？、，,]+$/g,"").trim();if(!value||phaseRef.current==="saving")return;
  // ASR often inserts spaces between Japanese words: 「登録 を 確定」.
  const command=value.normalize("NFKC").replace(/[\s　、。．.!！?？,]+/g,"");
  if(/^(キャンセル|破棄|最初から|cancel)$/i.test(command)){clear();return;}
  if(/^(内容を確認|内容を確認して|確認して|確認|review)$/i.test(command)){
   const d=draftRef.current;
   if(!d||!d.title||d.missing.length||d.notes.length){say("登録内容が未完成です。不足している項目を補ってください。");return;}
   setStage("review");say("下書きを確認してください。正しければ「登録を確定」と話してください。");return;
  }
  if(/^(登録を確定|登録を確定して|保存を確定|登録して|保存して|confirmsave)$/i.test(command)){
   if(phaseRef.current!=="review"){say("先に「内容を確認」と話してください。");return;}
   await save();return;
  }
  const next=[...turnsRef.current,value].slice(-30);turnsRef.current=next;setTurns(next);
  draftRef.current=null;setDraft(null);requestId.current=null;setStage("dictating");
  await parse(next);
 }
 function enqueue(s:string){pending.current=pending.current.then(()=>handle(s)).catch(()=>say("音声処理でエラーが発生しました。"));}
 function flushSpeech(){if(speechTimer.current)clearTimeout(speechTimer.current);speechTimer.current=null;const chunks=speechChunks.current.splice(0);if(chunks.length)enqueue(chunks.join("、"));}
 function collectSpeech(chunk:string){
  const normalized=chunk.normalize("NFKC").replace(/[\\s　、。．.!！?？,]+/g,"");
  if(/^(内容を確認|内容を確認して|確認して|確認|登録を確定|登録を確定して|保存を確定|登録して|保存して|キャンセル|破棄|最初から)$/i.test(normalized)){
   flushSpeech();enqueue(chunk);return;
  }
  speechChunks.current.push(chunk);
  if(speechTimer.current)clearTimeout(speechTimer.current);
  // SpeechRecognition final results are phrase fragments, not full sentences.
  // Accumulate across pauses and transcribe as one coherent instruction.
  speechTimer.current=setTimeout(flushSpeech,3500);
 }
 function start(){
  const w=window as SpeechBrowser;const Constructor=w.SpeechRecognition||w.webkitSpeechRecognition;
  if(!Constructor){say("このブラウザは音声認識に対応していません。Chromeをご利用ください。");return;}
  active.current=true;setListening(true);
  function open(){
   if(!active.current||!alive.current)return;
   const r=new Constructor!();recognition.current=r;lastIndex.current=0;
   r.lang=ja?"ja-JP":"en-US";r.continuous=true;r.interimResults=false;
   r.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++){if(i<lastIndex.current||!e.results[i].isFinal)continue;lastIndex.current=i+1;collectSpeech(e.results[i][0].transcript);}};
   r.onerror=e=>{if(e.error==="not-allowed"||e.error==="service-not-allowed"){active.current=false;setListening(false);say("マイクへのアクセスが許可されていません。");}};
   r.onend=()=>{if(recognition.current===r)recognition.current=null;if(active.current&&alive.current){try{open();}catch{active.current=false;setListening(false);say("マイクを再開できません。もう一度開始してください。");}}};
   r.start();
  }
  try{open();}catch{active.current=false;setListening(false);say("マイクを開始できませんでした。");}
 }
 function stop(){active.current=false;recognition.current?.stop();flushSpeech();setListening(false);}
 return <section className="card" aria-label="音声レシピ一括登録">
  <h2>{ja?"音声でレシピを一括登録":"Full recipe by voice"}</h2>
  <p>料理名、食材、分量、仕入単価、売価を自然な言葉で伝えてください。訂正は続けて話せます。勝手に補完・保存しません。</p>
  <p>音声操作：「内容を確認」→「登録を確定」。取り消しは「キャンセル」。</p>
  <button type="button" onClick={listening?stop:start} aria-pressed={listening}>{listening?"■ マイクを停止":"🎙 音声登録を開始"}</button>
  <p aria-live="polite">{busy?"処理中：":""}{message}</p>
  <form onSubmit={e=>{e.preventDefault();if(manual.trim()){enqueue(manual);setManual("");}}}>
   <input aria-label="音声認識できない場合の入力" value={manual} onChange={e=>setManual(e.target.value)} placeholder="音声認識できないときの補助入力"/>
   <button type="submit" disabled={!manual.trim()}>反映</button>
  </form>
  <p>認識した発話：{turns.length?turns.join(" ／ "):"なし"}</p>
  {draft&&<div aria-label="未保存のレシピ下書き">
   <h3>未保存の下書き：{draft.title||"料理名未設定"}</h3>
   <p>売価：{draft.selling_price_jpy?("¥"+draft.selling_price_jpy):"未設定"}</p>
   <ul>{draft.materials.map((m,i)=><li key={i}>{m.name||"食材名不明"}：{m.quantity||"?"}{m.unit} ／ 仕入単価 ¥{m.price_jpy||"?"} / {m.price_quantity||"?"}{m.price_unit}</li>)}</ul>
   {draft.missing.length>0&&<p role="alert">不足情報：{draft.missing.join("、")}</p>}
   {draft.notes.length>0&&<p role="alert">要確認：{draft.notes.join("、")}</p>}
   <p>{phase==="review"?"確認待ち：『登録を確定』で保存します。":"まだ保存されていません。"}</p>
   <button type="button" disabled={busy||phase!=="review"} onClick={()=>void save()}>内容を承認して保存</button>
   <button type="button" disabled={busy} onClick={clear}>下書きを破棄</button>
  </div>}
 </section>;
}
