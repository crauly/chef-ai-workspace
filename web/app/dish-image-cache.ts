// Optional device-local generated-dish image cache. Not a recipe mutation.
// A generated data URL is retained across reloads; temporary upstream URLs
// are intentionally not cached because they can expire.
const DATABASE="chef-ai-recipe-image-cache",STORE="images";
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
export async function getDishPreview(id:string):Promise<string|null>{
 if(!id)return null;
 const value=await access<unknown>("readonly",s=>s.get(id));
 return typeof value==="string"&&/^data:image\/(?:png|jpeg|webp);base64,/.test(value)?value:null;
}
export async function storeDishPreview(id:string,image:string):Promise<boolean>{
 if(!id||!/^data:image\/(?:png|jpeg|webp);base64,/.test(image))return false;
 await access("readwrite",s=>s.put(image,id));
 return true;
}
