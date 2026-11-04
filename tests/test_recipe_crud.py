"""Regression tests for master-backed CRUD (no database or API credits needed)."""
import unittest
from dataclasses import asdict, replace
from uuid import uuid4

from chef_ai_workspace.models import Recipe, MaterialLine, TrackedValue, Ingredient, PriceQuote
from chef_ai_workspace.mutations import Proposal, MutationError
from chef_ai_workspace.recipe_crud import save_recipe_crud


def tv(value):
    return TrackedValue(str(value), "confirmed", "user")


class Repository:
    def __init__(self):
        self.recipe_id = str(uuid4())
        self.ingredient_id = str(uuid4())
        self.recipe = Recipe(self.recipe_id, tv("Pasta"), (
            MaterialLine(str(uuid4()), tv("Pasta"), tv("100"), "g",
                         ingredient_id=self.ingredient_id, price_mode="inherit"),
        ))
        self.ingredients = {self.ingredient_id: Ingredient(self.ingredient_id, "Pasta",
            PriceQuote(tv("400"), "1", "kg", "manual"))}
        self.receipts = {}
        self.commits = []
        self.supplier_prices = {}

    def get_mutation_receipt(self, owner, request):
        return self.receipts.get(request)

    def load_owned_recipe(self, owner, recipe_id):
        assert recipe_id == self.recipe_id
        return self.recipe

    def load_owned_catalog(self, owner, recipe):
        return {i: self.ingredients[i] for i in
                {line.ingredient_id for line in recipe.materials if line.ingredient_id}
                if i in self.ingredients}

    def load_owned_ingredients(self, owner, ids):
        return {i: self.ingredients[i] for i in ids if i in self.ingredients}

    def find_owned_ingredients_exact(self, owner, name):
        return [{"id": i, "name": ingredient.name} for i, ingredient
                in self.ingredients.items() if ingredient.name.casefold() == name.casefold()]

    def load_owned_supplier_prices(self, owner, recipe):
        return self.supplier_prices

    def list_owned_units(self, owner):
        return [{"id": str(uuid4()), "symbol": "g", "dimension": "mass",
                 "base_factor": "1", "aliases": []},
                {"id": str(uuid4()), "symbol": "kg", "dimension": "mass",
                 "base_factor": "1000", "aliases": []}]

    def commit_recipe_crud(self, **kwargs):
        self.commits.append(kwargs)
        for entry in kwargs["ingredient_entries"]:
            ingredient = self.ingredients.get(entry["id"])
            quote = next((p["quote"] for p in entry["purchases"] if not p["supplier_id"]),None)
            if quote:
                from chef_ai_workspace.supabase_adapter import _quote
                new_quote = _quote(quote)
            else:
                new_quote = ingredient.current_price if ingredient else None
            self.ingredients[entry["id"]] = Ingredient(entry["id"], entry["name"], new_quote)
        from chef_ai_workspace.supabase_adapter import decode_recipe
        self.recipe = decode_recipe(kwargs["state"])
        self.receipts[kwargs["request_id"]] = (
            kwargs["payload_hash"], self.recipe.revision)
        return self.recipe.revision


class RecipeCrudTests(unittest.TestCase):
    def setUp(self):
        self.repo = Repository()

    def save(self, *operations):
        proposal = Proposal(self.repo.recipe_id, self.repo.recipe.revision,
                            str(uuid4()), tuple(operations))
        return save_recipe_crud(owner_id=str(uuid4()), proposal=proposal,
                                repository=self.repo)

    def test_price_edits_master_not_recipe_line(self):
        line = self.repo.recipe.materials[0]
        saved = self.save({"op": "set_material_price", "material_id": line.id,
                           "price_jpy": "450", "price_quantity": "1", "price_unit": "kg"})
        self.assertEqual(saved.recipe.materials[0].price_mode, "inherit")
        self.assertIsNone(saved.recipe.materials[0].price_override)
        self.assertEqual(self.repo.ingredients[self.repo.ingredient_id].current_price.amount_jpy.value, "450")
        self.assertEqual(len(self.repo.commits), 1)

    def test_quantity_and_supplier_edit_remain_master_linked(self):
        line = self.repo.recipe.materials[0]
        supplier = str(uuid4())
        saved = self.save({"op": "set_material_quantity", "material_id": line.id,
                           "value": "120", "unit": "g"},
                          {"op": "set_material_supplier", "material_id": line.id,
                           "supplier_id": supplier})
        self.assertEqual(saved.recipe.materials[0].quantity.value, "120")
        self.assertEqual(saved.recipe.materials[0].supplier_id, supplier)
        self.assertEqual(saved.recipe.materials[0].price_mode, "inherit")

    def test_purchase_term_id_preserved_and_snapshotted(self):
        supplier, offer = str(uuid4()), str(uuid4())
        self.repo.supplier_prices[(self.repo.ingredient_id, f"offer:{offer}")] = PriceQuote(
            tv("1650"), "3500", "g", "manual")
        line = self.repo.recipe.materials[0]
        saved = self.save({"op": "set_material_supplier", "material_id": line.id,
                           "supplier_id": supplier, "offer_id": offer})
        self.assertEqual(saved.recipe.materials[0].offer_id, offer)
        self.assertEqual(self.repo.commits[-1]["state"]["materials"][0]["offer_id"], offer)
        snapshot = self.repo.commits[-1]["cost_snapshot"]
        self.assertFalse(snapshot["partial"])
        self.assertEqual(snapshot["total_cost_jpy"], "47")
        self.assertEqual(
            snapshot["effective_quotes"][line.id]["effective_quote"]["amount_jpy"]["value"],
            "1650")

    def test_supplier_price_cannot_mutate_shared_master(self):
        supplier = str(uuid4())
        line = self.repo.recipe.materials[0]
        self.repo.recipe = replace(self.repo.recipe, materials=(
            replace(line, supplier_id=supplier),))
        self.save({"op":"set_material_price","material_id":line.id,"price_jpy":"123","price_quantity":"1","price_unit":"kg"})
        self.assertEqual(self.repo.ingredients[self.repo.ingredient_id].current_price.amount_jpy.value,"400")
        entry=self.repo.commits[0]["ingredient_entries"][0]
        self.assertNotIn("current_price",entry)
        self.assertEqual(entry["purchases"][0]["supplier_id"],supplier)
        self.assertEqual(entry["purchases"][0]["quote"]["amount_jpy"]["value"],"123")

    def test_explicit_offer_price_absent_keeps_cost_partial(self):
        supplier, offer = str(uuid4()), str(uuid4())
        line = self.repo.recipe.materials[0]
        self.repo.recipe = replace(self.repo.recipe, materials=(
            replace(line, supplier_id=supplier, offer_id=offer),))
        saved = self.save({"op": "set_material_quantity", "material_id": line.id,
                           "value": "120", "unit": "g"})
        snapshot = self.repo.commits[-1]["cost_snapshot"]
        self.assertTrue(snapshot["partial"])
        self.assertIsNone(snapshot["total_cost_jpy"])
        self.assertEqual(saved.recipe.materials[0].offer_id, offer)

    def test_renaming_to_another_master_drops_old_purchase_identity(self):
        old_line = self.repo.recipe.materials[0]
        supplier, offer, other = str(uuid4()), str(uuid4()), str(uuid4())
        self.repo.ingredients[other] = Ingredient(
            other, "Tomato", PriceQuote(tv("300"), "1", "kg", "manual"))
        self.repo.recipe = replace(self.repo.recipe, materials=(
            replace(old_line, supplier_id=supplier, offer_id=offer),))
        saved = self.save({"op": "set_material_name",
                           "material_id": old_line.id, "value": "Tomato"})
        line = saved.recipe.materials[0]
        self.assertEqual(line.ingredient_id, other)
        self.assertIsNone(line.supplier_id)
        self.assertIsNone(line.offer_id)
        self.assertEqual(self.repo.commits[-1]["state"]["materials"][0]["offer_id"], None)

    def test_clear_supplier_and_offer_then_edit_market_price(self):
        old_line = self.repo.recipe.materials[0]
        self.repo.recipe = replace(self.repo.recipe, materials=(replace(
            old_line, supplier_id=str(uuid4()), offer_id=str(uuid4())),))
        saved = self.save(
            {"op": "set_material_supplier", "material_id": old_line.id,
             "supplier_id": "", "offer_id": ""},
            {"op": "set_material_price", "material_id": old_line.id,
             "price_jpy": "500", "price_quantity": "1", "price_unit": "kg"})
        line = saved.recipe.materials[0]
        self.assertIsNone(line.supplier_id)
        self.assertIsNone(line.offer_id)
        self.assertEqual(self.repo.ingredients[line.ingredient_id].current_price.amount_jpy.value, "500")
        self.assertEqual(self.repo.commits[-1]["cost_snapshot"]["total_cost_jpy"], "50")

    def test_switching_supplier_clears_selected_offer(self):
        old_line = self.repo.recipe.materials[0]
        supplier, offer, other_supplier = str(uuid4()), str(uuid4()), str(uuid4())
        self.repo.recipe = replace(self.repo.recipe, materials=(
            replace(old_line, supplier_id=supplier, offer_id=offer),))
        saved = self.save({"op": "set_material_supplier", "material_id": old_line.id,
                           "supplier_id": other_supplier})
        line = saved.recipe.materials[0]
        self.assertEqual(line.supplier_id, other_supplier)
        self.assertIsNone(line.offer_id)
        self.assertTrue(self.repo.commits[-1]["cost_snapshot"]["partial"])

    def test_same_name_different_ingredient_ids_update_only_selected_master(self):
        other_id = str(uuid4())
        from dataclasses import replace
        line = self.repo.recipe.materials[0]
        self.repo.ingredients[other_id] = Ingredient(other_id, "Pasta",
            PriceQuote(tv("700"), "1", "kg", "manual"))
        self.repo.recipe = replace(self.repo.recipe, materials=(
            line, replace(line, id=str(uuid4()), ingredient_id=other_id)))
        saved = self.save({"op": "set_material_price",
                           "material_id": self.repo.recipe.materials[1].id,
                           "price_jpy": "900", "price_quantity": "1", "price_unit": "kg"})
        writes = {entry["id"]: entry for entry in self.repo.commits[0]["ingredient_entries"]}
        self.assertFalse(writes[self.repo.ingredient_id]["purchases"])
        self.assertEqual(writes[other_id]["purchases"][0]["quote"]["amount_jpy"]["value"], "900")
        self.assertEqual(self.repo.ingredients[self.repo.ingredient_id].current_price.amount_jpy.value, "400")
        self.assertEqual(self.repo.ingredients[other_id].current_price.amount_jpy.value, "900")

    def test_remove_and_title_edit(self):
        line = self.repo.recipe.materials[0]
        saved = self.save({"op": "remove_material", "material_id": line.id},
                          {"op": "set_title", "value": "New title"})
        self.assertEqual(saved.recipe.materials, ())
        self.assertEqual(saved.recipe.title.value, "New title")
