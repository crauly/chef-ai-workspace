"use client";
import {useRef,useState} from "react";
import type {Locale} from "./i18n";
import {clearPlate,isPlateImageValid,loadPlate,PLATE_MAX_BYTES,PLATE_NOTE_MAX,sanitizePlateNote,savePlate} from "./plate-settings";

// Default plate registration (Block 3 follow-up). Device-local only: the
// photo is kept in this browser's localStorage (max 1) and is sent to
// POST /api/dish-image solely as part of an explicit generation request.
// No server persistence, no shared access, no save-path change.
function downscale(file:File,maxBytes:number):Promise<string>{
 return new Promise((resolve,reject)=>{
  const url=URL.createObjectURL(file);
  const img=new Image();
  img.onload=()=>{
   try{
    const scale=Math.min(1,768/Math.max(img.width,img.height));
    const w=Math.max(1,Math.round(img.width*scale)),h=Math.max(1,Math.round(img.height*scale));
    const canvas=document.createElement("canvas");
    canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext("2d");
    if(!ctx)throw new Error("no_canvas");
    ctx.drawImage(img,0,0,w,h);
    URL.revokeObjectURL(url);
    const out=canvas.toDataURL("image/jpeg",0.85);
    if(!isPlateImageValid(out)||out.length*3/4>maxBytes)reject(new Error("too_large"));
    else resolve(out);
   }catch(err){URL.revokeObjectURL(url);reject(err);}
  };
  img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("unreadable"));};
  img.src=url;
 });
}
export default function PlateSettingsSection({locale}:{locale:Locale}){
 const ja=locale==="ja";
 const [image,setImage]=useState<string|null>(()=>loadPlate().image);
 const [note,setNote]=useState(()=>loadPlate().note);
 const [error,setError]=useState("");
 const [saved,setSaved]=useState(false);
 const fileRef=useRef<HTMLInputElement|null>(null);
 async function onFile(file:File|null){
  if(!file)return;
  setError("");setSaved(false);
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)){
   setError(ja?"対応形式はJPEG・PNG・WebPです":"Use JPEG, PNG, or WebP");
   return;
  }
  if(file.size<=PLATE_MAX_BYTES){
   const reader=new FileReader();
   reader.onload=()=>{
    const url=String(reader.result||"");
    if(!isPlateImageValid(url))setError(ja?"画像が大きすぎます":"Image is too large");
    else setImage(url);
   };
   reader.onerror=()=>setError(ja?"画像を読み取れませんでした":"Could not read the image");
   reader.readAsDataURL(file);
   return;
  }
  try{setImage(await downscale(file,PLATE_MAX_BYTES));}
  catch{setError(ja?"画像が大きすぎます（3MB以下にしてください）":"Image is too large (keep it under 3 MB)");}
 }
 function onSave(){
  setError("");
  try{
   savePlate({image,note:sanitizePlateNote(note)});
   setSaved(true);
  }catch(err){
   setSaved(false);
   setError(String(err)==="Error: storage_unavailable"
    ?(ja?"この端末に保存できません":"Cannot save on this device")
    :(ja?"画像が大きすぎます（3MB以下にしてください）":"Image is too large (keep it under 3 MB)"));
  }
 }
 function onDelete(){
  clearPlate();
  setImage(null);setNote("");setSaved(false);setError("");
  if(fileRef.current)fileRef.current.value="";
 }
 return <div className="plate-settings-body">
  <p className="muted">{ja?"いつも使う皿の写真を1枚登録します。この端末だけに保存され、画像生成時に参照されます。":"Register one photo of your usual plate. It stays on this device and is referenced when generating images."}</p>
  {image
   ?<img className="plate-preview" src={image} alt={ja?"登録した皿のプレビュー":"Registered plate preview"}/>
   :<p className="muted">{ja?"皿は未登録です":"No plate registered"}</p>}
  <label className="plate-file-label">{ja?"皿の写真を選ぶ":"Choose a plate photo"}
   <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>void onFile(e.target.files?.[0]??null)}/>
  </label>
  <label className="plate-note-label">{ja?`補足情報（任意・${PLATE_NOTE_MAX}文字まで）`:`Note (optional, up to ${PLATE_NOTE_MAX} chars)`}
   <input value={note} maxLength={PLATE_NOTE_MAX} placeholder={ja?"例：白い丸皿、マットな質感":"e.g. white round plate, matte texture"} onChange={e=>{setNote(e.target.value);setSaved(false);}}/>
  </label>
  {error&&<p role="alert" className="error">{error}</p>}
  {saved&&<p role="status" className="muted">{ja?"保存しました":"Saved"}</p>}
  <div className="plate-actions">
   <button type="button" disabled={!image} onClick={onSave}>{ja?"保存":"Save"}</button>
   <button type="button" className="secondary" disabled={!image&&!note} onClick={onDelete}>{ja?"削除":"Delete"}</button>
   {image&&<button type="button" className="secondary" onClick={()=>{setImage(null);setSaved(false);if(fileRef.current)fileRef.current.value="";}}>{ja?"写真を変更":"Replace photo"}</button>}
  </div>
 </div>;
}
