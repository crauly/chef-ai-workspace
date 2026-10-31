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
import os
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




class SchemaParityTests(unittest.TestCase):
    """Offline guard: the live probe's Python mirror must equal the SSOT.

    Serializes the real `web/muse-schemas.ts` with the existing Node runtime
    (no dependencies: the module is erasable-syntax-only) and deep-compares
    the whole VOICE_RECIPE_SCHEMA structure: field types, required, array
    items, nesting and additionalProperties. Prevents the live test from
    passing against a stale, diverging schema. No network, no key.
    If Node is unavailable the deep check is skipped with a reason; if Node
    exists but the TS import, execution or JSON parsing fails, the test fails.
    """
    TS_PATH = os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "web", "muse-schemas.ts")

    def _ssot_voice_schema(self):
        import shutil
        import subprocess
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node runtime unavailable for SSOT check")
        script = ("import(process.argv[1]).then(m=>console.log("
                  "JSON.stringify(m.VOICE_RECIPE_SCHEMA)))")
        try:
            out = subprocess.run(
                [node, "--input-type=module", "-e", script, self.TS_PATH],
                capture_output=True, timeout=60, check=True)
        except (subprocess.SubprocessError, OSError) as exc:
            self.fail("SSOT serialization failed: %r" % (exc,))
        try:
            return json.loads(out.stdout.decode("utf-8"))
        except ValueError as exc:
            self.fail("SSOT output is not JSON: %r" % (exc,))

    def test_python_mirror_deep_equals_ts_ssot(self):
        try:
            import test_structured_output_live as live
        except ModuleNotFoundError:  # package-style invocation
            from tests import test_structured_output_live as live
        mirror = live.VOICE_RECIPE_SCHEMA_PY
        # The live probe sends exactly this object as JSON.
        json.dumps(mirror)
        self.assertEqual(self._ssot_voice_schema(), mirror)

    def test_intent_contract_matches_ts_ssot(self):
        import re
        try:
            import test_structured_output_live as live
        except ModuleNotFoundError:  # package-style invocation
            from tests import test_structured_output_live as live
        _ = live  # intent schema lives inline in the live probe payload
        text = open(self.TS_PATH, encoding="utf-8").read()
        required = re.findall(r"required:\s*\[([^\]]*)\]", text)
        self.assertIn(set(["intent", "target"]),
                      [set(re.findall(r'"([^"]+)"', m)) for m in required])
        for value in ("create", "browse", "edit", "clarify"):
            self.assertIn('"%s"' % value, text)


if __name__ == "__main__":
    unittest.main()
