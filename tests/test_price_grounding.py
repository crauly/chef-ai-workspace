"""Fixture tests for the Meta Search Grounding seam. No network, no DB."""
import unittest

from chef_ai_workspace.price_web_search import (
    build_price_search_input,
    parse_responses_output,
)
from chef_ai_workspace.external_reference import (
    build_external_query,
    summarize_external_reference,
    validate_external_candidate,
)


def _responses(text, citations, with_call=True):
    output = []
    if with_call:
        output.append({"type": "web_search_call", "id": "ws_1",
                       "status": "completed"})
    output.append({"type": "message", "role": "assistant",
                   "status": "completed",
                   "content": [{"type": "output_text", "text": text,
                                "annotations": citations}]})
    return {"status": "completed", "output": output}


CITATION = {"type": "url_citation", "title": "Shop A",
            "url": "https://shop.example/pork",
            "start_index": 0, "end_index": 10}

CANDIDATE = {"name": "豚バラ肉", "amount": "380", "currency": "JPY",
             "package_quantity": "500", "package_unit": "g",
             "seller": "Shop A", "source": "shop.example",
             "url": "https://shop.example/pork"}


class GroundingParseTests(unittest.TestCase):
    def test_call_plus_citation_is_searched_with_payload(self):
        raw = _responses('{"candidates": [%s]}' % __import__("json").dumps(CANDIDATE), [CITATION])
        out = parse_responses_output(raw)
        self.assertTrue(out["searched"])
        self.assertEqual(len(out["citations"]), 1)
        self.assertEqual(out["citations"][0]["url"], "https://shop.example/pork")
        self.assertIn("candidates", out["payload"])

    def test_call_without_citation_is_not_searched(self):
        raw = _responses('{"candidates": []}', [])
        self.assertFalse(parse_responses_output(raw)["searched"])

    def test_message_without_call_is_not_searched(self):
        raw = _responses('{"candidates": []}', [CITATION], with_call=False)
        self.assertFalse(parse_responses_output(raw)["searched"])

    def test_malformed_shapes_are_not_searched(self):
        for raw in (None, {}, {"output": "x"}, {"output": [{"type": "reasoning"}]},
                    {"status": "incomplete", "output": []}):
            out = parse_responses_output(raw)
            self.assertFalse(out["searched"])
            self.assertEqual(out["citations"], [])

    def test_non_url_annotations_ignored(self):
        raw = _responses('{"candidates": []}',
                         [{"type": "other", "url": "https://x.example"}])
        self.assertFalse(parse_responses_output(raw)["searched"])

    def test_build_input_carries_request_verbatim_ja_en(self):
        ja = build_price_search_input("豚バラ肉", "だいたいの相場で入れて")
        self.assertIn("豚バラ肉", ja)
        self.assertIn("だいたいの相場で入れて", ja)
        en = build_price_search_input("pork belly", "use the average price", "en")
        self.assertIn("pork belly", en)
        self.assertIn("use the average price", en)
        with self.assertRaises(ValueError):
            build_price_search_input("  ", "x")


class GroundingContractTests(unittest.TestCase):
    def test_provider_neutral_query_builder_unchanged(self):
        q = build_external_query("豚バラ肉", "だいたいの相場で入れて")
        self.assertEqual(q["material_name"], "豚バラ肉")
        self.assertEqual(q["kind"], "reference_price")

    def test_candidate_validation_rejects_unproven_rows(self):
        self.assertIsNotNone(validate_external_candidate(CANDIDATE))
        for bad in (None, "x", dict(CANDIDATE, amount="abc"),
                    dict(CANDIDATE, amount="-5"),
                    {k: v for k, v in CANDIDATE.items() if k != "source"}):
            self.assertIsNone(validate_external_candidate(bad))
        # Unknown units pass field validation but never survive grouping.
        cup = dict(CANDIDATE, package_unit="cup")
        self.assertIsNotNone(validate_external_candidate(cup))
        self.assertFalse(summarize_external_reference([cup])["available"])

    def test_summary_groups_comparable_only(self):
        other = dict(CANDIDATE, name="豚バラ肉B", amount="2.50",
                     currency="USD", seller="Shop B", source="shop2.example")
        res = summarize_external_reference([CANDIDATE, other])
        self.assertTrue(res["available"])
        self.assertEqual(res["origin"], "external")
        self.assertEqual(res["currency"], "JPY")
        self.assertEqual(res["sample_count"], 1)
        self.assertEqual(res["excluded_count"], 1)
        self.assertIn("サンプルからの参考値", res["label"])
        self.assertNotIn("市場平均", res["label"])

    def test_summary_empty_is_unavailable(self):
        res = summarize_external_reference([{"name": "x"}])
        self.assertFalse(res["available"])


class NonFiniteTests(unittest.TestCase):
    def test_non_finite_amounts_rejected_without_abort(self):
        base = dict(CANDIDATE)
        for bad in ("NaN", "sNaN", "Infinity", "-Infinity"):
            # Must return None, never raise out of validation.
            self.assertIsNone(validate_external_candidate(
                dict(base, amount=bad)), "amount=" + bad)
            self.assertIsNone(validate_external_candidate(
                dict(base, package_quantity=bad)), "quantity=" + bad)

    def test_non_finite_rows_dropped_aggregate_unchanged(self):
        good = dict(CANDIDATE)
        good2 = dict(CANDIDATE, name="豚バラ肉B", amount="460",
                     seller="Shop B", source="shop2.example")
        poisoned = [good, {"name": "x", "amount": "NaN", "currency": "JPY",
                            "package_quantity": "500", "package_unit": "g",
                            "seller": "S", "source": "s"},
                    dict(good2, amount="Infinity"), good2]
        res = summarize_external_reference(poisoned)
        self.assertTrue(res["available"])
        self.assertEqual(res["sample_count"], 2)
        # (380 + 460) / 2 per 500g -> 0.84/g; poisoned rows excluded.
        self.assertEqual(res["average_unit_price"], "0.8400")
        self.assertEqual(res["excluded_count"], 0)


class ProvenanceTests(unittest.TestCase):
    OLD = "2020-05-01T10:00:00+00:00"

    def test_samples_keep_provenance_no_backfill(self):
        mine = dict(CANDIDATE, fetched_at=self.OLD,
                    tax_note="税込", shipping_note="送料別")
        res = summarize_external_reference([mine])
        self.assertTrue(res["available"])
        sample = res["samples"][0]
        # Original observation time/URL/terms survive aggregation.
        self.assertEqual(sample["fetched_at"], self.OLD)
        self.assertEqual(sample["url"], CANDIDATE["url"])
        self.assertEqual(sample["tax_note"], "税込")
        self.assertEqual(sample["shipping_note"], "送料別")
        # Aggregation time is labelled as such, never as fetched_at.
        self.assertIn("aggregated_at", res)
        self.assertNotIn("fetched_at", res)
        self.assertNotEqual(res["aggregated_at"], self.OLD)

    def test_missing_provenance_never_fabricated(self):
        res = summarize_external_reference([dict(CANDIDATE)])
        sample = res["samples"][0]
        self.assertNotIn("fetched_at", sample)
        self.assertNotIn("tax_note", sample)
        self.assertEqual(sample["url"], CANDIDATE["url"])


if __name__ == "__main__":
    unittest.main()
