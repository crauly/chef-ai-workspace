"use client";
import {useEffect,useImperativeHandle,useRef,useState,type Ref} from "react";
import {label, type Locale} from "./i18n";
import VoiceInput from "./VoiceInput";
import {request, type AIProposal, type Operation, type Recipe} from "./types";
import {voiceCommand} from "./voice-commands";
import type {VoiceCaptureMeta} from "./useVoiceCapture";

type Review = {proposal: AIProposal; instruction: string; requestId: string; evidence?:string[]};
function describe(recipe: Recipe, operations: Operation[], locale: Locale): string[] | null {
  const ja = locale === "ja";
  const lines = new Map(recipe.materials.map(line => [line.id, {...line}]));
  let title = recipe.title.value, selling = recipe.selling_price_jpy.value;
  const changes: string[] = [];
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
        const p = line.price_override;
        const before = line.price_mode === "inherit" ? (ja ? "共通食材の単価" : "Shared ingredient price") : p ? `¥${p.amount_jpy.value ?? "—"} / ${p.per_quantity} ${p.per_unit}` : "—";
        changes.push(`${line.material_name.value || label(locale, "unnamed")} · ${ja ? "単価" : "Price"}: ${before} → ¥${op.price_jpy} / ${op.price_quantity} ${op.price_unit}`);
        lines.set(line.id, {...line, price_mode: "override", price_override: {amount_jpy: {value: op.price_jpy, status: "assumed"}, per_quantity: op.price_quantity, per_unit: op.price_unit}}); break;
      }
      case "add_material":
        if (lines.has(op.material_id)) return null;
        changes.push(`${ja ? "食材を追加" : "Add ingredient"}: ${op.name}, ${op.quantity} ${op.unit}, ¥${op.price_jpy} / ${op.price_quantity} ${op.price_unit}`);
        lines.set(op.material_id, {id: op.material_id, material_name: {value: op.name, status: "assumed"}, quantity: {value: op.quantity, status: "assumed"}, unit: op.unit, price_mode: "override", price_override: {amount_jpy: {value: op.price_jpy, status: "assumed"}, per_quantity: op.price_quantity, per_unit: op.price_unit}}); break;
      default: return null;
    }
  }
  return changes;
}

export type EditorHandle={submit:(text:string,meta?:VoiceCaptureMeta)=>Promise<void>;hasPending:()=>boolean;invalidate:()=>void;isBusy:()=>boolean};
export default function AIEditor({recipe, locale, onSaved, onBusy,control,markReview}: {
  recipe: Recipe; locale: Locale; onSaved: (recipe: Recipe) => void; onBusy: (busy: boolean) => void;
  control?:Ref<EditorHandle>;markReview?:()=>number;
}) {
  const t = (key: Parameters<typeof label>[1]) => label(locale, key);
  const [instruction, setInstruction] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [heard, setHeard] = useState(""), [preferred, setPreferred] = useState("");
  const lock = useRef(false);
  const reviewRef=useRef<Review|null>(null),reviewEpoch=useRef(-1),generation=useRef(0),alive=useRef(true);
  const voiceHistory=useRef<string[]>([]),latestRecipe=useRef(recipe);latestRecipe.current=recipe;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  function invalidate(){generation.current++;reviewRef.current=null;setReview(null);setApproved(false);}
  useEffect(()=>{invalidate();voiceHistory.current=[];},[recipe.id,recipe.revision]);
  useImperativeHandle(control,()=>({submit:voiceSubmit,hasPending:()=>Boolean(reviewRef.current||voiceHistory.current.length||instruction.trim()),invalidate,isBusy:()=>lock.current}));
  const changes = review ? describe(recipe, review.proposal.operations, locale) : null;
  const valid = review && review.proposal.recipe_id === recipe.id && review.proposal.base_revision === recipe.revision && changes !== null;
  async function refreshAfterConflict() {
    invalidate();
    const latest = await request<Recipe>(`/api/recipes/${recipe.id}`);
    onSaved(latest);
    setError(locale === "ja" ? "最新のレシピを取得しました。変更案を作り直してください。" : "Recipe refreshed. Request a new proposal.");
  }
  function working(value: boolean) {lock.current = value; setBusy(value); onBusy(value);}
  function report(e: unknown, uncertainSave = false) {
    const status = e instanceof Error ? e.message : "";
    setError(t(status === "409" ? "staleProposal" : !uncertainSave && (status === "502" || status === "503") ? "aiUnavailable" : "failure"));
  }
  async function propose(e: React.FormEvent) {
    e.preventDefault();voiceHistory.current=[];await proposeText(instruction);
  }
  async function proposeText(text:string) {
    if (lock.current || !text.trim()) return;
    const token=++generation.current,base=latestRecipe.current;
    working(true); setError(""); setNotice(""); setReview(null); setApproved(false);
    reviewRef.current=null;
    try {
      // A price research instruction needs real provenance, not an AI-invented
      // numerical mutation. Scope is resolved dynamically against live rows.
      const researchRequested=/(?:価格|単価|値段|仕入値|相場).*(?:調べ|検索|調査|探し)|(?:調べ|検索|調査|探し).*(?:価格|単価|値段|仕入値|相場)|市場価格|参考価格|仮単価|平均価格|最安|価格比較|price research|market price|average price|look up.*price|check.*price|research.*price|compare prices/i.test(text);
      let researchNotice="";
      let evidence:string[]|undefined;
      let proposal:AIProposal;
      if(researchRequested){
        const result=await request<{indices:number[];operations:Operation[];results:{name:string;status:string;description:string}[];ambiguous:boolean}>("/api/recipe-price-research",{
          method:"POST",body:JSON.stringify({instruction:text,materials:base.materials.map(m=>({id:m.id,name:m.material_name.value||"",supplier_id:m.supplier_id??null,offer_id:m.offer_id??null}))})});
        if(!alive.current||token!==generation.current||latestRecipe.current.id!==base.id||latestRecipe.current.revision!==base.revision)return;
        if(result.ambiguous||!result.indices.length){
          setNotice(locale==="ja"?"調査対象を特定できませんでした。食材名・範囲、または「すべて」を指定してください。":"Could not determine the target rows. Name ingredients, a range, or all.");
          return;
        }
        evidence=result.results.map(item=>`${item.name}: ${item.description}`);
        const skipped=result.results.filter(item=>item.status!=="candidate");
        researchNotice=(locale==="ja"?`調査対象${result.indices.length}品・仮単価候補${result.operations.length}品。`:`Researched ${result.indices.length} ingredients; ${result.operations.length} provisional candidates.`)+
          (skipped.length?(locale==="ja"?" 候補未取得："+skipped.map(item=>item.name).join("、"):" No usable quote: "+skipped.map(item=>item.name).join(", ")):"");
        if(!result.operations.length){setNotice(researchNotice);return;}
        proposal={recipe_id:base.id,base_revision:base.revision,operations:result.operations,requires_confirmation:true};
      }else{
        proposal=await request<AIProposal>(`/api/recipes/${base.id}/propose`, {method: "POST", body: JSON.stringify({instruction:text})});
      }
      if(!alive.current||token!==generation.current||latestRecipe.current.id!==base.id||latestRecipe.current.revision!==base.revision)return;
      if (proposal.requires_confirmation !== true || !Array.isArray(proposal.operations) || proposal.operations.length > 40) throw new Error("invalid");
      if (proposal.recipe_id !== base.id) throw new Error("invalid");
      if (proposal.base_revision !== base.revision) {await refreshAfterConflict(); return;}
      if (describe(base, proposal.operations, locale) === null) throw new Error("invalid");
      const next:Review={proposal,instruction:text,requestId:crypto.randomUUID(),evidence};reviewRef.current=next;setReview(next);
      reviewEpoch.current=markReview?.()??-1;
      setNotice(researchNotice+" "+(locale==="ja"?"変更案を表示しました。差分を確認後、もう一度「保存してください」と明示するか、確認チェックと保存ボタンを操作してください。":"Review the proposal, then explicitly request saving or use the approval controls."));
    } catch (e) {report(e);} finally {working(false);}
  }
  async function confirm(voiceApproval?:Review) {
    const current=voiceApproval??review;
    if (lock.current || !current || current!==reviewRef.current || (!voiceApproval&&!approved) ||
      current.proposal.recipe_id!==recipe.id||current.proposal.base_revision!==recipe.revision||!describe(recipe,current.proposal.operations,locale)?.length) return;
    working(true); setError("");
    try {
      const result = await request<{recipe: Recipe}>(`/api/recipes/${recipe.id}/confirm`, {method: "POST", body: JSON.stringify({base_revision: current.proposal.base_revision, request_id: current.requestId, operations: current.proposal.operations, save_version: true})});
      latestRecipe.current=result.recipe;invalidate();voiceHistory.current=[];setInstruction("");setNotice(t("savedRecalculated")); onSaved(result.recipe);
    } catch (e) {
      report(e, true);
      if (e instanceof Error && e.message === "409") {
        try {await refreshAfterConflict();} catch {setError(t("failure"));}
      }
      // Keep the same request ID on uncertain network outcomes: retry cannot apply twice.
    } finally {working(false);}
  }
  async function voiceSubmit(text:string,meta?:VoiceCaptureMeta){
    const command=voiceCommand(text);
    if(command==="cancel"||command==="hold"){
      invalidate();if(command==="cancel"){voiceHistory.current=[];setInstruction("");}
      setNotice(locale==="ja"?"保存していません。変更案の承認を解除しました。":"Not saved. Proposal approval was cleared.");return;
    }
    if(command==="review"||command==="save"){
      const current=reviewRef.current;
      if(!current){setNotice(locale==="ja"?"保存できる変更案がありません。変更内容を話してください。":"No proposal to save. Describe the desired changes.");return;}
      if(command==="save"&&(!meta||meta.reviewEpoch===reviewEpoch.current))await confirm(current);
      else {reviewEpoch.current=markReview?.()??-1;setNotice(locale==="ja"?"差分を確認してください。その後、もう一度「保存してください」と明示してください。":"Review the changes, then explicitly request saving again.");}
      return;
    }
    const next=[...voiceHistory.current,text];
    if(next.join("\n").length>4000){setError(locale==="ja"?"変更指示が長すぎます。変更案を確認・保存するか、破棄してください。":"Too many change instructions. Review and save or discard the existing proposal.");return;}
    voiceHistory.current=next;setInstruction(next.join("\n"));await proposeText(next.join("\n"));
  }
  async function record(e: React.FormEvent) {
    e.preventDefault(); if (lock.current || !heard.trim() || !preferred.trim() || heard.trim() === preferred.trim()) return;
    working(true); setError(""); setNotice("");
    try {
      await request(`/api/recipes/${recipe.id}/corrections`, {method: "POST", body: JSON.stringify({heard: heard.trim(), preferred: preferred.trim()})});
      setNotice(t("correctionSaved")); setHeard(""); setPreferred("");
    } catch (e) {report(e, true);} finally {working(false);}
  }
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
    {review && <section className="proposal" aria-label={t("proposalDiff")}>
      <h3>{t("proposalDiff")}</h3><p className="muted">{t("originalInstruction")}: {review.instruction}</p>
      {review.proposal.provider && <p className="tag">{review.proposal.provider.name === "meta_responses" ? "Meta Muse" : (locale === "ja" ? "代替モデル" : "Substitute model")} · {review.proposal.provider.model}</p>}
      {!valid ? <p role="alert">{t("staleProposal")}</p> : changes?.length ? <>
        <ol>{changes.map((change, i) => <li key={i}>{change}</li>)}</ol>
        {review.evidence?.length ? <details open><summary>{locale==="ja"?"調査根拠・未取得の理由":"Research evidence and unavailable quotes"}</summary><ul>{review.evidence.map((entry,i)=><li key={i}>{entry}</li>)}</ul></details>:null}
        <p>{t("proposalOnly")}</p>
        <label className="approval"><input type="checkbox" checked={approved} disabled={busy} onChange={e => setApproved(e.target.checked)}/>{t("approveValues")}</label>
        <div className="actions"><button type="button" disabled={busy || !approved} onClick={() => void confirm()}>{t("confirmSave")}</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => {invalidate();voiceHistory.current=[];setInstruction("");}}>{t("discard")}</button></div>
      </> : <p>{t("noProposal")}</p>}
    </section>}
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
