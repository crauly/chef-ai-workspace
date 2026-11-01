"""Ledger-grounded reference price for natural-language research requests."""
import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.demo_api import router
from chef_ai_workspace.price_history import PriceObservation, summarize_reference_price

if not any(getattr(route, "path", None) == "/demo/recipes" for route in app.routes):
    app.include_router(router)


def obs(**kw):
    base = {"id": str(uuid4()), "ingredient_id": "ing-1", "offer_id": "off-1",
            "supplier_id": None, "amount": "350", "currency": "JPY",
            "tax_note": None, "shipping_note": None,
            "package_quantity": "500", "package_unit": "g",
            "source": "purchase", "confirmed": True, "observed_at": "2026-10-20"}
    base.update(kw)
    return PriceObservation(**base)


class SummarizeTests(unittest.TestCase):
    def test_average_over_comparable(self):
        out = summarize_reference_price([obs(amount="350"), obs(amount="420", observed_at="2026-10-28")])
        self.assertTrue(out["available"])
        self.assertEqual(out["currency"], "JPY")
        self.assertEqual(out["unit_basis"], "g")
        self.assertEqual(out["observation_count"], 2)
        # (350/500 + 420/500) / 2 = 0.77
        self.assertEqual(out["average_unit_price"], "0.7700")
        self.assertEqual(out["observed_from"], "2026-10-20")
        self.assertEqual(out["observed_to"], "2026-10-28")

    def test_incomparable_terms_excluded(self):
        out = summarize_reference_price([
            obs(amount="350"), obs(amount="350", currency="USD"),
            obs(amount="350", package_unit="ml")])
        self.assertTrue(out["available"])
        self.assertEqual(out["observation_count"], 1)
        self.assertEqual(out["excluded_count"], 2)

    def test_single_observation_is_valid_reference(self):
        out = summarize_reference_price([obs()])
        self.assertTrue(out["available"])
        self.assertEqual(out["method"], "single observation")

    def test_empty_has_no_reference(self):
        out = summarize_reference_price([])
        self.assertFalse(out["available"])
        self.assertEqual(out["observation_count"], 0)

    def test_invalid_rows_excluded(self):
        out = summarize_reference_price([obs(amount="x"), obs(package_quantity="0")])
        self.assertFalse(out["available"])


class FakeLedger:
    def __init__(self, owner="owner"):
        self.owner = owner
        self.offers = [{"id": "off-1", "supplier_id": None,
                        "package_quantity": "500", "package_unit": "g"}]
        self.rows = {"off-1": {"id": "obs-1", "amount_jpy": "350",
                               "currency": "JPY", "tax_note": None,
                               "shipping_note": None, "source": "purchase",
                               "confirmed": True, "observed_at": "2026-10-28",
                               "supplier_id": None}}
    def search_owned_ingredients(self, owner, query, limit=20):
        assert owner == self.owner
        return [{"id": "ing-1", "name": "豚バラ肉"}] if query else []
    def list_ingredient_offers(self, owner, ingredient_id):
        return self.offers if ingredient_id == "ing-1" else []
    def list_latest_observations_for_offers(self, owner, offer_ids):
        return {oid: self.rows[oid] for oid in offer_ids if oid in self.rows}


class ReferenceEndpointTests(unittest.TestCase):
    def setUp(self):
        from uuid import uuid4
        self.owner = str(uuid4())
        self.repo = FakeLedger(self.owner)
        app.state.demo_owner_id = self.owner
        app.state.demo_access_token = "a-secret-known-only-to-presenter"
        app.state.repository_factory = lambda: self.repo
        self.client = TestClient(app)
    def tearDown(self):
        for key in ("demo_owner_id", "demo_access_token", "repository_factory"):
            if hasattr(app.state, key):
                delattr(app.state, key)
        self.client.close()
    def headers(self):
        return {"X-Demo-Access": "a-secret-known-only-to-presenter"}
    def test_reference_returns_average_with_provenance(self):
        res = self.client.get("/demo/price-reference", params={"name": "豚バラ"},
                              headers=self.headers())
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(len(body["candidates"]), 1)
        ref = body["candidates"][0]["reference"]
        self.assertTrue(ref["available"])
        self.assertEqual(ref["average_unit_price"], "0.7000")
        self.assertEqual(ref["unit_basis"], "g")
        self.assertEqual(len(body["candidates"][0]["observations"]), 1)

    def test_external_block_reports_unavailable_without_faking(self):
        from chef_ai_workspace.external_reference import (
            EXTERNAL_REFERENCE_STATUS, fetch_external_reference,
            ExternalReferenceUnavailable)
        self.assertFalse(EXTERNAL_REFERENCE_STATUS["available"])
        with self.assertRaises(ExternalReferenceUnavailable):
            fetch_external_reference("豚バラ肉")
        res = self.client.get("/demo/price-reference", params={"name": "豚バラ"},
                              headers=self.headers())
        body = res.json()
        self.assertFalse(body["external"]["available"])
        self.assertIn("required", body["external"])

    def test_blank_name_rejected(self):
        res = self.client.get("/demo/price-reference", params={"name": " "},
                              headers=self.headers())
        self.assertEqual(res.status_code, 422)

    def test_access_denied_without_secret(self):
        res = self.client.get("/demo/price-reference", params={"name": "豚"})
        self.assertEqual(res.status_code, 403)

    def test_read_only_no_writes(self):
        before = (list(self.repo.offers), dict(self.repo.rows))
        self.client.get("/demo/price-reference", params={"name": "豚バラ"},
                        headers=self.headers())
        self.assertEqual((self.repo.offers, self.repo.rows), (before[0], before[1]))


if __name__ == "__main__":
    unittest.main()
