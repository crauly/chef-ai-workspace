"""Display keeps material relation; linked ingredient name leads."""
import unittest
from chef_ai_workspace import Recipe, MaterialLine, TrackedValue
from chef_ai_workspace.models import Ingredient
from chef_ai_workspace.display_names import resolve_display_names


def tv(v):
    return TrackedValue(str(v), "confirmed", "user")


class DisplayNamesTests(unittest.TestCase):
    def test_unlinked_shows_material_name(self):
        r = Recipe("r1", tv("x"), (MaterialLine("m1", tv("でんぷん"), tv("100"), "g"),))
        self.assertEqual(resolve_display_names(r)["m1"],
                         {"display": "でんぷん", "material": "でんぷん"})

    def test_linked_shows_ingredient_name_and_keeps_material(self):
        r = Recipe("r1", tv("x"), (MaterialLine(
            "m1", tv("でんぷん"), tv("100"), "g",
            ingredient_id="i1", price_mode="inherit"),))
        out = resolve_display_names(r, {"i1": Ingredient("i1", "片栗粉", None)})
        self.assertEqual(out["m1"], {"display": "片栗粉", "material": "でんぷん"})

    def test_missing_catalog_entry_falls_back_safely(self):
        r = Recipe("r1", tv("x"), (MaterialLine(
            "m1", tv("でんぷん"), tv("100"), "g",
            ingredient_id="i9", price_mode="inherit"),))
        self.assertEqual(resolve_display_names(r, {})["m1"]["display"], "でんぷん")


if __name__ == "__main__":
    unittest.main()
