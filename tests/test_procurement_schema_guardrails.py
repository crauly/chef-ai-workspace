"""Static guardrails for the M1 procurement ledger migration.

Text assertions only; not a substitute for PostgreSQL/RLS integration tests.
"""
import pathlib
import unittest

RAW = (pathlib.Path(__file__).resolve().parents[1] /
         "supabase/migrations/202610300001_procurement_ledger.sql").read_text()
SQL = "\n".join(line for line in RAW.splitlines()
                 if not line.strip().startswith("--"))


class ProcurementSchemaGuardrails(unittest.TestCase):
    def test_new_tables_have_rls(self):
        for name in ("suppliers", "offers", "price_observations", "price_notifications"):
            with self.subTest(table=name):
                self.assertIn(f"alter table public.{name} enable row level security;", SQL)

    def test_owner_scoped_policies(self):
        for name in ("suppliers", "offers", "price_observations", "price_notifications"):
            with self.subTest(table=name):
                self.assertIn(f"create policy {name}_owner on public.{name} for all to authenticated", SQL)
                self.assertIn("owner_id = (select auth.uid())", SQL)

    def test_existing_tables_untouched(self):
        self.assertNotIn("create table public.ingredients", SQL)
        self.assertNotIn("create table public.recipes", SQL)
        self.assertNotIn("drop table", SQL.lower().replace("--   drop table", ""))

    def test_no_name_uniqueness_no_auto_adoption(self):
        self.assertNotRegex(SQL, r"unique\s*\(\s*name\s*\)")
        self.assertNotIn("auto", SQL.lower())
        self.assertIn("default 'unread'", SQL)

    def test_history_is_append_only_shaped(self):
        self.assertIn("references public.offers(id) on delete cascade", SQL)
        self.assertIn("unique(observation_id)", SQL)
        self.assertIn("on delete set null", SQL)


if __name__ == "__main__":
    unittest.main()
