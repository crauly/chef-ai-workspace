"""M7: substitute / alternate-supplier suggestions. Fixture repo; no live DB.

All candidates here are fixture ledger rows: no test performs live web
retrieval, and the suite asserts the provider status says unavailable
instead of returning invented listings. Real-fetch tests do not exist
yet because no retrieval means has been confirmed (ADR-009 section 6).
"""
import copy
import unittest
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.models import Ingredient

OWNER_1 = "11111111-1111-1111-1111-111111111111"
OWNER_2 = "22222222-2222-2222-2222-222222222222"
ING = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10"
ING_SIM1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11"
ING_SIM2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12"
ING_BARE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb00b1"
OFF_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab11"
OFF_2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab12"
OFF_3 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab13"
OFF_S1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab14"
SUP_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa21"
SUP_2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa22"
OBS_BASE = "33333333-3333-3333-3333-333333333300"
OBS_1 = "33333333-3333-3333-3333-333333333301"
OBS_2 = "33333333-3333-3333-3333-333333333302"
OBS_S1 = "33333333-3333-3333-3333-333333333303"


def _obs(oid, offer, amount, *, tax="税込", ship="送料込", source="purchase",
         confirmed=True, observed_at="2026-10-21T10:00:00+00:00"):
    return {"id": oid, "offer_id": offer, "amount_jpy": amount,
            "currency": "JPY", "tax_note": tax, "shipping_note": ship,
            "source": source, "confirmed": confirmed,
            "observed_at": observed_at}


class FakeLedger:
    """Owner-scoped fixture ledger with the M7 read surface."""

    def __init__(self, owner):
        self.owner = owner
        self.ingredients = {
            ING: {"owner": owner, "name": "パスタ", "adopted": OBS_BASE},
            ING_SIM1: {"owner": owner, "name": "パスタ(国産)",
                       "adopted": None},
            ING_SIM2: {"owner": owner, "name": "全粒粉パスタ",
                       "adopted": None},
            ING_BARE: {"owner": owner, "name": "塩", "adopted": None},
        }
        self.offers = {
            OFF_1: {"id": OFF_1, "owner": owner, "ingredient_id": ING,
                    "supplier_id": SUP_1, "product_url": None,
                    "package_quantity": "500", "package_unit": "g",
                    "shipping_note": None},
            OFF_2: {"id": OFF_2, "owner": owner, "ingredient_id": ING,
                    "supplier_id": SUP_2,
                    "product_url": "https://example.invalid/item/2",
                    "package_quantity": "500", "package_unit": "g",
                    "shipping_note": None},
            OFF_3: {"id": OFF_3, "owner": owner, "ingredient_id": ING,
                    "supplier_id": None, "product_url": None,
                    "package_quantity": "500", "package_unit": "g",
                    "shipping_note": None},
            OFF_S1: {"id": OFF_S1, "owner": owner,
                     "ingredient_id": ING_SIM1, "supplier_id": SUP_1,
                     "product_url": None, "package_quantity": "500",
                     "package_unit": "g", "shipping_note": None},
        }
        self.suppliers = {SUP_1: {"owner": owner, "name": "スーパーA"},
                          SUP_2: {"owner": owner, "name": "ネットB"}}
        self.observations = {
            OBS_BASE: _obs(OBS_BASE, OFF_1, "350",
                           observed_at="2026-10-01T10:00:00+00:00"),
            OBS_1: _obs(OBS_1, OFF_1, "420"),
            OBS_2: _obs(OBS_2, OFF_2, "300", tax="税別",
                        source="web_reference", confirmed=False,
                        observed_at="2026-10-22T10:00:00+00:00"),
            OBS_S1: _obs(OBS_S1, OFF_S1, "380",
                         observed_at="2026-10-20T10:00:00+00:00"),
        }

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
            out[i] = Ingredient(i, row["name"], None)
        return out

    def list_ingredient_offers(self, owner_id, ingredient_id):
        self._owned_ingredient(owner_id, ingredient_id)
        return [dict(o) for o in self.offers.values()
                if o["ingredient_id"] == ingredient_id
                and o["owner"] == owner_id]

    def list_ingredient_observations(self, owner_id, ingredient_id, limit=100):
        self._owned_ingredient(owner_id, ingredient_id)
        offer_ids = {o["id"] for o in self.offers.values()
                     if o["ingredient_id"] == ingredient_id}
        rows = [r for r in self.observations.values()
                if r["offer_id"] in offer_ids]
        rows.sort(key=lambda r: r["observed_at"], reverse=True)
        out = []
        for r in rows[:limit]:
            offer = self.offers[r["offer_id"]]
            supplier = self.suppliers.get(offer["supplier_id"] or "")
            out.append({**r, "ingredient_id": ingredient_id,
                        "package_quantity": offer["package_quantity"],
                        "package_unit": offer["package_unit"],
                        "supplier_id": offer["supplier_id"],
                        "supplier_name": supplier["name"] if supplier else None,
                        "product_url": offer["product_url"]})
        return out

    def get_owned_ingredient_adoption(self, owner_id, ingredient_id):
        row = self._owned_ingredient(owner_id, ingredient_id)
        return {"ingredient_id": ingredient_id,
                "adopted_observation_id": row["adopted"],
                "adopted_at": None}

    def get_owned_observation(self, owner_id, observation_id):
        row = self.observations.get(observation_id)
        if row is None or owner_id != self.owner:
            raise ValueError("Observation not owned by caller")
        offer = self.offers[row["offer_id"]]
        if offer["owner"] != owner_id:
            raise ValueError("Observation not owned by caller")
        return {**row, "ingredient_id": offer["ingredient_id"],
                "package_quantity": offer["package_quantity"],
                "package_unit": offer["package_unit"],
                "supplier_id": offer["supplier_id"]}

    def search_owned_ingredients(self, owner_id, query, limit=20):
        if owner_id != self.owner or not query.strip():
            return []
        needle = "".join(query.split()).lower()
        hits = [{"id": i, "name": r["name"]}
                for i, r in self.ingredients.items()
                if r["owner"] == owner_id
                and needle in "".join(r["name"].split()).lower()]
        hits.sort(key=lambda h: h["name"])
        return hits[:limit]

    def snapshot(self):
        return copy.deepcopy((self.ingredients, self.offers,
                              self.observations, self.suppliers))


class SuggestTests(unittest.TestCase):
    def setUp(self):
        self.repo = FakeLedger(OWNER_1)
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

    def _get(self, ingredient_id, **params):
        return self.client.get(
            f"/demo/ingredients/{ingredient_id}/sourcing-suggestions",
            headers=self.h, params=params)

    def test_same_and_similar_distinguished_and_capped(self):
        before = self.repo.snapshot()
        r = self._get(ING)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["ingredient_id"], ING)
        # 3 same-product offers + 2 similar = 5 found, 3 returned.
        self.assertEqual(body["total_found"], 5)
        self.assertEqual(body["returned"], 3)
        self.assertIsNone(body["shortage_note"])
        kinds = [c["kind"] for c in body["candidates"]]
        self.assertEqual(kinds, ["same_product_other_supplier"] * 3)
        first = body["candidates"][0]
        self.assertEqual(first["offer_id"], OFF_1)
        self.assertEqual(first["supplier_name"], "スーパーA")
        self.assertTrue(first["comparison"]["comparable"])
        self.assertEqual(first["comparison"]["diff"], "0.1400")
        self.assertFalse(body["provider"]["available"])
        self.assertTrue(body["provider"]["reason"])
        # Read-only: nothing in the ledger moved.
        self.assertEqual(self.repo.snapshot(), before)
        self.assertEqual(
            self.repo.ingredients[ING]["adopted"], OBS_BASE)

    def test_full_list_marks_similar_without_verdict(self):
        r = self._get(ING, max_candidates=10)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["returned"], 5)
        similar = [c for c in body["candidates"]
                   if c["kind"] == "similar_product"]
        self.assertEqual(len(similar), 2)
        self.assertTrue(all(c["ingredient_id"] != ING for c in similar))
        for c in similar:
            self.assertIn("別商品の可能性あり。規格・品質を人が確認",
                          c["unknowns"])
            if c["comparison"] is not None:
                self.assertFalse(c["comparison"]["comparable"])
                self.assertIsNone(c["comparison"]["diff"])
                self.assertTrue(c["comparison"]["reasons"])

    def test_incomparable_terms_get_reasons_not_verdict(self):
        r = self._get(ING, max_candidates=10)
        web_ref = [c for c in r.json()["candidates"]
                   if c["offer_id"] == OFF_2][0]
        self.assertEqual(web_ref["data_origin"], "registered_reference")
        self.assertEqual(web_ref["product_url"],
                         "https://example.invalid/item/2")
        self.assertIn("未確認の参考価格", web_ref["unknowns"])
        comp = web_ref["comparison"]
        self.assertFalse(comp["comparable"])
        self.assertIsNone(comp["diff"])
        self.assertTrue(any("tax" in reason for reason in comp["reasons"]))

    def test_offer_without_observation_lists_unknowns(self):
        r = self._get(ING, max_candidates=10)
        bare = [c for c in r.json()["candidates"]
                if c["offer_id"] == OFF_3][0]
        self.assertIsNone(bare["amount"])
        self.assertIn("価格情報なし", bare["unknowns"])
        self.assertIsNone(bare["comparison"])

    def test_shortage_and_no_basis(self):
        r = self._get(ING_BARE)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["total_found"], 0)
        self.assertEqual(body["returned"], 0)
        self.assertTrue(body["shortage_note"])
        self.assertFalse(body["provider"]["available"])

    def test_owner_isolation(self):
        other = FakeLedger(OWNER_2)
        app.state.repository_factory = lambda: other
        r = self._get(ING)
        self.assertEqual(r.status_code, 404)
        # Unknown IDs are also 404, never leaked.
        self.assertEqual(
            self._get("ffffffff-ffff-ffff-ffff-ffffffffffff").status_code,
            404)

    def test_no_live_origins(self):
        r = self._get(ING, max_candidates=10)
        origins = {c["data_origin"] for c in r.json()["candidates"]}
        self.assertTrue(origins <= {"ledger", "registered_reference"})


class ProviderTests(unittest.TestCase):
    def test_external_fetch_raises_instead_of_inventing(self):
        from chef_ai_workspace.substitute_sourcing import (
            EXTERNAL_PROVIDER_STATUS, ExternalRetrievalUnavailable,
            fetch_external_candidates)
        self.assertFalse(EXTERNAL_PROVIDER_STATUS["available"])
        self.assertTrue(EXTERNAL_PROVIDER_STATUS["reason"])
        with self.assertRaises(ExternalRetrievalUnavailable):
            fetch_external_candidates("パスタ")

    def test_pure_suggest_never_verdicts_incomparable(self):
        from chef_ai_workspace.substitute_sourcing import suggest_sourcing
        out = suggest_sourcing(
            ingredient_id="i", ingredient_name="塩", adopted=None,
            same_offers=[{"offer_id": "o", "observation": None}],
            similar=[])
        self.assertEqual(out["returned"], 1)
        self.assertEqual(out["candidates"][0]["comparison"], None)
        self.assertIn("価格情報なし",
                      out["candidates"][0]["unknowns"])
