// Device-local working recipe only: never a backend recipe or Human Gate approval.
export type WorkingDraftSnapshot={draft:{title:string;materials:unknown[];selling_price_jpy:string;notes:string[];missing:string[];[key:string]:unknown};turns:string[];image:string|null};
const DB="chef-ai-working-draft",STORE="draft",KEY="current";
function open():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function loadWorkingDraft():Promise<WorkingDraftSnapshot|null>{
 const db=await open();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,"readonly"),r=tx.objectStore(STORE).get(KEY);r.onsuccess=()=>{const v:unknown=r.result;if(v&&typeof v==="object"&&"draft" in v&&"turns" in v&&Array.isArray(v.turns))resolve(v as WorkingDraftSnapshot);else resolve(null);};r.onerror=()=>reject(r.error);});}finally{db.close();}
}
// All writes are dispatched in UI order; only transaction completion resolves.
let tail:Promise<void>=Promise.resolve();
export function saveWorkingDraft(snapshot:WorkingDraftSnapshot|null):Promise<void>{
 const operation=tail.catch(()=>{}).then(async()=>{
  const db=await open();try{await new Promise<void>((resolve,reject)=>{
   const tx=db.transaction(STORE,"readwrite");if(snapshot)tx.objectStore(STORE).put(snapshot,KEY);else tx.objectStore(STORE).delete(KEY);
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
 });
 tail=operation;return operation;
}
