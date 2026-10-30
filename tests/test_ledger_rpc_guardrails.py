"""Static guardrails for the M2 atomic ledger-commit RPC.

Text assertions only; real-DB execution, RLS integration and concurrency
verification are NOT performed here (see M8 acceptance).
"""
import pathlib
import unittest

RAW = (pathlib.Path(__file__).resolve().parents[1] /
       "supabase/migrations/202610300002_ledger_commit_rpc.sql").read_text()
SQL = "\n".join(line for line in RAW.splitlines()
                if not line.strip().startswith("--"))


class LedgerRpcGuardrails(unittest.TestCase):
    def test_single_function_covers_recipe_ledger_receipt(self):
        self.assertIn("create or replace function public.commit_recipe_with_ledger(", SQL)
        self.assertIn("insert into public.ingredients", SQL)
        self.assertIn("update public.recipes set state", SQL)
        self.assertIn("insert into public.mutation_receipts", SQL)

    def test_replay_and_revision_semantics_match_existing_rpc(self):
        for phrase in ("Stale recipe revision",
                       "Request ID reused with a different mutation",
                       "for update",
                       "payload_hash <> p_payload_hash"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, SQL)

    def test_cross_owner_second_gate(self):
        self.assertIn("Ingredient not owned by caller", SQL)

    def test_service_role_only(self):
        self.assertIn("revoke all on function public.commit_recipe_with_ledger", SQL)
        self.assertIn("to service_role;", SQL)
        self.assertNotRegex(SQL, r"to authenticated;")


if __name__ == "__main__":
    unittest.main()
