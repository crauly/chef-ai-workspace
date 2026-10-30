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
ING_SIM3 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa13"
ING_SIM4 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa14"
ING_SIM5 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa15"
OFF_S3 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab15"
OFF_S5 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab16"
OBS_S5 = "33333333-3333-3333-3333-333333333304"
ING_BARE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb00b1"
OFF_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab11"
OFF_2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab12"
OFF_3 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab13"
OFF_S1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab14"
OFF_4 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab17"
OBS_4 = "33333333-3333-3333-3333-333333333305"
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
            ING_SIM3: {"owner": owner, "name": "パスタ(早ゆで)",
                       "adopted": None},
            ING_SIM4: {"owner": owner, "name": "パスタ(有機)",
                       "adopted": None},
            ING_SIM5: {"owner": owner, "name": "米粉パスタ",
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
            OFF_4: {"id": OFF_4, "owner": owner, "ingredient_id": ING,
                    "supplier_id": SUP_1, "product_url": None,
                    "package_quantity": "1000", "package_unit": "g",
                    "shipping_note": None},
            OFF_S1: {"id": OFF_S1, "owner": owner,
                     "ingredient_id": ING_SIM1, "supplier_id": SUP_1,
                     "product_url": None, "package_quantity": "500",
                     "package_unit": "g", "shipping_note": None},
            OFF_S3: {"id": OFF_S3, "owner": owner,
                     "ingredient_id": ING_SIM3, "supplier_id": SUP_2,
                     "product_url": None, "package_quantity": "500",
                     "package_unit": "g", "shipping_note": None},
            OFF_S5: {"id": OFF_S5, "owner": owner,
                     "ingredient_id": ING_SIM5, "supplier_id": SUP_1,
                     "product_url": None, "package_quantity": "250",
                     "package_unit": "g", "shipping_note": None},
        }
        self.suppliers = {SUP_1: {"owner": owner, "name": "スーパーA"},
                          SUP_2: {"owner": owner, "name": "ネットB"}}
        self.calls = {"list_ingredient_observations": 0,
                      "bulk_offers": 0, "bulk_ingredients": 0}
        self.observations = {
            OBS_BASE: _obs(OBS_BASE, OFF_1, "350",
                           observed_at="2026-10-01T10:00:00+00:00"),
            OBS_1: _obs(OBS_1, OFF_1, "420"),
            OBS_2: _obs(OBS_2, OFF_2, "300", tax="税別",
                        source="web_reference", confirmed=False,
                        observed_at="2026-10-22T10:00:00+00:00"),
            OBS_4: _obs(OBS_4, OFF_4, "680",
                         observed_at="2026-10-21T10:00:00+00:00"),
            OBS_S1: _obs(OBS_S1, OFF_S1, "380",
                         observed_at="2026-10-20T10:00:00+00:00"),
            OBS_S5: _obs(OBS_S5, OFF_S5, "300",
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
        self.calls["list_ingredient_observations"] += 1
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

    def _observation_row(self, ingredient_id, row):
        offer = self.offers[row["offer_id"]]
        supplier = self.suppliers.get(offer["supplier_id"] or "")
        return {**row, "ingredient_id": ingredient_id,
                "package_quantity": offer["package_quantity"],
                "package_unit": offer["package_unit"],
                "supplier_id": offer["supplier_id"],
                "supplier_name": supplier["name"] if supplier else None,
                "product_url": offer["product_url"]}

    def list_latest_observations_for_offers(self, owner_id, offer_ids):
        """Exact latest per owned offer. One call, no per-offer fan-out."""
        self.calls["bulk_offers"] += 1
        wanted = [str(x) for x in (offer_ids or []) if x]
        if not wanted:
            return {}
        for oid in wanted:
            offer = self.offers.get(oid)
            if offer is None or offer["owner"] != owner_id:
                raise ValueError("Offer not owned by caller")
        latest = {}
        for row in self.observations.values():
            if row["offer_id"] not in wanted:
                continue
            current = latest.get(row["offer_id"])
            if current is None or row["observed_at"] > current["observed_at"]:
                latest[row["offer_id"]] = row
        out = {}
        for oid, row in latest.items():
            offer = self.offers[oid]
            out[oid] = self._observation_row(offer["ingredient_id"], row)
        return out

    def list_latest_observations_for_ingredients(self, owner_id,
                                                 ingredient_ids):
        """Exact latest per owned ingredient. One call, no per-item fan-out."""
        self.calls["bulk_ingredients"] += 1
        wanted = [str(x) for x in (ingredient_ids or []) if x]
        if not wanted:
            return {}
        offer_ids = [o["id"] for o in self.offers.values()
                     if o["ingredient_id"] in wanted
                     and o["owner"] == owner_id]
        per_offer = self.list_latest_observations_for_offers(
            owner_id, offer_ids)
        best = {}
        for row in per_offer.values():
            iid = row["ingredient_id"]
            current = best.get(iid)
            if current is None or row["observed_at"] > current["observed_at"]:
                best[iid] = row
        return best

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
        # Adopted offer excluded: 3 alternate offers + 5 similar = 8.
        self.assertEqual(body["total_found"], 8)
        self.assertEqual(body["returned"], 3)
        self.assertIsNone(body["shortage_note"])
        kinds = [c["kind"] for c in body["candidates"]]
        self.assertEqual(kinds, ["same_product_other_supplier",
                                 "same_product_unknown_supplier",
                                 "same_product_same_supplier"])
        first = body["candidates"][0]
        self.assertEqual(first["offer_id"], OFF_2)
        self.assertEqual(first["supplier_name"], "ネットB")
        # OFF_2 is a tax-mismatched web reference: reasons, no verdict.
        self.assertFalse(first["comparison"]["comparable"])
        self.assertIsNone(first["comparison"]["diff"])
        third = body["candidates"][2]
        self.assertEqual(third["offer_id"], OFF_4)
        self.assertTrue(third["comparison"]["comparable"])
        self.assertEqual(third["comparison"]["diff"], "-0.0200")
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
        self.assertEqual(body["returned"], 8)
        self.assertFalse(any(c["offer_id"] == OFF_1
                             for c in body["candidates"]))
        similar = [c for c in body["candidates"]
                   if c["kind"] == "similar_product"]
        self.assertEqual(len(similar), 5)
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

    def test_same_vs_other_supplier_classification(self):
        r = self._get(ING, max_candidates=10)
        self.assertEqual(r.status_code, 200, r.text)
        by_offer = {c["offer_id"]: c for c in r.json()["candidates"]}
        # The adopted offer itself is not an alternative.
        self.assertNotIn(OFF_1, by_offer)
        # OFF_4 shares the adopted basis supplier: same-supplier offer.
        self.assertEqual(by_offer[OFF_4]["kind"],
                         "same_product_same_supplier")
        self.assertEqual(by_offer[OFF_4]["comparison"]["diff"], "-0.0200")
        # OFF_2 is a confirmed different supplier; OFF_3 has an
        # unknown supplier and gets its own purchase-term kind.
        self.assertEqual(by_offer[OFF_2]["kind"],
                         "same_product_other_supplier")
        self.assertEqual(by_offer[OFF_3]["kind"],
                         "same_product_unknown_supplier")
        self.assertIn("仕入先不明", by_offer[OFF_3]["unknowns"])
        self.assertNotIn("仕入先不明", by_offer[OFF_4]["unknowns"])

    def test_no_basis_labels_all_same_ingredient_other(self):
        # ING_SIM1 has no adopted basis: no same-supplier claim is made.
        r = self._get(ING_SIM1, max_candidates=10)
        self.assertEqual(r.status_code, 200, r.text)
        same = [c for c in r.json()["candidates"]
                if c["ingredient_id"] == ING_SIM1]
        self.assertEqual(len(same), 1)
        self.assertEqual(same[0]["kind"], "same_product_other_supplier")
        self.assertIsNone(same[0]["comparison"])

    def test_similar_prices_need_no_per_ingredient_queries(self):
        # 5 similarly named ingredients, yet observation reads stay bulk:
        # one per-ingredient bulk call, zero per-ingredient list calls.
        self.repo.calls = {"list_ingredient_observations": 0,
                           "bulk_offers": 0, "bulk_ingredients": 0}
        r = self._get(ING, max_candidates=10)
        self.assertEqual(r.status_code, 200, r.text)
        similar = [c for c in r.json()["candidates"]
                   if c["kind"] == "similar_product"]
        self.assertEqual(len(similar), 5)
        self.assertEqual(self.repo.calls["bulk_ingredients"], 1)
        self.assertEqual(
            self.repo.calls["list_ingredient_observations"], 0)

    def test_long_history_keeps_every_offer_latest(self):
        # 250 newer observations on OFF_1 push OFF_3's only observation
        # past the old top-200 window: its latest must still be found.
        for n in range(250):
            oid = f"40000000-0000-4000-8000-{n:012d}"
            self.repo.observations[oid] = _obs(
                oid, OFF_2, "500",
                observed_at=f"2026-10-23T{n // 60:02d}:{n % 60:02d}:00+00:00")
        self.repo.observations["40000000-0000-4000-8000-999999999999"] = _obs(
            "40000000-0000-4000-8000-999999999999", OFF_3, "260",
            observed_at="2026-09-01T00:00:00+00:00")
        r = self._get(ING, max_candidates=10)
        self.assertEqual(r.status_code, 200, r.text)
        by_offer = {c["offer_id"]: c for c in r.json()["candidates"]
                    if c["offer_id"] in (OFF_2, OFF_3)}
        self.assertEqual(by_offer[OFF_2]["amount"], "500")
        self.assertEqual(by_offer[OFF_3]["amount"], "260")
        self.assertNotIn("価格情報なし", by_offer[OFF_3]["unknowns"])

    def test_unknown_supplier_is_never_labelled_other_supplier(self):
        # Supplier-less offers form their own kind at both layers.
        from chef_ai_workspace.substitute_sourcing import suggest_sourcing
        out = suggest_sourcing(
            ingredient_id="i", ingredient_name="パスタ", adopted=None,
            same_offers=[{"offer_id": "o1", "supplier_id": None,
                          "observation": None},
                         {"offer_id": "o2", "supplier_id": "s9",
                          "observation": None}],
            similar=[])
        kinds = {c["offer_id"]: c["kind"] for c in out["candidates"]}
        self.assertEqual(kinds["o1"], "same_product_unknown_supplier")
        self.assertEqual(kinds["o2"], "same_product_other_supplier")
        r = self._get(ING, max_candidates=10)
        http_kinds = {c["offer_id"]: c["kind"]
                      for c in r.json()["candidates"]}
        self.assertEqual(http_kinds[OFF_3],
                         "same_product_unknown_supplier")
        self.assertEqual(http_kinds[OFF_2],
                         "same_product_other_supplier")

    def test_numeric_zero_price_is_preserved(self):
        # Supabase numeric(0) must survive as "0", not "" or "None", and
        # compare as a valid decrease against the adopted basis.
        self.repo.observations["50000000-0000-4000-8000-000000000001"] = {
            "id": "50000000-0000-4000-8000-000000000001",
            "offer_id": OFF_4, "amount_jpy": 0, "currency": "JPY",
            "tax_note": "税込", "shipping_note": "送料込",
            "source": "purchase", "confirmed": True,
            "observed_at": "2026-10-24T00:00:00+00:00"}
        r = self._get(ING, max_candidates=10)
        self.assertEqual(r.status_code, 200, r.text)
        cand = {c["offer_id"]: c for c in r.json()["candidates"]}[OFF_4]
        self.assertEqual(cand["amount"], "0")
        self.assertTrue(cand["comparison"]["comparable"])
        self.assertEqual(cand["comparison"]["diff"], "-0.7000")

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


class AdapterBulkLatestTests(unittest.TestCase):
    """Bulk latest reads page through long histories (stubbed postgrest)."""

    def _repo(self, offers, suppliers, observations, calls):
        from chef_ai_workspace.supabase_adapter import SupabasePersistence

        class _Resp:
            def __init__(self, data):
                self.data = data

        class _Query:
            def __init__(self, table):
                self._table = table
                self._in = None
                self._range = None
            def select(self, cols):
                return self
            def eq(self, key, value):
                calls.append((self._table, "eq", key, value))
                return self
            def in_(self, key, values):
                self._in = (key, list(values))
                return self
            def order(self, key, desc=False):
                return self
            def range(self, start, end):
                self._range = (start, end)
                return self
            def limit(self, n):
                return self
            def execute(self):
                if self._table == "offers":
                    rows = offers
                    if self._in is not None:
                        key, values = self._in
                        rows = [r for r in rows if r.get(key) in values]
                    return _Resp(list(rows))
                if self._table == "suppliers":
                    return _Resp(list(suppliers))
                if self._table == "price_observations":
                    rows = observations
                    if self._in is not None:
                        key, values = self._in
                        rows = [r for r in rows if r.get(key) in values]
                    rows = sorted(rows,
                                  key=lambda r: r["observed_at"],
                                  reverse=True)
                    if self._range is not None:
                        start, end = self._range
                        rows = rows[start:end + 1]
                    return _Resp(list(rows))
                raise AssertionError(f"unexpected table {self._table}")

        class _Tables:
            def table(self, name):
                if name not in ("offers", "suppliers",
                                "price_observations"):
                    raise AssertionError(f"write or unknown table {name}")
                return _Query(name)

        repo = SupabasePersistence.__new__(SupabasePersistence)
        repo.client = _Tables()
        return repo

    def test_paged_latest_covers_every_offer(self):
        offers = [
            {"id": "o1", "ingredient_id": "i1", "supplier_id": "s1",
             "product_url": None, "package_quantity": "500",
             "package_unit": "g", "shipping_note": None},
            {"id": "o2", "ingredient_id": "i1", "supplier_id": "s2",
             "product_url": None, "package_quantity": "500",
             "package_unit": "g", "shipping_note": None},
        ]
        suppliers = [{"id": "s1", "name": "A"}, {"id": "s2", "name": "B"}]
        observations = [{
            "id": "old-o2", "offer_id": "o2", "amount_jpy": "260",
            "currency": "JPY", "tax_note": "税込", "shipping_note": "送料込",
            "source": "purchase", "confirmed": True,
            "observed_at": "2026-09-01T00:00:00+00:00"}]
        for n in range(1002):
            observations.append({
                "id": f"o1-{n}", "offer_id": "o1", "amount_jpy": "500",
                "currency": "JPY", "tax_note": "税込",
                "shipping_note": "送料込", "source": "purchase",
                "confirmed": True,
                "observed_at": (f"2026-10-{(n // 1440) + 1:02d}T"
                                f"{(n // 60) % 24:02d}:{n % 60:02d}:00+00:00")})
        calls = []
        repo = self._repo(offers, suppliers, observations, calls)
        out = repo.list_latest_observations_for_offers("owner-1",
                                                       ["o1", "o2"])
        self.assertEqual(set(out), {"o1", "o2"})
        self.assertEqual(out["o1"]["amount_jpy"], "500")
        self.assertEqual(out["o1"]["observed_at"],
                         "2026-10-01T16:41:00+00:00")
        self.assertEqual(out["o1"]["supplier_name"], "A")
        self.assertEqual(out["o2"]["amount_jpy"], "260")
        # Every read is owner-scoped; only reads were issued.
        eq_calls = [c for c in calls if c[0] in (
            "offers", "suppliers", "price_observations")]
        self.assertTrue(eq_calls)
        self.assertTrue(all(c[2] == "owner_id" and c[3] == "owner-1"
                            for c in calls if c[1] == "eq"))
        per_ing = repo.list_latest_observations_for_ingredients(
            "owner-1", ["i1"])
        self.assertEqual(set(per_ing), {"i1"})
        self.assertEqual(per_ing["i1"]["offer_id"], "o1")

    def test_empty_inputs_issue_no_queries(self):
        calls = []
        repo = self._repo([], [], [], calls)
        self.assertEqual(
            repo.list_latest_observations_for_offers("o", []), {})
        self.assertEqual(
            repo.list_latest_observations_for_ingredients("o", []), {})
        self.assertEqual(calls, [])


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
