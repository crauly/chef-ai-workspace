// Backup price-research trigger for when Muse omits price_research.
//
// The system prompt requires Muse to emit one price_research entry per
// researched ingredient, but a missed entry must not silently drop an
// explicit chef request. This detector is deliberately narrow: it fires
// only on explicit research phrasing in the spoken turns, and only for
// materials whose prices are still empty (unconfirmed). Stated prices
// ("500g350円") never match; vague words ("安い" alone, "いくら" alone)
// never match.
//
// Scoping: a request naming an ingredient targets ONLY that ingredient
// ("サフランの価格を調べて" researches saffron, never the whole draft),
// so the route's entry cap cannot eject the named ingredient in favor of
// unrelated lines. All unpriced materials are targeted only for an
// explicit recipe-wide request ("全食材の平均価格を調べて",
// "all ingredients"). A deictic request naming nothing ("この食材の価格を
// 調べて") resolves only when a single unpriced line exists; otherwise it
// targets nothing rather than guessing. The caller keeps Muse entries
// first and caps the total, so this path only fills gaps instead of
// duplicating Muse output.
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

const JA_RECIPE_WIDE = ["全食材", "すべての食材", "全ての食材", "すべての材料",
  "全ての材料", "全部の食材", "全部の材料", "レシピ全体", "全材料", "全部"];
const EN_RECIPE_WIDE = ["all ingredients", "every ingredient", "all of them",
  "whole recipe", "entire recipe"];

function turnIsRecipeWide(turn: string): boolean {
  if (JA_RECIPE_WIDE.some(k => turn.includes(k))) return true;
  return EN_RECIPE_WIDE.some(k => turn.toLowerCase().includes(k));
}

export function detectPriceResearch(turns: string[],
  materials: {name: string; price_jpy: string; price_quantity: string; price_unit: string}[]): ResearchTrigger[] {
  const hits = turns.filter(t => typeof t === "string" && turnRequestsResearch(t));
  if (!hits.length) return [];
  // Only unconfirmed lines: never re-search an already priced ingredient.
  const open = materials.filter(m => (m.name || "").trim() &&
    !m.price_jpy && !m.price_quantity && !m.price_unit);
  if (!open.length) return [];
  const lowered = hits.map(t => t.toLowerCase());
  // Named ingredients first: each named line gets the turn that named it.
  const named = open.filter(m => lowered.some(t => t.includes(m.name.trim().toLowerCase())));
  if (named.length) {
    return named.slice(0, 10).map(m => {
      const turn = hits[lowered.findIndex(t => t.includes(m.name.trim().toLowerCase()))];
      return {material_name: m.name.trim(), request: turn.trim().slice(0, 200)};
    });
  }
  if (hits.some(turnIsRecipeWide)) {
    const request = hits[0].trim().slice(0, 200);
    return open.slice(0, 10).map(m => ({material_name: m.name.trim(), request}));
  }
  // Deictic ("この食材") with a single open line: that line is unambiguous.
  // With several open lines and no names, guessing would mis-search, so none.
  if (open.length === 1) {
    return [{material_name: open[0].name.trim(), request: hits[0].trim().slice(0, 200)}];
  }
  return [];
}
