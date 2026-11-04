"""Adopted offer resolution contract: no live database or AI billing required."""
import unittest
from types import SimpleNamespace

from chef_ai_workspace.models import Ingredient, MaterialLine, PriceQuote, Recipe, TrackedValue
from chef_ai_workspace.costing import calculate_cost
from chef_ai_workspace.supabase_adapter import SupabasePersistence


def tv(value):
    return TrackedValue(str(value), "confirmed", "user")


class Query:
    def __init__(self, rows):
        self.rows = rows

    def select(self, *args):
        return self

    def eq(self, field, value):
        self.rows = [row for row in self.rows if row.get(field) == value]
        return self

    def in_(self, field, values):
        self.rows = [row for row in self.rows if row.get(field) in values]
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


class Client:
    def __init__(self):
        self.data = {
            "offers": [
                dict(id="offer-a", owner_id="owner", ingredient_id="ingredient",
                     supplier_id="supplier", package_quantity="3500", package_unit="g",
                     package_unit_id=None, adopted_observation_id="observation-a"),
                dict(id="offer-b", owner_id="owner", ingredient_id="ingredient",
                     supplier_id="supplier", package_quantity="3500", package_unit="g",
                     package_unit_id=None, adopted_observation_id="observation-b"),
                dict(id="offer-foreign", owner_id="other", ingredient_id="ingredient",
                     supplier_id="supplier", package_quantity="3500", package_unit="g",
                     package_unit_id=None, adopted_observation_id="observation-foreign"),
            ],
            "price_observations": [
                dict(id="observation-a", owner_id="owner", offer_id="offer-a",
                     amount_jpy="1800", currency="JPY", confirmed=True),
                dict(id="observation-b", owner_id="owner", offer_id="offer-b",
                     amount_jpy="1650", currency="JPY", confirmed=True),
                dict(id="observation-foreign", owner_id="other", offer_id="offer-foreign",
                     amount_jpy="1", currency="JPY", confirmed=True),
            ],
        }

    def table(self, name):
        return Query([dict(row) for row in self.data[name]])


class ApprovedOfferResolutionTests(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.repository = SupabasePersistence(self.client)
        self.catalog = {"ingredient": Ingredient(
            "ingredient", "Tomato", PriceQuote(tv("999"), "3500", "g", "manual"))}

    def recipe(self, offer=None):
        return Recipe("recipe", tv("Tomato soup"), (
            MaterialLine("line", tv("Tomato"), tv("500"), "g",
                         ingredient_id="ingredient", supplier_id="supplier",
                         offer_id=offer, price_mode="inherit"),))

    def test_supplier_only_is_ambiguous_when_two_offers_are_adopted(self):
        recipe = self.recipe()
        quotes = self.repository.load_owned_supplier_prices("owner", recipe)
        self.assertNotIn(("ingredient", "supplier"), quotes)
        result = calculate_cost(recipe, self.catalog, supplier_prices=quotes)
        self.assertTrue(result.partial)
        self.assertIsNone(result.total_cost_jpy)

    def test_explicit_offer_resolves_only_its_approved_observation(self):
        recipe = self.recipe("offer-b")
        quotes = self.repository.load_owned_supplier_prices("owner", recipe)
        self.assertEqual(
            quotes[("ingredient", "offer:offer-b")].amount_jpy.value, "1650")
        result = calculate_cost(recipe, self.catalog, supplier_prices=quotes)
        self.assertFalse(result.partial)
        self.assertEqual(str(result.total_cost_jpy), "236")
        self.assertNotIn(("ingredient", "offer:offer-a"), quotes)

    def test_foreign_offer_cannot_supply_quote(self):
        recipe = self.recipe("offer-foreign")
        quotes = self.repository.load_owned_supplier_prices("owner", recipe)
        self.assertEqual(quotes, {})
        result = calculate_cost(recipe, self.catalog, supplier_prices=quotes)
        self.assertTrue(result.partial)

    def test_unconfirmed_adoption_does_not_supply_a_quote(self):
        self.client.data["price_observations"][1]["confirmed"] = False
        recipe = self.recipe("offer-b")
        quotes = self.repository.load_owned_supplier_prices("owner", recipe)
        self.assertEqual(quotes, {})
        self.assertTrue(calculate_cost(
            recipe, self.catalog, supplier_prices=quotes).partial)


if __name__ == "__main__":
    unittest.main()
