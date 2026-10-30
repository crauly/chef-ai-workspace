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
        import threading as _th
        self._lock = _th.Lock()  # mirrors the RPC row lock on recipes
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
        # Serialized like the RPC row lock: concurrent losers observe the
        # winner's receipt instead of double-applying.
        with self._lock:
            return self._commit_locked(
                owner_id=owner_id, recipe_id=recipe_id, request_id=request_id,
                base_revision=base_revision, state=state, title=title,
                cost_snapshot=cost_snapshot, payload_hash=payload_hash,
                save_version=save_version, new_ingredients=new_ingredients)

    def _commit_locked(self, *, owner_id, recipe_id, request_id,
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

    def test_concurrent_threads_single_commit_one_replay(self):
        # True concurrency (threads, barrier-synced start), distinct from a
        # sequential resend: exactly one write lands, the loser replays.
        import threading as _th
        db = EphemeralStore()
        ledger = (LedgerIngredient("new", id=NEW_ID, name="塩"),)
        ops = ({"op": "set_title", "value": "New"},)
        barrier = _th.Barrier(2)
        outs, errs = [], []

        def fire():
            try:
                barrier.wait(timeout=10)
                outs.append(save_recipe_with_ledger(
                    owner_id="user-a", trusted_user_confirmed=True,
                    proposal=Proposal("r1", 0, "req-conc", ops),
                    ledger=ledger, repository=db, save_version=True))
            except Exception as exc:  # noqa: BLE001
                errs.append(exc)

        threads = [_th.Thread(target=fire), _th.Thread(target=fire)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        self.assertEqual(errs, [])
        self.assertEqual(len(outs), 2)
        self.assertEqual(len(db.writes), 1)
        flags = sorted(o.replayed for o in outs)
        self.assertEqual(flags, [False, True])
        self.assertEqual(outs[0].resulting_revision, outs[1].resulting_revision)

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
ALLOW_WRITE = os.getenv("SUPABASE_TEST_ALLOW_WRITE") == "1"
PROD_REF = "dfvryaybdelgjxihdmth"
ENABLED = bool(TEST_URL and TEST_KEY and ALLOW_WRITE and PROD_REF not in TEST_URL)


@unittest.skipUnless(ENABLED, "実DB未接続: 使い捨てテストDB未設定のため未検証")
class DisposableDbVerificationTests(unittest.TestCase):
    """Layer B: runs only against a disposable test project with
    SUPABASE_TEST_ALLOW_WRITE=1. Each case creates its own auth users and
    rows, then removes them in cleanup. Never runs against production."""

    def _client(self):
        from supabase import create_client
        return create_client(TEST_URL, TEST_KEY)

    def _setup(self, with_second_owner=False):
        """Create temp users + one rev-0 recipe. Returns ids; cleanup stacked."""
        import uuid
        client = self._client()
        owner = client.auth.admin.create_user(
            {"email": f"lv-a-{uuid.uuid4().hex[:8]}@example.invalid",
             "email_confirm": True}).user.id
        self.addCleanup(lambda: self._cleanup(client, owner))
        owner_b = None
        if with_second_owner:
            owner_b = client.auth.admin.create_user(
                {"email": f"lv-b-{uuid.uuid4().hex[:8]}@example.invalid",
                 "email_confirm": True}).user.id
            self.addCleanup(lambda: self._cleanup(client, owner_b))
        recipe_id = str(uuid.uuid4())
        state = {"id": recipe_id, "revision": 0, "title": "live-check",
                 "materials": []}
        snapshot = {"partial": True}
        client.rpc("create_owned_recipe", {
            "p_owner_id": owner, "p_recipe_id": recipe_id, "p_title": "live-check",
            "p_initial_state": state, "p_cost_snapshot": snapshot}).execute()
        self.addCleanup(client.table("recipes").delete().eq("id", recipe_id).execute)
        return client, owner, owner_b, recipe_id

    def _cleanup(self, client, owner):
        for table, col in (("mutation_receipts", "owner_id"),
                           ("price_notifications", "owner_id"),
                           ("price_observations", "owner_id"),
                           ("offers", "owner_id"),
                           ("ingredients", "owner_id")):
            try:
                client.table(table).delete().eq(col, owner).execute()
            except Exception:  # noqa: BLE001 -- best-effort cleanup
                pass
        try:
            client.auth.admin.delete_user(owner)
        except Exception:  # noqa: BLE001
            pass

    def _commit(self, client, owner, recipe_id, request_id, new_ingredients=()):
        import hashlib
        import json as _json
        payload = _json.dumps({"request_id": request_id,
                               "ledger": list(new_ingredients)}, sort_keys=True)
        digest = hashlib.sha256(payload.encode()).hexdigest()
        return client.rpc("commit_recipe_with_ledger", {
            "p_owner_id": owner, "p_recipe_id": recipe_id,
            "p_request_id": request_id, "p_expected_revision": 0,
            "p_new_state": {"id": recipe_id, "revision": 1},
            "p_title": "live-check", "p_cost_snapshot": {"partial": True},
            "p_payload_hash": digest, "p_save_version": False,
            "p_new_ingredients": list(new_ingredients)}).execute().data

    def test_b_atomic_commit(self):
        import uuid
        client, owner, _, recipe_id = self._setup()
        ing_id = str(uuid.uuid4())
        rev = self._commit(client, owner, recipe_id, str(uuid.uuid4()),
                           [{"id": ing_id, "name": "塩", "brand": None, "spec": None}])
        self.assertEqual(rev, 1)
        self.assertEqual(client.table("recipes").select("revision")
                         .eq("id", recipe_id).single().execute().data["revision"], 1)
        self.assertEqual(client.table("ingredients").select("id")
                         .eq("id", ing_id).execute().data[0]["id"], ing_id)

    def test_b_rollback(self):
        import uuid
        client, owner, _, recipe_id = self._setup()
        ing_id = str(uuid.uuid4())
        client.table("ingredients").insert(
            {"id": ing_id, "owner_id": owner, "name": "既存塩"}).execute()
        with self.assertRaises(Exception) as ctx:
            self._commit(client, owner, recipe_id, str(uuid.uuid4()),
                         [{"id": ing_id, "name": "別名塩", "brand": None, "spec": None}])
        self.assertIn("Ingredient already registered", str(ctx.exception))
        self.assertEqual(client.table("recipes").select("revision")
                         .eq("id", recipe_id).single().execute().data["revision"], 0)

    def test_b_concurrent_replay(self):
        # Threads in flight simultaneously (barrier-synced), unlike the
        # sequential resend case below: one commit wins, the loser replays
        # with the negated revision.
        import threading as _th
        import uuid
        client, owner, _, recipe_id = self._setup()
        request_id = str(uuid.uuid4())
        barrier = _th.Barrier(2)
        results, errs = [], []

        def fire():
            try:
                barrier.wait(timeout=30)
                results.append(self._commit(client, owner, recipe_id, request_id))
            except Exception as exc:  # noqa: BLE001
                errs.append(exc)

        threads = [_th.Thread(target=fire), _th.Thread(target=fire)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=120)
        self.assertEqual(errs, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(sorted(abs(r) for r in results), [1, 1])
        self.assertEqual(sorted(r < 0 for r in results), [False, True])
        receipts = client.table("mutation_receipts").select("request_id") \
            .eq("owner_id", owner).eq("request_id", request_id).execute().data
        self.assertEqual(len(receipts), 1)

    def test_b_idempotent_resend(self):
        import uuid
        client, owner, _, recipe_id = self._setup()
        request_id = str(uuid.uuid4())
        first = self._commit(client, owner, recipe_id, request_id)
        second = self._commit(client, owner, recipe_id, request_id)
        self.assertEqual(first, 1)
        self.assertEqual(second, -1)

    def test_b_owner_separation(self):
        import uuid
        client, owner, owner_b, recipe_id = self._setup(with_second_owner=True)
        foreign = str(uuid.uuid4())
        client.table("ingredients").insert(
            {"id": foreign, "owner_id": owner_b, "name": "他者塩"}).execute()
        with self.assertRaises(Exception) as ctx:
            self._commit(client, owner, recipe_id, str(uuid.uuid4()),
                         [{"id": foreign, "name": "塩", "brand": None, "spec": None}])
        self.assertIn("not owned by caller", str(ctx.exception))
        # Trigger-level check: cross-owner offer insert is rejected by 0003.
        with self.assertRaises(Exception) as ctx2:
            client.table("offers").insert(
                {"owner_id": owner, "ingredient_id": foreign,
                 "product_url": "https://example.invalid/x"}).execute()
        self.assertIn("not owned by caller", str(ctx2.exception))


if __name__ == "__main__":
    unittest.main()
