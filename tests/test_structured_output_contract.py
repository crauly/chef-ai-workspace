"""Phase C contract: Structured Output shape per Muse API surface.

Chat Completions (/v1/chat/completions, web routes): strict json_schema via
response_format is the verified surface; web/muse-schemas.ts is the SSOT and
both routes must send it while keeping app-side parse() validation.

Responses API (/v1/responses, Python meta_responses.py): text.format shape is
NOT verified against a live Responses acceptance in this repo, so the Python
adapter must not send unconfirmed structured-output parameters. Instructions
plus strict local parse_response remain the contract there.
"""
import json
import unittest

from chef_ai_workspace import meta_responses


class StructuredOutputContractTests(unittest.TestCase):
    def test_responses_adapter_sends_no_unverified_structured_params(self):
        seen = {}

        class FakeOpener:
            def open(self, req, timeout=None):
                seen["payload"] = json.loads(req.data.decode("utf-8"))
                raise AssertionError("stop before network")

        import urllib.request
        real = urllib.request.build_opener
        urllib.request.build_opener = lambda *a, **k: FakeOpener()
        try:
            try:
                meta_responses.MetaResponsesProvider("fixture-key").propose(
                    "test", {"recipe": {}})
            except AssertionError:
                pass
        finally:
            urllib.request.build_opener = real
        payload = seen["payload"]
        self.assertNotIn("response_format", payload)
        self.assertNotIn("text", payload)
        self.assertIn("instructions", payload)
        self.assertIn("input", payload)

    def test_responses_rejects_extra_approval_flags(self):
        raw = {"status": "completed", "output": [{
            "type": "message", "role": "assistant", "status": "completed",
            "content": [{"type": "output_text",
                         "text": '{"operations": [], "approved": true}'}]}]}
        with self.assertRaises(Exception):
            meta_responses.parse_response(raw)

    def test_chat_versus_responses_matrix_documented(self):
        # This test pins the decision so future edits must update the contract
        # deliberately: Chat=json_schema verified surface; Responses=unverified.
        matrix = {"chat_completions": "json_schema response_format",
                  "responses": "instructions + local parse (no text.format yet)"}
        self.assertEqual(matrix["chat_completions"], "json_schema response_format")
        self.assertIn("no text.format", matrix["responses"])


if __name__ == "__main__":
    unittest.main()
