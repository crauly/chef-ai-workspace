"""Run: python -m unittest discover -s tests -v"""
import unittest
from dataclasses import replace
from decimal import Decimal
from chef_ai_workspace import Ingredient, MaterialLine, PriceQuote, Recipe, TrackedValue, calculate_cost


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
