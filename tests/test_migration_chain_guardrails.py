"""migration 0001-0004: apply order, SQL shape, trigger wiring.

Connection-free static verification. Real-DB apply remains unverified
(see DisposableDbVerificationTests) and is never claimed from these.
"""
import pathlib
import re
import unittest

MIG = pathlib.Path(__file__).resolve().parents[1] / "supabase/migrations"
F1 = (MIG / "202610300001_procurement_ledger.sql").read_text()
F2 = (MIG / "202610300002_ledger_commit_rpc.sql").read_text()
F3 = (MIG / "202610300003_procurement_owner_integrity.sql").read_text()
F4 = (MIG / "202610300004_notification_basis.sql").read_text()


def code(sql):
    return "\n".join(l for l in sql.splitlines() if not l.strip().startswith("--"))


class MigrationChainTests(unittest.TestCase):
    def test_filenames_sort_in_apply_order(self):
        names = sorted(p.name for p in MIG.glob("20261030*.sql"))
        self.assertEqual(names, ["202610300001_procurement_ledger.sql",
                                 "202610300002_ledger_commit_rpc.sql",
                                 "202610300003_procurement_owner_integrity.sql",
                                 "202610300004_notification_basis.sql"])
        self.assertLess(F1.index("create table public.suppliers"), len(F1))
        # 0003 only references objects created in 0001.
        for obj in ("public.offers", "public.price_observations",
                    "public.price_notifications", "public.ingredients"):
            with self.subTest(obj=obj):
                self.assertIn(obj, F1)
                self.assertIn(obj, F3)

    def test_notification_basis_is_additive_only(self):
        body = code(F4).lower()
        for stmt in ("drop table", "truncate", "delete from", "drop column"):
            with self.subTest(stmt=stmt):
                self.assertNotIn(stmt, body)
        self.assertIn("basis_observation_id", code(F4))
        self.assertIn("unit_basis", code(F4))

    def test_dollar_quoting_balanced(self):
        for name, sql in (("0001", F1), ("0002", F2), ("0003", F3),
                           ("0004", F4)):
            with self.subTest(file=name):
                for tag in set(re.findall(r"\$[A-Za-z_]*\$", code(sql))):
                    self.assertEqual(code(sql).count(tag) % 2, 0,
                                     f"unbalanced {tag} in {name}")

    def test_no_unplanned_destructive_statements(self):
        for name, sql in (("0001", F1), ("0002", F2), ("0003", F3),
                           ("0004", F4)):
            with self.subTest(file=name):
                body = code(sql).lower()
                self.assertNotIn("drop table", body)
                self.assertNotIn("truncate", body)
                self.assertNotIn("delete from", body)

    def test_trigger_wiring_matches_function(self):
        body = code(F3)
        self.assertIn("create or replace function public.check_procurement_owner()", body)
        for table, trigger in (("public.offers", "offers_owner_check"),
                               ("public.price_observations", "price_observations_owner_check"),
                               ("public.price_notifications", "price_notifications_owner_check"),
                               ("public.ingredients", "ingredients_adopted_owner_check")):
            with self.subTest(trigger=trigger):
                self.assertIn(f"create trigger {trigger}", body)
                self.assertIn(f"on {table}", body)
                self.assertIn("execute function public.check_procurement_owner()", body)

    def test_trigger_branches_cover_all_tables(self):
        body = code(F3)
        for branch in ("TG_TABLE_NAME = 'offers'",
                       "TG_TABLE_NAME = 'price_observations'",
                       "TG_TABLE_NAME = 'price_notifications'",
                       "TG_TABLE_NAME = 'ingredients'"):
            with self.subTest(branch=branch):
                self.assertIn(branch, body)

    def test_ledger_rpc_rejects_duplicates_and_signals_replay(self):
        body = code(F2)
        self.assertIn("Ingredient already registered", body)
        self.assertIn("-v_receipt.resulting_revision", body)


if __name__ == "__main__":
    unittest.main()
