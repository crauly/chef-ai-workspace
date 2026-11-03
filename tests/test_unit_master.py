import unittest
from chef_ai_workspace.unit_master import resolve_unit

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
