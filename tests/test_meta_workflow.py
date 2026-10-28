"""Native Meta response parsing through the real protected FastAPI workflow."""
import io
import json
import unittest
from unittest.mock import patch
import test_ai_review_workflow as workflow
import test_meta_responses as transport
from chef_ai_workspace.api import app
from chef_ai_workspace.meta_responses import MetaResponsesProvider


class MetaWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.flow = workflow.ReviewWorkflowTests()
        self.flow.setUp()
        app.state.ai_provider = MetaResponsesProvider("test-only-meta-key")

    def tearDown(self):
        self.flow.tearDown()

    def test_native_proposal_explicit_confirmation_cost_and_correction(self):
        raw = transport.response(json.dumps({"operations": self.flow.operations}))
        with patch("urllib.request.OpenerDirector.open", return_value=io.BytesIO(json.dumps(raw).encode())):
            self.flow.test_proposal_confirm_recalculate_correction_and_replay()
        self.assertEqual(self.flow.recipe.materials[0].quantity.value, "15")

    def test_native_invalid_confidence_rejected_before_preview_and_persistence(self):
        self.flow.operations[0]["status"] = "confirmed"
        raw = transport.response(json.dumps({"operations": self.flow.operations}))
        with patch("urllib.request.OpenerDirector.open", return_value=io.BytesIO(json.dumps(raw).encode())):
            response = self.flow.proposal()
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.flow.writes, [])

    def test_preview_exposes_model_identity_without_backend_credentials(self):
        raw = transport.response(json.dumps({"operations": self.flow.operations}))
        with patch("urllib.request.OpenerDirector.open", return_value=io.BytesIO(json.dumps(raw).encode())):
            response = self.flow.proposal()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["provider"], {"name": "meta_responses", "model": "muse-spark-1.3"})
        self.assertNotIn("test-only-meta-key", response.text)
        self.assertTrue(response.json()["requires_confirmation"])
        self.assertEqual(self.flow.writes, [])
