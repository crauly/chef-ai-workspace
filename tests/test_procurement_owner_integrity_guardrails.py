"""P1: procurement owner integrity must hold at the DB layer, not RLS alone."""
import pathlib
import unittest

RAW = (pathlib.Path(__file__).resolve().parents[1] /
       "supabase/migrations/202610300003_procurement_owner_integrity.sql").read_text()
SQL = "\n".join(line for line in RAW.splitlines()
                if not line.strip().startswith("--"))


class ProcurementOwnerIntegrityGuardrails(unittest.TestCase):
    def test_trigger_function_exists(self):
        self.assertIn("create or replace function public.check_procurement_owner()", SQL)

    def test_all_tables_covered(self):
        for trg in ("offers_owner_check", "price_observations_owner_check",
                    "price_notifications_owner_check", "ingredients_adopted_owner_check"):
            with self.subTest(trigger=trg):
                self.assertIn(trg, SQL)

    def test_cross_owner_rejected_with_distinct_errors(self):
        for msg in ("Offer ingredient not owned by caller",
                    "Offer supplier not owned by caller",
                    "Observation offer not owned by caller",
                    "Notification observation not owned by caller",
                    "Notification ingredient not owned by caller",
                    "Adopted observation not owned by caller"):
            with self.subTest(msg=msg):
                self.assertIn(msg, SQL)

    def test_fires_on_insert_and_update(self):
        self.assertEqual(SQL.count("before insert or update"), 4)


if __name__ == "__main__":
    unittest.main()
