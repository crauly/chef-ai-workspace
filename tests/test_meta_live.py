"""Explicit opt-in: real Meta inference, real FastAPI/cost, isolated in-memory persistence.

No Supabase access. MODEL_API_KEY is read only by the backend test process.
"""
import os
import unittest
from decimal import Decimal
import test_ai_review_workflow as workflow
from chef_ai_workspace.api import app
from chef_ai_workspace.meta_responses import MetaResponsesProvider


@unittest.skipUnless(os.environ.get("CHEF_LIVE_META") == "1", "Opt-in real Meta inference")
class LiveMetaWorkflowTests(unittest.TestCase):
    def test_real_chef_self_correction_through_confirmation_cost_and_replay(self):
        test = workflow.ReviewWorkflowTests()
        test.setUp()
        try:
            app.state.ai_provider = MetaResponsesProvider(os.environ["MODEL_API_KEY"])
            # Real chef instruction: 片栗粉10g、いや15g。売価1800円に
            test.test_proposal_confirm_recalculate_correction_and_replay()
            self.assertEqual(Decimal(test.recipe.materials[0].quantity.value), Decimal("15"))
            self.assertEqual(Decimal(test.recipe.selling_price_jpy.value), Decimal("1800"))
            self.assertEqual(test.writes[0]["cost_snapshot"]["cost_rate_pct"], "0.8")
        finally:
            test.tearDown()
