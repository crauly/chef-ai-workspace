"""P2実DB検証: 原子性/ロールバック/並行/べき等性/所有者分離.

Two layers:

A. Ephemeral backend (always runs, no connection): an in-memory store that
   mirrors the contract of migrations 0001-0003 -- atomic recipe+ledger+
   receipt commit, receipt replay, revision CAS, and the owner-integrity
   trigger rules -- verifying the application/RPC semantics end to end
   through save_recipe_with_ledger.

B. Real disposable test DB (runs only with SUPABASE_TEST_URL +
   SUPABASE_TEST_SERVICE_KEY pointing at a DISPOSABLE test project; the
   production ref dfvryaybdelgjxihdmth is refused). Without them the cases
   SKIP and the area stays explicitly unverified -- layer-A successes must
   never be quoted as real-DB verification.
"""
import os
import unittest
from dataclasses import replace

from chef_ai_workspace import Recipe, MaterialLine, PriceQuote, TrackedValue
from chef_ai_workspace.models import Ingredient
from chef_ai_workspace.mutations import Proposal, MutationError
from chef_ai_workspace.persistence_service import (
    LedgerIngredient, save_recipe_with_ledger)


def tv(v):
    return TrackedValue(str(v), "confirmed", "user")


def quote(amount):
    return PriceQuote(tv(amount), "1", "g", "manual")


def recipe(rev=0):
    return Recipe("r1", tv("Base"), (MaterialLine("m1", tv("塩"), tv("100"), "g",
                  price_override=quote("10")),), tv("500"), revision=rev)


class EphemeralStore:
    """Mirrors the DB contract: atomic commit, replay receipts, revision
    CAS, and the 0003 owner-integrity trigger rules (same-owner writes pass,
    cross-owner references raise the same messages as the triggers)."""

    OWNERS = ("user-a", "user-b")

    def __init__(self):
        self.recipes = {("user-a", "r1"): recipe()}
        self.ingredients = {}
        self.receipts = {}
        self.writes = []

    # -- repository surface used by save_recipe_with_ledger --
    def load_owned_recipe(self, owner_id, recipe_id):
        try:
            return self.recipes[(owner_id, recipe_id)]
        except KeyError:
            raise ValueError("Not found") from None

    def load_owned_catalog(self, owner_id, recipe):
        return {i: g for (o, i), g in self.ingredients.items() if o == owner_id}

    def load_owned_ingredients(self, owner_id, ids):
        return {i: self.ingredients[(owner_id, i)] for i in ids
                if (owner_id, i) in self.ingredients}

    def get_mutation_receipt(self, owner_id, request_id):
        return self.receipts.get((owner_id, request_id))

    def commit_recipe_with_ledger(self, *, owner_id, recipe_id, request_id,
                                  base_revision, state, title, cost_snapshot,
                                  payload_hash, save_version, new_ingredients):
        # Receipt replay first (same semantics as the RPC: same payload
        # returns the recorded revision; different payload is a conflict).
        hit = self.receipts.get((owner_id, request_id))
        if hit is not None:
            saved_hash, saved_revision = hit
            if saved_hash != payload_hash:
                raise MutationError("Request ID reused with different payload")
            return -saved_revision  # negative = replayed
        # Recipe lock + revision CAS.
        try:
            current = self.recipes[(owner_id, recipe_id)]
        except KeyError:
            raise MutationError("Recipe not found") from None
        if current.revision != base_revision:
            raise MutationError("Stale recipe revision")
        # Ledger second gate + 0003 trigger mirror: reject cross-owner and
        # already-registered IDs instead of silently reusing them.
        staged = []
        for item in new_ingredients:
            for (o, i), g in self.ingredients.items():
                if i == item["id"] and o != owner_id:
                    raise MutationError("Ingredient not owned by caller")
            if any(i == item["id"] for (o, i) in self.ingredients):
                raise MutationError("Ingredient already registered")
            staged.append(item)
        # Atomic apply: all rows land together or not at all.
        for item in staged:
            self.ingredients[(owner_id, item["id"])] = Ingredient(
                item["id"], item["name"], None)
        self.recipes[(owner_id, recipe_id)] = replace(current, revision=base_revision + 1)
        self.receipts[(owner_id, request_id)] = (payload_hash, base_revision + 1)
        self.writes.append((recipe_id, tuple(i["id"] for i in staged)))
        return base_revision + 1


def send(store, ops, ledger=(), request="req-1", owner="user-a", confirmed=True):
    base = store.load_owned_recipe(owner, "r1").revision
    return save_recipe_with_ledger(
        owner_id=owner, trusted_user_confirmed=confirmed,
        proposal=Proposal("r1", base, request, tuple(ops)),
        ledger=tuple(ledger), repository=store, save_version=True)


NEW_ID = "66666666-6666-6666-6666-666666666666"


class EphemeralVerificationTests(unittest.TestCase):
    """Layer A: verifiable without any DB connection."""

    def test_atomic_recipe_ledger_commit(self):
        db = EphemeralStore()
        out = send(db, [{"op": "link_ingredient", "material_id": "m1",
                         "ingredient_id": NEW_ID, "price_mode": "override",
                         "price_jpy": "20", "price_quantity": "1", "price_unit": "g"}],
                   [LedgerIngredient("new", id=NEW_ID, name="塩")])
        self.assertFalse(out.replayed)
        self.assertEqual(out.resulting_revision, 1)
        self.assertEqual(out.saved_ingredient_ids, (NEW_ID,))
        # All three rows landed together.
        self.assertIn(("user-a", NEW_ID), db.ingredients)
        self.assertEqual(db.recipes[("user-a", "r1")].revision, 1)
        self.assertIn(("user-a", "req-1"), db.receipts)

    def test_rollback_on_ledger_conflict(self):
        db = EphemeralStore()
        db.ingredients[("user-a", NEW_ID)] = Ingredient(NEW_ID, "既存塩", None)
        with self.assertRaises(MutationError):
            send(db, [{"op": "set_title", "value": "x"}],
                 [LedgerIngredient("new", id=NEW_ID, name="別名塩")])
        # Nothing was persisted: no receipt, no revision bump.
        self.assertEqual(db.recipes[("user-a", "r1")].revision, 0)
        self.assertNotIn(("user-a", "req-1"), db.receipts)
        self.assertEqual(db.writes, [])

    def test_concurrent_same_request_replays(self):
        db = EphemeralStore()
        first = send(db, [{"op": "set_title", "value": "New"}], request="req-c")
        # A concurrent loser that passed the pre-check arrives after the
        # winner committed: same base revision, same payload -> replay.
        loser_repo_state = db.recipes[("user-a", "r1")].revision
        self.assertEqual(loser_repo_state, 1)
        stale = Proposal("r1", 0, "req-c", ({"op": "set_title", "value": "New"},))
        out = save_recipe_with_ledger(
            owner_id="user-a", trusted_user_confirmed=True,
            proposal=stale, repository=db, save_version=True)
        self.assertTrue(out.replayed)
        self.assertEqual(out.resulting_revision, first.resulting_revision)
        self.assertEqual(len(db.writes), 1)

    def test_same_request_resend_is_idempotent(self):
        db = EphemeralStore()
        ledger = (LedgerIngredient("new", id=NEW_ID, name="塩"),)
        first = send(db, [{"op": "set_title", "value": "New"}], ledger, request="req-r")
        # A network retry resends the byte-identical proposal (base 0), not
        # a freshly based one: same payload hash -> idempotent replay.
        retry = Proposal("r1", 0, "req-r", ({"op": "set_title", "value": "New"},))
        second = save_recipe_with_ledger(
            owner_id="user-a", trusted_user_confirmed=True,
            proposal=retry, ledger=ledger, repository=db, save_version=True)
        self.assertTrue(second.replayed)
        self.assertEqual(first.resulting_revision, second.resulting_revision)
        self.assertEqual(len(db.writes), 1)

    def test_owner_separation(self):
        db = EphemeralStore()
        db.ingredients[("user-b", NEW_ID)] = Ingredient(NEW_ID, "他者塩", None)
        with self.assertRaises(MutationError):
            send(db, [{"op": "set_title", "value": "x"}],
                 [LedgerIngredient("new", id=NEW_ID, name="塩")])
        with self.assertRaises(ValueError):
            db.load_owned_recipe("user-b", "r1")
        self.assertEqual(db.writes, [])


TEST_URL = os.getenv("SUPABASE_TEST_URL", "")
TEST_KEY = os.getenv("SUPABASE_TEST_SERVICE_KEY", "")
PROD_REF = "dfvryaybdelgjxihdmth"
ENABLED = bool(TEST_URL and TEST_KEY and PROD_REF not in TEST_URL)


@unittest.skipUnless(ENABLED, "実DB未接続: 使い捨てテストDB未設定のため未検証")
class DisposableDbVerificationTests(unittest.TestCase):
    """Layer B: runs only against a disposable test project. Each case
    creates its own owner/recipe rows and removes them afterwards."""

    def test_b_atomic_commit(self):
        self.fail("テストDB接続後に実施: 一体commitの全件成功を確認")

    def test_b_rollback(self):
        self.fail("テストDB接続後に実施: 競合時の全件ロールバックを確認")

    def test_b_concurrent_replay(self):
        self.fail("テストDB接続後に実施: 並行同一request_idで単一commit＋片方replayを確認")

    def test_b_idempotent_resend(self):
        self.fail("テストDB接続後に実施: 同一再送のべき等性を確認")

    def test_b_owner_separation(self):
        self.fail("テストDB接続後に実施: 他者参照の全経路拒否を確認")


if __name__ == "__main__":
    unittest.main()
