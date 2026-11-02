// Device-local plate gallery. IndexedDB stores images without localStorage quota pressure.
// The legacy single plate is copied once without deleting its source.
import {loadPlate,isPlateImageValid,sanitizePlateNote} from "./plate-settings";
export type Plate={id:string;name:string;image:string;note:string;createdAt:number};
const DB="chef-ai-plate-gallery",STORE="plates",META="meta";
export const PLATE_LIBRARY_CHANGED="chef-ai-plate-library-changed";
function dbOpen():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{
 const req=indexedDB.open(DB,1);
 req.onupgradeneeded=()=>{const db=req.result;db.createObjectStore(STORE,{keyPath:"id"});db.createObjectStore(META);};
 req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
});}
async function withStore<T>(storeName:string,mode:IDBTransactionMode,fn:(s:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
 const db=await dbOpen();
 try{return await new Promise<T>((resolve,reject)=>{const tx=db.transaction(storeName,mode);const req=fn(tx.objectStore(storeName));req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);tx.onerror=()=>reject(tx.error);});}
 finally{db.close();}
}
async function rawList():Promise<Plate[]>{return (await withStore<Plate[]>(STORE,"readonly",s=>s.getAll())).sort((a,b)=>a.createdAt-b.createdAt);}
// Settings and detail sections mount together, so concurrent loadPlates
// calls must share one migration: otherwise two readers can both see an
// empty gallery and copy the legacy plate twice. A rejected run clears the
// lock so the next call retries instead of reusing the failure.
async function ensureMigrated():Promise<void>{
 const migrated=await withStore<boolean|undefined>(META,"readonly",s=>s.get("legacy-migrated"));
 if(migrated)return;
 const old=loadPlate();
 const plates=await rawList();
 if(old.image&&isPlateImageValid(old.image)&&!plates.length){
  await withStore(STORE,"readwrite",s=>s.put({id:crypto.randomUUID(),name:"デフォルト皿",image:old.image,note:old.note,createdAt:Date.now()} as Plate));
  const after=await rawList();
  await withStore(META,"readwrite",s=>s.put(after[0].id,"default-id"));
 }
 await withStore(META,"readwrite",s=>s.put(true,"legacy-migrated"));
}
let migrationDone:Promise<void>|null=null;
export async function loadPlates():Promise<{plates:Plate[];defaultId:string|null}>{
 if(!migrationDone)migrationDone=ensureMigrated().catch(err=>{migrationDone=null;throw err;});
 await migrationDone;
 const plates=await rawList();
 const id=await withStore<string|undefined>(META,"readonly",s=>s.get("default-id"));
 return {plates,defaultId:id&&plates.some(p=>p.id===id)?id:(plates[0]?.id??null)};
}
function notify(){window.dispatchEvent(new Event(PLATE_LIBRARY_CHANGED));}
export async function addPlate(input:{name:string;image:string;note:string}):Promise<void>{
 if(!isPlateImageValid(input.image))throw new Error("invalid_image");
 const name=input.name.trim().slice(0,60);if(!name)throw new Error("missing_name");
 const current=await loadPlates();
 const plate:Plate={id:crypto.randomUUID(),name,image:input.image,note:sanitizePlateNote(input.note),createdAt:Date.now()};
 await withStore(STORE,"readwrite",s=>s.put(plate));
 if(!current.defaultId)await withStore(META,"readwrite",s=>s.put(plate.id,"default-id"));
 notify();
}
export async function removePlate(id:string):Promise<void>{
 await withStore(STORE,"readwrite",s=>s.delete(id));
 const list=await rawList(),def=await withStore<string|undefined>(META,"readonly",s=>s.get("default-id"));
 if(def===id)await withStore(META,"readwrite",s=>s.put(list[0]?.id??"","default-id"));
 notify();
}
export async function makeDefault(id:string):Promise<void>{
 const list=await rawList();if(!list.some(p=>p.id===id))throw new Error("plate_not_found");
 await withStore(META,"readwrite",s=>s.put(id,"default-id"));notify();
}
