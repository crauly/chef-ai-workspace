"""M6: explicit-confirmation bell notifications. Fake repo; no live DB."""
import threading
import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace import Recipe, MaterialLine, PriceQuote, TrackedValue
from chef_ai_workspace.models import Ingredient
from chef_ai_workspace.price_notifications import (
    STATUSES, check_transition, decide_notification)
from chef_ai_workspace.price_history import PriceObservation


def tv(v, status="confirmed"):
    return TrackedValue(str(v), status, "user")


def quote(amount, per_qty, per_unit):
    return PriceQuote(tv(amount), str(per_qty), str(per_unit), "manual")


ING_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
ING_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
SUP_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01"
OFF_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab01"
R1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaac01"
L_INHERIT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaad01"
OWNER_1 = "11111111-1111-1111-1111-111111111111"
OWNER_2 = "22222222-2222-2222-2222-222222222222"
OBS_BASE = "33333333-3333-3333-3333-333333333333"


def obs(oid, amount="350", offer=OFF_A, currency="JPY", tax="税込",
        ship="送料込", qty="500", unit="g", ingredient=ING_A):
    return PriceObservation(oid, ingredient, offer, SUP_A, amount, currency,
                            tax, ship, qty, unit, "purchase", True,
                            "2026-10-20T10:00:00+00:00")


class DecideTests(unittest.TestCase):
    def test_comparable_notifies_with_numbers(self):
        should, comp, reasons = decide_notification(obs("b"), obs("c", amount="420"))
        self.assertTrue(should)
        self.assertTrue(comp.comparable)
        self.assertEqual(reasons, [])
        self.assertEqual(comp.diff, "0.1400")

    def test_fall_notifies(self):
        should, comp, _ = decide_notification(obs("b"), obs("c", amount="300"))
        self.assertTrue(should)
        self.assertEqual(comp.diff, "-0.1000")

    def test_no_basis_suppresses(self):
        should, comp, reasons = decide_notification(None, obs("c"))
        self.assertFalse(should)
        self.assertIsNone(comp)
        self.assertEqual(reasons, ["no adopted price basis"])

    def test_incomparable_suppresses_without_numbers(self):
        should, comp, reasons = decide_notification(obs("b"), obs("c", tax="税別"))
        self.assertFalse(should)
        self.assertFalse(comp.comparable)
        self.assertTrue(reasons)
        self.assertIsNone(comp.diff)

    def test_non_jpy_suppresses(self):
        should, _, reasons = decide_notification(
            obs("b", currency="USD", amount="3"), obs("c", currency="USD", amount="4"))
        self.assertFalse(should)
        self.assertTrue(any("JPY" in r for r in reasons))

    def test_transitions(self):
        check_transition("unread", "acknowledged")
        check_transition("acknowledged", "resolved")
        check_transition("unread", "resolved")
        with self.assertRaises(ValueError):
            check_transition("resolved", "unread")
        with self.assertRaises(ValueError):
            check_transition("unread", "bogus")


class FakeRepo:
    """Owner-enforcing fake with unique(observation_id) notifications."""

    def __init__(self, owner):
        self.owner = owner
        self.lock = threading.Lock()
        self.ingredients = {ING_A: {"owner": owner, "name": "パスタ",
                                    "current_price": quote("700", "1000", "g"),
                                    "adopted": OBS_BASE},
                            ING_B: {"owner": owner, "name": "塩",
                                    "current_price": None, "adopted": None}}
        self.offers = {OFF_A: {"owner": owner, "ingredient_id": ING_A,
                               "supplier_id": SUP_A, "package_quantity": "500",
                               "package_unit": "g"}}
        self.observations = {OBS_BASE: {"id": OBS_BASE, "owner": owner,
                                        "offer_id": OFF_A, "amount_jpy": "350",
                                        "currency": "JPY", "tax_note": "税込",
                                        "shipping_note": "送料込",
                                        "source": "purchase", "confirmed": True,
                                        "observed_at": "2026-10-01T10:00:00+00:00"}}
        self.notifications = {}
        self.recipes = {
            R1: Recipe(R1, tv("ペペロンチーノ"), (
                MaterialLine(L_INHERIT, tv("パスタ"), tv("100"), "g",
                             ingredient_id=ING_A, price_mode="inherit"),),
                       tv("1800")),
        }
        self.adopt_writes = 0

    # -- M5 repo surface (read-only for notifications) --
    def _owned_ingredient(self, owner_id, ingredient_id):
        row = self.ingredients.get(ingredient_id)
        if owner_id != self.owner or row is None or row["owner"] != owner_id:
            raise ValueError("Ingredient not owned by caller")
        return row

    def load_owned_ingredients(self, owner_id, ids):
        out = {}
        for i in ids:
            try:
                row = self._owned_ingredient(owner_id, i)
            except ValueError:
                continue
            out[i] = Ingredient(i, row["name"], row["current_price"])
        return out

    def _row(self, obs_id):
        r = self.observations[obs_id]
        offer = self.offers[r["offer_id"]]
        return dict(r, ingredient_id=offer["ingredient_id"],
                    package_quantity=offer["package_quantity"],
                    package_unit=offer["package_unit"],
                    supplier_id=offer["supplier_id"])

    def get_owned_observation(self, owner_id, observation_id):
        row = self.observations.get(observation_id)
        if row is None or owner_id != self.owner or row["owner"] != owner_id:
            raise ValueError("Observation not owned by caller")
        return self._row(observation_id)

    def get_owned_ingredient_adoption(self, owner_id, ingredient_id):
        row = self._owned_ingredient(owner_id, ingredient_id)
        return {"ingredient_id": ingredient_id,
                "adopted_observation_id": row["adopted"], "adopted_at": None}

    def list_recipes_using_ingredient(self, owner_id, ingredient_id, limit=None,
                                      page_size=200):
        if owner_id != self.owner:
            raise ValueError("Ingredient not owned by caller")
        self._owned_ingredient(owner_id, ingredient_id)
        matches = [r for r in self.recipes.values()
                   if any(m.ingredient_id == ingredient_id for m in r.materials)]
        return matches if limit is None else matches[:limit]

    def create_owned_observation(self, owner_id, offer_id, amount_jpy,
                                 currency="JPY", tax_note=None,
                                 shipping_note=None, source="manual_entry",
                                 confirmed=False, observed_at=None):
        from chef_ai_workspace.models import decimal as _decimal
        offer = self.offers.get(offer_id)
        if owner_id != self.owner or offer is None or offer["owner"] != owner_id:
            raise ValueError("Offer not owned by caller")
        new_id = str(uuid4())
        self.observations[new_id] = {
            "id": new_id, "owner": owner_id, "offer_id": offer_id,
            "amount_jpy": str(_decimal(amount_jpy)), "currency": currency,
            "tax_note": tax_note, "shipping_note": shipping_note,
            "source": source, "confirmed": confirmed,
            "observed_at": observed_at or "2026-10-30T00:00:00+00:00"}
        return new_id

    # -- M6 repo surface --
    def confirm_observation_notification(self, owner_id, observation_id):
        from chef_ai_workspace.price_history import PriceObservation as _Obs
        from chef_ai_workspace.price_notifications import decide_notification
        candidate = self.get_owned_observation(owner_id, observation_id)
        ref = self.get_owned_ingredient_adoption(
            owner_id, candidate["ingredient_id"])

        def _mk(row):
            return _Obs(str(row["id"]), str(row["ingredient_id"]),
                        str(row["offer_id"]),
                        str(row["supplier_id"]) if row.get("supplier_id") else None,
                        str(row["amount_jpy"]), str(row["currency"]),
                        row.get("tax_note"), row.get("shipping_note"),
                        str(row.get("package_quantity") or ""),
                        str(row.get("package_unit") or ""),
                        str(row["source"]), bool(row.get("confirmed")),
                        str(row.get("observed_at") or ""))

        basis_id = ref.get("adopted_observation_id")
        base = _mk(self.get_owned_observation(owner_id, basis_id)) \
            if basis_id else None
        should, comp, reasons = decide_notification(
            base, _mk(candidate))
        if not should:
            raise ValueError("; ".join(reasons) or "incomparable")
        with self.lock:
            for note in self.notifications.values():
                if note["observation_id"] == observation_id \
                        and note["owner"] == owner_id:
                    return {"created": False, "notification": dict(note),
                            "comparison": {"comparable": True, "reasons": [],
                                           "diff": comp.diff,
                                           "rate_pct": comp.rate_pct,
                                           "currency": comp.currency}}
            nid = str(uuid4())
            note = {"id": nid, "owner": owner_id,
                    "observation_id": observation_id,
                    "ingredient_id": candidate["ingredient_id"],
                    "change_jpy": comp.diff, "status": "unread",
                    "created_at": "2026-10-30T00:00:00+00:00"}
            self.notifications[nid] = note
            return {"created": True, "notification": dict(note),
                    "comparison": {"comparable": True, "reasons": [],
                                   "diff": comp.diff, "rate_pct": comp.rate_pct,
                                   "currency": comp.currency}}

    def list_owned_notifications(self, owner_id, status=None, limit=100):
        from chef_ai_workspace.price_notifications import STATUSES
        if owner_id != self.owner:
            return []
        if status is not None and status not in STATUSES:
            raise ValueError("Unknown notification status")
        rows = sorted(self.notifications.values(),
                      key=lambda r: r["created_at"], reverse=True)
        if status is not None:
            rows = [r for r in rows if r["status"] == status]
        return [dict(r) for r in rows[:limit]]

    def get_owned_notification(self, owner_id, notification_id):
        row = self.notifications.get(notification_id)
        if row is None or owner_id != self.owner or row["owner"] != owner_id:
            raise ValueError("Notification not owned by caller")
        return dict(row)

    def update_notification_status(self, owner_id, notification_id, status):
        from chef_ai_workspace.price_notifications import check_transition
        row = self.get_owned_notification(owner_id, notification_id)
        check_transition(row["status"], status)
        if row["status"] == status:
            return dict(row)
        row["status"] = status
        self.notifications[notification_id] = row
        return dict(row)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.repo = FakeRepo(OWNER_1)
        app.state.demo_owner_id = OWNER_1
        app.state.demo_access_token = "test-secret"
        app.state.repository_factory = lambda: self.repo
        self.client = TestClient(app, raise_server_exceptions=False)
        self.h = {"X-Demo-Access": "test-secret"}

    def tearDown(self):
        self.client.close()
        del app.state.demo_owner_id
        del app.state.demo_access_token
        del app.state.repository_factory

    def _confirm_observation(self, amount, **kw):
        oid = self.repo.create_owned_observation(
            OWNER_1, OFF_A, amount, currency="JPY", tax_note="税込",
            shipping_note="送料込", source="purchase", confirmed=True,
            observed_at="2026-10-21T10:00:00+00:00", **kw)
        return self.client.post(f"/demo/observations/{oid}/confirm",
                                headers=self.h)

    def test_rise_and_fall_notify(self):
        r = self._confirm_observation("420")
        self.assertEqual(r.status_code, 201, r.text)
        self.assertTrue(r.json()["created"])
        self.assertEqual(r.json()["comparison"]["diff"], "0.1400")
        r = self._confirm_observation("300")
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["comparison"]["diff"], "-0.1000")

    def test_incomparable_suppressed(self):
        oid = self.repo.create_owned_observation(
            OWNER_1, OFF_A, "400", currency="JPY", tax_note="税別",
            shipping_note="送料込", source="purchase", confirmed=True,
            observed_at="2026-10-21T10:00:00+00:00")
        r = self.client.post(f"/demo/observations/{oid}/confirm", headers=self.h)
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.repo.notifications, {})

    def test_no_basis_suppressed(self):
        # Point the observation at ING_B (no adopted price) via a new offer.
        self.repo.offers["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0001"] = {
            "owner": OWNER_1, "ingredient_id": ING_B, "supplier_id": SUP_A,
            "package_quantity": "500", "package_unit": "g"}
        oid2 = self.repo.create_owned_observation(
            OWNER_1, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0001", "100",
            currency="JPY", tax_note="税込", shipping_note="送料込",
            source="purchase", confirmed=True,
            observed_at="2026-10-21T10:00:00+00:00")
        r = self.client.post(f"/demo/observations/{oid2}/confirm", headers=self.h)
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("no adopted price basis", r.text)

    def test_resend_and_concurrent_single_notification(self):
        r = self._confirm_observation("420")
        oid = r.json()["notification"]["observation_id"]
        again = self.client.post(f"/demo/observations/{oid}/confirm",
                                 headers=self.h)
        self.assertEqual(again.status_code, 201)
        self.assertFalse(again.json()["created"])
        self.assertEqual(again.json()["notification"]["id"],
                         r.json()["notification"]["id"])
        results = []
        # Fresh observation for the race.
        r2 = self._confirm_observation("430")
        oid2 = r2.json()["notification"]["observation_id"]
        # Delete it to re-race at repo level (keeps the HTTP path covered above).
        del self.repo.notifications[r2.json()["notification"]["id"]]

        def _hit():
            try:
                results.append(self.repo.confirm_observation_notification(
                    OWNER_1, oid2))
            except Exception as exc:  # pragma: no cover - must not happen
                results.append(exc)

        threads = [threading.Thread(target=_hit) for _ in range(10)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        ids = {res["notification"]["id"] for res in results
               if isinstance(res, dict)}
        self.assertEqual(len(ids), 1)
        self.assertEqual(sum(1 for res in results
                             if isinstance(res, dict) and res["created"]), 1)

    def test_status_flow_and_list_detail(self):
        r = self._confirm_observation("420")
        nid = r.json()["notification"]["id"]
        items = self.client.get("/demo/notifications", headers=self.h).json()["items"]
        self.assertEqual(len(items), 1)
        detail = self.client.get(f"/demo/notifications/{nid}",
                                 headers=self.h)
        self.assertEqual(detail.status_code, 200, detail.text)
        body = detail.json()
        self.assertEqual(body["notification"]["id"], nid)
        self.assertEqual(body["observation"]["id"],
                         body["notification"]["observation_id"])
        self.assertTrue(body["comparable"])
        self.assertEqual({i["recipe_id"] for i in body["items"]}, {R1})
        for nxt in ("acknowledged", "resolved"):
            u = self.client.patch(f"/demo/notifications/{nid}", headers=self.h,
                                  json={"status": nxt})
            self.assertEqual(u.status_code, 200, u.text)
            self.assertEqual(u.json()["status"], nxt)
        bad = self.client.patch(f"/demo/notifications/{nid}", headers=self.h,
                                json={"status": "unread"})
        self.assertEqual(bad.status_code, 422)
        # Status moves never adopt prices or rewrite recipes.
        self.assertEqual(self.repo.ingredients[ING_A]["adopted"], OBS_BASE)
        self.assertEqual(self.repo.ingredients[ING_A]["current_price"].amount_jpy.value,
                         "700")

    def test_owner_isolation(self):
        r = self._confirm_observation("420")
        nid = r.json()["notification"]["id"]
        other = FakeRepo(OWNER_2)
        app.state.repository_factory = lambda: other
        self.assertEqual(self.client.get("/demo/notifications",
                                         headers=self.h).json()["items"], [])
        self.assertEqual(self.client.get(f"/demo/notifications/{nid}",
                                         headers=self.h).status_code, 404)
        self.assertEqual(self.client.patch(f"/demo/notifications/{nid}",
                                           headers=self.h,
                                           json={"status": "acknowledged"}).status_code,
                         404)


if __name__ == "__main__":
    unittest.main()
