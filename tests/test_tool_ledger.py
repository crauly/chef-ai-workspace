"""Block 1: owned-ledger tool calling. Offline; Meta transport is mocked."""
import io
import json
import urllib.error
import unittest
from unittest.mock import patch
from uuid import uuid4

from chef_ai_workspace.ai_provider import ProposalProviderError
from chef_ai_workspace.meta_responses import MetaResponsesProvider, ENDPOINT
from chef_ai_workspace.models import Ingredient
from chef_ai_workspace.tool_ledger import (
    TOOL_NAME, execute_search_owned_ingredients, execute_tool, ToolLedgerError,
)


def _msg(text='{"operations":[]}'):
    return {"id": "resp_t", "status": "completed", "output": [
        {"type": "message", "role": "assistant", "status": "completed",
         "content": [{"type": "output_text", "text": text}]}]}


def _call_turn(call_id="call_1", name=TOOL_NAME, arguments='{"query":"トマト"}'):
    return {"id": "resp_t", "status": "completed", "output": [
        {"type": "function_call", "call_id": call_id, "name": name,
         "arguments": arguments}]}


def _queued(responses):
    bodies = [json.dumps(r).encode() for r in responses]
    return patch("urllib.request.OpenerDirector.open",
                 side_effect=[io.BytesIO(b) for b in bodies])


def _catalog():
    return {"ing-tomato": Ingredient("ing-tomato", "ホールトマト", None),
            "ing-pasta": Ingredient("ing-pasta", "乾燥パスタ", None)}


class ExecutorTests(unittest.TestCase):
    def test_happy_path_returns_catalog_ids(self):
        result = execute_tool(TOOL_NAME, {"query": "トマト"}, _catalog())
        self.assertEqual(result, {"ingredients": [{"id": "ing-tomato", "name": "ホールトマト"}]})

    def test_bad_arguments_return_error_dict_without_raising(self):
        for args in [{}, {"query": ""}, {"query": "x" * 101}, {"query": "トマト", "limit": 0},
                     {"query": "トマト", "limit": 21}, {"query": 1}, "nope", {"query": "トマト", "limit": True}]:
            result = execute_tool(TOOL_NAME, args, _catalog())
            self.assertIn("error", result, args)

    def test_limit_clamped_to_matches(self):
        result = execute_tool(TOOL_NAME, {"query": "ト", "limit": 20}, _catalog())
        self.assertLessEqual(len(result["ingredients"]), 20)

    def test_empty_catalog_returns_no_match(self):
        self.assertEqual(execute_tool(TOOL_NAME, {"query": "トマト"}, {}),
                         {"ingredients": []})

    def test_unknown_tool_raises_fail_closed(self):
        with self.assertRaises(ToolLedgerError):
            execute_tool("invent_ingredient", {"query": "x"}, _catalog())

    def test_ids_always_come_from_catalog(self):
        result = execute_search_owned_ingredients({"query": "トマト"}, _catalog())
        for item in result["ingredients"]:
            self.assertIn(item["id"], _catalog())


class ToolLoopTests(unittest.TestCase):
    def test_happy_path_tool_then_final(self):
        provider = MetaResponsesProvider("k")
        with _queued([_call_turn(), _msg()]) as opened:
            self.assertEqual(provider.propose_with_tools("link tomato", {}, _catalog()), [])
        self.assertEqual(opened.call_count, 2)
        second = json.loads(opened.call_args_list[1].args[0].data)
        kinds = [i["type"] for i in second["input"]]
        self.assertEqual(kinds, ["message", "function_call", "function_call_output"])
        out = second["input"][2]
        self.assertEqual(out["call_id"], "call_1")
        self.assertIn("ing-tomato", out["output"])

    def test_no_call_passthrough_single_request(self):
        provider = MetaResponsesProvider("k")
        with _queued([_msg()]) as opened:
            self.assertEqual(provider.propose_with_tools("set price", {}, _catalog()), [])
        self.assertEqual(opened.call_count, 1)
        body = json.loads(opened.call_args_list[0].args[0].data)
        self.assertIn("tools", body)
        self.assertFalse(body["store"])

    def test_invalid_arguments_are_returned_to_model_for_recovery(self):
        provider = MetaResponsesProvider("k")
        bad = _call_turn(arguments='{"query":""}')
        with _queued([bad, _msg()]) as opened:
            self.assertEqual(provider.propose_with_tools("x", {}, _catalog()), [])
        out = json.loads(opened.call_args_list[1].args[0].data)["input"][2]
        self.assertIn("invalid_arguments", out["output"])

    def test_unknown_tool_fails_closed(self):
        provider = MetaResponsesProvider("k")
        with _queued([_call_turn(name="drop_tables")]):
            with self.assertRaises(ProposalProviderError):
                provider.propose_with_tools("x", {}, _catalog())

    def test_timeout_fails_closed_without_partial_result(self):
        provider = MetaResponsesProvider("k")
        with patch("urllib.request.OpenerDirector.open", side_effect=TimeoutError):
            with self.assertRaises(ProposalProviderError):
                provider.propose_with_tools("x", {}, _catalog())

    def test_http_error_fails_closed(self):
        provider = MetaResponsesProvider("k")
        exc = urllib.error.HTTPError(ENDPOINT, 500, "e", {}, io.BytesIO(b"e"))
        with patch("urllib.request.OpenerDirector.open", side_effect=exc):
            with self.assertRaises(ProposalProviderError):
                provider.propose_with_tools("x", {}, _catalog())

    def test_loop_exhaustion_fails_closed(self):
        provider = MetaResponsesProvider("k")
        with _queued([_call_turn(), _call_turn(call_id="c2"), _call_turn(call_id="c3")]):
            with self.assertRaisesRegex(ProposalProviderError, "did not converge"):
                provider.propose_with_tools("x", {}, _catalog(), max_tool_turns=2)

    def test_more_than_four_calls_in_one_turn_fails_closed(self):
        provider = MetaResponsesProvider("k")
        turn = {"id": "r", "status": "completed", "output": [
            {"type": "function_call", "call_id": f"c{i}", "name": TOOL_NAME,
             "arguments": '{"query":"x"}'} for i in range(5)]}
        with _queued([turn]):
            with self.assertRaises(ProposalProviderError):
                provider.propose_with_tools("x", {}, _catalog())

    def test_refusal_or_incomplete_tool_turn_fails_closed(self):
        provider = MetaResponsesProvider("k")
        for raw in ({"status": "incomplete", "output": []},
                    {"id": "r", "status": "completed", "output": [
                        {"type": "message", "role": "assistant",
                         "content": [{"type": "refusal", "refusal": "no"}]}]}):
            with _queued([raw]):
                with self.assertRaises(ProposalProviderError):
                    provider.propose_with_tools("x", {}, _catalog())

    def test_max_tool_turns_validated(self):
        provider = MetaResponsesProvider("k")
        for bad in (-1, 3, "2"):
            with self.assertRaises(ValueError):
                provider.propose_with_tools("x", {}, _catalog(), max_tool_turns=bad)

    def test_legacy_propose_sends_no_tools(self):
        provider = MetaResponsesProvider("k")
        with _queued([_msg()]) as opened:
            provider.propose("x", {})
        body = json.loads(opened.call_args_list[0].args[0].data)
        self.assertNotIn("tools", body)


class EndpointGuardTests(unittest.TestCase):
    def test_unknown_tools_option_rejected(self):
        from fastapi.testclient import TestClient
        from chef_ai_workspace.api import app
        from chef_ai_workspace.demo_api import router
        if not any(getattr(r, "path", None) == "/demo/recipes" for r in app.routes):
            app.include_router(router)
        owner, rid = str(uuid4()), str(uuid4())
        app.state.demo_owner_id = owner
        app.state.demo_access_token = "secret-t"
        app.state.repository_factory = lambda: None
        app.state.ai_provider = MetaResponsesProvider("k")
        try:
            client = TestClient(app)
            r = client.post(f"/demo/recipes/{rid}/propose", json={"instruction": "x"},
                            params={"tools": "bogus"},
                            headers={"X-Demo-Access": "secret-t"})
            self.assertEqual(r.status_code, 422, r.text)
        finally:
            for attr in ("demo_owner_id", "demo_access_token", "repository_factory", "ai_provider"):
                try: delattr(app.state, attr)
                except AttributeError: pass


if __name__ == "__main__":
    unittest.main()
