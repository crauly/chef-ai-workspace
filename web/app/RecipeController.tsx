"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {label, type Locale} from "./i18n";
import {ingredientSaveMessage,safeIngredientSaveCode} from "../ingredient-save-contract";
import MasterMatchReview,{withMasterChoice,type MasterMatch,type EditRequest} from "./MasterMatchReview";
import AIEditor,{type EditorHandle} from "./AIEditor";
import DishImageSection from "./DishImageSection";
import {getDishPreview} from "./dish-image-cache";
import {recipeGaps} from "./recipe-gaps";
import VoiceWorkspace from "./VoiceWorkspace";
import PriceBell from "./PriceBell";
import {request, startupRead, type Recipe} from "./types";
// Presentation only: retain exact Decimal strings for backend costing and persistence.
const costFormatter=new Intl.NumberFormat("ja-JP",{minimumFractionDigits:1,maximumFractionDigits:1});
function displayCostJpy(value:string|number|null|undefined):string{
 if(value==null)return "—";
 const numeric=Number(value);
 return Number.isFinite(numeric)?`¥${costFormatter.format(numeric)}`:"—";
}
const decimalText=(value:string)=>{const [whole,fraction=""]=value.split(".");const tail=fraction.replace(/0+$/,"");return (whole.replace(/^0+(?=\d)/,"")||"0")+(tail?"."+tail:"");};
type Item={id:string;title:string;revision:number;updated_at?:string};
export default function RecipeController({pageKind:initialPageKind}:{pageKind:"home"|"detail"}){
 const [pageKind,setPageKind]=useState(initialPageKind);
 const [items,setItems]=useState<Item[]>([]),[selected,setSelected]=useState<Recipe|null>(null);
 const [thumbnails,setThumbnails]=useState<Record<string,string>>({});
 useEffect(()=>{
  if(selected)return;
  let active=true;
  const ids=items.map(item=>item.id);
  setThumbnails({});
  void Promise.all(ids.map(async id=>{
   try{return [id,await getDishPreview(id)] as const;}
   catch{return [id,null] as const;}
  })).then(images=>{
   if(active)setThumbnails(Object.fromEntries(images.filter((entry):entry is readonly [string,string]=>entry[1]!==null)));
  });
  return()=>{active=false;};
 },[items,selected]);
 const [draft,setDraft]=useState(""),[rename,setRename]=useState(""),[error,setError]=useState("");
 const [busy,setBusy]=useState(false),[page,setPage]=useState(1);
 const [query,setQuery]=useState(""),[searchInput,setSearchInput]=useState("");
 const [detailCandidatesActive,setDetailCandidatesActive]=useState(false);
 const listRequest=useRef(0);
 const voiceTarget=useRef<string|null>(null);
 const voiceSearchForEdit=useRef(false);
 const editSelectionPending=useRef(false);
 // Detail pages never load the recipe list, so a voice search started there
 // must still resolve: pendingVoiceSearch lets the reload effect run once for
 // it, and searchFallback restores the displayed recipe when no single match
 // is found instead of leaving the detail blank with a hung waiter.
 const searchFallback=useRef<Recipe|null>(null),pendingVoiceSearch=useRef(false);
 const [micControl,setMicControl]=useState<import("./EditProposalDialog").MicControl|null>(null);
 const editor=useRef<EditorHandle|null>(null),reviewBoundary=useRef<(()=>number)|null>(null);
 const browseWaiter=useRef<((recipe:Recipe|null)=>void)|null>(null);
 useEffect(()=>{if(selected&&browseWaiter.current){browseWaiter.current(selected);browseWaiter.current=null;}},[selected]);
 const [actionItem,setActionItem]=useState<Item|null>(null);
 const [deleteTarget,setDeleteTarget]=useState<{id:string;title:string}|null>(null);
 const longPressTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const longPressPoint=useRef<{x:number;y:number}|null>(null);
 const longPressTriggered=useRef(false);
 function cancelLongPress(){if(longPressTimer.current!==null)clearTimeout(longPressTimer.current);longPressTimer.current=null;longPressPoint.current=null;}
 function beginLongPress(item:Item,event:React.PointerEvent){
  if(event.pointerType==="mouse"&&event.button!==0)return;
  cancelLongPress();longPressTriggered.current=false;
  longPressPoint.current={x:event.clientX,y:event.clientY};
  longPressTimer.current=setTimeout(()=>{longPressTimer.current=null;longPressTriggered.current=true;setActionItem(item);},550);
 }
 function trackLongPress(event:React.PointerEvent){
  if(longPressPoint.current&&Math.hypot(event.clientX-longPressPoint.current.x,event.clientY-longPressPoint.current.y)>12)cancelLongPress();
 }
 async function deleteRecipe(target:{id:string;title:string}){
  if(busy)return;
  setBusy(true);setError("");
  try{
   await request<{deleted:boolean}>(`/api/recipes/${encodeURIComponent(target.id)}`,{method:"DELETE"});
   setDeleteTarget(null);setActionItem(null);setEditingId(null);
   if(selected?.id===target.id)backToLibrary();
   if(items.length===1&&page>1)setPage(p=>Math.max(1,p-1));
   else await reload();
  }catch(e){setError(String(e));}
  finally{setBusy(false);}
 }
 useEffect(()=>{
  if(!actionItem&&!deleteTarget)return;
  const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!busy){setActionItem(null);setDeleteTarget(null);}};
  document.addEventListener("keydown",onKey);
  return()=>document.removeEventListener("keydown",onKey);
 },[actionItem,deleteTarget,busy]);
 const [loadingList,setLoadingList]=useState(false);
 const [waking,setWaking]=useState(false);
 const [cost,setCost]=useState<{partial:boolean;subtotal_jpy:string;line_costs:Record<string,string>;total_cost_jpy:string|null;cost_rate_pct:string|null;estimated:boolean;unresolved_line_ids:string[]}|null>(null);
 const [costError,setCostError]=useState(false);
 const [food,setFood]=useState(""),[qty,setQty]=useState(""),[unit,setUnit]=useState(""),[price,setPrice]=useState(""),[priceQty,setPriceQty]=useState("1"),[priceUnit,setPriceUnit]=useState("");
 const [units,setUnits]=useState<Array<{id:string;symbol:string;dimension:string;aliases:string[]}>>([]);
 const [unitsLoaded,setUnitsLoaded]=useState(false),[unitsFailed,setUnitsFailed]=useState(false);
 type ChangeReview={ingredients:MasterMatch[];requires_selection:boolean;materials:Recipe['materials'];purchases:{material_id:string;supplier_id:string|null;quote:{amount_jpy:{value:string};per_quantity:string;per_unit:string}}[]};
 const [changeReview,setChangeReview]=useState<{body:EditRequest;plan:ChangeReview}|null>(null);
 const [suppliersFailed,setSuppliersFailed]=useState(false);
 const [suppliers,setSuppliers]=useState<Array<{id:string;name:string}>>([]);
 useEffect(()=>{let active=true;
   void (async()=>{const rows:Array<{id:string;name:string}>=[];
    for(let page=1;;page++){
     const result=await request<{items:Array<{id:string;name:string}>}>(`/api/suppliers?page=${page}&page_size=100`);
     rows.push(...result.items);if(result.items.length<100)break;
    }
    if(active)setSuppliers(rows);
   })().catch(()=>{if(active)setSuppliersFailed(true);});
   return()=>{active=false;};
 },[]);
 useEffect(()=>{let mounted=true;
   request<{items:Array<{id:string;symbol:string;dimension:string;aliases:string[]}>}>("/api/units")
    .then(result=>{if(mounted){setUnits(result.items);setUnitsLoaded(true);}})
    .catch(()=>{if(mounted){setUnitsLoaded(false);setUnitsFailed(true);}});
   return()=>{mounted=false;};
 },[]);
 const unitChoices=(value:string)=>{const available=units.map(item=>item.symbol);
   return [...new Set(value&&!available.includes(value)?[value,...available]:available)];
 };
 // Recipe detail editing (modal) + AI consult toggle. The modal only calls
 // the existing /confirm path (saveOperations); the AI editor stays mounted
 // while collapsed so the voice edit flow keeps working.
 const [editingId,setEditingId]=useState<string|null>(null);
 const [editName,setEditName]=useState("");
 const [editQty,setEditQty]=useState(""),[editUnit,setEditUnit]=useState("");
 const [editPrice,setEditPrice]=useState(""),[editPriceQty,setEditPriceQty]=useState("1"),[editPriceUnit,setEditPriceUnit]=useState("");
 const [editSupplier,setEditSupplier]=useState("");
 const [editOffer,setEditOffer]=useState("");
 const [editOffers,setEditOffers]=useState<Array<{offer_id:string;supplier_id:string|null;supplier_name:string|null;amount_jpy:string;quantity:string;unit:string}>>([]);
 const [editOffersLoading,setEditOffersLoading]=useState(false);
 const editLookup=useRef(0);
 const [aiOpen,setAiOpen]=useState(false);
 const [voiceEditRequest,setVoiceEditRequest]=useState(0);
 // A one-time navigation hint carries the requested voice-edit mode across
 // a full page load; the next render invokes the existing guarded transition.
 useEffect(()=>{
  if(pageKind!=="detail"||!selected)return;
  const params=new URLSearchParams(window.location.search);
  const voiceEdit=params.get("voiceEdit")==="1",aiEdit=params.get("aiEdit")==="1";
  if(!voiceEdit&&!aiEdit)return;
  window.history.replaceState(null,"",window.location.pathname);
  if(voiceEdit)setVoiceEditRequest(value=>value+1);
  if(aiEdit)setAiOpen(true);
 },[pageKind,selected?.id]);
 const [sellingPriceEdit,setSellingPriceEdit]=useState("");
 const [confirmQty,setConfirmQty]=useState(false),[confirmPrice,setConfirmPrice]=useState(false);
 const detailRef=useRef<HTMLElement|null>(null);
 useEffect(()=>{
  let active=true;
  const sync=async()=>{
   const match=window.location.pathname.match(/^\/recipes\/([^/]+)\/?$/);
   if(!match){setPageKind("home");setSelected(null);return;}
   setPageKind("detail");
   try{const recipe=await request<Recipe>(`/api/recipes/${encodeURIComponent(decodeURIComponent(match[1]))}`);
    if(active&&window.location.pathname===`/recipes/${encodeURIComponent(recipe.id)}`){setSelected(recipe);setRename(recipe.title.value||"");setError("");}}
   catch(e){if(active)setError(String(e));}
  };
  void sync();window.addEventListener("popstate",sync);
  return()=>{active=false;window.removeEventListener("popstate",sync);};
 },[]);
 function showDetail(recipe:Recipe,openVoiceEdit=false,openAiEditor=false){
  // Keep the controller/capture mounted; direct loads and reloads still use
  // the real detail route, with the URL as the selected recipe identity.
  const url=`/recipes/${encodeURIComponent(recipe.id)}`;
  if(window.location.pathname!==url)window.history.pushState(null,"",url);
  setSelected(recipe);setRename(recipe.title.value||"");setPageKind("detail");setDetailCandidatesActive(false);setAiOpen(openAiEditor);
  if(openVoiceEdit)setVoiceEditRequest(value=>value+1);
 }
 function backToLibrary(){if(window.location.pathname!=="/")window.history.pushState(null,"","/");setPageKind("home");setSelected(null);setDetailCandidatesActive(false);}

 const [locale,setLocale]=useState<Locale>("ja");
 const t=(key:Parameters<typeof label>[1])=>label(locale,key);
 useEffect(()=>{const current=localStorage.getItem("chef-ui-locale");if(current==="ja"||current==="en-US"){setLocale(current);document.documentElement.lang=current;}},[]);
 function switchLocale(next:Locale){setLocale(next);localStorage.setItem("chef-ui-locale",next);document.documentElement.lang=next;}
 useEffect(()=>{let active=true;setCost(null);setCostError(false);if(selected){void request<{partial:boolean;subtotal_jpy:string;line_costs:Record<string,string>;total_cost_jpy:string|null;cost_rate_pct:string|null;estimated:boolean;unresolved_line_ids:string[]}>(`/api/recipes/${selected.id}/cost`).then(result=>{if(active){setCost(result);setCostError(false);}}).catch(()=>{if(active){setCost(null);setCostError(true);}});}return()=>{active=false;};},[selected?.id,selected?.revision]);
 const reload=useCallback(async(preserveDetailCandidates=false)=>{
   if(pageKind==="detail"&&!preserveDetailCandidates)setDetailCandidatesActive(false);
   const current=++listRequest.current;setWaking(false);setLoadingList(true);
   try{
     const result=await startupRead<{items:Item[]}>(`/api/recipes?page=${page}&page_size=20&q=${encodeURIComponent(query)}`,()=>{if(current===listRequest.current)setWaking(true);});
     if(current===listRequest.current){
       setItems(result.items);setError("");
       const fromVoice=voiceTarget.current===query;
       if(fromVoice){voiceTarget.current=null;}
       if(fromVoice&&page===1&&result.items.length===1){
         const recipe=await request<Recipe>(`/api/recipes/${result.items[0].id}`);
         if(current===listRequest.current){
           const openVoiceEdit=voiceSearchForEdit.current;
           if(pageKind==="detail")setDetailCandidatesActive(false);
           voiceSearchForEdit.current=false;editSelectionPending.current=false;
           // The selected effect resolves only after the new editor ref commits.
           showDetail(recipe,openVoiceEdit);
         }
       }
       if(fromVoice&&result.items.length!==1){
         if(pageKind==="detail")setDetailCandidatesActive(result.items.length>1);
         editSelectionPending.current=result.items.length>1&&voiceSearchForEdit.current;
         voiceSearchForEdit.current=false;
         browseWaiter.current?.(null);browseWaiter.current=null;
         if(pageKind==="detail")setSelected(searchFallback.current);
       }
     }
   }catch(e){if(current===listRequest.current){setError(String(e));const voiceFailed=voiceTarget.current===query||voiceSearchForEdit.current;if(voiceFailed){voiceTarget.current=null;voiceSearchForEdit.current=false;editSelectionPending.current=false;if(pageKind==="detail"){setSelected(searchFallback.current);setDetailCandidatesActive(false);}}browseWaiter.current?.(null);browseWaiter.current=null;}}
   finally{if(current===listRequest.current){setWaking(false);setLoadingList(false);}}
 },[page,query,pageKind]);
 useEffect(()=>{const voiceOnly=pendingVoiceSearch.current;pendingVoiceSearch.current=false;if(pageKind==="home"||voiceOnly)void reload(voiceOnly);return()=>{listRequest.current++;};},[reload,pageKind]);
 function search(name:string,fromVoice=false,openVoiceEdit=false){
   if(!fromVoice){browseWaiter.current?.(null);browseWaiter.current=null;}
   if(fromVoice)searchFallback.current=selected;
   pendingVoiceSearch.current=fromVoice;
   voiceTarget.current=fromVoice?name.trim():null;
  voiceSearchForEdit.current=fromVoice&&openVoiceEdit;
   listRequest.current++;setPage(1);setLoadingList(true);
   // Detail pages resolve a voice search in the background: blanking the
   // displayed recipe here would unmount VoiceWorkspace mid-flow, so the
   // no-match/match continuation (feedback + waiter release) never reaches
   // the user. The list is home-only; detail keeps showing its recipe.
   if(pageKind==="home"){setItems([]);setSelected(null);}
   setSearchInput(name.trim());setQuery(name.trim());
   if(page===1&&query===name.trim())void reload(fromVoice);
 }
 function loadDetailCandidatePage(nextPage:number){
  if(loadingList||nextPage<1)return;
  setItems([]);pendingVoiceSearch.current=true;setPage(nextPage);
 }
 async function create(e:React.FormEvent){e.preventDefault();if(!draft.trim())return;setBusy(true);
 try{const recipe=await request<Recipe>("/api/recipes",{method:"POST",body:JSON.stringify({title:draft.trim()})});setDraft("");if(page===1){await reload();}else{setPage(1);}showDetail(recipe);}
 catch(e){setError(String(e));}finally{setBusy(false);}}
 async function open(id:string,openAiEditor=false){
  if(busy)return;
  if(editor.current?.hasPending()){
   setError(locale==="ja"?"未保存の変更案があります。保存するか、変更案を破棄してからレシピを選択してください。":"Save or discard the pending proposal before selecting another recipe.");return;
  }
  setBusy(true);try{const recipe=await request<Recipe>(`/api/recipes/${id}`);const openVoiceEdit=editSelectionPending.current;editSelectionPending.current=false;showDetail(recipe,openVoiceEdit,openAiEditor);setError("");}catch(e){setError(String(e));}finally{setBusy(false);}
 }
 async function change(e:React.FormEvent){e.preventDefault();if(!selected||!rename.trim())return;setBusy(true);
 try{const result=await request<{recipe:Recipe}>(`/api/recipes/${selected.id}/confirm`,{method:"POST",body:JSON.stringify({base_revision:selected.revision,request_id:crypto.randomUUID(),operations:[{op:"set_title",value:rename.trim()}],save_version:true})});setSelected(result.recipe);await reload();}
 catch(e){setError(String(e));}finally{setBusy(false);}}

 function saveError(error:unknown){
  const code=safeIngredientSaveCode((error as {code?:unknown})?.code);
  if(code)return ingredientSaveMessage(code,locale==="ja");
  return locale==="ja"?"保存・照合に失敗しました。通信状態、レシピの更新競合、食材・単位・仕入条件を確認してください。入力は保持しています。":"Save or review failed. Check connection, revision conflict and master purchase terms. Inputs are retained.";
 }
 async function saveOperations(operations:Record<string,string>[],approvedBody?:EditRequest):Promise<boolean> {
   if(!selected||busy)return false;
   setError("");setBusy(true);
   try {
     const result=await request<{recipe:Recipe}>(`/api/recipes/${selected.id}/confirm`,{
       method:"POST",body:JSON.stringify(approvedBody??{base_revision:selected.revision,
         request_id:crypto.randomUUID(),operations,save_version:true})});
     setSelected(result.recipe);
     try {
       const persisted=await request<Recipe>(`/api/recipes/${selected.id}`);
       if(persisted.revision!==result.recipe.revision)throw new Error("Saved revision mismatch");
       for(const op of operations){
         const material=persisted.materials.find(m=>m.id===op.material_id);
         if(op.op==="set_material_name"&&(!material||material.material_name.value!==op.value))throw new Error("Ingredient name not persisted");
         if(op.op==="remove_material"&&material)throw new Error("Ingredient removal not persisted");
         if(op.op==="set_material_quantity"&&(!material||material.quantity.value!==op.value||material.unit!==op.unit))throw new Error("Quantity not persisted");
         if(op.op==="set_material_price"&&(!material||decimalText(material.effective_price?.amount_jpy.value??"")!==decimalText(op.price_jpy)||decimalText(String(material.effective_price?.per_quantity??""))!==decimalText(op.price_quantity)||material.effective_price?.per_unit!==op.price_unit))throw new Error("Price not persisted");
         if(op.op==="set_material_supplier"){
          const adopted=operations.some(p=>p.material_id===op.material_id&&(p.op==="set_material_price"||(p.op==="link_ingredient"&&p.price_mode==="override")));
          const matches=material&&((material.supplier_id||"")===op.supplier_id||(adopted&&!op.supplier_id&&material.supplier_name==="相場参考価格"));
          if(!matches||(!adopted&&op.offer_id&&material?.offer_id!==op.offer_id))throw new Error("Supplier or purchase condition not persisted");
         }
         if(op.op==="set_selling_price"&&persisted.selling_price_jpy.value!==op.value_jpy)throw new Error("Selling price not persisted");
       }
       setSelected(persisted);setError("");
     }catch(e){
       setError(`保存APIは成功し変更を受け付けましたが、再取得による検証に失敗しました。再度保存せず、画面を更新して結果を確認してください: ${String(e)}`);
       // The POST has committed. Returning false would let callers retry a new mutation
       // (notably add_material with fresh IDs), duplicating ingredients and costs.
       return true;
     }
     return true;
   }catch(e){setError(saveError(e));return false;}finally{setBusy(false);}
 }
 async function reviewOperations(body:EditRequest){
  if(!selected||busy)return;setBusy(true);setError("");
  try{const plan=await request<ChangeReview>(`/api/recipes/${selected.id}/confirm/review`,{method:"POST",body:JSON.stringify(body)});setChangeReview({body,plan});}
  catch(e){setError(saveError(e));}
  finally{setBusy(false);}
 }
 async function queueOperations(operations:Record<string,string>[]){
  if(!selected)return;
  await reviewOperations({base_revision:selected.revision,request_id:crypto.randomUUID(),operations,save_version:true});
 }
 async function addFood(e:React.FormEvent){e.preventDefault();
  if(!food.trim()||!qty.trim()||!unit||!unitsLoaded)return;
  if(price.trim()&&(!priceQty.trim()||!priceUnit)){setError(locale==="ja"?"価格を入力した場合は仕入数量・単位も指定してください。":"Purchase quantity and unit are required with a price.");return;}
  const material_id=crypto.randomUUID();
  await queueOperations([price.trim()?{op:"add_material",material_id,name:food.trim(),quantity:qty,unit,price_jpy:price,price_quantity:priceQty,price_unit:priceUnit}:
   {op:"add_unpriced_material",material_id,name:food.trim(),quantity:qty,unit}]);
 }
 function openEdit(materialId:string){
   const line=selected?.materials.find(m=>m.id===materialId);
   if(!line||busy)return;
   const lookup=++editLookup.current;
   setEditName(line.material_name.value||"");
   setEditQty(line.quantity.value||"");setEditUnit(line.unit||"");
   setEditSupplier(line.supplier_id||"");setEditOffer(line.offer_id||"");
   setEditOffers([]);setEditOffersLoading(Boolean(line.ingredient_id));
   if(line.ingredient_id){
     void request<{items:Array<{offer_id:string;supplier_id:string|null;supplier_name:string|null;amount_jpy:string;quantity:string;unit:string}>}>(`/api/ingredients/${encodeURIComponent(line.ingredient_id)}/offer-prices`)
       .then(result=>{if(editLookup.current===lookup)setEditOffers(result.items);})
       .catch(()=>{if(editLookup.current===lookup)setError(locale==="ja"?"購入条件の取得に失敗しました":"Failed to load purchase conditions");})
       .finally(()=>{if(editLookup.current===lookup)setEditOffersLoading(false);});
   }
   setEditPrice(line.effective_price?.amount_jpy.value||line.price_override?.amount_jpy.value||"");
   setEditPriceQty(line.effective_price?.per_quantity||line.price_override?.per_quantity||"1");
   setEditPriceUnit(line.effective_price?.per_unit||line.price_override?.per_unit||line.unit||"");
   setConfirmQty(false);setConfirmPrice(false);setEditingId(materialId);
 }
 async function submitEdit(){
   const line=selected?.materials.find(m=>m.id===editingId);
   if(!line)return;
   const operations:Record<string,string>[]=[];
   if(editName.trim()!==line.material_name.value)operations.push({op:"set_material_name",material_id:line.id,value:editName.trim()});
   if((editQty.trim()&&editQty.trim()!==line.quantity.value)||editUnit!==(line.unit||"")||(confirmQty&&line.quantity.status==="assumed"))
     operations.push({op:"set_material_quantity",material_id:line.id,value:editQty.trim()||line.quantity.value||"",unit:editUnit});
   const priceChanged=editPrice.trim()!==(line.effective_price?.amount_jpy.value||line.price_override?.amount_jpy.value||"")||editPriceQty!==(line.effective_price?.per_quantity||line.price_override?.per_quantity||"1")||editPriceUnit!==(line.effective_price?.per_unit||line.price_override?.per_unit||line.unit||"")||(confirmPrice&&line.price_override?.amount_jpy.status==="assumed");
   if(editSupplier!==(line.supplier_id||"")||editOffer!==(line.offer_id||"")||priceChanged)
    operations.push({op:"set_material_supplier",material_id:line.id,supplier_id:editSupplier,offer_id:editOffer});
   if(priceChanged&&(editPrice.trim()||editPriceQty.trim()||editPriceUnit||editSupplier===(line.supplier_id||""))){
    if(!editPrice.trim()||!editPriceQty.trim()||!editPriceUnit){setError(locale==="ja"?"仕入価格・数量・単位をすべて入力してください。":"Enter purchase price, quantity and unit.");return;}
    operations.push({op:"set_material_price",material_id:line.id,price_jpy:editPrice.trim(),price_quantity:editPriceQty,price_unit:editPriceUnit});
   }
   if(!operations.length){setEditingId(null);return;}
   await queueOperations(operations);
 }
 function browseByVoice(target:string,openVoiceEdit=false):Promise<Recipe|null>{
  browseWaiter.current?.(null);browseWaiter.current=null;
  if(!target.trim()){backToLibrary();return Promise.resolve(null);}
  return new Promise(resolve=>{browseWaiter.current=resolve;search(target,true,openVoiceEdit);});
 }
 return <main id="top" className={pageKind==="detail"?"recipe-detail-page":""}><div><header className="chef-header"><div className="toolbar"><p className="tag">CHEF AI WORKSPACE</p><PriceBell locale={locale}/><label className="language-picker"><span>Language</span><select aria-label="Display language" value={locale} onChange={e=>switchLocale(e.target.value as Locale)}><option value="ja">Japanese</option><option value="en-US">English</option></select></label></div><div className="chef-brand"><img src="/chef-ai-mark.svg" alt="" width="58" height="58"/><h1>Chef AI</h1></div>{pageKind==="home"&&<p className="muted">{t("intro")}</p>}</header>
 </div>{(pageKind==="home"||selected)&&<div><VoiceWorkspace onMicControl={setMicControl} detailOnly={pageKind==="detail"} locale={locale} selected={selected} editor={editor} reviewBoundary={reviewBoundary} onBrowse={browseByVoice} setEditTargetSelectionPending={pending=>{editSelectionPending.current=pending;}} editRequest={voiceEditRequest} onCreated={recipe=>{showDetail(recipe);setError("");void reload();}}/></div>}
 {pageKind==="detail"&&detailCandidatesActive&&<section className="workspace-section" aria-label={locale==="ja"?"レシピ検索結果":"Recipe search results"} aria-busy={loadingList}>
  <h2>{locale==="ja"?"候補からレシピを選択":"Choose a recipe"}</h2>
  {items.length===0?<p role="status">{loadingList?(locale==="ja"?"検索しています…":"Searching…"):(locale==="ja"?"このページに候補はありません。":"No recipes on this page.")}</p>:<div className="recipe-list">{items.map(item=><button key={item.id} className="recipe-list-item" disabled={busy||loadingList} onClick={()=>void open(item.id)} aria-label={locale==="ja"?`${item.title}の詳細を開く`:`View ${item.title}`}>
   <span className="recipe-list-copy"><strong>{item.title}</strong><small>{locale==="ja"?"レシピ":"Recipe"}</small></span><span className="recipe-list-chevron" aria-hidden="true">›</span>
  </button>)}</div>}
  <div className="toolbar"><button type="button" disabled={busy||loadingList||page<=1} onClick={()=>loadDetailCandidatePage(page-1)}>{t("previous")}</button><span>{t("page")} {page}</span><button type="button" disabled={busy||loadingList||items.length<20} onClick={()=>loadDetailCandidatePage(page+1)}>{t("next")}</button></div>
 </section>}
 {pageKind==="home"&&<div>
 <section className="workspace-section recipe-library-section" aria-labelledby="recipe-library-heading">
 <div className="workspace-section-head"><div><h2 id="recipe-library-heading">{locale==="ja"?"レシピ一覧":"Recipes"}</h2><p>{locale==="ja"?"保存したレシピを検索・閲覧":"Search and browse saved recipes"}</p></div></div>
 <div className="recipe-library-controls"><form onSubmit={create}><input aria-label={t("newName")} placeholder={t("newName")} value={draft} onChange={e=>setDraft(e.target.value)}/><button disabled={busy||!draft.trim()}>{t("create")}</button></form>
 <form onSubmit={e=>{e.preventDefault();search(searchInput);}}>
  <input aria-label={locale==="ja"?"レシピ名で検索":"Search recipes by name"} maxLength={200} value={searchInput} onChange={e=>setSearchInput(e.target.value)}/>
  <button type="submit" disabled={busy}>{locale==="ja"?"検索":"Search"}</button>
  {query&&<button type="button" disabled={busy} onClick={()=>search("")}>{locale==="ja"?"検索を解除":"Clear search"}</button>}
 </form></div>
 {query&&<p role="status">{locale==="ja"?"検索中の料理名":"Recipe search"}: {query}</p>}
 {waking&&<p role="status" aria-live="polite">{locale==="ja"?"サーバーを起動しています。接続を再試行しています…":"Starting the server. Retrying connection…"}</p>}
 {error&&<p role="alert" className="error">{error}</p>}
 <div id="recipes" className="recipe-list" aria-busy={loadingList}>{items.map(item=><button key={item.id} className="recipe-list-item" disabled={busy}
  onPointerDown={e=>beginLongPress(item,e)} onPointerMove={trackLongPress} onPointerUp={cancelLongPress} onPointerLeave={cancelLongPress} onPointerCancel={cancelLongPress}
  onContextMenu={e=>{e.preventDefault();cancelLongPress();longPressTriggered.current=true;setActionItem(item);}}
  onClick={()=>{if(longPressTriggered.current){longPressTriggered.current=false;return;}void open(item.id);}}
  aria-label={locale==="ja"?`${item.title}の詳細を開く`:`View ${item.title}`}>
  <span className="recipe-list-thumbnail" aria-hidden="true">{thumbnails[item.id]?<img src={thumbnails[item.id]} alt="" loading="lazy" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m5 17 4.5-4 3 2.5 2.5-2 4 3.5"/><path d="M4 21 21 3"/></svg>}</span>
  <span className="recipe-list-copy"><strong>{item.title}</strong><small>{locale==="ja"?"レシピ":"Recipe"} · Rev {item.revision}</small></span>
  <span className="recipe-list-chevron" aria-hidden="true">›</span>
 </button>)}</div>
 {items.length===0&&!error&&!loadingList&&<p className="muted">{query?(locale==="ja"?"一致するレシピがありません。":"No recipes match this name."):t("empty")}</p>}
 <div className="toolbar"><button disabled={page===1} onClick={()=>setPage(p=>p-1)}>{t("previous")}</button><span>{t("page")} {page}</span><button disabled={items.length<20} onClick={()=>setPage(p=>p+1)}>{t("next")}</button></div>
 </section>

 </div>}
 {pageKind==="detail"&&!selected&&<section className="recipe-detail" aria-label={t("detail")}>
  <div className="detail-topbar"><button type="button" className="detail-back" onClick={backToLibrary}>{locale==="ja"?"← ホーム":"← Home"}</button></div>
  {error?<p role="alert" className="error">{error}</p>:<p role="status">{locale==="ja"?"レシピを読み込んでいます…":"Loading recipe…"}</p>}
 </section>}
 {pageKind==="detail"&&selected&&<section className="recipe-detail" ref={detailRef} aria-label={t("detail")}> 
 <div className="detail-topbar"><button type="button" className="detail-back" onClick={backToLibrary}>{locale==="ja"?"← ホーム":"← Home"}</button><button type="button" className="secondary recipe-delete-action" disabled={busy} onClick={()=>setDeleteTarget({id:selected.id,title:selected.title.value||""})}>{locale==="ja"?"レシピを削除":"Delete recipe"}</button></div>
 {error&&<p role="alert" className="error">{error}</p>}
 <div className="detail-heading"><p className="detail-eyebrow">{locale==="ja"?"RECIPE DETAIL":"RECIPE DETAIL"}</p><h2>{selected.title.value||t("detail")}</h2></div>
 {recipeGaps(selected).length>0&&<details className="recipe-gap-disclosure">
  <summary title={locale==="ja"?"不足情報を確認":"View incomplete fields"}><span aria-hidden="true">⚠</span> {locale==="ja"?"未確定情報":"Incomplete details"} · {recipeGaps(selected).length}{locale==="ja"?"件":""}</summary>
  <ul>{recipeGaps(selected).map((gap,index)=><li key={index}>{gap}</li>)}</ul>
  <p>{locale==="ja"?"内容は保存されています。編集画面で後から補完できます。":"The recipe is saved. You can fill in these fields later."}</p>
 </details>}
 <DishImageSection key={selected.id} recipeId={selected.id} title={selected.title.value||""} names={selected.materials.map(m=>m.material_name.value?.trim()||selected.display_names?.[m.id]?.display?.trim()||"")} locale={locale} disabled={busy}/>
 <div className="detail-metrics" role="region" aria-label="Recipe cost summary">
  <div><span>{locale==="ja"?"販売価格":"Selling price"}</span><strong>{selected.selling_price_jpy.value===null?"—":`¥${selected.selling_price_jpy.value}`}</strong></div>
  <div><span>{locale==="ja"?"材料原価":"Food cost"}</span><strong>{cost?.total_cost_jpy!=null?displayCostJpy(cost.total_cost_jpy):cost?.partial&&Object.keys(cost.line_costs).length>0?`${displayCostJpy(cost.subtotal_jpy)} (${locale==="ja"?"部分原価":"partial"})`:"—"}</strong></div>
  <div><span>{locale==="ja"?"原価率":"Cost rate"}</span><strong>{cost?.cost_rate_pct==null?"—":`${cost.cost_rate_pct}%`}</strong></div>
 </div>
 {costError&&<p className="error" role="alert">{locale==="ja"?"原価計算を取得できませんでした。画面を再読み込みして確認してください。":"Could not load the cost calculation. Reload to retry."}</p>}
 {cost?.partial&&<div className="detail-estimate" role="status">
  <p>{locale==="ja"?`未確定の材料 ${cost.unresolved_line_ids.length}件。合計原価と原価率は全材料の価格・単位換算が確定するまで表示されません。`:`${cost.unresolved_line_ids.length} unresolved lines. Total cost and cost rate require all prices and units to be resolved.`}</p>
  <ul>{selected.materials.filter(line=>cost.unresolved_line_ids.includes(line.id)).map(line=><li key={line.id}>
   {line.material_name.value||line.id}：{!(line.effective_price?.amount_jpy.value||line.price_override?.amount_jpy.value)?(locale==="ja"?"採用価格が未設定":"No adopted price"):line.quantity.value==null?(locale==="ja"?"使用量が未設定":"No quantity"):(locale==="ja"?"単位換算を確認":"Verify unit conversion")}
  </li>)}</ul>
 </div>}

 <details className="detail-action"><summary>{locale==="ja"?"✎ 販売価格を変更":"✎ Edit selling price"}</summary>
 <form onSubmit={async e=>{e.preventDefault();if(!selected||!sellingPriceEdit.trim())return;const saved=await saveOperations([{op:"set_selling_price",value_jpy:sellingPriceEdit.trim()}]);if(saved)setSellingPriceEdit("");}}>
 <label>{locale==="ja"?"販売価格（円）":"Selling price (JPY)"}<input inputMode="decimal" value={sellingPriceEdit} onChange={e=>setSellingPriceEdit(e.target.value)} placeholder={selected.selling_price_jpy.value??""} required/></label>
 <button type="submit" disabled={busy||!sellingPriceEdit.trim()||!Number.isFinite(Number(sellingPriceEdit))||Number(sellingPriceEdit)<=0}>{t("save")}</button></form></details>
 <div className="detail-section-heading"><h3>{t("ingredients")}</h3><span>{selected.materials.length}{locale==="ja"?"品目":" items"}</span></div>{selected.materials.length===0?<p className="muted">{t("noIngredients")}</p>:<ul className="detail-ingredients">{selected.materials.map(m=>{
  const name=m.material_name.value?.trim()||selected.display_names?.[m.id]?.display?.trim()?.trim()||t("unnamed");
  const qtyMark=m.quantity.status==="assumed"?` (${t("assumed")})`:m.quantity.status==="unresolved"?` (${t("unresolved")})`:"";
  const price=m.effective_price||m.price_override;
  const priceText=price?`${locale==="ja"?"仕入単価":"Purchase"} ¥${price.amount_jpy.value} / ${price.per_quantity}${price.per_unit}${price.amount_jpy.status==="assumed"?` (${t("assumed")})`:price.amount_jpy.status==="unresolved"?` (${t("unresolved")})`:""}`:m.supplier_id?(locale==="ja"?"この仕入先・購入条件の採用価格は未設定":"No adopted price for these supplier terms"):m.price_mode==="inherit"?(locale==="ja"?"共通価格 未確定":"Shared price unresolved"):(locale==="ja"?"仕入単価 未設定":"Purchase price not set");
  return <li key={m.id} className="ingredient-row"><div className="ingredient-main"><strong>{name}</strong><div className="detail-ingredient-data"><span className="detail-ingredient-qty">{m.quantity.value??t("missing")} {m.unit??""}{qtyMark}</span><span className="ingredient-price">{priceText}</span>{m.supplier_name&&<span className="ingredient-supplier">{m.supplier_name}</span>}{cost?.line_costs?.[m.id]!=null&&<span>{locale==="ja"?"材料原価":"Line cost"} {displayCostJpy(cost.line_costs[m.id])}</span>}</div></div><button className="icon-button" disabled={busy} type="button" aria-label={locale==="ja"?`${name}を編集`:`Edit ${name}`} onClick={()=>openEdit(m.id)}>✏️</button></li>;})}</ul>}
 {editingId!==null&&!changeReview&&(()=>{
  const line=selected.materials.find(m=>m.id===editingId);
  if(!line)return null;
  const name=line.material_name.value?.trim()||selected.display_names?.[line.id]?.display?.trim()||t("unnamed");
  const qtyChanged=editQty.trim()!==line.quantity.value||editUnit!==(line.unit||"");
  const priceChanged=editPrice.trim()!==(line.effective_price?.amount_jpy.value||line.price_override?.amount_jpy.value||"")||editPriceQty!==(line.effective_price?.per_quantity||line.price_override?.per_quantity||"1")||editPriceUnit!==(line.effective_price?.per_unit||line.price_override?.per_unit||line.unit||"");
  return <div className="name-choice-overlay" onClick={()=>setEditingId(null)}>
   <section role="dialog" aria-modal="true" aria-label={locale==="ja"?`${name}を編集`:`Edit ${name}`} className="name-choice-dialog" onClick={e=>e.stopPropagation()}>
    <h4>{name}</h4>
    <p className="muted">{locale==="ja"?"現在":"Current"}: {line.quantity.value??t("missing")} {line.unit??""} ／ {(line.effective_price||line.price_override)?`¥${(line.effective_price||line.price_override)?.amount_jpy.value} / ${(line.effective_price||line.price_override)?.per_quantity}${(line.effective_price||line.price_override)?.per_unit}`:line.price_mode==="inherit"?(locale==="ja"?"共通食材から継承（単価はここでは未取得）":"Inherited from shared ingredient (price not loaded)"):(locale==="ja"?"仕入単価 未設定":"Purchase price not set")}</p>
    {(qtyChanged||priceChanged)&&<p className="edit-diff">{locale==="ja"?"変更後":"After"}: {editQty.trim()||"?"} {editUnit}{priceChanged?` ／ ¥${editPrice.trim()||"?"} / ${editPriceQty}${editPriceUnit}`:""}</p>}
    <div className="edit-modal-fields">
     <label>{locale==="ja"?"食材名":"Ingredient name"}<input value={editName} onChange={e=>setEditName(e.target.value)} disabled={busy}/></label>
     <label>{locale==="ja"?"数量":"Quantity"}<input inputMode="decimal" value={editQty} onChange={e=>setEditQty(e.target.value)} disabled={busy}/></label>
     <label>Unit<select value={editUnit} onChange={e=>setEditUnit(e.target.value)} disabled={busy}><option value="">—</option>{unitChoices(editUnit).map(symbol=><option key={symbol} value={symbol}>{symbol}</option>)}</select></label>
     <label>{locale==="ja"?"仕入先":"Supplier"}<select value={editSupplier} onChange={e=>{const id=e.target.value;setEditSupplier(id);setEditOffer("");const q=editOffers.find(q=>q.supplier_id===id);setEditPrice(q?.amount_jpy??"");setEditPriceQty(q?.quantity??"");setEditPriceUnit(q?.unit??"");}} disabled={busy}><option value="">—</option>{editSupplier&&!suppliers.some(s=>s.id===editSupplier)&&<option value={editSupplier}>{line.supplier_name??(locale==="ja"?"仕入先を取得できません":"Supplier unavailable")}</option>}{suppliers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
     {editSupplier&&<label>{locale==="ja"?"採用する購入条件":"Adopted purchase condition"}
       <select value={editOffer} onChange={e=>{const id=e.target.value;setEditOffer(id);const q=editOffers.find(q=>q.offer_id===id);if(q){setEditPrice(q.amount_jpy);setEditPriceQty(q.quantity);setEditPriceUnit(q.unit);}}} disabled={busy||editOffersLoading}>
         <option value="">{locale==="ja"?"指定しない（購入条件が複数なら原価未確定）":"Unspecified (partial cost if ambiguous)"}</option>
         {editOffers.filter(offer=>offer.supplier_id===editSupplier).map(offer=>
           <option key={offer.offer_id} value={offer.offer_id}>{offer.quantity} {offer.unit} / ¥{offer.amount_jpy} — {offer.offer_id.slice(0,8)}</option>)}
       </select>
     </label>}
     {suppliersFailed&&<p role="alert">{locale==="ja"?"仕入先一覧を取得できません。再読み込みして確認してください。":"Supplier list is unavailable. Reload to retry."}</p>}
     {editSupplier&&<p className="muted">{locale==="ja"?"仕入価格の変更は、仕入れ先・購入条件を確認して承認した後、食材マスターの採用価格へ反映します。":"Review and approve supplier purchase terms to update the adopted master price."}</p>}
     <label>{locale==="ja"?"仕入単価（円）":"Price (JPY)"}<input inputMode="decimal" value={editPrice} onChange={e=>setEditPrice(e.target.value)} disabled={busy||!unitsLoaded}/></label>
     <label>{locale==="ja"?"単価の基準数量":"Price per quantity"}<input inputMode="decimal" value={editPriceQty} onChange={e=>setEditPriceQty(e.target.value)} disabled={busy||!unitsLoaded}/></label>
     <label>Price unit<select value={editPriceUnit} onChange={e=>setEditPriceUnit(e.target.value)} disabled={busy||!unitsLoaded}><option value="">—</option>{unitChoices(editPriceUnit).map(symbol=><option key={symbol} value={symbol}>{symbol}</option>)}</select></label>
     {line.quantity.status==="assumed"&&<label><input type="checkbox" checked={confirmQty} onChange={e=>setConfirmQty(e.target.checked)}/> {locale==="ja"?"現在の数量を明示確定":"Confirm current quantity"}</label>}
     {line.price_override?.amount_jpy.status==="assumed"&&<label><input type="checkbox" checked={confirmPrice} onChange={e=>setConfirmPrice(e.target.checked)}/> {locale==="ja"?"現在の仕入価格を明示確定":"Confirm current price"}</label>}
    </div>
    {error&&<p role="alert" className="error">{error}</p>}
    {busy&&<p role="status">{locale==="ja"?"保存・再取得を確認中…":"Saving and verifying…"}</p>}
    <div className="actions"><button type="button" disabled={busy||!editName.trim()} onClick={()=>void submitEdit()}>{t("save")}</button>
    <button type="button" disabled={busy} onClick={()=>{if(window.confirm(locale==="ja"?"この食材をレシピから削除しますか？":"Remove this ingredient from the recipe?"))void saveOperations([{op:"remove_material",material_id:line.id}]).then(ok=>{if(ok)setEditingId(null);});}}>{locale==="ja"?"食材を削除":"Remove ingredient"}</button>
    <button className="secondary" type="button" disabled={busy} onClick={()=>setEditingId(null)}>{t("close")}</button></div>
   </section>
  </div>;})()}
 <details className="detail-action"><summary>{locale==="ja"?"＋ 食材を追加":"＋ Add ingredient"}</summary><form onSubmit={addFood} className="material-form">
 <fieldset><legend>{locale==="ja"?"食材":"Ingredient"}</legend>
 <input aria-label={locale==="ja"?"食材名":"Ingredient name"} placeholder={locale==="ja"?"食材名（例：片栗粉）":"Ingredient name"} value={food} onChange={e=>setFood(e.target.value)} required/>
 </fieldset>
 <fieldset><legend>{locale==="ja"?"分量":"Quantity"}</legend>
 <input aria-label={locale==="ja"?"数量":"Quantity"} placeholder={locale==="ja"?"数量":"Quantity"} inputMode="decimal" value={qty} onChange={e=>setQty(e.target.value)} required/>
 <select aria-label="Unit" value={unit} onChange={e=>setUnit(e.target.value)}><option value="">—</option>{unitChoices(unit).map(symbol=><option key={symbol} value={symbol}>{symbol}</option>)}</select>
 </fieldset>
 <fieldset><legend>{locale==="ja"?"仕入単価":"Unit price"}</legend>
 <input aria-label={locale==="ja"?"仕入単価（円）":"Price (JPY)"} placeholder={locale==="ja"?"仕入単価 ¥":"Price ¥"} inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)}/>
 <input aria-label={locale==="ja"?"単価の基準数量":"Price per quantity"} placeholder="1" inputMode="decimal" value={priceQty} onChange={e=>setPriceQty(e.target.value)}/>
 <select aria-label="Price unit" value={priceUnit} onChange={e=>setPriceUnit(e.target.value)}><option value="">—</option>{unitChoices(priceUnit).map(symbol=><option key={symbol} value={symbol}>{symbol}</option>)}</select>
 </fieldset>
 {!unitsLoaded&&<p role="status">{unitsFailed?(locale==="ja"?"単位マスターの取得に失敗しました。画面を再読み込みして再試行してください。":"Unit master failed to load. Reload to retry."):(locale==="ja"?"単位マスターを取得中です。":"Loading unit master…")}</p>}
 <button disabled={busy||!food.trim()||!qty.trim()||!unitsLoaded||!unit||(Boolean(price.trim())&&(!priceQty.trim()||!priceUnit))}>{locale==="ja"?"食材を追加":"Add ingredient"}</button>
 </form></details>
 {cost?.estimated&&<p className="detail-estimate">{locale==="ja"?"原価に推定値が含まれます":"Cost includes estimates"}</p>}
 <details className="detail-action"><summary>{locale==="ja"?"✎ 料理名を変更":"✎ Rename recipe"}</summary><form onSubmit={change}><input aria-label={t("rename")} value={rename} onChange={e=>setRename(e.target.value)}/><button disabled={busy||!rename.trim()}>{t("save")}</button></form></details>
 <button type="button" disabled={busy} className="detail-ai-button" onClick={()=>setVoiceEditRequest(n=>n+1)}>{locale==="ja"?"🎙 音声でレシピを修正":"🎙 Edit recipe by voice"}</button>
 <p className="muted">{locale==="ja"?"編集モードへ切り替わります。マイクをオンにして変更内容を話してください。変更案を確認・承認してから保存します。":"Edit mode opens automatically. Enable the microphone and describe changes. Review and approve before saving."}</p>
 <button type="button" disabled={busy} aria-expanded={aiOpen} onClick={()=>setAiOpen(v=>!v)} className="detail-ai-button">{locale==="ja"?"◇ AIに変更相談":"◇ Ask AI to edit"}</button>
 <div hidden={!aiOpen}><AIEditor micControl={micControl} key={selected.id} recipe={selected} locale={locale} control={editor} markReview={()=>reviewBoundary.current?.()??-1} onBusy={b=>{setBusy(b);if(b)setAiOpen(true);}} onSaved={recipe=>{setSelected(recipe);setRename(recipe.title.value||"");void reload();}} /></div>
 </section>}
 {changeReview&&<div className="name-choice-overlay"><section role="dialog" aria-modal="true" aria-label={locale==="ja"?"レシピと食材マスターの保存確認":"Confirm recipe and master changes"} className="name-choice-dialog">
  <h3>{locale==="ja"?"レシピと食材マスターの保存確認":"Confirm recipe and master changes"}</h3>
  <MasterMatchReview items={changeReview.plan.ingredients} ja={locale==="ja"} disabled={busy} onChoose={(m,c,spec)=>void reviewOperations(withMasterChoice(changeReview.body,m,c,spec))}/>
  <ul>{changeReview.plan.materials.map(m=><li key={m.id}>{m.material_name.value}：{m.quantity.value??"—"} {m.unit}</li>)}</ul>
  <ul>{changeReview.plan.purchases?.map(p=><li key={p.material_id}>{suppliers.find(s=>s.id===p.supplier_id)?.name??(p.supplier_id?(selected?.materials.find(m=>m.id===p.material_id&&m.supplier_id===p.supplier_id)?.supplier_name??(locale==="ja"?"仕入先を確認できません":"Supplier unavailable")):(locale==="ja"?"相場参考価格":"Market reference"))}：¥{p.quote.amount_jpy.value} / {p.quote.per_quantity} {p.quote.per_unit}</li>)}</ul>
  <p>{locale==="ja"?"仕入価格の採用は同じ食材・仕入れ先・購入条件を使うレシピの現在原価にも反映されます。":"Adoption updates current costs for recipes using the same ingredient and purchase terms."}</p>
  {error&&<p role="alert">{error}</p>}
  <button disabled={busy||changeReview.plan.requires_selection} onClick={()=>void saveOperations(changeReview.body.operations,changeReview.body).then(ok=>{if(ok){setChangeReview(null);setEditingId(null);setFood("");setQty("");setPrice("");}})}>{locale==="ja"?"承認して保存":"Approve and save"}</button>
  <button disabled={busy} onClick={()=>setChangeReview(null)}>{locale==="ja"?"戻る":"Back"}</button>
 </section></div>}
 {actionItem&&<div className="name-choice-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setActionItem(null);}}>
   <section role="dialog" aria-modal="true" aria-label={locale==="ja"?"レシピの操作":"Recipe actions"} className="name-choice-dialog recipe-action-dialog">
    <h3>{actionItem.title}</h3>
    <p className="muted">{locale==="ja"?"操作を選択してください。":"Choose an action."}</p>
    <div className="recipe-action-options">
     <button type="button" disabled={busy} onClick={()=>{const id=actionItem.id;setActionItem(null);void open(id,true);}}>{locale==="ja"?"編集":"Edit"}</button>
     <button type="button" disabled={busy} className="recipe-delete-action" onClick={()=>{setDeleteTarget({id:actionItem.id,title:actionItem.title});setActionItem(null);}}>{locale==="ja"?"削除":"Delete"}</button>
     <button type="button" className="secondary" onClick={()=>setActionItem(null)}>{locale==="ja"?"キャンセル":"Cancel"}</button>
    </div>
   </section>
 </div>}
 {deleteTarget&&<div className="name-choice-overlay" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setDeleteTarget(null);}}>
   <section role="dialog" aria-modal="true" aria-label={locale==="ja"?"レシピ削除の確認":"Confirm recipe deletion"} className="name-choice-dialog recipe-action-dialog">
    <h3>{locale==="ja"?"レシピを削除":"Delete recipe"}</h3>
    <p>{locale==="ja"?`「${deleteTarget.title}」を削除しますか？この操作は取り消せません。`:`Permanently delete "${deleteTarget.title}"? This cannot be undone.`}</p>
    {error&&<p role="alert" className="error">{error}</p>}
    <div className="recipe-action-options">
     <button type="button" disabled={busy} className="recipe-delete-action" onClick={()=>void deleteRecipe(deleteTarget)}>{locale==="ja"?"削除する":"Delete permanently"}</button>
     <button type="button" disabled={busy} className="secondary" onClick={()=>setDeleteTarget(null)}>{locale==="ja"?"キャンセル":"Cancel"}</button>
    </div>
   </section>
 </div>}
 </main>;
}
