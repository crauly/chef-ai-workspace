"""M3: model receives bounded owned candidates; IDs are never invented."""
import unittest
from chef_ai_workspace.ai_provider import SYSTEM, build_proposal_context, MAX_CANDIDATES


class ProposalContextTests(unittest.TestCase):
    def test_system_allows_explicit_link_ops_only(self):
        self.assertIn("link_ingredient", SYSTEM)
        self.assertIn("unlink_ingredient", SYSTEM)
        self.assertIn("always explicit", SYSTEM)
        self.assertIn("never authorizes saving", SYSTEM)

    def test_candidates_bounded_and_minimal(self):
        ctx = build_proposal_context(
            {"revision": 0},
            [{"id": f"id-{i}", "name": f"n-{i}", "secret": "x"} for i in range(30)])
        self.assertEqual(len(ctx["ingredient_candidates"]), MAX_CANDIDATES)
        self.assertEqual(ctx["ingredient_candidates"][0], {"id": "id-0", "name": "n-0"})

    def test_malformed_candidates_dropped_empty_safe(self):
        ctx = build_proposal_context({"revision": 0},
                                     [{"id": "", "name": "x"}, {"name": "y"}, "z"])
        self.assertEqual(ctx["ingredient_candidates"], [])


if __name__ == "__main__":
    unittest.main()
