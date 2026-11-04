// Supabase Storage (through trusted backend) is the authoritative recipe
// illustration SSOT. The old IndexedDB cache is read-only except when a
// server upload fails, so previously generated art is never lost.
const DATABASE="chef-ai-recipe-image-cache",STORE="images";
const IMAGE=/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function openDB():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{
 const req=indexedDB.open(DATABASE,1);
 req.onupgradeneeded=()=>req.result.createObjectStore(STORE);
 req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
});}
async function access<T>(mode:IDBTransactionMode,fn:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
 const db=await openDB();
 try{return await new Promise<T>((resolve,reject)=>{
  const tx=db.transaction(STORE,mode),req=fn(tx.objectStore(STORE));
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
 });}finally{db.close();}
}
export async function getLocalDishPreview(id:string):Promise<string|null>{
 if(!UUID.test(id))return null;
 const value=await access<unknown>("readonly",s=>s.get(id));
 return typeof value==="string"&&IMAGE.test(value)?value:null;
}
export type DishImageSource="cloud"|"device"|null;
export async function loadDishImage(id:string):Promise<{image:string|null;source:DishImageSource}>{
 if(!UUID.test(id))return {image:null,source:null};
 try{
  const result=await fetch("/api/recipe-images/"+encodeURIComponent(id),{cache:"no-store"});
  if(result.ok){
   const payload:unknown=await result.json();
   const image=payload&&typeof payload==="object"?(payload as {image?:unknown}).image:null;
   if(typeof image==="string"&&IMAGE.test(image))return {image,source:"cloud"};
  }
 }catch{/* Preserve device-local images on connectivity failure. */}
 try{
  const image=await getLocalDishPreview(id);
  return {image,source:image?"device":null};
 }catch{return {image:null,source:null};}
}
export async function getDishPreview(id:string):Promise<string|null>{
 return (await loadDishImage(id)).image;
}
// Server save is authoritative. On failure preserve on this device and clearly
// report unsynchronized state; never describe a local fallback as cloud saved.
export async function storeDishPreview(id:string,image:string):Promise<boolean>{
 if(!UUID.test(id)||!IMAGE.test(image))return false;
 try{
  const res=await fetch("/api/recipe-images/"+encodeURIComponent(id),{
   method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({image}),cache:"no-store"});
  if(res.ok)return true;
 }catch{/* fall through to local retention */}
 try{await access("readwrite",s=>s.put(image,id));}catch{/* caller receives unsynced state */}
 return false;
}
