"use client";
import {useEffect,useState} from "react";
import type {Locale} from "./i18n";
import {isPlateImageValid,PLATE_NOTE_MAX,PLATE_MAX_BYTES} from "./plate-settings";
import {addPlate,loadPlates,makeDefault,removePlate,type Plate} from "./plate-library";
export default function PlateSettingsSection({locale}:{locale:Locale}){
 const ja=locale==="ja";
 const [plates,setPlates]=useState<Plate[]>([]),[defaultId,setDefaultId]=useState<string|null>(null);
 const [name,setName]=useState(""),[note,setNote]=useState(""),[image,setImage]=useState<string|null>(null),[error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 async function refresh(){const data=await loadPlates();setPlates(data.plates);setDefaultId(data.defaultId);}
 useEffect(()=>{void refresh().catch(()=>setError(ja?"皿を読み込めません":"Could not load plates"));},[]);
 async function choose(file:File|null){
  if(!file)return;setError("");
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)){setError(ja?"JPEG・PNG・WebPのみ対応":"JPEG/PNG/WebP only");return;}
  // Downscale before storage; no artificial limit on number of plates.
  try{
   const bitmap=await createImageBitmap(file);
   const scale=Math.min(1,900/Math.max(bitmap.width,bitmap.height));
   const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
   const ctx=canvas.getContext("2d");if(!ctx)throw new Error("canvas");
   ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
   const data=canvas.toDataURL("image/jpeg",.85);
   if(!isPlateImageValid(data))throw new Error("size");
   setImage(data);
  }catch{setError(ja?"写真を読み込めません。別の画像を選んでください":"Cannot read the photo");}
 }
 async function act(fn:()=>Promise<void>){setBusy(true);setError("");try{await fn();await refresh();}catch{setError(ja?"保存に失敗しました。空き容量を確認してください":"Could not save; check device storage");}finally{setBusy(false);}}
 return <div className="plate-settings-body">
  <div className="plate-settings-heading"><div><strong>{ja?"登録済みのお皿":"Registered plates"}</strong><p>{ja?"登録済みのお皿から標準のお皿を指定できます":"Choose the default plate from the registered plates"}</p></div><span className="plate-settings-status">{plates.length}{ja?"枚":" plates"}</span></div>
  <p className="plate-local-note">{ja?"写真はこのブラウザのIndexedDBに保存され、他の端末とは同期されません。同じブラウザを使う人には見えます。生成時のみ画像を送信します。":"Photos stay in this browser (IndexedDB), not synced between devices; shared-browser users can access them. Sent only for generation."}</p>
  {plates.length>0&&<div className="plate-gallery">{plates.map(p=><div className="plate-gallery-item" key={p.id}>
   <img src={p.image} alt={p.name}/><div className="plate-gallery-copy"><strong>{p.name}</strong><small>{p.note}</small><div className="plate-gallery-actions">
    <button type="button" disabled={busy||defaultId===p.id} onClick={()=>void act(()=>makeDefault(p.id))}>{defaultId===p.id?(ja?"デフォルト":"Default"):(ja?"この皿をデフォルトにする":"Make default")}</button>
    <button type="button" className="secondary" disabled={busy} onClick={()=>void act(()=>removePlate(p.id))}>{ja?"削除":"Delete"}</button>
   </div></div>
  </div>)}</div>}
  <div className="plate-register"><strong>{ja?"新しい皿を登録":"Register a new plate"}</strong>
   <label className="plate-note-label">{ja?"皿の名前":"Plate name"}<input maxLength={60} value={name} onChange={e=>setName(e.target.value)} placeholder={ja?"例：白い丸皿 24cm":"e.g. white round plate"}/></label>
   <label className="plate-file-label">{ja?"皿の写真":"Plate photo"}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>void choose(e.target.files?.[0]??null)}/></label>
   {image&&<img className="plate-preview" src={image} alt={ja?"登録予定の皿":"New plate preview"}/>}
   <label className="plate-note-label">{ja?"補足（任意）":"Note (optional)"}<input maxLength={PLATE_NOTE_MAX} value={note} onChange={e=>setNote(e.target.value)}/></label>
   <button type="button" disabled={busy||!name.trim()||!image} onClick={()=>void act(async()=>{await addPlate({name,image:image!,note});setImage(null);setName("");setNote("");})}>{ja?"この皿を登録":"Save plate"}</button>
  </div>
  {error&&<p role="alert" className="error">{error}</p>}
 </div>;
}
