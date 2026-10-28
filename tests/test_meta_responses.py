import io
import json
import os
import unittest
import urllib.error
from unittest.mock import patch
from fastapi import FastAPI

from chef_ai_workspace.ai_provider import ChatCompletionsProvider, ProposalProviderError
from chef_ai_workspace.meta_responses import MetaResponsesProvider, parse_response, ENDPOINT, MAX_RESPONSE_BYTES
from chef_ai_workspace.server_config import configure_ai


def response(text='{"operations":[{"op":"set_selling_price","value_jpy":"1800"}]}'):
    return {"id": "resp_test", "status": "completed", "output": [
        {"type": "reasoning", "summary": []},
        {"type": "message", "role": "assistant", "status": "completed",
         "content": [{"type": "output_text", "text": text}]}]}


class MetaResponsesTests(unittest.TestCase):
    def test_native_request_shape_and_text_extraction(self):
        provider = MetaResponsesProvider("private-key")
        phrase = "片栗粉10g、いや15g。売価を1800円に"
        raw = io.BytesIO(json.dumps(response()).encode())
        with patch("urllib.request.OpenerDirector.open", return_value=raw) as call:
            operations = provider.propose(phrase, {"revision": 2})
        self.assertEqual(operations, [{"op": "set_selling_price", "value_jpy": "1800"}])
        req = call.call_args.args[0]
        self.assertEqual(req.full_url, ENDPOINT)
        self.assertEqual(req.get_header("Authorization"), "Bearer private-key")
        body = json.loads(req.data)
        self.assertEqual(body["model"], "muse-spark-1.3")
        self.assertFalse(body["store"])
        self.assertEqual(json.loads(body["input"])["instruction"], phrase)
        self.assertIn("self-corrections", body["instructions"])
        self.assertTrue(set(body).isdisjoint({"messages", "response_format", "temperature"}))
        self.assertNotIn("private-key", repr(provider))

    def test_output_text_blocks_are_concatenated_in_order(self):
        raw = response()
        raw["output"][1]["content"] = [{"type": "output_text", "text": '{"operations":'},
                                       {"type": "output_text", "text": "[]}"}]
        self.assertEqual(parse_response(raw), [])

    def test_incomplete_refusal_tools_malformed_json_and_wrong_envelopes_fail_closed(self):
        cases = [response("not json"), response('{"operations":[],"confirmed":true}'),
                 response('{"operations":{}}'), response('{"operations":[null]}'),
                 response(json.dumps({"operations": [{}] * 41})), {"status": "completed", "output": []}]
        for status in ["incomplete", "failed", "in_progress", "cancelled"]:
            raw = response(); raw["status"] = status; cases.append(raw)
        raw = response(); raw["output"][1]["content"] = [{"type": "refusal", "refusal": "No"}]; cases.append(raw)
        raw = response(); raw["output"].append({"type": "function_call"}); cases.append(raw)
        raw = response(); raw["output"][1]["role"] = "user"; cases.append(raw)
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(ProposalProviderError): parse_response(raw)

    def test_http_auth_error_and_oversized_response_do_not_leak_secrets(self):
        provider = MetaResponsesProvider("private-key")
        exc = urllib.error.HTTPError(ENDPOINT, 401, "private-key", {}, io.BytesIO(b"private-key"))
        with patch("urllib.request.OpenerDirector.open", side_effect=exc):
            with self.assertRaisesRegex(ProposalProviderError, "Meta Responses HTTP 401") as caught:
                provider.propose("Change price", {})
        self.assertNotIn("private-key", str(caught.exception))
        with patch("urllib.request.OpenerDirector.open", return_value=io.BytesIO(b" " * (MAX_RESPONSE_BYTES + 1))):
            with self.assertRaisesRegex(ProposalProviderError, "too large"): provider.propose("Change price", {})

    def test_runtime_prefers_meta_and_never_falls_back_after_failure(self):
        app = FastAPI()
        with patch.dict(os.environ, {"MODEL_API_KEY": "meta-key", "AI_API_KEY": "substitute-key"}, clear=True):
            configure_ai(app)
        self.assertIsInstance(app.state.ai_provider, MetaResponsesProvider)
        self.assertEqual(app.state.ai_provider.identity, {"name": "meta_responses", "model": "muse-spark-1.3"})
        with patch("urllib.request.OpenerDirector.open", side_effect=TimeoutError):
            with self.assertRaises(ProposalProviderError): app.state.ai_provider.propose("Change", {})
        self.assertIsInstance(app.state.ai_provider, MetaResponsesProvider)
        with patch.dict(os.environ, {"AI_API_KEY": "substitute-key"}, clear=True): configure_ai(app)
        self.assertIsInstance(app.state.ai_provider, ChatCompletionsProvider)
        with patch.dict(os.environ, {}, clear=True): configure_ai(app)
        self.assertFalse(hasattr(app.state, "ai_provider"))
