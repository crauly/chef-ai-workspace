import unittest
from decimal import Decimal
from dataclasses import replace
from chef_ai_workspace import MaterialLine, PriceQuote, Recipe, TrackedValue
from chef_ai_workspace.mutations import MutationError, Proposal, prepare_mutation

def tv(v):
    return TrackedValue(str(v), "confirmed", "user")

def fixture():
    return Recipe("r1", tv("海老のパスタ"), (MaterialLine("m1", tv("海老"), tv("3"), "尾", price_override=PriceQuote(tv("150"), "1", "尾", "manual")),), tv("1800"))

def apply(r, *ops, confirmed=True, revision=None):
    return prepare_mutation(r, Proposal("r1", r.revision if revision is None else revision, "req-one", ops), user_confirmed=confirmed)

class MutationTests(unittest.TestCase):
    def test_request_id_and_revision_type_validation(self):
        r = fixture()
        for bad_id in ("", None, "  "):
            with self.subTest(request_id=bad_id), self.assertRaises(MutationError):
                prepare_mutation(r, Proposal("r1", 0, bad_id, ({"op":"set_title","value":"new"},)), user_confirmed=True)
        for bad_revision in (True, "0"):
            with self.subTest(revision=bad_revision), self.assertRaises(MutationError):
                prepare_mutation(r, Proposal("r1", bad_revision, "unique", ({"op":"set_title","value":"new"},)), user_confirmed=True)

    def test_add_material_and_price_recompute(self):
        from uuid import uuid4
        from chef_ai_workspace.costing import calculate_cost as _calculate_cost
        unit_catalog={"g":("mass",Decimal("1")),"kg":("mass",Decimal("1000"))}
        calculate_cost=lambda recipe:_calculate_cost(recipe,units=unit_catalog)
        mid = str(uuid4())
        r = fixture()
        created = apply(r, {"op":"add_material","material_id":mid,"name":"片栗粉",
            "quantity":"100","unit":"g","price_jpy":"500",
            "price_quantity":"1","price_unit":"kg"})
        self.assertEqual(created.materials[1].material_name.value,"片栗粉")
        self.assertIsNone(created.materials[1].ingredient_id)
        self.assertEqual(calculate_cost(created).total_cost_jpy, 500)
        priced = apply(created, {"op":"set_material_price","material_id":mid,
            "price_jpy":"600","price_quantity":"1","price_unit":"kg"})
        self.assertEqual(calculate_cost(priced).total_cost_jpy, 510)
        changed = apply(priced, {"op":"set_material_quantity","material_id":mid,"value":"200","unit":"g"})
        self.assertEqual(calculate_cost(changed).total_cost_jpy, 570)

    def test_add_material_invalid_batch_remains_atomic(self):
        from uuid import uuid4
        r=fixture()
        mid=str(uuid4())
        base={"op":"add_material","material_id":mid,"name":"片栗粉","quantity":"100",
              "unit":"g","price_jpy":"500","price_quantity":"1","price_unit":"kg"}
        for altered in (dict(base, price_jpy="-2"),dict(base,material_id="invalid"),
                        dict(base,price_quantity="0")):
            with self.subTest(altered=altered),self.assertRaises((MutationError,ValueError)):
                apply(r,altered)
        with self.assertRaises(MutationError):
            apply(r,base,base)
        self.assertEqual(len(r.materials),1)

    def test_unconfirmed_ai_material_is_assumed(self):
        from uuid import uuid4
        r=apply(fixture(), {"op":"add_material","material_id":str(uuid4()),"name":"片栗粉",
             "quantity":"10","unit":"g","price_jpy":"500","price_quantity":"1",
             "price_unit":"kg"},confirmed=False)
        self.assertEqual(r.materials[-1].material_name.status,"assumed")
        self.assertEqual(r.materials[-1].price_override.amount_jpy.status,"assumed")

    def test_material_rename_and_remove(self):
        original = fixture()
        renamed = apply(original, {"op": "set_material_name", "material_id": "m1", "value": "有頭海老"})
        self.assertEqual(renamed.materials[0].material_name.value, "有頭海老")
        self.assertEqual(renamed.revision, 1)
        self.assertEqual(original.materials[0].material_name.value, "海老")
        removed = apply(renamed, {"op": "remove_material", "material_id": "m1"})
        self.assertEqual(removed.materials, ())
        self.assertEqual(removed.revision, 2)

    def test_material_rename_remove_reject_invalid_operations_atomically(self):
        original = fixture()
        for op in (
            {"op": "set_material_name", "material_id": "m1", "value": " "},
            {"op": "set_material_name", "material_id": "missing", "value": "海老"},
            {"op": "remove_material", "material_id": "missing"},
            {"op": "remove_material", "material_id": "m1", "extra": "bad"},
        ):
            with self.subTest(op=op), self.assertRaises(MutationError):
                apply(original, op)
        self.assertEqual(len(original.materials), 1)
        with self.assertRaises(MutationError):
            apply(original, {"op": "remove_material", "material_id": "m1"},
                  {"op": "set_material_quantity", "material_id": "m1", "value": "2", "unit": "尾"})
        self.assertEqual(original.revision, 0)

    def test_quantity_and_revision(self):
        r=fixture()
        out=apply(r, {"op":"set_material_quantity","material_id":"m1","value":"4","unit":"尾"})
        self.assertEqual(out.materials[0].quantity.value,"4")
        self.assertEqual(out.revision,1)
        self.assertEqual(r.materials[0].quantity.value,"3")
    def test_adjust_relative_and_absolute(self):
        r=fixture()
        a=apply(r,{"op":"adjust_cost_adjustment","delta_jpy":"50"})
        self.assertEqual(a.cost_adjustment_jpy.value,"50")
        b=apply(a,{"op":"set_cost_adjustment","value_jpy":"20"})
        self.assertEqual(b.cost_adjustment_jpy.value,"20")
        self.assertEqual(b.materials[0].price_override.amount_jpy.value,"150")
    def test_assumed_adjustment_survives_confirmed_delta(self):
        r = replace(fixture(), cost_adjustment_jpy=TrackedValue("50", "assumed", "ai"))
        changed = apply(r, {"op":"adjust_cost_adjustment","delta_jpy":"10"})
        self.assertEqual(changed.cost_adjustment_jpy.value, "60")
        self.assertEqual(changed.cost_adjustment_jpy.status, "assumed")
        absolute = apply(changed, {"op":"set_cost_adjustment","value_jpy":"60"})
        self.assertEqual(absolute.cost_adjustment_jpy.status, "confirmed")

    def test_assumed_delta_remains_assumed(self):
        changed = apply(fixture(), {"op":"adjust_cost_adjustment","delta_jpy":"10"}, confirmed=False)
        self.assertEqual(changed.cost_adjustment_jpy.status, "assumed")

    def test_atomic_invalid_second(self):
        r=fixture()
        with self.assertRaises(MutationError):
            apply(r,{"op":"set_material_quantity","material_id":"m1","value":"4","unit":"尾"},{"op":"unexpected"})
        self.assertEqual(r.revision,0)
        self.assertEqual(r.materials[0].quantity.value,"3")
    def test_stale_revision(self):
        with self.assertRaises(MutationError):
            apply(fixture(),{"op":"set_title","value":"新しい料理"},revision=10)
    def test_ambiguous_line_rejected(self):
        with self.assertRaises(MutationError):
            apply(fixture(),{"op":"set_material_quantity","material_id":"unknown","value":"4","unit":"尾"})
    def test_reject_model_status_forgery(self):
        with self.assertRaises(MutationError):
            apply(fixture(),{"op":"set_title","value":"料理","status":"confirmed"},confirmed=False)
    def test_ai_inference_assumed(self):
        r=apply(fixture(),{"op":"set_title","value":"料理"},confirmed=False)
        self.assertEqual(r.title.status,"assumed")
    def test_negative_total_rejected(self):
        with self.assertRaises(ValueError):
            apply(fixture(),{"op":"adjust_cost_adjustment","delta_jpy":"-1000"})
    def test_unknown_fields_rejected(self):
        with self.assertRaises(MutationError):
            apply(fixture(),{"op":"set_title","value":"料理","extra":True})
    def test_missing_price_rejected(self):
        with self.assertRaises(MutationError):
            apply(fixture(),{"op":"set_selling_price","value_jpy":"0"})

if __name__ == "__main__":
    unittest.main()
