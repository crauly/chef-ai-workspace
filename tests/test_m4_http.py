"""M4 HTTP regression: assist/search wiring, one-shot confirm, display, 422s."""
import unittest
from dataclasses import replace
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace import Recipe, MaterialLine, PriceQuote, TrackedValue
from chef_ai_workspace.models import Ingredient


def tv(v):
    return TrackedValue(str(v), "confirmed", "user")


LINE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
PASTA_ID = "11111111-1111-1111-1111-111111111111"
RECIPE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


class Repo:
    def __init__(self):
        self.owner = OWNER
        self.recipes = {RECIPE_ID: Recipe(
            RECIPE_ID, tv("パスタ"), (MaterialLine(
                LINE_ID, tv("パスタ"), tv("100"), "g",
                price_override=PriceQuote(tv("150"), "100", "g", "manual")),),
            tv("1800"))}
        self.catalog = {PASTA_ID: Ingredient(PASTA_ID, "乾燥パスタ", None)}
        self.receipts = {}
        self.search_calls = []
    def list_owned_units(self, owner_id):
        return [{"id": "test-g", "symbol": "g", "dimension": "mass", "aliases": []}]

    def load_owned_recipe(self, owner_id, recipe_id):
        if owner_id != self.owner or recipe_id not in self.recipes:
            raise ValueError("Not found")
        return self.recipes[recipe_id]
    def load_owned_catalog(self, owner_id, recipe):
        return dict(self.catalog)
    def load_owned_ingredients(self, owner_id, ids):
        return {i: self.catalog[i] for i in ids if i in self.catalog}
    def search_owned_ingredients(self, owner_id, query, limit=20):
        assert owner_id == self.owner, "owner must be server-derived"
        self.search_calls.append(query)
        return [{"id": g.id, "name": g.name}
                for g in self.catalog.values() if query in g.name][:limit]
    def get_mutation_receipt(self, owner_id, request_id):
        return self.receipts.get(request_id)
    def commit_recipe_with_ledger(self, **kw):
        state = kw.get("state") or {}
        revised = state.get("revision", kw["base_revision"] + 1)
        self.receipts[kw["request_id"]] = (kw["payload_hash"], revised)
        for item in kw["new_ingredients"]:
            self.catalog[item["id"]] = Ingredient(item["id"], item["name"], None)
        current = self.recipes[kw["recipe_id"]]
        # Persist the canonical state the orchestration committed, the way
        # the atomic RPC would, so a reload shows the same links.
        by_id = {m.get("id"): m for m in state.get("materials", [])}
        lines = [replace(m, ingredient_id=(by_id[m.id].get("ingredient_id")
                                           if m.id in by_id else m.ingredient_id))
                 for m in current.materials]
        self.recipes[kw["recipe_id"]] = replace(
            current, materials=tuple(lines), revision=revised)
        return revised


class M4HttpTests(unittest.TestCase):
    def setUp(self):
        self.repo = Repo()
        app.state.demo_owner_id = OWNER
        app.state.demo_access_token = "test-secret"
        app.state.repository_factory = lambda: self.repo
        self.client = TestClient(app, raise_server_exceptions=False)
        self.h = {"X-Demo-Access": "test-secret"}

    def tearDown(self):
        self.client.close()
        del app.state.demo_owner_id
        del app.state.demo_access_token
        del app.state.repository_factory

    def test_search_requires_access_and_scopes_owner(self):
        self.assertEqual(self.client.get("/demo/ingredients/search?q=パスタ").status_code, 403)
        r = self.client.get("/demo/ingredients/search?q=パスタ", headers=self.h)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["items"][0]["id"], PASTA_ID)
        self.assertEqual(self.repo.search_calls, ["パスタ"])

    def test_assist_reuse_and_new_with_suggested_id(self):
        r = self.client.post(f"/demo/recipes/{RECIPE_ID}/ingredient-assist",
                             json={"material_id": LINE_ID, "name": "乾燥パスタ"},
                             headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["decision"], "reuse")
        r = self.client.post(f"/demo/recipes/{RECIPE_ID}/ingredient-assist",
                             json={"material_id": LINE_ID, "name": "オリーブオイル"},
                             headers=self.h)
        body = r.json()
        self.assertEqual(body["decision"], "new")
        self.assertIn("suggested_new_id", body)

    def test_assist_unknown_material_is_404(self):
        r = self.client.post(f"/demo/recipes/{RECIPE_ID}/ingredient-assist",
                             json={"material_id": str(uuid4()), "name": "塩"},
                             headers=self.h)
        self.assertEqual(r.status_code, 404)

    def test_confirm_one_shot_register_link_shows_display(self):
        new_id = str(uuid4())
        r = self.client.post(f"/demo/recipes/{RECIPE_ID}/confirm", headers=self.h, json={
            "base_revision": 0, "request_id": str(uuid4()),
            "operations": [{"op": "link_ingredient", "material_id": LINE_ID,
                            "ingredient_id": new_id, "price_mode": "override",
                            "price_jpy": "200", "price_quantity": "100",
                            "price_unit": "g"}],
            "ledger": [{"kind": "new", "id": new_id, "name": "オリーブオイル"}]})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["saved_ingredient_ids"], [new_id])
        self.assertEqual(body["recipe"]["display_names"][LINE_ID]["display"],
                         "オリーブオイル")
        self.assertEqual(body["recipe"]["display_names"][LINE_ID]["material"], "パスタ")

    def test_assist_to_confirm_to_reload_same_id(self):
        # End-to-end with one ID: assist issues suggested_new_id, the same ID
        # registers+links in confirm, and reload shows the link and display.
        assist = self.client.post(f"/demo/recipes/{RECIPE_ID}/ingredient-assist",
                                  json={"material_id": LINE_ID, "name": "オリーブオイル"},
                                  headers=self.h)
        self.assertEqual(assist.status_code, 200, assist.text)
        self.assertEqual(assist.json()["decision"], "new")
        new_id = assist.json()["suggested_new_id"]
        confirm = self.client.post(f"/demo/recipes/{RECIPE_ID}/confirm", headers=self.h, json={
            "base_revision": 0, "request_id": str(uuid4()),
            "operations": [{"op": "link_ingredient", "material_id": LINE_ID,
                            "ingredient_id": new_id, "price_mode": "override",
                            "price_jpy": "200", "price_quantity": "100",
                            "price_unit": "g"}],
            "ledger": [{"kind": "new", "id": new_id, "name": "オリーブオイル"}]})
        self.assertEqual(confirm.status_code, 200, confirm.text)
        self.assertEqual(confirm.json()["saved_ingredient_ids"], [new_id])
        reloaded = self.client.get(f"/demo/recipes/{RECIPE_ID}", headers=self.h)
        self.assertEqual(reloaded.status_code, 200, reloaded.text)
        reloaded_line = next(m for m in reloaded.json()["materials"] if m["id"] == LINE_ID)
        self.assertEqual(reloaded_line["ingredient_id"], new_id)
        self.assertEqual(reloaded.json()["display_names"][LINE_ID]["display"],
                         "オリーブオイル")

    def test_price_unit_only_is_422(self):
        r = self.client.post("/demo/recipes/full", headers=self.h, json={
            "request_id": str(uuid4()), "title": "t",
            "materials": [{"name": "塩", "quantity": "5", "unit": "g",
                           "price_unit": "g"}]})
        self.assertEqual(r.status_code, 422)

    def test_incomplete_ledger_and_prices_are_422(self):
        base = {"base_revision": 0, "request_id": str(uuid4()),
                "operations": [{"op": "set_title", "value": "x"}]}
        r = self.client.post(f"/demo/recipes/{RECIPE_ID}/confirm", headers=self.h, json={
            **base, "ledger": [{"kind": "new"}]})
        self.assertEqual(r.status_code, 422)
        r = self.client.post(f"/demo/recipes/{RECIPE_ID}/confirm", headers=self.h, json={
            **base, "ledger": [{"kind": "reuse"}]})
        self.assertEqual(r.status_code, 422)
        r = self.client.post("/demo/recipes/full", headers=self.h, json={
            "request_id": str(uuid4()), "title": "t",
            "materials": [{"name": "塩", "quantity": "5", "unit": "g",
                           "price_jpy": "10"}]})
        self.assertEqual(r.status_code, 422)

    def test_get_recipe_shows_display_names(self):
        r = self.client.get(f"/demo/recipes/{RECIPE_ID}", headers=self.h)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["display_names"][LINE_ID]["display"], "パスタ")


if __name__ == "__main__":
    unittest.main()
