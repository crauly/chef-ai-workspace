"""3-axis sourcing picks (cost/compatibility/quality). Fixture only.

Pure-function rules plus the read-only demo endpoint. Muse evaluations
here are canned fixtures; the single live-inference test is opt-in
(CHEF_LIVE_META=1) and skipped otherwise. No live web retrieval exists
in this suite: the provider status must say unavailable.
"""
import json
import os
import unittest
from fastapi.testclient import TestClient

from chef_ai_workspace.api import app
from chef_ai_workspace.axis_sourcing import (
    AxisEvaluationError, assign_axes, build_axis_prompt,
    parse_axis_evaluations)

OWNER_1 = "11111111-1111-1111-1111-111111111111"
OWNER_2 = "22222222-2222-2222-2222-222222222222"
ING = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10"
ING_SIM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11"
OFF_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab11"
OFF_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab12"
SUP_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa21"
SUP_2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa22"


def _comparison(new_price, *, comparable=True, basis="g"):
    return {"comparable": comparable,
            "reasons": [] if comparable else ["税条件不一致"],
            "currency": "JPY", "unit_basis": basis if comparable else None,
            "base_unit_price": "1.0", "new_unit_price": new_price,
            "diff": "-0.2", "rate_pct": "-16.7"}


def _candidate(index, *, kind="same_product_other_supplier",
               price="0.8", comparable=True, name="パスタ"):
    return {"kind": kind, "ingredient_id": ING,
            "ingredient_name": name, "offer_id": f"offer-{index}",
            "supplier_name": f"仕入先{index}", "product_url": None,
            "amount": "400", "currency": "JPY",
            "package_quantity": "500", "package_unit": "g",
            "shipping_note": "送料込", "tax_note": "税込",
            "source": "purchase", "observed_at": "2026-10-21T10:00:00+00:00",
            "data_origin": "ledger", "unknowns": [],
            "comparison": _comparison(price, comparable=comparable)}


def _eval(index, axis="compatibility", reason="同じ茹で時間で使える",
          confidence="high"):
    return {"candidate_index": index, "axis": axis, "reason": reason,
            "confidence": confidence}


class ParseTests(unittest.TestCase):
    def test_valid_payload(self):
        evaluations, skipped = parse_axis_evaluations(
            json.dumps({"evaluations": [_eval(0), _eval(1, "quality")]}), 3)
        self.assertEqual(skipped, 0)
        self.assertEqual([e["axis"] for e in evaluations],
                         ["compatibility", "quality"])

    def test_rejects_non_json_and_wrong_shape(self):
        for bad in ("not json", "[]",
                    json.dumps({"evaluations": "x"}),
                    json.dumps({"other": []}),
                    json.dumps({"evaluations": [_eval(0)] * 11})):
            with self.assertRaises(AxisEvaluationError):
                parse_axis_evaluations(bad, 3)

    def test_skips_bad_entries_and_counts(self):
        payload = {"evaluations": [
            _eval(0),
            _eval(1, "cost"),  # Muse must never decide cost
            _eval(9),  # out of range
            _eval(0),  # duplicate
            {"candidate_index": 1, "axis": "quality", "reason": " ",
             "confidence": "high"},
            {"candidate_index": 1, "axis": "quality", "reason": "x" * 301,
             "confidence": "high"},
            {"candidate_index": 1, "axis": "quality", "reason": "ok",
             "confidence": "sure"},
            {"candidate_index": 1, "axis": "quality", "reason": "ok"},
        ]}
        evaluations, skipped = parse_axis_evaluations(json.dumps(payload), 3)
        self.assertEqual(len(evaluations), 1)
        self.assertEqual(evaluations[0]["candidate_index"], 0)
        self.assertEqual(skipped, 7)

    def test_prompt_is_bounded_and_owner_free(self):
        prompt = build_axis_prompt("パスタ" * 100,
                                   [_candidate(i) for i in range(11)])
        self.assertLessEqual(len(prompt["ingredient_name"]), 120)
        self.assertEqual(len(prompt["candidates"]), 10)
        self.assertNotIn("owner", json.dumps(prompt, ensure_ascii=False))


class AssignTests(unittest.TestCase):
    def test_cost_pick_is_lowest_comparable_unit_price(self):
        result = assign_axes(
            ingredient_id=ING, ingredient_name="パスタ",
            candidates=[_candidate(0, price="0.9"), _candidate(1, price="0.5"),
                        _candidate(2, price="0.7", comparable=False)],
            evaluations=[_eval(0, "compatibility")])
        self.assertEqual(result["axes"]["cost"]["pick"]["candidate_index"], 1)
        self.assertEqual(result["axes"]["cost"]["pick"]["reason_source"],
                         "deterministic")
        # Muse compatibility evaluation survives on its own axis.
        self.assertEqual(
            result["axes"]["compatibility"]["pick"]["candidate_index"], 0)
        self.assertEqual(
            result["axes"]["compatibility"]["pick"]["reason_source"], "muse")

    def test_mixed_kg_and_g_bases_rank_cheapest_correctly(self):
        # Adopted basis in kg: M5 keeps per-kg for the kg offer but
        # converts the g offer to per-g. Bare values (500 vs 0.9) would
        # misrank; normalized values (0.5/g vs 0.9/g) must pick 500/kg.
        per_kg = _candidate(0, price="500.0000", name="業務用パスタ")
        per_kg["comparison"]["unit_basis"] = "kg"
        per_g = _candidate(1, price="0.9000", name="小分けパスタ")
        per_g["comparison"]["unit_basis"] = "g"
        result = assign_axes(
            ingredient_id=ING, ingredient_name="パスタ",
            candidates=[per_g, per_kg], evaluations=[])
        self.assertEqual(result["axes"]["cost"]["pick"]["candidate_index"], 1)
        self.assertEqual(
            result["axes"]["cost"]["pick"]["candidate"]["ingredient_name"],
            "業務用パスタ")

    def test_unknown_basis_is_never_ranked(self):
        odd = _candidate(0, price="0.1000")
        odd["comparison"]["unit_basis"] = "袋"
        result = assign_axes(
            ingredient_id=ING, ingredient_name="パスタ",
            candidates=[odd], evaluations=[])
        self.assertIsNone(result["axes"]["cost"]["pick"])

    def test_every_pick_is_either_slotted_or_extra(self):
        pool = [_candidate(i, price=str(0.5 + i * 0.1)) for i in range(5)]
        result = assign_axes(
            ingredient_id=ING, ingredient_name="パスタ", candidates=pool,
            evaluations=[], max_picks=5)
        slotted = {slot["pick"]["candidate_index"]
                   for slot in result["axes"].values()
                   if slot["pick"] is not None}
        self.assertEqual(result["returned"], len(result["picks"]))
        extra = [p for p in result["picks"]
                 if p["candidate_index"] not in slotted]
        self.assertTrue(extra)  # fills beyond the cost slot exist here
        for pick in extra:
            # Fill extras are deterministic cost-axis backups only; the UI
            # must render them as extras so displayed counts match.
            self.assertEqual(pick["axis"], "cost")
            self.assertEqual(pick["reason_source"], "deterministic")

    def test_incomparable_pool_leaves_cost_empty_with_reason(self):
        result = assign_axes(
            ingredient_id=ING, ingredient_name="パスタ",
            candidates=[_candidate(0, comparable=False)], evaluations=[])
        self.assertIsNone(result["axes"]["cost"]["pick"])
        self.assertIn("比較可能", result["axes"]["cost"]["empty_reason"])

    def test_no_force_fill_and_shortage_note(self):
        result = assign_axes(
            ingredient_id=ING, ingredient_name="パスタ",
            candidates=[_candidate(0)], evaluations=[])
        self.assertEqual(result["returned"], 1)
        self.assertIsNotNone(result["shortage_note"])

    def test_one_pick_per_axis_and_max_five(self):
        pool = [_candidate(i, price=str(0.5 + i * 0.1)) for i in range(7)]
        evaluations = [_eval(1, "compatibility"), _eval(2, "compatibility"),
                       _eval(3, "quality")]
        result = assign_axes(
            ingredient_id=ING, ingredient_name="パスタ", candidates=pool,
            evaluations=evaluations, muse_used=True, max_picks=5)
        self.assertLessEqual(result["returned"], 5)
        axes = [p["axis"] for p in result["picks"]]
        self.assertEqual(axes.count("compatibility"), 1)
        self.assertEqual(axes.count("quality"), 1)
        self.assertEqual(
            result["axes"]["compatibility"]["pick"]["candidate_index"], 1)
        self.assertEqual(
            result["axes"]["quality"]["pick"]["candidate_index"], 3)

    def test_similar_products_never_autofill(self):
        pool = [_candidate(0, price="0.5"),
                _candidate(1, kind="similar_product", price="0.1")]
        result = assign_axes(
            ingredient_id=ING, ingredient_name="パスタ", candidates=pool,
            evaluations=[], max_picks=5)
        indexes = [p["candidate_index"] for p in result["picks"]]
        self.assertIn(0, indexes)
        self.assertNotIn(1, indexes)

    def test_muse_unused_leaves_semantic_axes_explicit(self):
        result = assign_axes(
            ingredient_id=ING, ingredient_name="パスタ",
            candidates=[_candidate(0)], evaluations=[], muse_used=False,
            muse_error="Muse axis evaluation not configured")
        for axis in ("compatibility", "quality"):
            self.assertIsNone(result["axes"][axis]["pick"])
            self.assertIn("未実行", result["axes"][axis]["empty_reason"])


class FakeLedger:
    """Minimal owner-scoped read surface with write traps and counters."""

    def __init__(self, owner):
        self.owner = owner
        self.calls = {}
        self.writes = []

    def _count(self, name):
        self.calls[name] = self.calls.get(name, 0) + 1

    def _owned(self, owner):
        if owner != self.owner:
            raise ValueError("not owned by caller")
        return True

    def load_owned_ingredients(self, owner, ids):
        self._count("load_owned_ingredients")
        self._owned(owner)
        from chef_ai_workspace.models import Ingredient
        if ING in ids:
            return {ING: Ingredient(ING, "パスタ", None)}
        return {}

    def list_ingredient_offers(self, owner, ingredient_id):
        self._count("list_ingredient_offers")
        self._owned(owner)
        return [{"id": OFF_A, "supplier_id": SUP_1, "product_url": None,
                 "package_quantity": "500", "package_unit": "g"},
                {"id": OFF_B, "supplier_id": SUP_2,
                 "product_url": "https://example.invalid/b",
                 "package_quantity": "1", "package_unit": "kg"}]

    def list_latest_observations_for_offers(self, owner, offer_ids):
        self._count("list_latest_observations_for_offers")
        self._owned(owner)
        return {OFF_A: {"id": "obs-a", "amount_jpy": "400",
                        "currency": "JPY", "tax_note": "税込",
                        "shipping_note": "送料込", "source": "purchase",
                        "confirmed": True,
                        "observed_at": "2026-10-21T10:00:00+00:00",
                        "supplier_id": SUP_1, "supplier_name": "問屋A"},
                OFF_B: {"id": "obs-b", "amount_jpy": "750",
                        "currency": "JPY", "tax_note": "税込",
                        "shipping_note": "送料別", "source": "purchase",
                        "confirmed": True,
                        "observed_at": "2026-10-22T10:00:00+00:00",
                        "supplier_id": SUP_2, "supplier_name": "問屋B"}}

    def list_latest_observations_for_ingredients(self, owner, ids):
        self._count("list_latest_observations_for_ingredients")
        self._owned(owner)
        return {ING_SIM: {"id": "obs-s", "offer_id": None,
                          "amount_jpy": "300", "currency": "JPY",
                          "tax_note": "税込", "shipping_note": "送料込",
                          "source": "purchase", "confirmed": False,
                          "observed_at": "2026-10-20T10:00:00+00:00",
                          "supplier_id": None, "supplier_name": None,
                          "product_url": None, "package_quantity": "500",
                          "package_unit": "g"}}

    def get_owned_ingredient_adoption(self, owner, ingredient_id):
        self._count("get_owned_ingredient_adoption")
        self._owned(owner)
        return {"adopted_observation_id": "obs-base"}

    def get_owned_observation(self, owner, observation_id):
        self._count("get_owned_observation")
        self._owned(owner)
        if observation_id != "obs-base":
            raise ValueError("Observation not owned by caller")
        return {"id": "obs-base", "ingredient_id": ING,
                "offer_id": "offer-base", "supplier_id": SUP_1,
                "amount_jpy": "500", "currency": "JPY",
                "tax_note": "税込", "shipping_note": "送料込",
                "package_quantity": "500", "package_unit": "g",
                "source": "purchase", "confirmed": True,
                "observed_at": "2026-10-20T10:00:00+00:00"}

    def search_owned_ingredients(self, owner, name, limit=6):
        self._count("search_owned_ingredients")
        self._owned(owner)
        return [{"id": ING_SIM, "name": "全粒粉パスタ"}]

    def load_owned_recipe(self, owner, recipe_id):
        raise ValueError("not owned by caller")

    def __getattr__(self, name):
        if name.startswith(("create_", "commit_", "confirm_", "save_",
                            "update_", "adopt_", "record_")):
            def _trap(*args, **kwargs):
                self.writes.append(name)
                raise AssertionError(f"read-only endpoint wrote: {name}")
            return _trap
        raise AttributeError(name)


class FakeMuse:
    """Canned single-call Muse stand-in counting invocations."""

    def __init__(self, evaluations=None, error=None):
        self.evaluations = evaluations or []
        self.error = error
        self.calls = 0
        self.last_prompt = None

    def evaluate_sourcing_axes(self, prompt_json):
        self.calls += 1
        self.last_prompt = prompt_json
        if self.error:
            raise self.error
        return self.evaluations


class AxisEndpointTests(unittest.TestCase):
    def setUp(self):
        self.repo = FakeLedger(OWNER_1)
        self.muse = FakeMuse([{"candidate_index": 2, "axis": "compatibility",
                               "reason": "同じ茹で時間で代替可能",
                               "confidence": "medium"}])
        app.state.demo_owner_id = OWNER_1
        app.state.demo_access_token = "test-secret"
        app.state.repository_factory = lambda: self.repo
        app.state.ai_provider = self.muse
        self.client = TestClient(app, raise_server_exceptions=False)
        self.h = {"X-Demo-Access": "test-secret"}

    def tearDown(self):
        self.client.close()
        for key in ("demo_owner_id", "demo_access_token",
                    "repository_factory", "ai_provider"):
            if hasattr(app.state, key):
                delattr(app.state, key)

    def _get(self, ingredient_id=ING, **params):
        return self.client.get(
            f"/demo/ingredients/{ingredient_id}/axis-suggestions",
            headers=self.h, params=params)

    def test_three_axes_with_single_muse_call(self):
        r = self._get()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["ingredient_id"], ING)
        self.assertEqual(set(body["axes"]), {"cost", "compatibility",
                                             "quality"})
        self.assertEqual(self.muse.calls, 1)
        # Cost decided by Python, not by the canned Muse evaluation.
        cost = body["axes"]["cost"]["pick"]
        self.assertIsNotNone(cost)
        self.assertEqual(cost["reason_source"], "deterministic")
        compat = body["axes"]["compatibility"]["pick"]
        self.assertIsNotNone(compat)
        self.assertEqual(compat["reason"], "同じ茹で時間で代替可能")
        self.assertEqual(compat["confidence"], "medium")
        # Prompt carries facts only, never credentials or owner IDs.
        prompt = json.loads(self.muse.last_prompt)
        self.assertNotIn("owner", json.dumps(prompt, ensure_ascii=False))
        self.assertNotIn("test-secret", json.dumps(prompt))

    def test_muse_opt_out_still_returns_cost(self):
        r = self._get(use_muse="false")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(self.muse.calls, 0)
        self.assertFalse(body["provider"]["muse"]["used"])
        self.assertIsNotNone(body["axes"]["cost"]["pick"])
        self.assertIsNone(body["axes"]["compatibility"]["pick"])

    def test_muse_failure_degrades_without_failing_request(self):
        app.state.ai_provider = FakeMuse(error=ValueError("boom"))
        r = self._get()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertFalse(body["provider"]["muse"]["used"])
        self.assertIsNotNone(body["provider"]["muse"]["error"])
        self.assertIsNotNone(body["axes"]["cost"]["pick"])

    def test_owner_separation_and_read_only(self):
        app.state.repository_factory = lambda: FakeLedger(OWNER_2)
        r = self._get()
        self.assertEqual(r.status_code, 404, r.text)
        app.state.repository_factory = lambda: self.repo
        r = self._get(use_muse="false")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.repo.writes, [])
        # Bulk loaders run once each per request: no N+1.
        for name in ("load_owned_ingredients", "list_ingredient_offers",
                     "list_latest_observations_for_offers",
                     "list_latest_observations_for_ingredients",
                     "get_owned_ingredient_adoption",
                     "search_owned_ingredients"):
            self.assertEqual(self.repo.calls.get(name), 1, name)

    def test_external_retrieval_stays_unavailable(self):
        r = self._get(use_muse="false")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["provider"]["external"]["available"])


@unittest.skipUnless(os.environ.get("CHEF_LIVE_META") == "1",
                     "Opt-in real Muse inference")
class LiveAxisEvaluationTests(unittest.TestCase):
    def test_real_muse_axis_evaluation_completes(self):
        from chef_ai_workspace.meta_responses import MetaResponsesProvider
        provider = MetaResponsesProvider(os.environ["MODEL_API_KEY"])
        prompt = json.dumps(build_axis_prompt(
            "パスタ", [_candidate(0), _candidate(1, kind="similar_product",
                                                 name="全粒粉パスタ")]),
            ensure_ascii=False)
        evaluations = provider.evaluate_sourcing_axes(prompt)
        self.assertLessEqual(len(evaluations), 2)
        for evaluation in evaluations:
            self.assertIn(evaluation["axis"], ("compatibility", "quality"))
            self.assertIn(evaluation["candidate_index"], (0, 1))


if __name__ == "__main__":
    unittest.main()
