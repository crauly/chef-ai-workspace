"use client";
import {useState} from "react";
export default function MuseVerification(){
 const [result,setResult]=useState("未実行");const [busy,setBusy]=useState(false);
 async function run(){setBusy(true);setResult("確認中");try{
  const r=await fetch("/api/vercel-direct-meta-check",{method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store"});
  const data=await r.json();setResult(r.ok&&data.status==="inference_ready"?"成功：Muse Spark 1.3が推論テキストを出力":("失敗："+(data.status??r.status)));
 }catch{setResult("失敗：ネットワークエラー");}finally{setBusy(false);}}
 return <main style={{maxWidth:640,margin:"4rem auto",padding:"1.5rem"}}><h1>Muse Spark 1.3 API診断</h1><p>本番VercelからMeta APIへ推論を送信し、応答テキストまで確認します。レシピデータは変更しません。</p><button onClick={run} disabled={busy}>{busy?"確認中…":"推論APIをテスト"}</button><p role="status" aria-live="polite">{result}</p></main>;
}
