"""M2: one approved request saves new-ingredient ledger rows and recipe refs."""
import unittest
from dataclasses import replace
from chef_ai_workspace import Recipe, MaterialLine, PriceQuote, TrackedValue
from chef_ai_workspace.models import Ingredient
from chef_ai_workspace.mutations import Proposal, MutationError
from chef_ai_workspace.persistence_service import (
    LedgerIngredient, save_recipe_with_ledger, save_validated_mutation)


def tv(v):
    return TrackedValue(str(v), "confirmed", "user")


def quote(amount, per_q="1", per_u="尾"):
    return PriceQuote(tv(amount), per_q, per_u, "manual")


def recipe():
    return Recipe("r1", tv("Pasta"), (MaterialLine("m1", tv("海老"), tv("3"), "尾",
                  price_override=quote("150")),), tv("1000"))


PASTA_ID = "11111111-1111-1111-1111-111111111111"


class FakeLedgerRepository:
    def __init__(self):
        self.current = recipe()
        self.catalog = {PASTA_ID: Ingredient(PASTA_ID, "乾燥パスタ", None)}
        self.receipts = {}
        self.writes = []
        self.fail_commit = False
    def load_owned_recipe(self, owner_id, recipe_id):
        if owner_id != "user-a" or recipe_id != self.current.id:
            raise ValueError("Not found")
        return self.current
    def load_owned_catalog(self, owner_id, recipe):
        if owner_id != "user-a":
            raise ValueError("Not found")
        return dict(self.catalog)
    def get_mutation_receipt(self, owner_id, request_id):
        return self.receipts.get(request_id)
    def commit_recipe_revision(self, **kwargs):
        raise AssertionError("legacy path must not be used here")
    def commit_recipe_with_ledger(self, *, owner_id, recipe_id, request_id,
                                  base_revision, state, title, cost_snapshot,
                                  payload_hash, save_version, new_ingredients):
        if self.fail_commit:
            raise RuntimeError("database unavailable")
        if base_revision != self.current.revision:
            raise ValueError("stale")
        self.writes.append((state, new_ingredients))
        for item in new_ingredients:
            self.catalog[item["id"]] = Ingredient(item["id"], item["name"], None)
        self.receipts[request_id] = (payload_hash, base_revision + 1)
        self.current = replace(self.current, revision=base_revision + 1)
        return self.current.revision


def run(repo, ops, ledger=(), request="req-ledger-1", confirmed=True):
    proposal = Proposal("r1", repo.current.revision, request, tuple(ops))
    return save_recipe_with_ledger(owner_id="user-a", trusted_user_confirmed=confirmed,
                                   proposal=proposal, ledger=tuple(ledger),
                                   repository=repo, save_version=True)


class LedgerSaveTests(unittest.TestCase):
    def test_new_ingredient_and_recipe_saved_together(self):
        db = FakeLedgerRepository()
        out = run(db, [{"op": "add_material", "material_id": "22222222-2222-2222-2222-222222222222",
                        "name": "オリーブオイル", "quantity": "10", "unit": "ml",
                        "price_jpy": "50", "price_quantity": "10", "price_unit": "ml"}],
                  [LedgerIngredient("new", id="33333333-3333-3333-3333-333333333333",
                                    name="オリーブオイル")])
        self.assertEqual(out.resulting_revision, 1)
        self.assertEqual(out.saved_ingredient_ids, ("33333333-3333-3333-3333-333333333333",))
        self.assertEqual(len(db.writes), 1)

    def test_reuse_existing_id_writes_no_duplicate(self):
        db = FakeLedgerRepository()
        out = run(db, [{"op": "link_ingredient", "material_id": "m1",
                        "ingredient_id": PASTA_ID, "price_mode": "override",
                        "price_jpy": "350", "price_quantity": "500", "price_unit": "g"}],
                  [LedgerIngredient("reuse", id=PASTA_ID)])
        self.assertEqual(out.resulting_revision, 1)
        self.assertEqual(out.saved_ingredient_ids, ())
        self.assertEqual(len(db.catalog), 1)

    def test_unknown_reuse_id_writes_nothing(self):
        db = FakeLedgerRepository()
        with self.assertRaises(MutationError):
            run(db, [{"op": "set_title", "value": "x"}],
                [LedgerIngredient("reuse", id="99999999-9999-9999-9999-999999999999")])
        self.assertEqual(db.writes, [])
        self.assertEqual(db.current.revision, 0)

    def test_cross_owner_writes_nothing(self):
        db = FakeLedgerRepository()
        proposal = Proposal("r1", 0, "req-x", ({"op": "set_title", "value": "x"},))
        with self.assertRaises(ValueError):
            save_recipe_with_ledger(owner_id="user-b", trusted_user_confirmed=True,
                                    proposal=proposal, repository=db)
        self.assertEqual(db.writes, [])

    def test_retry_same_request_replays_without_new_writes(self):
        db = FakeLedgerRepository()
        proposal = Proposal("r1", 0, "req-replay", ({"op": "set_title", "value": "Pasta"},))
        def send():
            return save_recipe_with_ledger(owner_id="user-a", trusted_user_confirmed=True,
                                           proposal=proposal, repository=db, save_version=True)
        first = send()
        second = send()
        self.assertTrue(second.replayed)
        self.assertEqual(len(db.writes), 1)
        self.assertEqual(first.resulting_revision, second.resulting_revision)

    def test_same_request_different_payload_rejected(self):
        db = FakeLedgerRepository()
        run(db, [{"op": "set_title", "value": "Pasta"}])
        with self.assertRaises(MutationError):
            run(db, [{"op": "set_title", "value": "Changed"}])
        self.assertEqual(len(db.writes), 1)

    def test_commit_failure_leaves_revision(self):
        db = FakeLedgerRepository()
        db.fail_commit = True
        with self.assertRaises(RuntimeError):
            run(db, [{"op": "set_title", "value": "Pasta"}])
        self.assertEqual(db.current.revision, 0)

    def test_legacy_path_still_works(self):
        db = FakeLedgerRepository()
        db.commit_recipe_revision = lambda **k: 1
        out = save_validated_mutation(owner_id="user-a", trusted_user_confirmed=True,
                                      proposal=Proposal("r1", 0, "req-old", (
                                          {"op": "set_title", "value": "Pasta"},)),
                                      repository=db)
        self.assertEqual(out.resulting_revision, 1)


if __name__ == "__main__":
    unittest.main()


class LedgerLoaderTests(unittest.TestCase):
    def test_reuse_validated_against_owned_ledger_not_recipe_lines(self):
        db = FakeLedgerRepository()
        db.load_owned_ingredients = lambda owner, ids: (
            {i: db.catalog[i] for i in ids if i in db.catalog}
            if owner == "user-a" else (_ for _ in ()).throw(ValueError("Not found")))
        out = run(db, [{"op": "set_title", "value": "Pasta"}],
                  [LedgerIngredient("reuse", id=PASTA_ID)])
        self.assertEqual(out.resulting_revision, 1)

    def test_legacy_repository_without_loader_still_works(self):
        db = FakeLedgerRepository()
        self.assertFalse(hasattr(db, "load_owned_ingredients"))
        out = run(db, [{"op": "set_title", "value": "Pasta"}])
        self.assertEqual(out.resulting_revision, 1)
