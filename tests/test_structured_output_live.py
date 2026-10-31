"""Opt-in live acceptance for Structured Output (Phase C).

Never runs in CI. Requires MODEL_API_KEY in the backend environment and
CHEF_LIVE_STRUCTURED=1. Read-only: one tiny classification call, no DB,
no persistence, no secret output.
"""
import json
import os
import unittest
import urllib.request


@unittest.skipUnless(os.environ.get("CHEF_LIVE_STRUCTURED") == "1",
                     "Opt-in live Structured Output acceptance")
class LiveStructuredOutputTests(unittest.TestCase):
    ENDPOINT = "https://api.meta.ai/v1/chat/completions"

    def post(self, payload: dict) -> dict:
        req = urllib.request.Request(
            self.ENDPOINT, data=json.dumps(payload).encode("utf-8"), method="POST",
            headers={"Authorization": "Bearer " + os.environ["MODEL_API_KEY"],
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.loads(response.read(8192))

    def test_chat_json_schema_accepted_for_intent(self):
        raw = self.post({
            "model": "muse-spark-1.3", "reasoning_effort": "low",
            "max_completion_tokens": 2048,
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "chef_intent", "strict": True, "schema": {
                    "type": "object",
                    "properties": {
                        "intent": {"type": "string",
                                   "enum": ["create", "browse", "edit", "clarify"]},
                        "target": {"type": "string"}},
                    "required": ["intent", "target"],
                    "additionalProperties": False}}},
            "messages": [
                {"role": "system",
                 "content": "Return ONLY a JSON object with exactly intent and target."},
                {"role": "user",
                 "content": json.dumps({"utterance": "内容を確認",
                                        "current_mode": "idle"})}]})
        content = raw["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        self.assertEqual(set(parsed), {"intent", "target"})
        self.assertIn(parsed["intent"], ("create", "browse", "edit", "clarify"))
        self.assertIsInstance(parsed["target"], str)
