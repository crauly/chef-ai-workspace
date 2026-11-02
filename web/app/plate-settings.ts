// Default plate (default dish) settings — Block 3 follow-up.
// Device-local single-plate store: at most one photo plus an optional note
// (color/shape/texture). Registration never touches a server: the bytes stay
// in this browser's localStorage and leave it only as the `image` part of an
// explicit POST /api/dish-image call, which forwards them to Meta's
// OpenAI-compatible images/edits endpoint (live-verified 2026-11-02 with
// muse-image-1.0; generations-only docs never promised it, so the probe, not
// the doc, is the basis). No new server persistence, no schema change, and no
// cross-user access: owner isolation is inherent because nothing is uploaded
// at registration time. This module is pure (no browser globals at import
// time) so the API route can reuse the same validators.
export type PlateSettings={image:string|null;note:string};
export const PLATE_STORAGE_KEY="chef-ai-plate-v1";
export const PLATE_MAX_BYTES=3*1024*1024;
export const PLATE_NOTE_MAX=200;
const DATA_URL_RE=/^data:(image\/(?:jpeg|png|webp));base64,/;
export function parsePlateDataUrl(image:unknown):{mime:string;b64:string}|null{
 if(typeof image!=="string")return null;
 const match=DATA_URL_RE.exec(image);
 if(!match)return null;
 const b64=image.slice(match[0].length);
 if(!b64||b64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(b64))return null;
 return {mime:match[1],b64};
}
export function plateByteLength(b64:string):number{
 return Math.floor(b64.length*3/4);
}
export function isPlateImageValid(image:unknown):boolean{
 const parsed=parsePlateDataUrl(image);
 return !!parsed&&plateByteLength(parsed.b64)>0&&plateByteLength(parsed.b64)<=PLATE_MAX_BYTES;
}
export function sanitizePlateNote(note:unknown):string{
 return (typeof note==="string"?note:"").trim().slice(0,PLATE_NOTE_MAX);
}
export type PlateStorage=Pick<Storage,"getItem"|"setItem"|"removeItem">;
function defaultStorage():PlateStorage|null{
 try{
  if(typeof localStorage!=="undefined")return localStorage;
 }catch{/* private mode / SSR */}
 return null;
}
export function loadPlate(storage?:PlateStorage|null):PlateSettings{
 const store=storage===undefined?defaultStorage():storage;
 if(!store)return {image:null,note:""};
 try{
  const raw=store.getItem(PLATE_STORAGE_KEY);
  if(!raw)return {image:null,note:""};
  const parsed:unknown=JSON.parse(raw);
  const image=parsed&&typeof parsed==="object"?(parsed as {image?:unknown}).image:null;
  const note=parsed&&typeof parsed==="object"?(parsed as {note?:unknown}).note:"";
  return {image:isPlateImageValid(image)?image as string:null,note:sanitizePlateNote(note)};
 }catch{return {image:null,note:""};}
}
export function savePlate(settings:PlateSettings,storage?:PlateStorage|null):void{
 const store=storage===undefined?defaultStorage():storage;
 if(!store)throw new Error("storage_unavailable");
 const image=settings.image;
 if(image!==null&&!isPlateImageValid(image))throw new Error("invalid_image");
 store.setItem(PLATE_STORAGE_KEY,JSON.stringify({image,note:sanitizePlateNote(settings.note)}));
 try{
  if(typeof window!=="undefined")window.dispatchEvent(new Event("chef-ai-plate-changed"));
 }catch{/* event is best-effort */}
}
export function clearPlate(storage?:PlateStorage|null):void{
 const store=storage===undefined?defaultStorage():storage;
 if(!store)return;
 store.removeItem(PLATE_STORAGE_KEY);
 try{
  if(typeof window!=="undefined")window.dispatchEvent(new Event("chef-ai-plate-changed"));
 }catch{/* event is best-effort */}
}
export const PLATE_CHANGED_EVENT="chef-ai-plate-changed";
