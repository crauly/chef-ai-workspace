"""M4 demo routes: unpriced voice save, ledger confirm, display names.

Calls route functions directly (no TestClient) with a fake repository.
"""
import unittest
from uuid import uuid4
from chef_ai_workspace import Recipe, TrackedValue
from chef_ai_workspace.demo_api import (
    CompleteRecipeBody, ConfirmChangeBody, create_complete_demo_recipe,
    confirm_demo_change, get_demo_recipe)


class FakeRepo:
    def __init__(self):
        self.recipes = {}
        self.catalog = {}
        self.receipts = {}
    def list_owned_units(self, owner_id):
        return [{"id": "test-g", "symbol": "g", "dimension": "mass", "aliases": []}]

    def load_owned_recipe(self, owner_id, recipe_id):
        try:
            return self.recipes[recipe_id]
        except KeyError:
            raise ValueError("Not found") from None
    def load_owned_catalog(self, owner_id, recipe):
        return dict(self.catalog)
    def load_owned_ingredients(self, owner_id, ids):
        return {i: self.catalog[i] for i in ids if i in self.catalog}
    def get_mutation_receipt(self, owner_id, request_id):
        return self.receipts.get(request_id)
    def find_owned_ingredients_exact(self, owner, name):
        return [{"id":id,"name":v.name} for id,v in self.catalog.items()
                if v.name.casefold()==name.casefold()]
    def create_owned_recipe(self, owner, recipe, snapshot, unit_candidates=(), ingredient_entries=()):
        from chef_ai_workspace.models import Ingredient
        from chef_ai_workspace.supabase_adapter import _quote
        for entry in ingredient_entries:
            existing=self.catalog.get(entry["id"])
            price=_quote(entry["current_price"]) if entry["current_price"] else (
                existing.current_price if existing else None)
            self.catalog[entry["id"]]=Ingredient(entry["id"],entry["name"],price)
        if recipe.id in self.recipes:
            raise ValueError("exists")
        from dataclasses import replace
        self.recipes[recipe.id] = replace(recipe, revision=0)
    def commit_recipe_with_ledger(self, **kw):
        from dataclasses import replace
        self.receipts[kw["request_id"]] = (kw["payload_hash"], kw["base_revision"] + 1)
        for item in kw["new_ingredients"]:
            from chef_ai_workspace.models import Ingredient
            self.catalog[item["id"]] = Ingredient(item["id"], item["name"], None)
        current = self.recipes[kw["recipe_id"]]
        self.recipes[kw["recipe_id"]] = replace(current, revision=kw["base_revision"] + 1)
        return kw["base_revision"] + 1


def ctx(repo):
    return ("user-a", repo)


class DemoRouteTests(unittest.TestCase):
    def test_voice_create_without_prices_partial(self):
        repo = FakeRepo()
        body = CompleteRecipeBody(request_id=uuid4(), title="肉じゃが",
                                  materials=[{"name": "牛肉", "quantity": "200",
                                              "unit": "g"}])
        out = create_complete_demo_recipe(body, ctx(repo))
        self.assertIn("materials", out)
        line = out["materials"][0]
        self.assertIsNone(line["price_override"])
        self.assertEqual(line["quantity"]["status"], "confirmed")

    def test_voice_create_partial_price_rejected(self):
        repo = FakeRepo()
        body = CompleteRecipeBody(request_id=uuid4(), title="肉じゃが",
                                  materials=[{"name": "牛肉", "quantity": "200",
                                              "unit": "g", "price_jpy": "500"}])
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            create_complete_demo_recipe(body, ctx(repo))
        self.assertEqual(repo.recipes, {})

    def test_confirm_with_ledger_registers_and_links(self):
        from chef_ai_workspace.demo_api import LedgerEntryBody
        repo = FakeRepo()
        body = CompleteRecipeBody(request_id=uuid4(), title="パスタ",
                                  materials=[{"name": "パスタ", "quantity": "100",
                                              "unit": "g", "price_jpy": "150",
                                              "price_quantity": "100",
                                              "price_unit": "g"}])
        created = create_complete_demo_recipe(body, ctx(repo))
        line_id = created["materials"][0]["id"]
        new_id = str(uuid4())
        confirm = ConfirmChangeBody(
            base_revision=0, request_id=uuid4(),
            operations=[{"op": "link_ingredient", "material_id": line_id,
                         "ingredient_id": new_id, "price_mode": "override",
                         "price_jpy": "150", "price_quantity": "100",
                         "price_unit": "g"}],
            ledger=[LedgerEntryBody(kind="new", id=new_id, name="パスタ")])
        out = confirm_demo_change(created["id"], confirm, ctx(repo))
        self.assertEqual(out["saved_ingredient_ids"], [new_id])
        self.assertFalse(out["replayed"])

    def test_get_recipe_includes_display_names(self):
        repo = FakeRepo()
        body = CompleteRecipeBody(request_id=uuid4(), title="パスタ",
                                  materials=[{"name": "パスタ", "quantity": "100",
                                              "unit": "g", "price_jpy": "150",
                                              "price_quantity": "100",
                                              "price_unit": "g"}])
        created = create_complete_demo_recipe(body, ctx(repo))
        out = get_demo_recipe(created["id"], ctx(repo))
        line_id = created["materials"][0]["id"]
        self.assertEqual(out["display_names"][line_id]["display"], "パスタ")


if __name__ == "__main__":
    unittest.main()
