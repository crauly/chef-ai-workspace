import unittest
from chef_ai_workspace.unit_master import resolve_unit, prepare_unit_approval

class UnitMasterTests(unittest.TestCase):
    def setUp(self):
        self.units = [
            {"id": "unit-a", "symbol": "個", "dimension": "count", "aliases": ["こ", "コ"]},
            {"id": "unit-b", "symbol": "g", "dimension": "mass", "aliases": ["グラム"]},
        ]

    def test_exact_symbol_reuse(self):
        result = resolve_unit("個", self.units)
        self.assertEqual((result.status, result.unit_id), ("reuse", "unit-a"))

    def test_alias_reuses_same_id(self):
        self.assertEqual(resolve_unit("コ", self.units).unit_id, "unit-a")

    def test_unregistered_unit_remains_proposal(self):
        result = resolve_unit("束", self.units)
        self.assertEqual((result.status, result.unit_id), ("new_candidate", None))

    def test_alias_collision_cannot_pick_arbitrarily(self):
        units = self.units + [{"id":"unit-c","symbol":"袋","dimension":"count","aliases":["コ"]}]
        self.assertEqual(resolve_unit("コ",units).status, "ambiguous")

    def test_empty_is_not_registered(self):
        self.assertEqual(resolve_unit("", self.units).status, "missing")

    def test_single_gate_plan_reuses_existing_and_proposes_new(self):
        plan = prepare_unit_approval(["コ", "束"], self.units, {"束": "count"})
        self.assertEqual((plan[0].status, plan[0].unit_id), ("reuse", "unit-a"))
        self.assertEqual((plan[1].status, plan[1].unit_id), ("new_candidate", None))

    def test_unreviewed_new_dimension_blocks_approval_plan(self):
        with self.assertRaises(ValueError):
            prepare_unit_approval(["束"], self.units, {})

    def test_ambiguous_unit_blocks_approval_plan(self):
        units = self.units + [{"id": "unit-c", "symbol": "袋",
                               "dimension": "count", "aliases": ["コ"]}]
        with self.assertRaises(ValueError):
            prepare_unit_approval(["コ"], units, {})
