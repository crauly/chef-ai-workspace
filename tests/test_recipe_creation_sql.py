import pathlib
import unittest

SQL=(pathlib.Path(__file__).resolve().parents[1]/"supabase/migrations/202610270002_create_recipe.sql").read_text()

class RecipeCreateSqlTests(unittest.TestCase):
    def test_service_role_only(self):
        self.assertIn("from public, anon, authenticated", SQL)
        self.assertIn("to service_role", SQL)
        self.assertNotIn("to authenticated;", SQL)
    def test_atomic_initial_snapshot(self):
        self.assertIn("insert into public.recipes",SQL)
        self.assertIn("insert into public.recipe_versions",SQL)
        self.assertIn("p_initial_state->>'revision' is distinct from '0'",SQL)
    def test_reject_malformed_input(self):
        self.assertIn("raise exception 'Invalid initial recipe'", SQL)
        self.assertIn("p_initial_state->>'id' is distinct from p_recipe_id::text", SQL)

if __name__=="__main__":
    unittest.main()
