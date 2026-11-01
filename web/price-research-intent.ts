// Backup price-research trigger for when Muse omits price_research.
//
// The system prompt requires Muse to emit one price_research entry per
// researched ingredient, but a missed entry must not silently drop an
// explicit chef request. This detector is deliberately narrow: it fires
// only on explicit research phrasing in the spoken turns, and only for
// materials whose prices are still empty (unconfirmed). Stated prices
// ("500g350円") never match; vague words ("安い" alone, "いくら" alone)
// never match. The caller keeps Muse entries first and caps the total,
// so this path only fills gaps instead of duplicating Muse output.
export type ResearchTrigger = {material_name: string; request: string};

const JA_STANDALONE = ["相場", "平均価格", "仕入価格", "仕入れ価格", "仕入値",
  "市場価格", "参考価格", "仕入先", "仕入れ先", "最安", "平均で", "平均を"];
const JA_VERBS = ["調べ", "参考に", "探し"];
const JA_TOPICS = ["価格", "値段", "メーカー", "商品"];
const EN_PHRASES = ["average price", "market price", "reference price", "check the price",
  "look up the price", "lookup the price", "find a cheaper", "cheaper supplier",
  "compare prices", "price check", "at what price"];

function turnRequestsResearch(turn: string): boolean {
  if (JA_STANDALONE.some(k => turn.includes(k))) return true;
  if (JA_VERBS.some(v => turn.includes(v)) && JA_TOPICS.some(t => turn.includes(t))) return true;
  const low = turn.toLowerCase();
  return EN_PHRASES.some(k => low.includes(k));
}

export function detectPriceResearch(turns: string[],
  materials: {name: string; price_jpy: string; price_quantity: string; price_unit: string}[]): ResearchTrigger[] {
  const hits = turns.filter(t => typeof t === "string" && turnRequestsResearch(t));
  if (!hits.length) return [];
  const request = hits[0].trim().slice(0, 200);
  const out: ResearchTrigger[] = [];
  for (const m of materials) {
    const name = (m.name || "").trim();
    if (!name || out.length >= 10) continue;
    // Only unconfirmed lines: never re-search an already priced ingredient.
    if (m.price_jpy || m.price_quantity || m.price_unit) continue;
    out.push({material_name: name, request});
  }
  return out;
}
