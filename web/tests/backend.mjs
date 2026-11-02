// Isolated browser-test backend. No Supabase connection or real inference.
import {createServer} from "node:http";
import {randomUUID} from "node:crypto";
const id = "11111111-1111-4111-8111-111111111111", materialId = "22222222-2222-4222-8222-222222222222";
const id2 = "33333333-3333-4333-8333-333333333333", id3 = "44444444-4444-4444-8444-444444444444";
const tracked = value => ({value, status: "confirmed", origin: "user"});
const assumed = value => ({value, status: "assumed", origin: "model"});
let recipe, recipes, confirms, corrections, receipts, browseItems, listQueries;
function reset() {
  recipe = {id, title: tracked("片栗粉のレシピ"), revision: 0, materials: [{id: materialId, material_name: tracked("片栗粉"), quantity: tracked("10"), unit: "g", price_mode: "override", price_override: {amount_jpy: tracked("1000"), per_quantity: "1", per_unit: "kg"}}], selling_price_jpy: tracked("1000")};
  // Visual-check fixtures for the recipe detail UI (automated specs use `recipe` only).
  const pasta = {id: id2, title: tracked("ミートソースパスタ"), revision: 0, materials: [
    {id: "33333333-3333-4333-8333-333333333331", material_name: tracked("ディチェコ乾燥パスタ"), quantity: tracked("100"), unit: "g", price_mode: "override", price_override: {amount_jpy: tracked("380"), per_quantity: "500", per_unit: "g"}},
    {id: "33333333-3333-4333-8333-333333333332", material_name: tracked("国産ニンニク"), quantity: assumed("10"), unit: "g", price_mode: "override", price_override: {amount_jpy: assumed("150"), per_quantity: "1", per_unit: "kg"}},
    {id: "33333333-3333-4333-8333-333333333333", material_name: tracked("グラナパダーノ"), quantity: tracked("10"), unit: "g"}],
    selling_price_jpy: tracked("1200")};
  const soup = {id: id3, title: tracked("きのこのクリームスープ"), revision: 0, materials: [
    {id: "44444444-4444-4444-8444-444444444441", material_name: tracked("牛乳"), quantity: tracked("200"), unit: "ml", price_mode: "override", price_override: {amount_jpy: tracked("280"), per_quantity: "1", per_unit: "L"}},
    {id: "44444444-4444-4444-8444-444444444442", material_name: tracked("生クリーム"), quantity: tracked("50"), unit: "ml"}],
    selling_price_jpy: tracked("900")};
  recipes = {[id]: recipe, [id2]: pasta, [id3]: soup};
  confirms = []; corrections = []; receipts = new Map();
  browseItems = Object.values(recipes).map(r => ({id: r.id, title: r.title.value, revision: r.revision})); listQueries = [];
}
reset();
createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const path = new URL(req.url, "http://localhost").pathname;
  function send(status, value) {res.writeHead(status, {"Content-Type": "application/json"}); res.end(JSON.stringify(value));}
  if (path === "/test/reset") {reset(); return send(200, {});}
  if (path === "/test/advance") {recipe.revision++; recipe.materials[0].quantity = tracked("20"); return send(200, {});}
  if (path === "/test/search-fixtures") {
    browseItems = [...Array.from({length: 21}, (_, i) => ({id: `00000000-0000-4000-8000-${String(i).padStart(12,"0")}`, title: "別の料理" + i, revision: 0})), {id, title: recipe.title.value, revision: 0}];
    return send(200, {});
  }
  if (path === "/test/state") return send(200, {confirms, corrections, revision: recipe.revision, listQueries});
  if (req.headers["x-demo-access"] !== "test-only-backend-token") return send(403, {detail: "denied"});
  if (path === "/demo/recipes") {
    const params = new URL(req.url, "http://localhost").searchParams;
    const q = params.get("q") || "", page = Number(params.get("page") || 1), size = Number(params.get("page_size") || 20);
    listQueries.push({q, page});
    const items = browseItems.filter(item => item.title.toLowerCase().includes(q.toLowerCase()));
    return send(200, {items: items.slice((page - 1) * size, page * size)});
  }
  // Fixture-only equivalent of POST /demo/recipes/full: honor the submitted
  // recipe ID and content, never return the unrelated seeded test recipe.
  if (path === "/demo/recipes/full" && req.method === "POST") {
    const uuid = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
    if (!uuid.test(body.request_id ?? "") || typeof body.title !== "string" || !body.title.trim() ||
        !Array.isArray(body.materials) || body.materials.length > 40) return send(422,{detail:"invalid recipe"});
    if (recipes[body.request_id]) return send(200,recipes[body.request_id]);
    const materials=[];
    for (const entry of body.materials) {
      if (typeof entry.name !== "string" || !entry.name.trim()) return send(422,{detail:"missing ingredient name"});
      const hasQuantity=entry.quantity!=null && entry.quantity!=="";
      const hasUnit=entry.unit!=null && entry.unit!=="";
      const priceFields=[entry.price_jpy,entry.price_quantity,entry.price_unit];
      const priced=priceFields.every(value=>value!=null&&value!=="");
      if (hasQuantity!==hasUnit || (priceFields.some(value=>value!=null&&value!=="")&&!priced) ||
          (priced&&!hasQuantity)) return send(422,{detail:"incomplete quantity or price tuple"});
      materials.push({
        id:crypto.randomUUID(),material_name:tracked(entry.name.trim()),
        quantity:hasQuantity?tracked(String(entry.quantity)):{value:null,status:"unresolved",origin:"system"},
        unit:hasUnit?entry.unit:null,price_mode:"override",
        price_override:priced?{amount_jpy:tracked(String(entry.price_jpy)),per_quantity:String(entry.price_quantity),per_unit:entry.price_unit}:null
      });
    }
    const created={id:body.request_id,title:tracked(body.title.trim()),revision:0,materials,
      selling_price_jpy:body.selling_price_jpy==null?{value:null,status:"unresolved",origin:"system"}:tracked(String(body.selling_price_jpy))};
    recipes[created.id]=created;
    browseItems.unshift({id:created.id,title:created.title.value,revision:0});
    return send(201,created);
  }
  const targetId = (path.match(/^\/demo\/recipes\/([^/]+)\//) || [])[1];
  const target = (targetId && recipes[targetId]) || recipe;
  if (path.endsWith("/cost")) return send(200, {total_cost_jpy: target.materials[0].quantity.value, cost_rate_pct: "1.0", estimated: false, partial: false});
  if (path.endsWith("/propose")) {
    if (body.instruction === "failure") return send(502, {detail: "private-test-only-backend-token"});
    const revision = body.instruction === "stale" ? target.revision + 1 : target.revision;
    return send(200, {recipe_id: id, base_revision: revision, requires_confirmation: true, provider: {name: "meta_responses", model: "muse-spark-1.3"}, operations: body.instruction === "empty" ? [] : [{op: "set_material_quantity", material_id: materialId, value: "15", unit: "g"}, {op: "set_selling_price", value_jpy: "1800"}]});
  }
  if (path.endsWith("/confirm")) {
    if (receipts.has(body.request_id)) return send(200, {recipe: target, replayed: true});
    if (body.base_revision !== target.revision) return send(409, {});
    confirms.push(body); receipts.set(body.request_id, body);
    for (const op of body.operations) {
      const line = target.materials.find(m => m.id === op.material_id) || target.materials[0];
      if (op.op === "set_material_quantity") {line.quantity = tracked(op.value); if (op.unit) line.unit = op.unit;}
      if (op.op === "set_material_price") line.price_override = {amount_jpy: tracked(op.price_jpy), per_quantity: op.price_quantity || "1", per_unit: op.price_unit || "g"};
      if (op.op === "set_selling_price") target.selling_price_jpy = tracked(op.value_jpy);
    }
    target.revision++; return send(200, {recipe: target});
  }
  if (path.endsWith("/corrections")) {corrections.push(body); return send(201, {saved: true});}
  const single = path.match(/^\/demo\/recipes\/([^/]+)$/);
  if (single && req.method === "GET") {
    const found = recipes[single[1]];
    if (!found) return send(404, {detail: "not found"});
    return send(200, found);
  }
  return send(200, recipe);
}).listen(8100, "127.0.0.1");
