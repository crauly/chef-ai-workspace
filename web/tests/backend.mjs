// Isolated browser-test backend. No Supabase connection or real inference.
import {createServer} from "node:http";
const id = "11111111-1111-4111-8111-111111111111", materialId = "22222222-2222-4222-8222-222222222222";
const tracked = value => ({value, status: "confirmed", origin: "user"});
let recipe, confirms, corrections, receipts;
function reset() {
  recipe = {id, title: tracked("片栗粉のレシピ"), revision: 0, materials: [{id: materialId, material_name: tracked("片栗粉"), quantity: tracked("10"), unit: "g", price_mode: "override", price_override: {amount_jpy: tracked("1000"), per_quantity: "1", per_unit: "kg"}}], selling_price_jpy: tracked("1000")};
  confirms = []; corrections = []; receipts = new Map();
}
reset();
createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const path = new URL(req.url, "http://localhost").pathname;
  function send(status, value) {res.writeHead(status, {"Content-Type": "application/json"}); res.end(JSON.stringify(value));}
  if (path === "/test/reset") {reset(); return send(200, {});}
  if (path === "/test/state") return send(200, {confirms, corrections, revision: recipe.revision});
  if (req.headers["x-demo-access"] !== "test-only-backend-token") return send(403, {detail: "denied"});
  if (path === "/demo/recipes") return send(200, {items: [{id, title: recipe.title.value, revision: recipe.revision}]});
  if (path.endsWith("/cost")) return send(200, {total_cost_jpy: recipe.materials[0].quantity.value, cost_rate_pct: "1.0", estimated: false, partial: false});
  if (path.endsWith("/propose")) {
    if (body.instruction === "failure") return send(502, {detail: "private-test-only-backend-token"});
    const revision = body.instruction === "stale" ? recipe.revision + 1 : recipe.revision;
    return send(200, {recipe_id: id, base_revision: revision, requires_confirmation: true, operations: body.instruction === "empty" ? [] : [{op: "set_material_quantity", material_id: materialId, value: "15", unit: "g"}, {op: "set_selling_price", value_jpy: "1800"}]});
  }
  if (path.endsWith("/confirm")) {
    if (receipts.has(body.request_id)) return send(200, {recipe, replayed: true});
    if (body.base_revision !== recipe.revision) return send(409, {});
    confirms.push(body); receipts.set(body.request_id, body);
    for (const op of body.operations) {
      if (op.op === "set_material_quantity") recipe.materials[0].quantity = tracked(op.value);
      if (op.op === "set_selling_price") recipe.selling_price_jpy = tracked(op.value_jpy);
    }
    recipe.revision++; return send(200, {recipe});
  }
  if (path.endsWith("/corrections")) {corrections.push(body); return send(201, {saved: true});}
  return send(200, recipe);
}).listen(8100, "127.0.0.1");
