/** Meta Search Grounding price-research seam (Responses API web_search only).
 *
 * Contract (ADR-011): when the owned ledger has no usable reference for an
 * explicit price_research request, the app may ask Muse Spark 1.3 to run a
 * real web search via the Responses API `web_search` tool and report
 *出典付き reference prices. A bare tool request is NOT success: an
 * observed `web_search_call` output item must back the result, with source
 * evidence from either `url_citation` annotations or per-candidate source
 * URLs actually returned by the model (live responses carry tool calls
 * whose candidates cite their own page URLs). Only validated candidates
 * with comparable terms are summarized. Failures keep the ledger entry;
 * the draft path is never failed and nothing is auto-saved.
 *
 * Request shape: `search_context_size` lives INSIDE the web_search tool
 * object. The same key sent top-level is rejected with HTTP 400
 * `unknown parameter` (verified against the live API).
 *
 * Validation mirrors chef_ai_workspace/external_reference.py
 * (validate_external_candidate): required name/amount/currency/
 * package_quantity/package_unit/seller/source, decimal-checked, never
 * silently repaired. No Tavily/Brave/Exa/Google path exists here.
 */
export const RESPONSES_ENDPOINT = "https://api.meta.ai/v1/responses";
export const GROUNDED_SEARCH_MODEL = "muse-spark-1.3";

export type GroundedCitation = {url: string; title: string};
export type GroundedCandidate = {
  name: string; amount: string; currency: string;
  package_quantity: string; package_unit: string;
  seller: string; source: string; url?: string; fetched_at?: string;
  maker?: string; spec?: string; tax_note?: string; shipping_note?: string;
};
export type GroundedSample = {
  name: string; seller: string; source: string;
  amount: string; package: string; package_quantity?:string; package_unit?:string;
  url?: string; fetched_at?: string;
  tax_note?: string; shipping_note?: string;
  maker?: string; spec?: string;
};
export type ExternalPriceEntry = {
  material_name: string;
  status: "available" | "none";
  origin: "external";
  ingredient_name: string | null;
  currency: string | null;
  unit_basis: string | null;
  average_unit_price: string | null;
  observation_count: number | null;
  observed_to: string | null;
  sources: GroundedCitation[];
  fetched_at: string;
  samples: GroundedSample[];
  text: string;
};

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MASS: Record<string, number> = {g: 1, kg: 1000};
const VOLUME: Record<string, number> = {ml: 1, L: 1000};

export function buildPriceSearchInput(materialName: string, request: string, locale = "ja"): string {
  const material = materialName.trim();
  if (!material) throw new Error("material name required");
  const lang = locale === "en" ? "en" : "ja";
  // The chef's wording travels verbatim; the model forms the web query.
  return lang === "en"
    ? `Reference price research for "${material}". Chef request in their own words: "${request.trim()}". ` +
      `Search the web for current retail offers of this ingredient, then return JSON only.`
    : `「${material}」の参考価格調査。料理人の依頼（原文）:「${request.trim()}」。` +
      `Webで現在の販売価格を検索し、JSONのみで返すこと。`;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractJson(rawText: string): unknown {
  const direct = tryParse(rawText);
  if (direct !== undefined) return direct;
  for (const open of ["{", "["]) {
    const start = rawText.indexOf(open);
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < rawText.length; i++) {
      const ch = rawText[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          const parsed = tryParse(rawText.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }
  return undefined;
}

/** Split a Responses API output into search evidence + model text.
 *
 * `toolRan` reports whether a `web_search_call` item ran. `searched` keeps
 * its strict meaning (tool ran AND at least one `url_citation`); callers
 * that also accept per-candidate source URLs combine `toolRan` with the
 * model's candidate payload (see runGroundedSearch). */
export function parseGroundedResponse(raw: unknown): {
  searched: boolean; toolRan: boolean; citations: GroundedCitation[]; texts: string[]; modelJson: unknown;
} {
  const out = {searched: false, toolRan: false, citations: [] as GroundedCitation[], texts: [] as string[], modelJson: undefined as unknown};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const output = (raw as {output?: unknown}).output;
  if (!Array.isArray(output)) return out;
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === "web_search_call") {
      out.toolRan = true;
      continue;
    }
    if (rec.type !== "message" || rec.role !== "assistant") continue;
    const content = rec.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "output_text" || typeof p.text !== "string") continue;
      out.texts.push(p.text);
      const anns = p.annotations;
      if (Array.isArray(anns)) {
        for (const ann of anns) {
          if (!ann || typeof ann !== "object" || Array.isArray(ann)) continue;
          const a = ann as Record<string, unknown>;
          if (a.type !== "url_citation" || typeof a.url !== "string" || !a.url.trim()) continue;
          const url = a.url.trim();
          const title = typeof a.title === "string" && a.title.trim() ? a.title.trim() : url;
          if (out.citations.every(c => c.url !== url)) {
            out.citations.push({url: url.slice(0, 500), title: title.slice(0, 200)});
          }
        }
      }
    }
  }
  // Strict searched: the tool actually ran AND at least one source is cited.
  out.searched = out.toolRan && out.citations.length > 0;
  const joined = out.texts.join("\n");
  if (joined.trim()) out.modelJson = extractJson(joined);
  return out;
}

/** Mirror of Python validate_external_candidate: normalize or null.
 *
 * Finiteness parity: the DECIMAL regex only matches plain digit strings,
 * so "NaN", "Infinity", and "-Infinity" are rejected here exactly as
 * Python's is_finite() gate rejects them -- no exception path exists on
 * either side, and only the offending row is dropped.
 */
export function validateGroundedCandidate(raw: unknown): GroundedCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  for (const k of ["name", "amount", "currency", "package_quantity", "package_unit", "seller", "source"]) {
    const v = rec[k];
    if (typeof v !== "string" || !v.trim()) return null;
  }
  const name = String(rec.name).trim();
  const amount = String(rec.amount).trim();
  const currency = String(rec.currency).trim();
  const quantity = String(rec.package_quantity).trim();
  const unit = String(rec.package_unit).trim();
  if (!DECIMAL.test(amount) || !DECIMAL.test(quantity) || Number(quantity) <= 0) return null;
  if (!(unit in MASS) && !(unit in VOLUME)) return null;
  if (name.length > 200 || currency.length > 10 || amount.length > 30) return null;
  const out: GroundedCandidate = {
    name, amount, currency, package_quantity: quantity, package_unit: unit,
    seller: String(rec.seller).trim().slice(0, 200),
    source: String(rec.source).trim().slice(0, 200),
  };
  // fetched_at passes through exactly like Python: a candidate-observed
  // timestamp survives; when absent the shared search time is used below.
  for (const k of ["url", "fetched_at", "maker", "spec", "tax_note", "shipping_note"] as const) {
    const v = rec[k];
    if (typeof v === "string" && v.trim() && v.length <= 500) out[k] = v.trim();
  }
  return out;
}

function baseOf(qty: string, unit: string): {dim: string; base: number} | null {
  const factor = MASS[unit] ?? VOLUME[unit];
  if (!factor) return null;
  const base = Number(qty) * factor;
  if (!Number.isFinite(base) || base <= 0) return null;
  return {dim: unit in MASS ? "mass" : "volume", base};
}

/** Group comparable candidates; summarize the largest group as a sample reference. */
export function summarizeGroundedCandidates(
  raws: unknown[], citations: GroundedCitation[], materialName: string, fetchedAt = new Date().toISOString(),
): ExternalPriceEntry {
  const wanted = materialName.trim();
  const valid: {item: GroundedCandidate; unitPrice: number}[] = [];
  for (const raw of raws) {
    const item = validateGroundedCandidate(raw);
    if (!item) continue;
    const b = baseOf(item.package_quantity, item.package_unit);
    if (!b) continue;
    valid.push({item, unitPrice: Number(item.amount) / b.base});
  }
  const none = (text: string): ExternalPriceEntry => ({
    material_name: wanted, status: "none", origin: "external",
    ingredient_name: null, currency: null, unit_basis: null,
    average_unit_price: null, observation_count: null, observed_to: null,
    sources: citations.slice(0, 10), fetched_at: fetchedAt, samples: [], text,
  });
  if (!valid.length) {
    return none(`参考価格なし：${wanted}のWeb調査では価格と容量が確認できる候補がありませんでした（価格未確定のまま保存できます）`);
  }
  const groups = new Map<string, {item: GroundedCandidate; unitPrice: number}[]>();
  for (const v of valid) {
    const b = baseOf(v.item.package_quantity, v.item.package_unit)!;
    const key = [v.item.currency, b.dim, v.item.tax_note ?? "", v.item.shipping_note ?? ""].join("|");
    const list = groups.get(key) ?? [];
    list.push(v);
    groups.set(key, list);
  }
  let best: {item: GroundedCandidate; unitPrice: number}[] = [];
  let bestKey = "";
  for (const [key, list] of groups) {
    if (list.length > best.length) {
      best = list;
      bestKey = key;
    }
  }
  const [currency, , tax, ship] = bestKey.split("|");
  const unit = best[0].item.package_unit in MASS ? "g" : "ml";
  const sorted = [...best].sort((a, b) => a.unitPrice - b.unitPrice);
  const avg = sorted.reduce((s, v) => s + v.unitPrice, 0) / sorted.length;
  const avgStr = avg.toFixed(4);
  const excluded = valid.length - sorted.length;
  const domains = [...new Set(citations.map(c => {
    try {
      return new URL(c.url).hostname;
    } catch {
      return "";
    }
  }).filter(Boolean))].slice(0, 3).join("・");
  const terms = [tax ? `税条件:${tax}` : "", ship ? `送料:${ship}` : ""].filter(Boolean).join(" ");
  const amount = currency === "JPY" ? `${unit}あたり平均${avgStr}円` : `${unit}あたり平均${avgStr} ${currency}`;
  // Per-sample provenance: url/tax/shipping/maker/spec travel with the
  // sample only when the candidate supplied them -- never backfilled.
  // fetched_at here is the search time shared by all candidates of this
  // grounding call, i.e. their genuine observation time, not an estimate.
  const samples: GroundedSample[] = sorted.map(({item}) => {
    const sample: GroundedSample = {
      name: item.name, seller: item.seller, source: item.source,
      amount: item.amount,
      package: item.package_quantity + item.package_unit,
      package_quantity:item.package_quantity,package_unit:item.package_unit,
      // The candidate's own observation time wins; otherwise the shared
      // search time (genuine for this grounding call, never an estimate).
      fetched_at: item.fetched_at ?? fetchedAt,
    };
    for (const k of ["url", "tax_note", "shipping_note", "maker", "spec"] as const) {
      if (item[k] !== undefined) sample[k] = item[k];
    }
    return sample;
  });
  return {
    material_name: wanted, status: "available", origin: "external",
    ingredient_name: sorted[0].item.name, currency, unit_basis: unit,
    average_unit_price: avgStr, observation_count: sorted.length, observed_to: null,
    sources: citations.slice(0, 10), fetched_at: fetchedAt, samples,
    text: `Web参考価格：${sorted[0].item.name}は${amount}` +
      `（${sorted.length}件のサンプルからの参考値` +
      `${excluded ? `・比較対象外${excluded}件を除外` : ""}` +
      `${domains ? `・出典:${domains}` : ""}${terms ? `・${terms}` : ""}・推定・要確認）`,
  };
}

const SEARCH_INSTRUCTIONS =
  `You research current retail prices for ONE ingredient via web search. ` +
  `Use the search tool. Find 1-3 comparable offers for this ONE ingredient, then stop. ` +
  `Use at most two search queries and only open pages needed to verify price/package. ` +
  `Do not narrate your progress. Keep the final answer compact. First line: ONLY JSON {"candidates":[...]}. ` +
  `Each candidate: name, amount (decimal string), currency, package_quantity (decimal string), ` +
  `package_unit (g|kg|ml|L), seller, source, url, maker, spec, tax_note, shipping_note. ` +
  `Include ONLY offers whose price and package size you actually saw in the search results, ` +
  `with the source page URL. After the JSON, add one bullet per candidate: ` +
  `"- <seller>: <source page title> <full page URL>" so each source is cited in prose. ` +
  `Never invent prices from your own knowledge. ` +
  `When unsure, return {"candidates":[]}.`;

/** A per-candidate source URL is usable only when it is a non-empty
 * http(s) URL. In the citation-free fallback path every summarized row
 * must carry its own: one row's URL must never substantiate another row's
 * price. */
export function hasUsableSourceUrl(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const u = (raw as Record<string, unknown>).url;
  if (typeof u !== "string" || !u.trim()) return false;
  try {
    const parsed = new URL(u.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Discriminated grounding outcome. "found" and "empty" both searched;
 * "not_searched" means the tool never ran, or ran without any source
 * evidence (neither url_citation annotations nor candidate source URLs);
 * provider/timeout/misconfigured failures carry no price data. Never throws.
 */
export type GroundedOutcome =
  | {kind: "found" | "empty"; entry: ExternalPriceEntry}
  | {kind: "not_searched" | "provider_error" | "timeout" | "misconfigured"};

/** Live Responses API call with a machine-readable outcome. Never throws. */
export async function runGroundedSearch(args: {
  apiKey: string; materialName: string; request: string; locale?: string;
  fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<GroundedOutcome> {
  const {apiKey, materialName, request} = args;
  if (!apiKey || !materialName.trim()) return {kind: "misconfigured"};
  const fetchImpl = args.fetchImpl ?? fetch;
  const locale = args.locale === "en" ? "en" : "ja";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 45000);
  try {
    const res = await fetchImpl(RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {"Authorization": "Bearer " + apiKey, "Content-Type": "application/json"},
      body: JSON.stringify({
        model: GROUNDED_SEARCH_MODEL,
        instructions: SEARCH_INSTRUCTIONS,
        input: buildPriceSearchInput(materialName, request, locale),
        tools: [{type: "web_search", search_context_size: "low"}],
        tool_choice: "auto",
        store: false,
        max_output_tokens: 4096,
        reasoning: {effort: "low"},
      }),
      cache: "no-store",
      redirect: "error",
      signal: ctrl.signal,
    });
    if (!res.ok) return {kind: "provider_error"};
    const raw: unknown = await res.json();
    if (!raw || typeof raw !== "object" || (raw as {status?: unknown}).status !== "completed")
      return {kind: "provider_error"};
    const parsed = parseGroundedResponse(raw);
    const mj = parsed.modelJson;
    const list = mj && typeof mj === "object" && !Array.isArray(mj)
      ? (mj as {candidates?: unknown}).candidates
      : Array.isArray(mj) ? mj : [];
    if (!Array.isArray(list)) return {kind: "provider_error"};
    // Strict pass: tool ran with url_citation annotations. Fallback: the
    // tool ran and the model returned candidates that each carry their own
    // usable source URL (the shape live completed responses actually use).
    // Unsourced rows are dropped BEFORE summarization, so one row's URL can
    // never substantiate another row's price in the average. Anything else
    // -- tool-request-only, citation-free prose, unparsable payload -- stays
    // "not_searched" and never becomes a price.
    let sources = parsed.citations;
    let rows: unknown[] = list;
    if (!parsed.searched) {
      if (!parsed.toolRan) return {kind: "not_searched"};
      rows = list.filter(hasUsableSourceUrl);
      if (!rows.length) return {kind: "not_searched"};
      const seen = new Set(sources.map(c => c.url));
      for (const c of rows) {
        const u = ((c as Record<string, unknown>).url as string).trim();
        if (seen.has(u)) continue;
        seen.add(u);
        sources = [...sources, {url: u.slice(0, 500), title: u.slice(0, 200)}];
      }
    }
    const entry = summarizeGroundedCandidates(rows, sources, materialName);
    return entry.status === "available" ? {kind: "found", entry} : {kind: "empty", entry};
  } catch (error) {
    // Abort (local timeout or caller cancellation) stays distinct from
    // provider/network failures so the UI can say "timed out" vs "failed".
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
      return {kind: "timeout"};
    return {kind: "provider_error"};
  } finally {
    clearTimeout(timer);
  }
}

/** Legacy wrapper: usable external entry, or null. Never throws. */
export async function searchGroundedPrices(args: {
  apiKey: string; materialName: string; request: string; locale?: string;
  fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<ExternalPriceEntry | null> {
  const out = await runGroundedSearch(args);
  return out.kind === "found" ? out.entry : null;
}
