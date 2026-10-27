"""Static guardrails only; these do not replace PostgreSQL/RLS integration tests."""
import pathlib
import re
import unittest

SQL = (pathlib.Path(__file__).resolve().parents[1] /
       "supabase/migrations/202610270001_initial.sql").read_text()

class SupabaseSchemaGuardrails(unittest.TestCase):
    def test_tables_have_rls(self):
        for name in ("recipes","recipe_versions","mutation_receipts","ingredients","ingredient_images"):
            with self.subTest(table=name):
                self.assertIn(f"alter table public.{name} enable row level security;", SQL)

    def test_no_direct_recipe_client_writes(self):
        self.assertNotRegex(SQL, r"create policy\s+\w+\s+on public\.recipes for (all|insert|update|delete)\b")

    def test_rpc_restricted_to_service_role(self):
        self.assertRegex(SQL, r"grant execute on function public\.commit_recipe_revision\([\s\S]*?\) to service_role;")
        self.assertNotRegex(SQL, r"grant execute on function public\.commit_recipe_revision\([\s\S]*?\) to authenticated;")
        self.assertIn("revoke all on function public.commit_recipe_revision",SQL)

    def test_owner_scoped_queries_and_replay_protection(self):
        self.assertIn("owner_id = v_owner for update",SQL)
        self.assertIn("owner_id = v_owner and request_id = p_request_id",SQL)
        self.assertIn("payload_hash <> p_payload_hash",SQL)
        self.assertIn("Stale recipe revision",SQL)

    def test_optional_images_and_version_snapshot(self):
        self.assertIn("cost_snapshot jsonb not null",SQL)
        self.assertIn("storage_path text not null unique",SQL)
        self.assertIn("ingredient_id uuid not null references public.ingredients",SQL)

if __name__ == "__main__":
    unittest.main()
