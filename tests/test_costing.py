"""Run: python -m unittest discover -s tests -v"""
import unittest
from dataclasses import replace
from decimal import Decimal
from chef_ai_workspace import Ingredient, MaterialLine, PriceQuote, Recipe, TrackedValue, calculate_cost as _calculate_cost


# Fixture-defined unit master ratios, not an application whitelist.
UNITS = {
    "g": ("mass", Decimal("1")), "kg": ("mass", Decimal("1000")),
    "ml": ("volume", Decimal("1")), "L": ("volume", Decimal("1000")),
}
def calculate_cost(recipe, catalog=None):
    return _calculate_cost(recipe, catalog, UNITS)


def known(value, status="confirmed", origin="user"):
    return TrackedValue(str(value), status, origin)


def quote(price, per="1", unit="尾", status="confirmed"):
    return PriceQuote(known(price, status, "ai" if status == "assumed" else "user"), per, unit, "estimated" if status == "assumed" else "manual")


def recipe(line, adjustment="0", selling="1800"):
    return Recipe("r1", known("海老のパスタ"), (line,), known(selling), known(adjustment))


class CostTests(unittest.TestCase):
    def test_quantity_change_exact_150(self):
        line = MaterialLine("m1", known("海老"), known("3"), "尾", price_override=quote("150"))
        self.assertEqual(calculate_cost(recipe(line)).total_cost_jpy, Decimal("450"))
        self.assertEqual(calculate_cost(recipe(replace(line, quantity=known("4")))).total_cost_jpy, Decimal("600"))

    def test_assumed_price_is_estimate(self):
        line = MaterialLine("m1", known("海老"), known("3"), "尾", price_override=quote("120", status="assumed"))
        self.assertTrue(calculate_cost(recipe(line)).estimated)

    def test_missing_price_is_partial_not_zero_total(self):
        line = MaterialLine("m1", known("海老"), known("3"), "尾")
        result = calculate_cost(recipe(line))
        self.assertTrue(result.partial)
        self.assertIsNone(result.total_cost_jpy)
        self.assertIsNone(result.cost_rate_pct)

    def test_linked_ingredient_and_preserved_display_name(self):
        line = MaterialLine("m1", known("でんぷん"), known("100"), "g", ingredient_id="i1", price_mode="inherit")
        product = Ingredient("i1", "片栗粉", quote("500", "1", "kg"))
        result = calculate_cost(recipe(line), {"i1": product})
        self.assertEqual(result.total_cost_jpy, Decimal("50"))
        self.assertEqual(line.material_name.value, "でんぷん")
        self.assertEqual(result.line_price_sources["m1"], "shared_ingredient")

    def test_supplier_selection_changes_current_cost_without_changing_ingredient_id(self):
        line = MaterialLine("m1", known("トマト水煮"), known("500"), "g",
                            ingredient_id="i1", supplier_id="sup-a", price_mode="inherit")
        product = Ingredient("i1", "トマト水煮", quote("1800", "3500", "g"))
        suppliers = {("i1", "sup-a"): quote("1800", "3500", "g"),
                     ("i1", "sup-b"): quote("1650", "3500", "g")}
        a = _calculate_cost(recipe(line), {"i1": product}, UNITS, suppliers)
        b = _calculate_cost(recipe(replace(line, supplier_id="sup-b")),
                            {"i1": product}, UNITS, suppliers)
        self.assertEqual(a.line_costs["m1"], Decimal("500") * Decimal("1800") / 3500)
        self.assertEqual(b.line_costs["m1"], Decimal("500") * Decimal("1650") / 3500)
        self.assertEqual(line.ingredient_id, "i1")

    def test_explicit_offer_id_selects_purchase_term_with_same_supplier(self):
        line = MaterialLine("m1", known("トマト水煮"), known("500"), "g",
                            ingredient_id="i1", supplier_id="sup-a",
                            offer_id="offer-2", price_mode="inherit")
        product = Ingredient("i1", "トマト水煮", quote("999", "3500", "g"))
        selected = {("i1", "offer-1"): quote("1800", "3500", "g"),
                    ("i1", "offer-2"): quote("1650", "3500", "g")}
        result = _calculate_cost(recipe(line), {"i1": product}, UNITS, selected)
        self.assertFalse(result.partial)
        self.assertEqual(result.line_costs["m1"], Decimal("500") * Decimal("1650") / 3500)

    def test_explicit_offer_never_falls_back_to_supplier_or_market(self):
        line = MaterialLine("m1", known("トマト水煮"), known("500"), "g",
                            ingredient_id="i1", supplier_id="sup-a",
                            offer_id="offer-missing", price_mode="inherit")
        product = Ingredient("i1", "トマト水煮", quote("999", "3500", "g"))
        selected = {("i1", "sup-a"): quote("1800", "3500", "g")}
        result = _calculate_cost(recipe(line), {"i1": product}, UNITS, selected)
        self.assertTrue(result.partial)
        self.assertIsNone(result.total_cost_jpy)

    def test_offer_requires_linked_inherited_ingredient(self):
        with self.assertRaises(ValueError):
            MaterialLine("m1", known("トマト"), known("1"), "g", offer_id="offer-1")
        with self.assertRaises(ValueError):
            MaterialLine("m1", known("トマト"), known("1"), "g",
                         ingredient_id="i1", offer_id="offer-1", price_mode="override")

    def test_missing_supplier_price_does_not_fall_back_to_shared_or_market_quote(self):
        line = MaterialLine("m1", known("トマト水煮"), known("500"), "g",
                            ingredient_id="i1", supplier_id="sup-a", price_mode="inherit")
        product = Ingredient("i1", "トマト水煮", quote("1650", "3500", "g"))
        result = _calculate_cost(recipe(line), {"i1": product}, UNITS, {})
        self.assertTrue(result.partial)
        self.assertIsNone(result.total_cost_jpy)
        shared = _calculate_cost(recipe(replace(line, supplier_id=None)),
                                 {"i1": product}, UNITS, {})
        self.assertFalse(shared.partial)

    def test_supplier_price_incompatible_unit_is_partial(self):
        line = MaterialLine("m1", known("鶏卵"), known("1"), "個",
                            ingredient_id="i1", supplier_id="sup-a", price_mode="inherit")
        product = Ingredient("i1", "鶏卵", quote("300", "10", "個"))
        result = _calculate_cost(recipe(line), {"i1": product}, UNITS,
                                 {("i1", "sup-a"): quote("300", "1", "パック")})
        self.assertTrue(result.partial)

    def test_unsupported_unit_is_partial(self):
        line = MaterialLine("m1", known("海老"), known("3"), "尾", price_override=quote("300", "100", "g"))
        self.assertTrue(calculate_cost(recipe(line)).partial)

    def test_override_and_adjustment(self):
        line = MaterialLine("m1", known("海老"), known("3"), "尾", ingredient_id="i1", price_override=quote("150"), price_mode="override")
        result = calculate_cost(recipe(line, adjustment="50"), {"i1": Ingredient("i1", "別の海老", quote("10"))})
        self.assertEqual(result.total_cost_jpy, Decimal("500"))
        self.assertEqual(result.line_price_sources["m1"], "line_override")

    def test_rounding(self):
        line = MaterialLine("m1", known("海老"), known("1"), "尾", price_override=quote("1", "3"))
        result = calculate_cost(recipe(line, selling="3"))
        self.assertEqual(result.total_cost_jpy, Decimal("0"))
        self.assertEqual(result.cost_rate_pct, Decimal("0.0"))

    def test_half_yen_boundary_avoid_early_ratio_rounding(self):
        line = MaterialLine("m1", known("でんぷん"), known("1"), "g", price_override=quote("121", "22", "g"))
        result = calculate_cost(recipe(line, selling="100"))
        self.assertEqual(result.line_costs["m1"], Decimal("5.5"))
        self.assertEqual(result.total_cost_jpy, Decimal("6"))
        self.assertEqual(result.cost_rate_pct, Decimal("6.0"))

    def test_reject_invalid_values(self):
        with self.assertRaises(ValueError):
            TrackedValue("100", "confirmed", "ai")
        with self.assertRaises(ValueError):
            quote("-1")
        with self.assertRaises(ValueError):
            Recipe("r", known("test"), selling_price_jpy=known("0"))

    def test_reject_unknown_price_mode(self):
        with self.assertRaises(ValueError):
            MaterialLine("m1", known("海老"), known("1"), "尾", price_mode="unexpected")

    def test_reject_nonnumeric_adjustment(self):
        with self.assertRaises(ValueError):
            Recipe("r1", known("パスタ"), cost_adjustment_jpy=known("not-a-number"))

    def test_reject_known_quantity_without_unit(self):
        with self.assertRaises(ValueError):
            MaterialLine("m1", known("海老"), known("2"), None)

    def test_reject_nonfinite_adjustment(self):
        with self.assertRaises(ValueError):
            Recipe("r1", known("パスタ"), cost_adjustment_jpy=known("NaN"))

    def test_unresolved_adjustment(self):
        line = MaterialLine("m1", known("海老"), known("1"), "尾", price_override=quote("100"))
        r = replace(recipe(line), cost_adjustment_jpy=TrackedValue(None, "unresolved", "system"))
        self.assertTrue(calculate_cost(r).partial)


if __name__ == "__main__":
    unittest.main()
