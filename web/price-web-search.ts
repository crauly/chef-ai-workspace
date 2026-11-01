/** Meta Search Grounding price-research seam (Responses API web_search only).
 *
 * Contract (ADR-011): when the owned ledger has no usable reference for an
 * explicit price_research request, the app may ask Muse Spark 1.3 to run a
 * real web search via the Responses API `web_search` tool and report
 *出典付き reference prices. A bare tool request is NOT success: only an
 * observed `web_search_call` output item plus at least one `url_citation`
 * annotation counts as searched, and only validated candidates with
 * comparable terms are summarized. Failures keep the ledger entry; the
 * draft path is never failed and nothing is auto-saved.
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
  seller: string; source: string; url?: string;
  maker?: string; spec?: string; tax_note?: string; shipping_note?: string;
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

/** Split a Responses API output into search evidence + model text. */
export function parseGroundedResponse(raw: unknown): {
  searched: boolean; citations: GroundedCitation[]; texts: string[]; modelJson: unknown;
} {
  const out = {searched: false, citations: [] as GroundedCitation[], texts: [] as string[], modelJson: undefined as unknown};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const output = (raw as {output?: unknown}).output;
  if (!Array.isArray(output)) return out;
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === "web_search_call") {
      out.searched = true;
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
  // Searched means the tool actually ran AND at least one source is cited.
  out.searched = out.searched && out.citations.length > 0;
  const joined = out.texts.join("\n");
  if (joined.trim()) out.modelJson = extractJson(joined);
  return out;
}

/** Mirror of Python validate_external_candidate: normalize or null. */
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
  for (const k of ["url", "maker", "spec", "tax_note", "shipping_note"] as const) {
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
    sources: citations.slice(0, 10), fetched_at: fetchedAt, text,
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
  return {
    material_name: wanted, status: "available", origin: "external",
    ingredient_name: sorted[0].item.name, currency, unit_basis: unit,
    average_unit_price: avgStr, observation_count: sorted.length, observed_to: null,
    sources: citations.slice(0, 10), fetched_at: fetchedAt,
    text: `Web参考価格：${sorted[0].item.name}は${amount}` +
      `（${sorted.length}件のサンプルからの参考値` +
      `${excluded ? `・比較対象外${excluded}件を除外` : ""}` +
      `${domains ? `・出典:${domains}` : ""}${terms ? `・${terms}` : ""}・推定・要確認）`,
  };
}

const SEARCH_INSTRUCTIONS =
  `You research current retail prices for ONE ingredient via web search. ` +
  `Use the search tool. First line: ONLY JSON {"candidates":[...]}. ` +
  `Each candidate: name, amount (decimal string), currency, package_quantity (decimal string), ` +
  `package_unit (g|kg|ml|L), seller, source, url, maker, spec, tax_note, shipping_note. ` +
  `Include ONLY offers whose price and package size you actually saw in the search results, ` +
  `with the source page URL. After the JSON, add one bullet per candidate: ` +
  `"- <seller>: <source page title> <full page URL>" so each source is cited in prose. ` +
  `Never invent prices from your own knowledge. ` +
  `When unsure, return {"candidates":[]}.`;

/** Live Responses API call. Returns an external entry, or null when unusable. Never throws. */
export async function searchGroundedPrices(args: {
  apiKey: string; materialName: string; request: string; locale?: string;
  fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<ExternalPriceEntry | null> {
  const {apiKey, materialName, request} = args;
  if (!apiKey || !materialName.trim()) return null;
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
        tools: [{type: "web_search"}],
        tool_choice: "auto",
        search_context_size: "low",
        store: false,
        max_output_tokens: 2048,
        reasoning: {effort: "low"},
      }),
      cache: "no-store",
      redirect: "error",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (!raw || typeof raw !== "object" || (raw as {status?: unknown}).status !== "completed") return null;
    const parsed = parseGroundedResponse(raw);
    // Search-tool invocation without citations is NOT success.
    if (!parsed.searched) return null;
    const mj = parsed.modelJson;
    const list = mj && typeof mj === "object" && !Array.isArray(mj)
      ? (mj as {candidates?: unknown}).candidates
      : Array.isArray(mj) ? mj : [];
    if (!Array.isArray(list)) return null;
    const entry = summarizeGroundedCandidates(list, parsed.citations, materialName);
    return entry.status === "available" ? entry : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
