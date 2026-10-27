import unittest
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
