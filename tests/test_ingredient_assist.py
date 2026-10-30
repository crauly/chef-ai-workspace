"""M4: assistive search/candidates; chef approval stays mandatory."""
import unittest
from chef_ai_workspace.ingredient_assist import (
    LinkCandidate, build_approval_request, classify_material,
    search_owned_ingredients)
from chef_ai_workspace.models import Ingredient


def cat():
    return {
        "a": Ingredient("a", "片栗粉", None),
        "b": Ingredient("b", "片栗粉（業務用）", None),
        "c": Ingredient("c", "オリーブオイル", None),
    }


class AssistTests(unittest.TestCase):
    def test_search_owned_only_substring(self):
        hits = search_owned_ingredients("片栗", cat())
        self.assertEqual([g.id for g in hits], ["a", "b"])
        self.assertEqual(search_owned_ingredients("", cat()), [])
        self.assertEqual(search_owned_ingredients("塩", cat()), [])

    def test_single_exact_reuses_id(self):
        out = classify_material("オリーブオイル", cat())
        self.assertEqual(out.decision, "reuse")
        self.assertEqual(out.candidates[0].id, "c")

    def test_same_name_products_stay_separate(self):
        out = classify_material("出汁", {"a": Ingredient("a", "出汁", None),
                                      "b": Ingredient("b", "出汁", None)})
        self.assertEqual(out.decision, "ambiguous")
        self.assertEqual([g.id for g in out.candidates], ["a", "b"])

    def test_no_match_proposes_new_without_id(self):
        out = classify_material("塩", cat())
        self.assertEqual(out.decision, "new")

    def test_new_requires_explicit_approval(self):
        with self.assertRaises(ValueError):
            build_approval_request(material_id="11111111-1111-1111-1111-111111111111",
                                   material_name="塩",
                                   candidate=LinkCandidate("new", ()))

    def test_one_shot_register_and_link(self):
        ledger, ops = build_approval_request(
            material_id="11111111-1111-1111-1111-111111111111", material_name="塩",
            candidate=LinkCandidate("new", ()), approved_new=True,
            new_id="22222222-2222-2222-2222-222222222222",
            quote={"price_jpy": "50", "price_quantity": "100", "price_unit": "g"})
        self.assertEqual(ledger[0].kind, "new")
        self.assertEqual(ops[0]["op"], "link_ingredient")
        self.assertEqual(ops[0]["ingredient_id"], "22222222-2222-2222-2222-222222222222")

    def test_ambiguous_requires_explicit_choice(self):
        cand = classify_material("出汁", {"a": Ingredient("a", "出汁", None),
                                       "b": Ingredient("b", "出汁", None)})
        with self.assertRaises(ValueError):
            build_approval_request(material_id="11111111-1111-1111-1111-111111111111",
                                   material_name="出汁", candidate=cand,
                                   approved_ingredient_id="zzz",
                                   quote={"price_jpy": "1", "price_quantity": "1",
                                          "price_unit": "g"})
        ledger, ops = build_approval_request(
            material_id="11111111-1111-1111-1111-111111111111", material_name="出汁",
            candidate=cand, approved_ingredient_id="b",
            quote={"price_jpy": "1", "price_quantity": "1", "price_unit": "g"})
        self.assertEqual(ops[0]["ingredient_id"], "b")
        self.assertEqual(ledger[0].id, "b")

    def test_override_link_requires_quote(self):
        out = classify_material("オリーブオイル", cat())
        with self.assertRaises(ValueError):
            build_approval_request(material_id="11111111-1111-1111-1111-111111111111",
                                   material_name="オリーブオイル", candidate=out,
                                   approved_ingredient_id="c")



    def test_quote_extra_keys_cannot_redirect_approval(self):
        cand = classify_material("出汁", {"a": Ingredient("a", "出汁", None),
                                          "b": Ingredient("b", "出汁", None)})
        ledger, ops = build_approval_request(
            material_id="11111111-1111-1111-1111-111111111111", material_name="出汁",
            candidate=cand, approved_ingredient_id="a",
            quote={"price_jpy": "1", "price_quantity": "1", "price_unit": "g",
                   "ingredient_id": "b", "material_id": "zzz",
                   "price_mode": "inherit"})
        self.assertEqual(ops[0]["ingredient_id"], "a")
        self.assertEqual(ops[0]["material_id"],
                         "11111111-1111-1111-1111-111111111111")
        self.assertEqual(ops[0]["price_mode"], "override")
        self.assertEqual(ledger[0].id, "a")

    def test_new_quote_extra_keys_cannot_redirect_approval(self):
        ledger, ops = build_approval_request(
            material_id="11111111-1111-1111-1111-111111111111", material_name="塩",
            candidate=LinkCandidate("new", ()), approved_new=True,
            new_id="22222222-2222-2222-2222-222222222222",
            quote={"price_jpy": "50", "price_quantity": "100", "price_unit": "g",
                   "ingredient_id": "99999999-9999-9999-9999-999999999999",
                   "price_mode": "inherit"})
        self.assertEqual(ops[0]["ingredient_id"],
                         "22222222-2222-2222-2222-222222222222")
        self.assertEqual(ops[0]["price_mode"], "override")

    def test_new_without_assigned_id_is_rejected(self):
        with self.assertRaises(ValueError):
            build_approval_request(
                material_id="11111111-1111-1111-1111-111111111111",
                material_name="塩", candidate=LinkCandidate("new", ()),
                approved_new=True)
if __name__ == "__main__":
    unittest.main()
