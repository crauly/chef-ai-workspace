"""External reference seam: contract without a live provider."""

import unittest

from chef_ai_workspace.external_reference import (
    EXTERNAL_REFERENCE_STATUS,
    MISSING_CONDITIONS,
    ExternalReferenceUnavailable,
    build_external_query,
    fetch_external_reference,
    summarize_external_reference,
    validate_external_candidate,
)


def _cand(**over):
    base = {"name": "豚バラ肉", "amount": "800", "currency": "JPY",
            "package_quantity": "500", "package_unit": "g",
            "seller": "Xストア", "source": "example-listing"}
    base.update(over)
    return base


class QueryTests(unittest.TestCase):
    def test_request_carried_verbatim_ja(self):
        q = build_external_query("豚バラ肉", "だいたいの相場で入れて", "ja")
        self.assertEqual(q["material_name"], "豚バラ肉")
        self.assertEqual(q["request"], "だいたいの相場で入れて")
        self.assertEqual(q["locale"], "ja")

    def test_request_carried_verbatim_en(self):
        q = build_external_query("pork belly", "Find a reference price.", "en")
        self.assertEqual(q["request"], "Find a reference price.")
        self.assertEqual(q["locale"], "en")

    def test_blank_material_rejected(self):
        with self.assertRaises(ValueError):
            build_external_query("  ", "調べて", "ja")

    def test_unknown_locale_falls_back(self):
        self.assertEqual(build_external_query("米", "調べて", "it")["locale"], "ja")


class CandidateTests(unittest.TestCase):
    def test_valid_candidate_normalized(self):
        out = validate_external_candidate(_cand())
        self.assertIsNotNone(out)
        self.assertEqual(out["amount"], "800")

    def test_missing_provenance_rejected(self):
        for key in ("seller", "source", "currency", "package_quantity"):
            row = _cand()
            del row[key]
            self.assertIsNone(validate_external_candidate(row), key)

    def test_negative_or_zero_quantity_rejected(self):
        self.assertIsNone(validate_external_candidate(_cand(amount="-5")))
        self.assertIsNone(validate_external_candidate(_cand(package_quantity="0")))

    def test_non_dict_rejected(self):
        self.assertIsNone(validate_external_candidate("800円"))


class SummaryTests(unittest.TestCase):
    def test_sample_average_never_market_average(self):
        out = summarize_external_reference(
            [_cand(amount="800"), _cand(amount="900", seller="Yストア")])
        self.assertTrue(out["available"])
        self.assertEqual(out["average_unit_price"], "1.7000")
        self.assertEqual(out["sample_count"], 2)
        self.assertNotIn("市場平均", out["label"])
        self.assertIn("サンプル", out["label"])

    def test_incomparable_currency_excluded_not_mixed(self):
        out = summarize_external_reference(
            [_cand(amount="800"), _cand(amount="5", currency="USD")])
        self.assertTrue(out["available"])
        self.assertEqual(out["currency"], "JPY")
        self.assertEqual(out["excluded_count"], 1)

    def test_empty_has_no_reference(self):
        out = summarize_external_reference([])
        self.assertFalse(out["available"])

    def test_nothing_faked(self):
        out = summarize_external_reference([{"junk": True}])
        self.assertFalse(out["available"])


class UnavailableTests(unittest.TestCase):
    def test_live_fetch_raises_without_faking(self):
        with self.assertRaises(ExternalReferenceUnavailable):
            fetch_external_reference({"material_name": "米"})

    def test_missing_conditions_are_concrete(self):
        self.assertFalse(EXTERNAL_REFERENCE_STATUS["available"])
        self.assertGreaterEqual(len(MISSING_CONDITIONS), 4)
        joined = " ".join(MISSING_CONDITIONS)
        self.assertIn("credentials", joined)


if __name__ == "__main__":
    unittest.main()
