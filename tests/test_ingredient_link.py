"""Link/unlink operations: explicit inherit/override, no silent catalog reuse."""
import unittest
from chef_ai_workspace.models import Ingredient, MaterialLine, PriceQuote, Recipe, TrackedValue
from chef_ai_workspace.costing import calculate_cost
from chef_ai_workspace.mutations import Proposal, prepare_mutation, MutationError


def tv(v, status="confirmed"):
    return TrackedValue(v, status, "user" if status == "confirmed" else "ai")


def quote(amount, per_q="1", per_u="g", status="confirmed"):
    return PriceQuote(tv(amount, status), per_q, per_u,
                      "manual" if status == "confirmed" else "estimated")


def fixture():
    line = MaterialLine("m1", tv("でんぷん"), tv("100"), "g",
                        price_override=quote("120", "100", "g"))
    return Recipe("r1", tv("テスト"), (line,), tv("1800"))


def catalog():
    return {"11111111-1111-1111-1111-111111111111":
            Ingredient("11111111-1111-1111-1111-111111111111", "片栗粉",
                       quote("150", "100", "g"))}


IID = "11111111-1111-1111-1111-111111111111"


def apply(recipe, ops, confirmed=True, cat=None):
    return prepare_mutation(recipe, Proposal("r1", recipe.revision, "req-link", tuple(ops)),
                            user_confirmed=confirmed, catalog=cat)


class LinkTest(unittest.TestCase):
    def test_link_inherit_uses_catalog_and_keeps_display_name(self):
        out = apply(fixture(), [{"op": "link_ingredient", "material_id": "m1",
                                 "ingredient_id": IID, "price_mode": "inherit"}],
                    cat=catalog())
        line = out.materials[0]
        self.assertEqual(line.material_name.value, "でんぷん")
        self.assertEqual(line.price_mode, "inherit")
        cost = calculate_cost(out, catalog())
        self.assertEqual(cost.line_price_sources["m1"], "shared_ingredient")
        self.assertEqual(cost.line_costs["m1"], 150)

    def test_link_requires_explicit_price_mode(self):
        with self.assertRaises(MutationError):
            apply(fixture(), [{"op": "link_ingredient", "material_id": "m1",
                               "ingredient_id": IID}], cat=catalog())
        with self.assertRaises(MutationError):
            apply(fixture(), [{"op": "link_ingredient", "material_id": "m1",
                               "ingredient_id": IID, "price_mode": "auto"}],
                  cat=catalog())

    def test_link_inherit_unknown_ingredient_rejected(self):
        with self.assertRaises(MutationError):
            apply(fixture(), [{"op": "link_ingredient", "material_id": "m1",
                               "ingredient_id": "22222222-2222-2222-2222-222222222222",
                               "price_mode": "inherit"}],
                  cat=catalog())

    def test_link_override_with_explicit_quote(self):
        out = apply(fixture(), [{"op": "link_ingredient", "material_id": "m1",
                                 "ingredient_id": IID, "price_mode": "override",
                                 "price_jpy": "200", "price_quantity": "100",
                                 "price_unit": "g"}],
                    cat=catalog())
        line = out.materials[0]
        self.assertEqual(line.price_mode, "override")
        cost = calculate_cost(out, catalog())
        self.assertEqual(cost.line_price_sources["m1"], "line_override")
        self.assertEqual(cost.line_costs["m1"], 200)

    def test_link_override_foreign_id_rejected(self):
        # P1 abnormal: another user's ingredient ID is absent from the owned
        # catalog, so both inherit and override links must be rejected.
        foreign = "99999999-9999-9999-9999-999999999999"
        for mode in ("inherit", "override"):
            op = {"op": "link_ingredient", "material_id": "m1",
                  "ingredient_id": foreign, "price_mode": mode,
                  "price_jpy": "999", "price_quantity": "100", "price_unit": "g"}
            with self.subTest(mode=mode):
                with self.assertRaises(MutationError):
                    apply(fixture(), [op], cat=catalog())

    def test_unconfirmed_link_is_assumed(self):
        out = apply(fixture(), [{"op": "link_ingredient", "material_id": "m1",
                                 "ingredient_id": IID, "price_mode": "override",
                                 "price_jpy": "200", "price_quantity": "100",
                                 "price_unit": "g"}],
                    confirmed=False, cat=catalog())
        self.assertEqual(out.materials[0].price_override.amount_jpy.status, "assumed")

    def test_unlink_inherit_mark_unresolved_never_zero_filled(self):
        linked = apply(fixture(), [{"op": "link_ingredient", "material_id": "m1",
                                    "ingredient_id": IID, "price_mode": "inherit"}],
                       cat=catalog())
        out = prepare_mutation(linked, Proposal("r1", linked.revision, "req-unlink",
                               ({"op": "unlink_ingredient", "material_id": "m1",
                                 "on_unlink": "mark_unresolved"},)),
                               user_confirmed=True, catalog=catalog())
        line = out.materials[0]
        self.assertIsNone(line.ingredient_id)
        self.assertIsNone(line.price_override)
        cost = calculate_cost(out, catalog())
        self.assertTrue(cost.partial)
        self.assertIn("m1", cost.unresolved_line_ids)

    def test_unlink_inherit_preserve_requires_explicit_quote(self):
        linked = apply(fixture(), [{"op": "link_ingredient", "material_id": "m1",
                                    "ingredient_id": IID, "price_mode": "inherit"}],
                       cat=catalog())
        with self.assertRaises(MutationError):
            prepare_mutation(linked, Proposal("r1", linked.revision, "req-unlink2",
                             ({"op": "unlink_ingredient", "material_id": "m1",
                               "on_unlink": "preserve_quote"},)),
                             user_confirmed=True, catalog=catalog())

    def test_unlink_override_line_keeps_own_quote(self):
        out = apply(fixture(), [{"op": "unlink_ingredient", "material_id": "m1",
                                 "on_unlink": "preserve_quote"}])
        line = out.materials[0]
        self.assertEqual(line.price_override.amount_jpy.value, "120")


if __name__ == "__main__":
    unittest.main()
