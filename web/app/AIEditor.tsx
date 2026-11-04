"use client";
import {useEffect,useImperativeHandle,useRef,useState,type Ref} from "react";
import MasterMatchReview,{withMasterChoice,type MasterMatch,type EditRequest} from "./MasterMatchReview";
import {label, type Locale} from "./i18n";
import {useVoiceProcessingStatus,type VoiceStatusKey} from "./VoiceProcessingStatus";
import EditProposalDialog,{type MicControl} from "./EditProposalDialog";
import VoiceInput from "./VoiceInput";
import ResearchEvidence from "./ResearchEvidence";
import {isPriceResearchRequest,combineResearch,type RecipeResearch,type ResearchResult} from "../recipe-price-research";
import {request, type AIProposal, type Operation, type Recipe} from "./types";
import {editVoiceCommand} from "./voice-commands";
import type {VoiceCaptureMeta} from "./useVoiceCapture";

type Review = {proposal: AIProposal; instruction: string; requestId: string;modal:boolean;masters?:{ingredients:MasterMatch[];requires_selection:boolean};ledger?:EditRequest["ledger"]};
export function describe(recipe: Recipe, operations: Operation[], locale: Locale) {
  const ja = locale === "ja";
  const lines = new Map(recipe.materials.map(line => [line.id, {...line}]));
  let title = recipe.title.value, selling = recipe.selling_price_jpy.value;
  const changes: string[] = [];
  const addedIds=new Set<string>();
  for (const op of operations) {
    if (!op || Object.values(op).some(value => typeof value !== "string")) return null;
    const line = lines.get(op.material_id);
    switch (op.op) {
      case "set_title": changes.push(`${ja ? "料理名" : "Recipe name"}: ${title ?? "—"} → ${op.value}`); title = op.value; break;
      case "set_selling_price": changes.push(`${ja ? "売価" : "Selling price"}: ¥${selling ?? "—"} → ¥${op.value_jpy}`); selling = op.value_jpy; break;
      case "set_material_quantity":
        if (!line) return null;
        changes.push(`${line.material_name.value || label(locale, "unnamed")}: ${line.quantity.value ?? "—"} ${line.unit ?? ""} → ${op.value} ${op.unit}`);
        lines.set(line.id, {...line, quantity: {value: op.value, status: "assumed"}, unit: op.unit}); break;
      case "set_material_price": {
        if (!line) return null;
        const p = line.effective_price??line.price_override;
        const before = line.price_mode === "inherit" && !p ? (ja ? "共通食材の単価" : "Shared ingredient price") : p ? `¥${p.amount_jpy.value ?? "—"} / ${p.per_quantity} ${p.per_unit}` : "—";
        changes.push(`${line.material_name.value || label(locale, "unnamed")} · ${line.supplier_name??(ja?"相場参考価格":"Market reference")} · ${ja ? "単価" : "Price"}: ${before} → ¥${op.price_jpy} / ${op.price_quantity} ${op.price_unit}`);
        const quote={amount_jpy:{value:op.price_jpy,status:"assumed"},per_quantity:op.price_quantity,per_unit:op.price_unit};
        lines.set(line.id, {...line, price_mode: "override", price_override:quote,effective_price:quote}); break;
      }
      case "set_material_name":
        if(!line)return null;
        changes.push(`${ja?"食材名":"Ingredient"}: ${line.material_name.value??"—"} → ${op.value}`);
        lines.set(line.id,{...line,material_name:{value:op.value,status:"assumed"}});break;
      case "remove_material":
        if(!line)return null;
        changes.push(`${ja?"削除":"Remove"}: ${line.material_name.value??label(locale,"unnamed")} (${line.quantity.value??"—"} ${line.unit??""})`);
        lines.delete(line.id);break;
      case "link_ingredient":
        if(!line)return null;
        changes.push(`${line.material_name.value} · ${ja?"食材マスターを選択":"Select ingredient master"}`);break;
      case "set_material_supplier":
        if(!line)return null;
        changes.push(`${line.material_name.value} · ${ja?"仕入条件を変更":"Change supplier terms"}`);break;
      case "add_unpriced_material":
        if(lines.has(op.material_id))return null;
        addedIds.add(op.material_id);changes.push(`${ja?"食材を追加":"Add ingredient"}: ${op.name} ${op.quantity??"—"} ${op.unit??""} (${ja?"価格未確定":"unpriced"})`);
        lines.set(op.material_id,{id:op.material_id,material_name:{value:op.name,status:"assumed"},quantity:{value:op.quantity??null,status:op.quantity?"assumed":"unresolved"},unit:op.unit??null,price_mode:"inherit"});break;
      case "add_material":
        if (lines.has(op.material_id)) return null;
        addedIds.add(op.material_id);
        changes.push(`${ja ? "食材を追加" : "Add ingredient"}: ${op.name}, ${op.quantity} ${op.unit}, ¥${op.price_jpy} / ${op.price_quantity} ${op.price_unit}`);
        lines.set(op.material_id, {id: op.material_id, material_name: {value: op.name, status: "assumed"}, quantity: {value: op.quantity, status: "assumed"}, unit: op.unit, price_mode: "override", price_override: {amount_jpy: {value: op.price_jpy, status: "assumed"}, per_quantity: op.price_quantity, per_unit: op.price_unit}}); break;
      default: return null;
    }
  }
  return {changes,materials:Array.from(lines.values()),addedIds};
}

export type EditorHandle={submit:(text:string,meta?:VoiceCaptureMeta)=>Promise<void>;hasPending:()=>boolean;invalidate:()=>void;isBusy:()=>boolean};
export default function AIEditor({recipe, locale, onSaved, onBusy,control,markReview,micControl}: {
  recipe: Recipe; locale: Locale; onSaved: (recipe: Recipe) => void; onBusy: (busy: boolean) => void;
  micControl?:MicControl|null;
  control?:Ref<EditorHandle>;markReview?:()=>number;
}) {
  const t = (key: Parameters<typeof label>[1]) => label(locale, key);
  const [instruction, setInstruction] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [reviewOpen,setReviewOpen]=useState(false);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [processing,setProcessing]=useState<VoiceStatusKey|null>(null);
  useVoiceProcessingStatus(locale,processing?[{key:processing}]:[]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [researchResults,setResearchResults]=useState<ResearchResult[]>([]);
  const [heard, setHeard] = useState(""), [preferred, setPreferred] = useState("");
  const lock = useRef(false);
  const reviewRef=useRef<Review|null>(null),reviewEpoch=useRef(-1),generation=useRef(0),alive=useRef(true);
  const voiceHistory=useRef<string[]>([]),latestRecipe=useRef(recipe);latestRecipe.current=recipe;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  function invalidate(){setReviewOpen(false);reviewEpoch.current=-1;generation.current++;reviewRef.current=null;setReview(null);setApproved(false);setResearchResults([]);}
  useEffect(()=>{invalidate();voiceHistory.current=[];},[recipe.id,recipe.revision]);
  useImperativeHandle(control,()=>({submit:voiceSubmit,hasPending:()=>Boolean(reviewRef.current||voiceHistory.current.length||instruction.trim()),invalidate,isBusy:()=>lock.current}));
  const preview = review ? describe(recipe, review.proposal.operations, locale) : null;
  const changes=preview?.changes;
  const valid = review && review.proposal.recipe_id === recipe.id && review.proposal.base_revision === recipe.revision && preview !== null;
  async function refreshAfterConflict() {
    invalidate();
    const latest = await request<Recipe>(`/api/recipes/${recipe.id}`);
    onSaved(latest);
    setError(locale === "ja" ? "最新のレシピを取得しました。変更案を作り直してください。" : "Recipe refreshed. Request a new proposal.");
  }
  function working(value: boolean) {lock.current = value; setBusy(value); onBusy(value);}
  function report(e: unknown, uncertainSave = false) {
    const status = e instanceof Error ? e.message : "";
    if(status==="Too many operations; split the edits"){setError(locale==="ja"?"1回の承認は40操作までです。調査対象と他の変更を分けてください。":"Approval supports 40 operations. Split the research and other edits.");return;}
    if(status==="unsupported combined edit"){setError(locale==="ja"?"食材の追加などは価格調査と分けて指示してください。保存していません。":"Request ingredient additions separately from price research. Nothing was saved.");return;}
    setError(t(status === "409" ? "staleProposal" : !uncertainSave && (status === "502" || status === "503") ? "aiUnavailable" : "failure"));
  }
  async function propose(e: React.FormEvent) {
    e.preventDefault();voiceHistory.current=[];await proposeText(instruction);
  }
  async function proposeText(text:string,showConfirmation=false) {
    if (lock.current || !text.trim()) return;
    const token=++generation.current,base=latestRecipe.current;
    working(true); setError(""); setNotice(""); setReview(null); setApproved(false);setResearchResults([]);
    reviewRef.current=null;
    try {
      // A price research instruction needs real provenance, not an AI-invented
      // numerical mutation. Scope is resolved dynamically against live rows.
      const researchRequested=isPriceResearchRequest(text);
      let researchNotice="";
      let proposal:AIProposal;
      if(researchRequested){
        setProcessing("price");
        const result=await request<RecipeResearch>("/api/recipe-price-research",{
          method:"POST",body:JSON.stringify({instruction:text,recipe_id:base.id,base_revision:base.revision})});
        if(!alive.current||token!==generation.current||latestRecipe.current.id!==base.id||latestRecipe.current.revision!==base.revision)return;
        setProcessing(null);
        setResearchResults(result.results);
        if((result.ambiguous||!result.indices.length)&&!result.edit_instruction){
          setNotice(locale==="ja"?"調査対象を特定できませんでした。食材名・範囲、または「すべて」を指定してください。":"Could not determine the target rows. Name ingredients, a range, or all.");
          return;
        }
        const skipped=result.results.filter(item=>item.status!=="candidate");
        researchNotice=(locale==="ja"?`調査対象${result.indices.length}品・仮単価候補${result.operations.length}品。`:`Researched ${result.indices.length} ingredients; ${result.operations.length} provisional candidates.`)+
          (skipped.length?(locale==="ja"?" 適用候補なし："+skipped.map(item=>item.name).join("、"):" No directly applicable quote: "+skipped.map(item=>item.name).join(", ")):"");
        let edit:AIProposal|undefined;
        if(result.edit_instruction?.trim()){
          setProcessing("propose");
          edit=await request<AIProposal>(`/api/recipes/${base.id}/propose`,{
            method:"POST",body:JSON.stringify({instruction:result.edit_instruction})});
        }
        proposal=combineResearch(base,result,edit);
        if(!proposal.operations.length){setNotice(researchNotice);return;}
      }else{
        setProcessing("propose");
        proposal=await request<AIProposal>(`/api/recipes/${base.id}/propose`, {method: "POST", body: JSON.stringify({instruction:text})});
      }
      if(!alive.current||token!==generation.current||latestRecipe.current.id!==base.id||latestRecipe.current.revision!==base.revision)return;
      if (proposal.requires_confirmation !== true || !Array.isArray(proposal.operations) || proposal.operations.length > 40) throw new Error("invalid");
      if (proposal.recipe_id !== base.id) throw new Error("invalid");
      if (proposal.base_revision !== base.revision) {await refreshAfterConflict(); return;}
      if (describe(base, proposal.operations, locale) === null) throw new Error("invalid");
      const requestId=crypto.randomUUID();
      const masters=await request<NonNullable<Review['masters']>>(`/api/recipes/${base.id}/confirm/review`,{method:'POST',body:JSON.stringify({base_revision:proposal.base_revision,request_id:requestId,operations:proposal.operations,save_version:true})});
      if(!alive.current||token!==generation.current||latestRecipe.current.revision!==base.revision)return;
      const next:Review={proposal,instruction:text,requestId,modal:showConfirmation,masters};reviewRef.current=next;setReview(next);setReviewOpen(showConfirmation);
      reviewEpoch.current=showConfirmation?-1:markReview?.()??-1;
      setNotice(researchNotice+" "+(locale==="ja"?"変更案を表示しました。差分を確認後、もう一度「保存してください」と明示するか、確認チェックと保存ボタンを操作してください。":"Review the proposal, then explicitly request saving or use the approval controls."));
    } catch (e) {
      report(e);
      if(e instanceof Error&&e.message==="409"&&alive.current&&token===generation.current&&latestRecipe.current.id===base.id){
        try{await refreshAfterConflict();}catch{setError(t("failure"));}
      }
    } finally {setProcessing(null);working(false);}
  }
  async function chooseMaster(match:MasterMatch,choice:string,spec:string){
   const current=reviewRef.current;if(!current||lock.current)return;
   working(true);setError("");setApproved(false);reviewEpoch.current=-1;
   try{
    const body=withMasterChoice({base_revision:current.proposal.base_revision,request_id:current.requestId,operations:current.proposal.operations,save_version:true,ledger:current.ledger},match,choice,spec);
    const masters=await request<NonNullable<Review['masters']>>(`/api/recipes/${recipe.id}/confirm/review`,{method:'POST',body:JSON.stringify(body)});
    if(reviewRef.current!==current)return;
    const next={...current,masters,ledger:body.ledger,proposal:{...current.proposal,operations:body.operations}};
    reviewRef.current=next;setReview(next);reviewEpoch.current=markReview?.()??-1;
   }catch(e){report(e);}finally{working(false);}
  }
  async function confirm(voiceApproval?:Review) {
    const current=voiceApproval??review;
    if (lock.current || !current || current.masters?.requires_selection || current!==reviewRef.current || (!voiceApproval&&!approved) ||
      current.proposal.recipe_id!==recipe.id||current.proposal.base_revision!==recipe.revision||!describe(recipe,current.proposal.operations,locale)?.changes.length) return;
    working(true); setError("");setProcessing("save");
    try {
      const result = await request<{recipe: Recipe}>(`/api/recipes/${recipe.id}/confirm`, {method: "POST", body: JSON.stringify({base_revision: current.proposal.base_revision, request_id: current.requestId, operations: current.proposal.operations, save_version: true,ledger:current.ledger??[]})});
      latestRecipe.current=result.recipe;invalidate();voiceHistory.current=[];setInstruction("");setNotice(t("savedRecalculated")); onSaved(result.recipe);
    } catch (e) {
      report(e, true);
      if (e instanceof Error && e.message === "409") {
        try {await refreshAfterConflict();} catch {setError(t("failure"));}
      }
      // Keep the same request ID on uncertain network outcomes: retry cannot apply twice.
    } finally {setProcessing(null);working(false);}
  }
  async function voiceSubmit(text:string,meta?:VoiceCaptureMeta){
    const command=editVoiceCommand(text);
    if(command==="cancel"||command==="hold"){
      invalidate();if(command==="cancel"){voiceHistory.current=[];setInstruction("");}
      setNotice(locale==="ja"?"保存していません。変更案の承認を解除しました。":"Not saved. Proposal approval was cleared.");return;
    }
    if(command==="review"||command==="save"){
      const current=reviewRef.current;
      if(!current){setNotice(locale==="ja"?"保存できる変更案がありません。変更内容を話してください。":"No proposal to save. Describe the desired changes.");return;}
      if((reviewOpen||!current.modal)&&command==="save"&&(!meta||meta.reviewEpoch===reviewEpoch.current))await confirm(current);
      else {setReviewOpen(true);reviewEpoch.current=markReview?.()??-1;setNotice(locale==="ja"?"差分を確認してください。その後、もう一度「保存してください」と明示してください。":"Review the changes, then explicitly request saving again.");}
      return;
    }
    const next=[...voiceHistory.current,text];
    if(next.join("\n").length>4000){setError(locale==="ja"?"変更指示が長すぎます。変更案を確認・保存するか、破棄してください。":"Too many change instructions. Review and save or discard the existing proposal.");return;}
    voiceHistory.current=next;setInstruction(next.join("\n"));await proposeText(next.join("\n"),true);
  }
  async function record(e: React.FormEvent) {
    e.preventDefault(); if (lock.current || !heard.trim() || !preferred.trim() || heard.trim() === preferred.trim()) return;
    working(true); setError(""); setNotice("");
    try {
      await request(`/api/recipes/${recipe.id}/corrections`, {method: "POST", body: JSON.stringify({heard: heard.trim(), preferred: preferred.trim()})});
      setNotice(t("correctionSaved")); setHeard(""); setPreferred("");
    } catch (e) {report(e, true);} finally {working(false);}
  }
  const proposalContent = review && <section className="proposal" aria-label={t("proposalDiff")}>
      <h3>{t("proposalDiff")}</h3><p className="muted">{t("originalInstruction")}: {review.instruction}</p>
      {review.proposal.provider && <p className="tag">{review.proposal.provider.name === "meta_responses" ? "Meta Muse" : (locale === "ja" ? "代替モデル" : "Substitute model")} · {review.proposal.provider.model}</p>}
      {!valid ? <p role="alert">{t("staleProposal")}</p> : changes?.length ? <>
        <ol>{changes.map((change, i) => <li key={i}>{change}</li>)}</ol>
        {preview&&<section aria-label={locale==="ja"?"更新後の食材構成":"Ingredients after changes"}><h4>{locale==="ja"?"更新後の食材構成":"Ingredients after changes"}</h4><ul>{preview.materials.map(line=><li key={line.id} className={preview.addedIds.has(line.id)?"font-bold text-emerald-300":""}>{preview.addedIds.has(line.id)&&<strong>{locale==="ja"?"追加：":"Added: "}</strong>}{line.material_name.value} · {line.quantity.value??"—"} {line.unit??""}</li>)}</ul></section>}
        {review.masters&&<MasterMatchReview items={review.masters.ingredients} ja={locale==="ja"} disabled={busy} onChoose={(m,c,s)=>void chooseMaster(m,c,s)}/>}
        <p>{t("proposalOnly")}</p>
        <label className="approval"><input type="checkbox" checked={approved} disabled={busy} onChange={e => setApproved(e.target.checked)}/>{t("approveValues")}</label>
        <div className="actions"><button type="button" disabled={busy || !approved || review.masters?.requires_selection} onClick={() => void confirm()}>{t("confirmSave")}</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => {invalidate();voiceHistory.current=[];setInstruction("");}}>{t("discard")}</button></div>
      </> : <p>{t("noProposal")}</p>}
    </section>;
  return <section className="ai-workspace" aria-label={t("aiInstruction")} aria-busy={busy}>
    <p className="tag">{t("conversation")}</p><h2>{t("aiInstruction")}</h2>
    <p className="muted">{t("approvalHelp")}</p><p className="provider-note">{t("museStatus")}</p>
    <form onSubmit={propose} className="instruction-form">
      <label htmlFor="ai-instruction">{t("instructionLabel")}</label>
      <textarea id="ai-instruction" maxLength={4000} rows={3} value={instruction} disabled={busy} placeholder={t("instructionExample")} onChange={e => {setInstruction(e.target.value);voiceHistory.current=[];invalidate();}} required />
      {!control&&<VoiceInput locale={locale} disabled={busy} onTranscript={text => {setInstruction(text);invalidate();}}/>}<button disabled={busy || !instruction.trim()}>{busy ? t("processing") : t("getProposal")}</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <p role="status">{notice}</p>
    {!reviewOpen&&<ResearchEvidence results={researchResults} locale={locale}/>}
    {reviewOpen&&review?<EditProposalDialog locale={locale} busy={busy} micControl={micControl} onPresented={()=>{reviewEpoch.current=markReview?.()??-1;}} onClose={()=>{setReviewOpen(false);setApproved(false);reviewEpoch.current=-1;}}>
      {error&&<p role="alert" className="error">{error}</p>}<p role="status">{notice}</p><ResearchEvidence results={researchResults} locale={locale}/>{proposalContent}
    </EditProposalDialog>:<>{proposalContent}{review&&<button type="button" onClick={()=>setReviewOpen(true)}>{locale==="ja"?"変更案を確認":"Review changes"}</button>}</>}

    <details className="correction"><summary>{t("correctionTitle")}</summary>
      <p className="muted">{t("correctionHelp")}</p>
      <form onSubmit={record}>
        <label>{t("heardPhrase")}<input maxLength={200} value={heard} disabled={busy} onChange={e => setHeard(e.target.value)} required /></label>
        <label>{t("preferredPhrase")}<input maxLength={200} value={preferred} disabled={busy} onChange={e => setPreferred(e.target.value)} required /></label>
        <button disabled={busy || !heard.trim() || !preferred.trim() || heard.trim() === preferred.trim()}>{t("saveCorrection")}</button>
      </form>
    </details>
  </section>;
}
