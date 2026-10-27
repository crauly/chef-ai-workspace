"use client";
import {useRef, useState} from "react";
import {label, type Locale} from "./i18n";
import {request, type AIProposal, type Operation, type Recipe} from "./types";

type Review = {proposal: AIProposal; instruction: string; requestId: string};
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

export default function AIEditor({recipe, locale, onSaved, onBusy}: {
  recipe: Recipe; locale: Locale; onSaved: (recipe: Recipe) => void; onBusy: (busy: boolean) => void;
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
  const changes = review ? describe(recipe, review.proposal.operations, locale) : null;
  const valid = review && review.proposal.recipe_id === recipe.id && review.proposal.base_revision === recipe.revision && changes !== null;
  async function refreshAfterConflict() {
    setReview(null); setApproved(false);
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
    e.preventDefault(); if (lock.current || !instruction.trim()) return;
    working(true); setError(""); setNotice(""); setReview(null); setApproved(false);
    try {
      const proposal = await request<AIProposal>(`/api/recipes/${recipe.id}/propose`, {method: "POST", body: JSON.stringify({instruction})});
      if (proposal.requires_confirmation !== true || !Array.isArray(proposal.operations) || proposal.operations.length > 40) throw new Error("invalid");
      if (proposal.recipe_id !== recipe.id) throw new Error("invalid");
      if (proposal.base_revision !== recipe.revision) {await refreshAfterConflict(); return;}
      if (describe(recipe, proposal.operations, locale) === null) throw new Error("invalid");
      setReview({proposal, instruction, requestId: crypto.randomUUID()});
    } catch (e) {report(e);} finally {working(false);}
  }
  async function confirm() {
    if (lock.current || !review || !valid || !approved || !changes?.length) return;
    working(true); setError("");
    try {
      const result = await request<{recipe: Recipe}>(`/api/recipes/${recipe.id}/confirm`, {method: "POST", body: JSON.stringify({base_revision: review.proposal.base_revision, request_id: review.requestId, operations: review.proposal.operations, save_version: true})});
      setReview(null); setApproved(false); setNotice(t("savedRecalculated")); onSaved(result.recipe);
    } catch (e) {
      report(e, true);
      if (e instanceof Error && e.message === "409") {
        try {await refreshAfterConflict();} catch {setError(t("failure"));}
      }
      // Keep the same request ID on uncertain network outcomes: retry cannot apply twice.
    } finally {working(false);}
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
      <textarea id="ai-instruction" maxLength={4000} rows={3} value={instruction} disabled={busy} placeholder={t("instructionExample")} onChange={e => {setInstruction(e.target.value); setReview(null); setApproved(false);}} required />
      <button disabled={busy || !instruction.trim()}>{busy ? t("processing") : t("getProposal")}</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <p role="status">{notice}</p>
    {review && <section className="proposal" aria-label={t("proposalDiff")}>
      <h3>{t("proposalDiff")}</h3><p className="muted">{t("originalInstruction")}: {review.instruction}</p>
      {!valid ? <p role="alert">{t("staleProposal")}</p> : changes?.length ? <>
        <ol>{changes.map((change, i) => <li key={i}>{change}</li>)}</ol>
        <p>{t("proposalOnly")}</p>
        <label className="approval"><input type="checkbox" checked={approved} disabled={busy} onChange={e => setApproved(e.target.checked)}/>{t("approveValues")}</label>
        <div className="actions"><button type="button" disabled={busy || !approved} onClick={() => void confirm()}>{t("confirmSave")}</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => {setReview(null); setApproved(false);}}>{t("discard")}</button></div>
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
