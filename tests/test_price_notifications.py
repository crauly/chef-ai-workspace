"""M6: explicit-confirmation bell notifications. Fake repo; no live DB."""
import threading
import unittest
from decimal import Decimal
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace import Recipe, MaterialLine, PriceQuote, TrackedValue
from chef_ai_workspace.models import Ingredient
from chef_ai_workspace.price_notifications import (
    STATUSES, check_transition, decide_notification)
from chef_ai_workspace.price_history import PriceObservation


UNIT_DEFINITIONS = {"g": ("mass", Decimal("1")),
                    "kg": ("mass", Decimal("1000")),
                    "ml": ("volume", Decimal("1"))}

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
    def get_owned_observations(self, owner_id, ids):
        out = {}
        for i in ids:
            out[str(i)] = self.get_owned_observation(owner_id, str(i))
        return out

    def confirm_observation_notification(self, owner_id, observation_id):
        from chef_ai_workspace.price_history import PriceObservation as _Obs
        from chef_ai_workspace.price_notifications import (
            comparison_payload, decide_notification)
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
            base, _mk(candidate), UNIT_DEFINITIONS)
        if not should:
            raise ValueError("; ".join(reasons) or "incomparable")
        payload = comparison_payload(comp, basis_id)
        with self.lock:
            for note in self.notifications.values():
                if note["observation_id"] == observation_id \
                        and note["owner"] == owner_id:
                    stored_basis = note.get("basis_observation_id")
                    if stored_basis:
                        try:
                            basis_row = self.get_owned_observation(
                                owner_id, str(stored_basis))
                        except ValueError:
                            basis_row = None
                        if basis_row is not None:
                            from chef_ai_workspace.price_history import (
                                compare_observations as _compare)
                            snap_base = _mk(basis_row)
                            snap_cand = _mk(candidate)
                            _should, snap_comp, _reasons = decide_notification(
                                snap_base, snap_cand, UNIT_DEFINITIONS)
                            snap_comp = (snap_comp if snap_comp is not None
                                         else _compare(snap_base, snap_cand, UNIT_DEFINITIONS))
                            snap_payload = comparison_payload(
                                snap_comp, str(stored_basis))
                            return {"created": False,
                                    "notification": dict(note),
                                    "comparison": snap_payload}
                    legacy_payload = {
                        "comparable": False,
                        "reasons": ["original price basis unavailable"],
                        "currency": None,
                        "unit_basis": note.get("unit_basis"),
                        "base_unit_price": None,
                        "new_unit_price": None,
                        "diff": None,
                        "rate_pct": None,
                        "basis_observation_id": stored_basis,
                    }
                    return {"created": False, "notification": dict(note),
                            "comparison": legacy_payload}
            nid = str(uuid4())
            note = {"id": nid, "owner": owner_id,
                    "observation_id": observation_id,
                    "ingredient_id": candidate["ingredient_id"],
                    "basis_observation_id": basis_id,
                    "unit_basis": comp.unit_basis,
                    "change_jpy": comp.diff, "status": "unread",
                    "created_at": "2026-10-30T00:00:00+00:00"}
            self.notifications[nid] = note
            return {"created": True, "notification": dict(note),
                    "comparison": payload}

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
        from chef_ai_workspace.price_notifications import (
            ALLOWED_SOURCES, NotificationConflict, check_transition)
        if status not in ("unread", "acknowledged", "resolved"):
            raise ValueError("Unknown notification status")
        with self.lock:
            row = self.get_owned_notification(owner_id, notification_id)
            if row["status"] == status:
                return dict(row)
            if row["status"] not in ALLOWED_SOURCES[status]:
                check_transition(row["status"], status)
                raise NotificationConflict(
                    f"Notification {notification_id} moved concurrently; "
                    f"stored status is {row['status']}")
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


class UnitBasisContractTests(unittest.TestCase):
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

    def test_confirm_list_detail_retain_unit_basis(self):
        oid = self.repo.create_owned_observation(
            OWNER_1, OFF_A, "420", currency="JPY", tax_note="税込",
            shipping_note="送料込", source="purchase", confirmed=True,
            observed_at="2026-10-21T10:00:00+00:00")
        r = self.client.post(f"/demo/observations/{oid}/confirm", headers=self.h)
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["comparison"]["unit_basis"], "g")
        self.assertEqual(r.json()["comparison"]["currency"], "JPY")
        items = self.client.get("/demo/notifications", headers=self.h).json()["items"]
        self.assertEqual(len(items), 1)
        # No hardcoded unit: the basis travels with the payload.
        self.assertEqual(items[0]["unit_basis"], "g")
        self.assertEqual(items[0]["currency"], "JPY")
        self.assertEqual(items[0]["change_jpy"],
                         r.json()["comparison"]["diff"])
        nid = r.json()["notification"]["id"]
        detail = self.client.get(f"/demo/notifications/{nid}",
                                 headers=self.h).json()
        self.assertEqual(detail["comparison"]["unit_basis"], "g")
        self.assertEqual(detail["comparison"]["diff"], "0.1400")

    def test_kg_offer_converts_basis_without_hardcoding(self):
        self.repo.offers["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab09"] = {
            "owner": OWNER_1, "ingredient_id": ING_A, "supplier_id": SUP_A,
            "package_quantity": "1", "package_unit": "kg"}
        oid = self.repo.create_owned_observation(
            OWNER_1, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab09", "700",
            currency="JPY", tax_note="税込", shipping_note="送料込",
            source="purchase", confirmed=True,
            observed_at="2026-10-21T10:00:00+00:00")
        r = self.client.post(f"/demo/observations/{oid}/confirm", headers=self.h)
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["comparison"]["unit_basis"], "g")
        self.assertEqual(r.json()["comparison"]["diff"], "0.0000")


class StatusConflictTests(unittest.TestCase):
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

    def _notified_id(self):
        oid = self.repo.create_owned_observation(
            OWNER_1, OFF_A, "420", currency="JPY", tax_note="税込",
            shipping_note="送料込", source="purchase", confirmed=True,
            observed_at="2026-10-21T10:00:00+00:00")
        r = self.client.post(f"/demo/observations/{oid}/confirm", headers=self.h)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["notification"]["id"]

    def test_resolved_then_acknowledged_is_rejected(self):
        nid = self._notified_id()
        self.assertEqual(self.client.patch(
            f"/demo/notifications/{nid}", headers=self.h,
            json={"status": "resolved"}).status_code, 200)
        bad = self.client.patch(f"/demo/notifications/{nid}", headers=self.h,
                                json={"status": "acknowledged"})
        self.assertIn(bad.status_code, (409, 422))
        self.assertEqual(self.client.get(
            f"/demo/notifications/{nid}", headers=self.h
        ).json()["notification"]["status"], "resolved")

    def test_conflict_maps_to_409(self):
        from chef_ai_workspace.price_notifications import NotificationConflict

        class _ConflictRepo:
            def update_notification_status(self, owner_id, nid, status):
                raise NotificationConflict("moved concurrently")

        app.state.repository_factory = lambda: _ConflictRepo()
        r = self.client.patch(
            "/demo/notifications/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99",
            headers=self.h, json={"status": "acknowledged"})
        self.assertEqual(r.status_code, 409)

    def test_concurrent_moves_stay_legal(self):
        import threading
        nid = self._notified_id()
        outcomes = []

        def _move(target):
            try:
                outcomes.append(self.client.patch(
                    f"/demo/notifications/{nid}", headers=self.h,
                    json={"status": target}).status_code)
            except Exception as exc:  # pragma: no cover
                outcomes.append(exc)

        threads = [threading.Thread(target=_move, args=(t,))
                   for t in ("acknowledged", "resolved")]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertTrue(all(c in (200, 409, 422) for c in outcomes
                            if isinstance(c, int)), outcomes)
        final = self.client.get(f"/demo/notifications/{nid}",
                                headers=self.h).json()["notification"]["status"]
        self.assertIn(final, ("acknowledged", "resolved"))

    def test_adapter_cas_detects_moved_row(self):
        from chef_ai_workspace.price_notifications import NotificationConflict

        class _Resp:
            def __init__(self, data):
                self.data = data

        class _Query:
            def __init__(self, table, store):
                self._table = table
                self._store = store
            def select(self, *a, **k):
                return self
            def eq(self, *a, **k):
                return self
            def in_(self, *a, **k):
                return self
            def limit(self, *a, **k):
                return self
            def update(self, *a, **k):
                return self
            def order(self, *a, **k):
                return self
            def execute(self):
                if self._table == "price_notifications":
                    # UPDATE misses (row moved); re-read sees acknowledged.
                    return _Resp([])
                return _Resp([])

        class _Tables:
            def table(self, name):
                return _Query(name, None)

        from chef_ai_workspace.supabase_adapter import SupabasePersistence
        repo = SupabasePersistence.__new__(SupabasePersistence)
        repo.client = _Tables()
        repo.get_owned_notification = lambda o, n: {
            "id": n, "observation_id": "o", "ingredient_id": "i",
            "change_jpy": "0.1", "status": "acknowledged",
            "created_at": "2026-10-30T00:00:00+00:00"}
        with self.assertRaises(NotificationConflict):
            repo.update_notification_status(OWNER_1, "n", "resolved")


class HistoryInvarianceTests(unittest.TestCase):
    """Past notifications must not move when adoption changes later."""

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

    def _confirm(self, amount):
        oid = self.repo.create_owned_observation(
            OWNER_1, OFF_A, amount, currency="JPY", tax_note="税込",
            shipping_note="送料込", source="purchase", confirmed=True,
            observed_at="2026-10-21T10:00:00+00:00")
        r = self.client.post(f"/demo/observations/{oid}/confirm", headers=self.h)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def test_adoption_change_leaves_history_untouched(self):
        first = self._confirm("420")
        nid = first["notification"]["id"]
        before_list = self.client.get(
            "/demo/notifications", headers=self.h).json()["items"][0]
        before_detail = self.client.get(
            f"/demo/notifications/{nid}", headers=self.h).json()
        # Adopt a different price afterwards.
        oid2 = self.repo.create_owned_observation(
            OWNER_1, OFF_A, "500", currency="JPY", tax_note="税込",
            shipping_note="送料込", source="purchase", confirmed=True,
            observed_at="2026-10-22T10:00:00+00:00")
        self.repo.ingredients[ING_A]["adopted"] = oid2
        after_list = self.client.get(
            "/demo/notifications", headers=self.h).json()["items"][0]
        after_detail = self.client.get(
            f"/demo/notifications/{nid}", headers=self.h).json()
        self.assertEqual(after_list["basis_observation_id"], OBS_BASE)
        self.assertEqual(after_list["unit_basis"], before_list["unit_basis"])
        self.assertEqual(after_list["change_jpy"], before_list["change_jpy"])
        self.assertEqual(after_detail["basis_observation_id"], OBS_BASE)
        self.assertEqual(after_detail["comparison"]["unit_basis"],
                         before_detail["comparison"]["unit_basis"])
        self.assertEqual(after_detail["comparison"]["diff"],
                         before_detail["comparison"]["diff"])
        self.assertEqual(after_detail["comparison"]["diff"], "0.1400")
        self.assertEqual({i["recipe_id"] for i in after_detail["items"]}, {R1})
        # A new confirmation uses the new basis.
        second = self._confirm("300")
        self.assertEqual(second["comparison"]["basis_observation_id"], oid2)

    def test_legacy_row_without_snapshot_still_readable(self):
        first = self._confirm("420")
        nid = first["notification"]["id"]
        # Simulate a pre-0004 row: snapshot columns absent.
        row = self.repo.notifications[nid]
        del row["basis_observation_id"]
        del row["unit_basis"]
        items = self.client.get("/demo/notifications", headers=self.h).json()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["unit_basis"], "g")
        detail = self.client.get(f"/demo/notifications/{nid}",
                                 headers=self.h).json()
        self.assertTrue(detail["comparable"])
        self.assertEqual(detail["comparison"]["diff"], "0.1400")


class ResendSnapshotTests(unittest.TestCase):
    """Resending one observation must replay its creation snapshot."""

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

    def _confirm(self, amount):
        oid = self.repo.create_owned_observation(
            OWNER_1, OFF_A, amount, currency="JPY", tax_note="税込",
            shipping_note="送料込", source="purchase", confirmed=True,
            observed_at="2026-10-21T10:00:00+00:00")
        r = self.client.post(f"/demo/observations/{oid}/confirm", headers=self.h)
        self.assertEqual(r.status_code, 201, r.text)
        return oid, r.json()

    def test_resend_after_adoption_change_replays_snapshot(self):
        oid, first = self._confirm("420")
        nid = first["notification"]["id"]
        # Adopt a different price afterwards.
        oid2 = self.repo.create_owned_observation(
            OWNER_1, OFF_A, "500", currency="JPY", tax_note="税込",
            shipping_note="送料込", source="purchase", confirmed=True,
            observed_at="2026-10-22T10:00:00+00:00")
        self.repo.ingredients[ING_A]["adopted"] = oid2
        again = self.client.post(f"/demo/observations/{oid}/confirm",
                                 headers=self.h)
        self.assertEqual(again.status_code, 201, again.text)
        body = again.json()
        self.assertFalse(body["created"])
        self.assertEqual(body["notification"]["id"], nid)
        self.assertEqual(body["comparison"]["basis_observation_id"], OBS_BASE)
        self.assertEqual(body["comparison"]["unit_basis"],
                         first["comparison"]["unit_basis"])
        self.assertEqual(body["comparison"]["diff"], first["comparison"]["diff"])
        self.assertEqual(body["comparison"]["diff"], "0.1400")
        self.assertEqual(len(self.repo.notifications), 1)

    def test_legacy_resend_returns_no_invented_numbers(self):
        oid, first = self._confirm("420")
        nid = first["notification"]["id"]
        row = self.repo.notifications[nid]
        del row["basis_observation_id"]
        del row["unit_basis"]
        again = self.client.post(f"/demo/observations/{oid}/confirm",
                                 headers=self.h)
        self.assertEqual(again.status_code, 201, again.text)
        body = again.json()
        self.assertFalse(body["created"])
        self.assertEqual(body["notification"]["id"], nid)
        self.assertFalse(body["comparison"]["comparable"])
        self.assertIsNone(body["comparison"]["diff"])
        self.assertTrue(body["comparison"]["reasons"])
        self.assertEqual(len(self.repo.notifications), 1)


class AdapterResendSnapshotTests(unittest.TestCase):
    """Adapter conflict path must replay the stored basis snapshot."""

    def _repo_with_conflict(self, note, rows):
        from chef_ai_workspace.supabase_adapter import SupabasePersistence

        class _Conflict(Exception):
            pass

        class _Resp:
            def __init__(self, data):
                self.data = data

        class _Insert:
            def execute(self):
                exc = Exception("duplicate key value violates unique constraint")
                exc.code = "23505"
                raise exc

        class _Select:
            def __init__(self, data):
                self._data = data
            def eq(self, *a, **k):
                return self
            def limit(self, *a, **k):
                return self
            def execute(self):
                return _Resp(self._data)

        class _Table:
            def __init__(self, note):
                self._note = note
            def insert(self, payload):
                return _Insert()
            def select(self, cols):
                return _Select([dict(self._note)])

        class _Tables:
            def __init__(self, note):
                self._note = note
            def table(self, name):
                return _Table(self._note)

        repo = SupabasePersistence.__new__(SupabasePersistence)
        repo.client = _Tables(note)
        repo.list_owned_units = lambda owner: [{"id":"g-id","symbol":"g",
            "dimension":"mass","base_factor":"1","aliases":[]}]
        return repo

    def _row(self, oid, amount):
        return {"id": oid, "ingredient_id": ING_A, "offer_id": OFF_A,
                "supplier_id": SUP_A, "amount_jpy": amount, "currency": "JPY",
                "tax_note": "税込", "shipping_note": "送料込",
                "package_quantity": "500", "package_unit": "g",
                "source": "purchase", "confirmed": True,
                "observed_at": "2026-10-21T10:00:00+00:00"}

    def test_conflict_replays_stored_basis_not_current_adoption(self):
        old_basis = self._row(OBS_BASE, "350")
        cand_id = "cccccccc-cccc-cccc-cccc-cccccccccc01"
        cand = self._row(cand_id, "420")
        new_basis = self._row("dddddddd-dddd-dddd-dddd-dddddddddd01", "500")
        note = {"id": "n1", "observation_id": cand_id, "ingredient_id": ING_A,
                "basis_observation_id": OBS_BASE, "unit_basis": "g",
                "change_jpy": "0.1400", "status": "unread",
                "created_at": "2026-10-30T00:00:00+00:00"}
        repo = self._repo_with_conflict(note, None)
        repo.get_owned_observation = lambda o, i: {
            cand_id: cand, OBS_BASE: old_basis,
            "dddddddd-dddd-dddd-dddd-dddddddddd01": new_basis}[str(i)]
        repo.get_owned_ingredient_adoption = lambda o, i: {
            "ingredient_id": i,
            "adopted_observation_id": "dddddddd-dddd-dddd-dddd-dddddddddd01",
            "adopted_at": None}
        out = repo.confirm_observation_notification(OWNER_1, cand_id)
        self.assertFalse(out["created"])
        self.assertEqual(out["notification"]["id"], "n1")
        self.assertEqual(out["comparison"]["basis_observation_id"], OBS_BASE)
        self.assertEqual(out["comparison"]["unit_basis"], "g")
        self.assertEqual(out["comparison"]["diff"], "0.1400")

    def test_conflict_legacy_note_returns_incomparable(self):
        cand_id = "cccccccc-cccc-cccc-cccc-cccccccccc02"
        cand = self._row(cand_id, "420")
        note = {"id": "n2", "observation_id": cand_id, "ingredient_id": ING_A,
                "change_jpy": "0.1400", "status": "unread",
                "created_at": "2026-10-30T00:00:00+00:00"}
        repo = self._repo_with_conflict(note, None)
        repo.get_owned_observation = lambda o, i: cand
        repo.get_owned_ingredient_adoption = lambda o, i: {
            "ingredient_id": i, "adopted_observation_id": OBS_BASE,
            "adopted_at": None}
        out = repo.confirm_observation_notification(OWNER_1, cand_id)
        self.assertFalse(out["created"])
        self.assertEqual(out["notification"]["id"], "n2")
        self.assertFalse(out["comparison"]["comparable"])
        self.assertIsNone(out["comparison"]["diff"])
        self.assertTrue(out["comparison"]["reasons"])


class AdapterSchemaFallbackTests(unittest.TestCase):
    """Pre-0004 databases stay usable via the legacy column set."""

    def _repo(self, handler):
        from chef_ai_workspace.supabase_adapter import SupabasePersistence

        class _Resp:
            def __init__(self, data):
                self.data = data

        class _Query:
            def __init__(self, table, handler):
                self._table = table
                self._handler = handler
                self._cols = ""
            def select(self, cols):
                self._cols = cols
                return self
            def eq(self, *a, **k):
                return self
            def in_(self, *a, **k):
                return self
            def order(self, *a, **k):
                return self
            def limit(self, *a, **k):
                return self
            def update(self, *a, **k):
                return self
            def execute(self):
                return _Resp(self._handler(self._table, self._cols))

        class _Tables:
            def table(self, name):
                return _Query(name, handler)

        repo = SupabasePersistence.__new__(SupabasePersistence)
        repo.client = _Tables()
        return repo

    def test_list_falls_back_on_missing_columns(self):
        from postgrest.exceptions import APIError
        calls = []

        def _handle(table, cols):
            calls.append(cols)
            if "basis_observation_id" in cols:
                raise APIError({"code": "42703",
                                "message": 'column "basis_observation_id" does not exist'})
            return [{"id": "n", "observation_id": "o", "ingredient_id": "i",
                     "change_jpy": "0.1", "status": "unread",
                     "created_at": "2026-10-30T00:00:00+00:00"}]

        repo = self._repo(_handle)
        rows = repo.list_owned_notifications(OWNER_1)
        self.assertEqual(len(rows), 1)
        self.assertTrue(any("basis_observation_id" in c for c in calls))
        self.assertTrue(any("basis_observation_id" not in c for c in calls))

    def test_non_column_errors_are_not_swallowed(self):
        from postgrest.exceptions import APIError

        def _handle(table, cols):
            raise APIError({"code": "42501",
                            "message": "permission denied"})

        repo = self._repo(_handle)
        with self.assertRaises(APIError):
            repo.list_owned_notifications(OWNER_1)


if __name__ == "__main__":
    unittest.main()
