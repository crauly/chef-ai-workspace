"""M4: voice unpriced save, same-approval register+link, display fallback."""
import unittest
from dataclasses import replace
from uuid import uuid4
from chef_ai_workspace import Recipe, MaterialLine, PriceQuote, TrackedValue
from chef_ai_workspace.costing import calculate_cost
from chef_ai_workspace.display_names import resolve_display_names
from chef_ai_workspace.ingredient_assist import (
    build_approval_request, classify_material)
from chef_ai_workspace.models import Ingredient
from chef_ai_workspace.mutations import MutationError, Proposal, prepare_mutation


def tv(v):
    return TrackedValue(str(v), "confirmed", "user")


LINE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


def recipe():
    return Recipe("r1", tv("Base"), (MaterialLine(LINE_ID, tv("でんぷん"), tv("100"), "g",
                  price_override=PriceQuote(tv("120"), "100", "g", "manual")),), tv("1800"))


class FakeRepo:
    def __init__(self):
        self.current = recipe()
        self.catalog = {"11111111-1111-1111-1111-111111111111":
                        Ingredient("11111111-1111-1111-1111-111111111111", "片栗粉", None)}
        self.receipts = {}
    def load_owned_recipe(self, owner_id, recipe_id):
        return self.current
    def load_owned_catalog(self, owner_id, recipe):
        return dict(self.catalog)
    def load_owned_ingredients(self, owner_id, ids):
        return {i: self.catalog[i] for i in ids if i in self.catalog}
    def get_mutation_receipt(self, owner_id, request_id):
        return self.receipts.get(request_id)
    def commit_recipe_with_ledger(self, **kw):
        from chef_ai_workspace.persistence_service import save_recipe_with_ledger  # noqa
        self.receipts[kw["request_id"]] = (kw["payload_hash"], kw["base_revision"] + 1)
        for item in kw["new_ingredients"]:
            self.catalog[item["id"]] = Ingredient(item["id"], item["name"], None)
        self.current = replace(self.current, revision=kw["base_revision"] + 1)
        # Persist linked lines the way the RPC persists state.
        import copy
        state = kw["state"]
        mats = tuple(MaterialLine(m["id"], TrackedValue(**m["material_name"]),
                                  TrackedValue(**m["quantity"]), m["unit"],
                                  ingredient_id=m.get("ingredient_id"),
                                  price_override=None, price_mode=m.get("price_mode", "override"))
                     if m.get("price_override") is None else
                     MaterialLine(m["id"], TrackedValue(**m["material_name"]),
                                  TrackedValue(**m["quantity"]), m["unit"],
                                  ingredient_id=m.get("ingredient_id"),
                                  price_override=PriceQuote(
                                      TrackedValue(**m["price_override"]["amount_jpy"]),
                                      m["price_override"]["per_quantity"],
                                      m["price_override"]["per_unit"],
                                      m["price_override"]["source"]),
                                  price_mode=m.get("price_mode", "override"))
                     for m in state["materials"])
        self.current = replace(self.current, materials=mats)
        return self.current.revision


class M4FlowTests(unittest.TestCase):
    def test_unpriced_material_partial_no_zero_fill(self):
        out = prepare_mutation(
            recipe(), Proposal("r1", 0, "req-u1", ({"op": "add_unpriced_material",
                "material_id": "22222222-2222-2222-2222-222222222222",
                "name": "塩", "quantity": "少々".replace("少々", "5"), "unit": "g"},)),
            user_confirmed=False, catalog={})
        cost = calculate_cost(out, {})
        self.assertTrue(cost.partial)
        self.assertIn("22222222-2222-2222-2222-222222222222", cost.unresolved_line_ids)
        self.assertNotIn("22222222-2222-2222-2222-222222222222", cost.line_costs)

    def test_unpriced_without_quantity(self):
        out = prepare_mutation(
            recipe(), Proposal("r1", 0, "req-u2", ({"op": "add_unpriced_material",
                "material_id": "33333333-3333-3333-3333-333333333333",
                "name": "胡椒"},)),
            user_confirmed=False, catalog={})
        line = [m for m in out.materials if m.id == "33333333-3333-3333-3333-333333333333"][0]
        self.assertIsNone(line.quantity.value)
        self.assertIsNone(line.price_override)

    def test_unit_without_quantity_rejected(self):
        with self.assertRaises(MutationError):
            prepare_mutation(
                recipe(), Proposal("r1", 0, "req-u3", ({"op": "add_unpriced_material",
                    "material_id": "44444444-4444-4444-4444-444444444444",
                    "name": "塩", "unit": "g"},)),
                user_confirmed=False, catalog={})

    def test_voice_new_ingredient_same_approval_reload(self):
        from chef_ai_workspace.persistence_service import save_recipe_with_ledger
        db = FakeRepo()
        new_id = "55555555-5555-5555-5555-555555555555"
        cand = classify_material("オリーブオイル", db.catalog)
        self.assertEqual(cand.decision, "new")
        ledger, ops = build_approval_request(
            material_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", material_name="オリーブオイル", candidate=cand,
            approved_new=True, new_id=new_id,
            quote={"price_jpy": "200", "price_quantity": "100", "price_unit": "g"})
        out = save_recipe_with_ledger(
            owner_id="u", trusted_user_confirmed=True,
            proposal=Proposal("r1", 0, "req-m4-1", ops),
            ledger=ledger, repository=db, save_version=True)
        self.assertEqual(out.saved_ingredient_ids, (new_id,))
        reloaded = db.load_owned_recipe("u", "r1")
        line = [m for m in reloaded.materials if m.id == LINE_ID][0]
        self.assertEqual(line.ingredient_id, new_id)
        names = resolve_display_names(reloaded, db.catalog)
        self.assertEqual(names[LINE_ID]["display"], "オリーブオイル")
        self.assertEqual(names[LINE_ID]["material"], "でんぷん")

    def test_reuse_past_recipe_ingredient(self):
        from chef_ai_workspace.persistence_service import save_recipe_with_ledger
        db = FakeRepo()
        cand = classify_material("片栗粉", db.catalog)
        self.assertEqual(cand.decision, "reuse")
        ledger, ops = build_approval_request(
            material_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", material_name="でんぷん", candidate=cand,
            approved_ingredient_id="11111111-1111-1111-1111-111111111111",
            inherit_price=False,
            quote={"price_jpy": "150", "price_quantity": "100", "price_unit": "g"})
        out = save_recipe_with_ledger(
            owner_id="u", trusted_user_confirmed=True,
            proposal=Proposal("r1", 0, "req-m4-2", ops),
            ledger=ledger, repository=db, save_version=True)
        self.assertEqual(out.saved_ingredient_ids, ())
        self.assertEqual(
            [m for m in out.recipe.materials if m.id == LINE_ID][0].ingredient_id,
            "11111111-1111-1111-1111-111111111111")

    def test_unlinked_falls_back_to_material_name(self):
        names = resolve_display_names(recipe(), {})
        self.assertEqual(names[LINE_ID]["display"], "でんぷん")


if __name__ == "__main__":
    unittest.main()
