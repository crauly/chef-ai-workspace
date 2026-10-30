"""M5: observations, comparability, impact. Fixture repo; no live DB."""
import copy
import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace import Recipe, MaterialLine, PriceQuote, TrackedValue
from chef_ai_workspace.models import Ingredient
from chef_ai_workspace.price_history import (
    PriceObservation, assess_impact, compare_observations, observation_quote)


def tv(v, status="confirmed"):
    return TrackedValue(str(v), status, "user")


def quote(amount, per_qty, per_unit):
    return PriceQuote(tv(amount), str(per_qty), str(per_unit), "manual")


ING_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
ING_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
SUP_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01"
SUP_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02"
OFF_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab01"
OFF_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab02"
R1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaac01"
R2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaac02"
L_INHERIT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaad01"
L_OVERRIDE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaad02"
L_PLAIN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaad03"


OWNER_1 = "11111111-1111-1111-1111-111111111111"
OWNER_2 = "22222222-2222-2222-2222-222222222222"
OBS_BASE = "33333333-3333-3333-3333-333333333333"


def obs(oid, ingredient=ING_A, offer=OFF_A, supplier=SUP_A, amount="350",
        currency="JPY", tax="税込", ship="送料込", qty="500", unit="g",
        source="purchase",
        observed_at="2026-10-20T10:00:00+00:00"):
    return PriceObservation(oid, ingredient, offer, supplier, amount, currency,
                            tax, ship, qty, unit, source, True, observed_at)


class CompareTests(unittest.TestCase):
    def test_comparable_rise(self):
        out = compare_observations(obs("o1"), obs("o2", amount="420"))
        self.assertTrue(out.comparable)
        self.assertEqual(out.reasons, ())
        self.assertEqual(out.base_unit_price, "0.7000")
        self.assertEqual(out.new_unit_price, "0.8400")
        self.assertEqual(out.diff, "0.1400")
        self.assertEqual(out.rate_pct, "20.0")

    def test_comparable_fall_across_suppliers(self):
        # Same ingredient and terms, different offer/supplier: comparable.
        out = compare_observations(obs("o1"), obs("o2", offer=OFF_B,
                                                  supplier=SUP_B,
                                                  amount="300"))
        self.assertTrue(out.comparable)
        self.assertEqual(out.diff, "-0.1000")
        self.assertEqual(out.rate_pct, "-14.3")

    def test_comparable_kg_to_g_conversion(self):
        out = compare_observations(obs("o1"), obs("o2", qty="1", unit="kg",
                                                  amount="700"))
        self.assertTrue(out.comparable)
        self.assertEqual(out.unit_basis, "g")
        self.assertEqual(out.new_unit_price, "0.7000")
        self.assertEqual(out.diff, "0.0000")

    def test_rejects_different_package_tax_shipping_currency(self):
        cases = [
            (obs("o2", tax="税別"), "tax"),
            (obs("o2", ship="送料別"), "shipping"),
            (obs("o2", currency="USD", amount="3"), "currency"),
            (obs("o2", unit="袋"), "interconvertible"),
            (obs("o2", ingredient=ING_B), "different ingredient"),
        ]
        for other, hint in cases:
            with self.subTest(hint=hint):
                out = compare_observations(obs("o1"), other)
                self.assertFalse(out.comparable)
                self.assertTrue(out.reasons)
                self.assertIsNone(out.diff)
                self.assertIsNone(out.rate_pct)

    def test_no_guessed_identity_or_numbers(self):
        out = compare_observations(obs("o1"), obs("o2", unit="袋"))
        self.assertFalse(out.comparable)
        self.assertIsNone(out.base_unit_price)
        self.assertIsNone(out.new_unit_price)


class FakeRepo:
    """Owner-enforcing in-memory repo. Records writes to prove reads stay pure."""

    def __init__(self, owner):
        self.owner = owner
        self.ingredients = {ING_A: {"owner": owner, "name": "パスタ",
                                    "current_price": quote("700", "1000", "g"),
                                    "adopted": OBS_BASE},
                            ING_B: {"owner": owner, "name": "塩",
                                    "current_price": None, "adopted": None}}
        self.offers = {OFF_A: {"owner": owner, "ingredient_id": ING_A,
                               "supplier_id": SUP_A, "package_quantity": "500",
                               "package_unit": "g"},
                       OFF_B: {"owner": owner, "ingredient_id": ING_A,
                               "supplier_id": SUP_B, "package_quantity": "500",
                               "package_unit": "g"}}
        self.observations = {OBS_BASE: {"id": OBS_BASE, "owner": owner,
                                          "offer_id": OFF_A, "amount_jpy": "350",
                                          "currency": "JPY", "tax_note": "税込",
                                          "shipping_note": "送料込",
                                          "source": "purchase",
                                          "confirmed": True,
                                          "observed_at": "2026-10-01T10:00:00+00:00"}}
        self.writes = 0
        self.recipes = {
            R1: Recipe(R1, tv("ペペロンチーノ"), (
                MaterialLine(L_INHERIT, tv("パスタ"), tv("100"), "g",
                             ingredient_id=ING_A, price_mode="inherit"),
                MaterialLine(L_OVERRIDE, tv("パスタ"), tv("100"), "g",
                             ingredient_id=ING_A,
                             price_override=quote("60", "50", "g")),),
                       tv("1800")),
            R2: Recipe(R2, tv("カルボナーラ"), (
                MaterialLine(L_PLAIN, tv("パスタ"), tv("200"), "g",
                             ingredient_id=ING_A, price_mode="inherit"),),
                       tv("2000")),
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
            out[i] = Ingredient(i, row["name"], row["current_price"])
        return out

    def create_owned_observation(self, owner_id, offer_id, amount_jpy,
                                 currency="JPY", tax_note=None,
                                 shipping_note=None, source="manual_entry",
                                 confirmed=False, observed_at=None):
        from chef_ai_workspace.models import decimal as _decimal
        from chef_ai_workspace.price_history import SOURCES
        offer = self.offers.get(offer_id)
        if owner_id != self.owner or offer is None or offer["owner"] != owner_id:
            raise ValueError("Offer not owned by caller")
        if _decimal(amount_jpy) < 0:
            raise ValueError("Negative amount")
        if source not in SOURCES:
            raise ValueError("Unknown observation source")
        if type(confirmed) is not bool:
            raise ValueError("Confirmed flag must be boolean")
        new_id = str(uuid4())
        self.observations[new_id] = {
            "id": new_id, "owner": owner_id, "offer_id": offer_id,
            "amount_jpy": str(_decimal(amount_jpy)), "currency": currency,
            "tax_note": tax_note, "shipping_note": shipping_note,
            "source": source, "confirmed": confirmed,
            "observed_at": observed_at or "2026-10-30T00:00:00+00:00"}
        self.writes += 1
        return new_id

    def list_ingredient_observations(self, owner_id, ingredient_id, limit=100):
        self._owned_ingredient(owner_id, ingredient_id)
        rows = [dict(r, ingredient_id=self.offers[r["offer_id"]]["ingredient_id"],
                     package_quantity=self.offers[r["offer_id"]]["package_quantity"],
                     package_unit=self.offers[r["offer_id"]]["package_unit"],
                     supplier_id=self.offers[r["offer_id"]]["supplier_id"])
                for r in self.observations.values()
                if r["owner"] == owner_id
                and self.offers[r["offer_id"]]["ingredient_id"] == ingredient_id]
        rows.sort(key=lambda r: r["observed_at"], reverse=True)
        return rows[:limit]

    def get_owned_observation(self, owner_id, observation_id):
        row = self.observations.get(observation_id)
        if row is None or owner_id != self.owner or row["owner"] != owner_id:
            raise ValueError("Observation not owned by caller")
        offer = self.offers[row["offer_id"]]
        return dict(row, ingredient_id=offer["ingredient_id"],
                    package_quantity=offer["package_quantity"],
                    package_unit=offer["package_unit"],
                    supplier_id=offer["supplier_id"])

    def get_owned_ingredient_adoption(self, owner_id, ingredient_id):
        row = self._owned_ingredient(owner_id, ingredient_id)
        return {"ingredient_id": ingredient_id,
                "adopted_observation_id": row["adopted"], "adopted_at": None}

    def list_recipes_using_ingredient(self, owner_id, ingredient_id, limit=100):
        if owner_id != self.owner:
            raise ValueError("Ingredient not owned by caller")
        self._owned_ingredient(owner_id, ingredient_id)
        return [r for r in self.recipes.values()
                if any(m.ingredient_id == ingredient_id for m in recipe_materials(r))][:limit]


def recipe_materials(recipe):
    return recipe.materials


class ImpactTests(unittest.TestCase):
    def setUp(self):
        self.repo = FakeRepo(OWNER_1)
        catalog = {ING_A: Ingredient(ING_A, "パスタ", quote("700", "1000", "g"))}
        self.catalog = catalog
        self.candidate = observation_quote(obs("o2", amount="840"))

    def test_inherit_follows_override_unchanged(self):
        (r1,) = [r for r in self.repo.recipes.values() if r.id == R1]
        (impact,) = assess_impact((r1,), self.catalog, ING_A, self.candidate)
        self.assertEqual(impact.current_total, "190")
        self.assertEqual(impact.hypo_total, "288")
        self.assertEqual(impact.diff, "98")
        self.assertFalse(impact.current_partial)
        self.assertEqual([l.line_id for l in impact.affected_lines], [L_INHERIT])
        self.assertEqual(impact.affected_lines[0].current_line_cost, "70")
        self.assertEqual(impact.affected_lines[0].hypo_line_cost, "168")
        self.assertEqual(impact.unchanged_lines, (L_OVERRIDE,))

    def test_inputs_and_snapshots_untouched(self):
        (r1,) = [r for r in self.repo.recipes.values() if r.id == R1]
        before_recipe = copy.deepcopy(r1)
        before_catalog = copy.deepcopy(self.catalog)
        snapshot = {"total_cost_jpy": "190", "revision": 0}
        before_snapshot = copy.deepcopy(snapshot)
        assess_impact((r1,), self.catalog, ING_A, self.candidate)
        self.assertEqual(r1, before_recipe)
        self.assertEqual(self.catalog, before_catalog)
        self.assertEqual(snapshot, before_snapshot)
        self.assertEqual(self.repo.writes, 0)

    def test_unresolved_stays_partial(self):
        line = MaterialLine("line-x", tv("パスタ"), TrackedValue(None, "unresolved", "system"),
                            None, ingredient_id=ING_A, price_mode="inherit")
        recipe = Recipe("rx", tv("試作"), (line,), tv("1000"))
        (impact,) = assess_impact((recipe,), self.catalog, ING_A, self.candidate)
        self.assertTrue(impact.current_partial)
        self.assertTrue(impact.hypo_partial)
        self.assertIsNone(impact.diff)


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

    def test_append_never_adopts(self):
        before = self.repo.ingredients[ING_A]["current_price"]
        r = self.client.post(f"/demo/offers/{OFF_A}/observations", headers=self.h, json={
            "amount_jpy": "420", "source": "purchase", "confirmed": True,
            "tax_note": "税込", "shipping_note": "送料込"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(self.repo.ingredients[ING_A]["current_price"], before)
        self.assertEqual(self.repo.ingredients[ING_A]["adopted"], OBS_BASE)
        history = self.client.get(f"/demo/ingredients/{ING_A}/observations", headers=self.h)
        self.assertEqual(history.status_code, 200)
        self.assertEqual(len(history.json()["items"]), 2)
        self.assertEqual(history.json()["items"][0]["amount_jpy"], "420")

    def test_foreign_offer_and_bad_payload(self):
        r = self.client.post(f"/demo/offers/{OFF_A}/observations", headers=self.h,
                             json={"amount_jpy": "-5"})
        self.assertEqual(r.status_code, 422)
        r = self.client.post(f"/demo/offers/{OFF_A}/observations", headers=self.h,
                             json={"amount_jpy": "10", "source": "scraped"})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.client.post(
            "/demo/offers/00000000-0000-0000-0000-000000000000/observations",
            headers=self.h, json={"amount_jpy": "10"}).status_code, 404)
        self.assertEqual(self.client.get(
            f"/demo/ingredients/{ING_B}/observations",
            headers=self.h).status_code, 200)

    def test_compare_endpoint_rise_and_refusal(self):
        r = self.client.post(f"/demo/ingredients/{ING_A}/observations/compare",
                             headers=self.h, json={
                                 "base_observation_id": OBS_BASE,
                                 "candidate_observation_id": OBS_BASE})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["comparable"])
        self.assertEqual(r.json()["diff"], "0.0000")
        r = self.client.post(f"/demo/ingredients/{ING_A}/observations/compare",
                             headers=self.h, json={
                                 "base_observation_id": OBS_BASE,
                                 "candidate_observation_id": OBS_BASE,
                                 "base_adopted": True})
        self.assertEqual(r.status_code, 422)
        r = self.client.post(f"/demo/ingredients/{ING_A}/observations/compare",
                             headers=self.h, json={
                                 "base_adopted": True,
                                 "candidate_observation_id": OBS_BASE})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["comparable"])
        r = self.client.post(f"/demo/ingredients/{ING_B}/observations/compare",
                             headers=self.h, json={
                                 "base_observation_id": OBS_BASE,
                                 "candidate_observation_id": OBS_BASE})
        self.assertEqual(r.status_code, 422)

    def test_impact_endpoint(self):
        r = self.client.get(
            f"/demo/ingredients/{ING_A}/price-impact?observation_id=" + OBS_BASE + "",
            headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        items = {item["recipe_id"]: item for item in r.json()["items"]}
        self.assertEqual(set(items), {R1, R2})
        self.assertEqual(items[R1]["diff"], "0")
        self.assertEqual(items[R1]["unchanged_lines"], [L_OVERRIDE])
        self.assertEqual(self.client.get(
            f"/demo/ingredients/{ING_B}/price-impact?observation_id=" + OBS_BASE + "",
            headers=self.h).status_code, 422)
        self.assertEqual(self.client.get(
            f"/demo/ingredients/{ING_A}/price-impact?observation_id=00000000-0000-0000-0000-000000000000",
            headers=self.h).status_code, 404)

    def test_cross_owner_refused(self):
        other = FakeRepo(OWNER_2)
        app.state.repository_factory = lambda: other
        self.assertEqual(self.client.get(
            f"/demo/ingredients/{ING_A}/observations").status_code, 403)
        self.assertEqual(self.client.get(
            f"/demo/ingredients/{ING_A}/observations",
            headers=self.h).status_code, 404)


if __name__ == "__main__":
    unittest.main()
