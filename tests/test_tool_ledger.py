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


def _search(catalog=None, calls=None, rows=None):
    """Owner-scoped search stub: substring over the mapping, or fixed rows."""
    if catalog is None:
        catalog = _catalog()
    def _run(query, limit):
        if calls is not None:
            calls.append((query, limit))
        if rows is not None:
            return rows
        return [{"id": g.id, "name": g.name} for g in catalog.values()
                if query in g.name][:limit]
    return _run


class ExecutorTests(unittest.TestCase):
    def test_happy_path_returns_catalog_ids(self):
        result = execute_tool(TOOL_NAME, {"query": "トマト"}, _search())
        self.assertEqual(result, {"ingredients": [{"id": "ing-tomato", "name": "ホールトマト"}]})

    def test_bad_arguments_return_error_dict_without_raising(self):
        for args in [{}, {"query": ""}, {"query": "x" * 101}, {"query": "トマト", "limit": 0},
                     {"query": "トマト", "limit": 21}, {"query": 1}, "nope", {"query": "トマト", "limit": True}]:
            result = execute_tool(TOOL_NAME, args, _search())
            self.assertIn("error", result, args)

    def test_limit_clamped_to_matches(self):
        result = execute_tool(TOOL_NAME, {"query": "ト", "limit": 20}, _search())
        self.assertLessEqual(len(result["ingredients"]), 20)

    def test_empty_catalog_returns_no_match(self):
        self.assertEqual(execute_tool(TOOL_NAME, {"query": "トマト"}, _search({})),
                         {"ingredients": []})

    def test_dict_and_object_rows_accepted_malformed_rows_dropped(self):
        rows = [{"id": "a", "name": "トマトA"}, {"id": "", "name": "x"},
                {"id": "b"}, "nope", Ingredient("c", "トマトC", None)]
        result = execute_tool(TOOL_NAME, {"query": "トマト"}, _search(rows=rows))
        self.assertEqual(result, {"ingredients": [{"id": "a", "name": "トマトA"},
                                                 {"id": "c", "name": "トマトC"}]})

    def test_search_failure_returns_error_dict(self):
        def _boom(query, limit):
            raise ValueError("db down")
        self.assertEqual(execute_tool(TOOL_NAME, {"query": "トマト"}, _boom),
                         {"error": "search_failed"})
        self.assertEqual(execute_tool(TOOL_NAME, {"query": "トマト"},
                                      lambda q, lim: {"not": "a list"}),
                         {"error": "search_failed"})

    def test_unknown_tool_raises_fail_closed(self):
        with self.assertRaises(ToolLedgerError):
            execute_tool("invent_ingredient", {"query": "x"}, _search())

    def test_ids_always_come_from_search(self):
        result = execute_search_owned_ingredients({"query": "トマト"}, _search())
        for item in result["ingredients"]:
            self.assertIn(item["id"], _catalog())


class ToolLoopTests(unittest.TestCase):
    def test_happy_path_tool_then_final(self):
        provider = MetaResponsesProvider("k")
        with _queued([_call_turn(), _msg()]) as opened:
            self.assertEqual(provider.propose_with_tools("link tomato", {}, _search()), [])
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
            self.assertEqual(provider.propose_with_tools("set price", {}, _search()), [])
        self.assertEqual(opened.call_count, 1)
        body = json.loads(opened.call_args_list[0].args[0].data)
        self.assertIn("tools", body)
        self.assertFalse(body["store"])

    def test_invalid_arguments_are_returned_to_model_for_recovery(self):
        provider = MetaResponsesProvider("k")
        bad = _call_turn(arguments='{"query":""}')
        with _queued([bad, _msg()]) as opened:
            self.assertEqual(provider.propose_with_tools("x", {}, _search()), [])
        out = json.loads(opened.call_args_list[1].args[0].data)["input"][2]
        self.assertIn("invalid_arguments", out["output"])

    def test_unknown_tool_fails_closed(self):
        provider = MetaResponsesProvider("k")
        with _queued([_call_turn(name="drop_tables")]):
            with self.assertRaises(ProposalProviderError):
                provider.propose_with_tools("x", {}, _search())

    def test_timeout_fails_closed_without_partial_result(self):
        provider = MetaResponsesProvider("k")
        with patch("urllib.request.OpenerDirector.open", side_effect=TimeoutError):
            with self.assertRaises(ProposalProviderError):
                provider.propose_with_tools("x", {}, _search())

    def test_http_error_fails_closed(self):
        provider = MetaResponsesProvider("k")
        exc = urllib.error.HTTPError(ENDPOINT, 500, "e", {}, io.BytesIO(b"e"))
        with patch("urllib.request.OpenerDirector.open", side_effect=exc):
            with self.assertRaises(ProposalProviderError):
                provider.propose_with_tools("x", {}, _search())

    def test_loop_exhaustion_fails_closed(self):
        provider = MetaResponsesProvider("k")
        with _queued([_call_turn(), _call_turn(call_id="c2"), _call_turn(call_id="c3")]):
            with self.assertRaisesRegex(ProposalProviderError, "did not converge"):
                provider.propose_with_tools("x", {}, _search(), max_tool_turns=2)

    def test_more_than_four_calls_in_one_turn_fails_closed(self):
        provider = MetaResponsesProvider("k")
        turn = {"id": "r", "status": "completed", "output": [
            {"type": "function_call", "call_id": f"c{i}", "name": TOOL_NAME,
             "arguments": '{"query":"x"}'} for i in range(5)]}
        with _queued([turn]):
            with self.assertRaises(ProposalProviderError):
                provider.propose_with_tools("x", {}, _search())

    def test_refusal_or_incomplete_tool_turn_fails_closed(self):
        provider = MetaResponsesProvider("k")
        for raw in ({"status": "incomplete", "output": []},
                    {"id": "r", "status": "completed", "output": [
                        {"type": "message", "role": "assistant",
                         "content": [{"type": "refusal", "refusal": "no"}]}]}):
            with _queued([raw]):
                with self.assertRaises(ProposalProviderError):
                    provider.propose_with_tools("x", {}, _search())

    def test_max_tool_turns_validated(self):
        provider = MetaResponsesProvider("k")
        for bad in (-1, 3, "2"):
            with self.assertRaises(ValueError):
                provider.propose_with_tools("x", {}, _search(), max_tool_turns=bad)

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


LINK_OP = {"op": "link_ingredient", "material_id": "mat-1",
           "ingredient_id": "ing-tomato", "price_mode": "inherit"}


class LinkProvenanceTests(unittest.TestCase):
    def _run(self, turns):
        provider = MetaResponsesProvider("k")
        with _queued(turns):
            return provider.propose_with_tools("link tomato", {}, _search())

    def test_tool_returned_id_is_accepted(self):
        ops = self._run([_call_turn(), _msg(json.dumps({"operations": [LINK_OP]}))])
        self.assertEqual(ops, [LINK_OP])

    def test_invented_id_fails_closed(self):
        forged = dict(LINK_OP, ingredient_id="ing-forged-by-model")
        with self.assertRaises(ProposalProviderError):
            self._run([_call_turn(), _msg(json.dumps({"operations": [forged]}))])

    def test_link_without_any_tool_call_fails_closed(self):
        with self.assertRaises(ProposalProviderError):
            self._run([_msg(json.dumps({"operations": [LINK_OP]}))])

    def test_error_result_contributes_no_ids(self):
        bad = _call_turn(arguments='{"query":""}')
        forged = dict(LINK_OP, ingredient_id="ing-tomato")
        with self.assertRaises(ProposalProviderError):
            self._run([bad, _msg(json.dumps({"operations": [forged]}))])

    def test_non_link_operations_need_no_provenance(self):
        body = {"operations": [{"op": "set_selling_price", "value_jpy": "1800"}]}
        self.assertEqual(self._run([_msg(json.dumps(body))]), body["operations"])

    def test_malformed_link_shape_left_to_downstream_validator(self):
        body = {"operations": [{"op": "link_ingredient", "material_id": "mat-1"}]}
        self.assertEqual(self._run([_msg(json.dumps(body))]), body["operations"])

    def test_legacy_propose_is_not_provenance_checked(self):
        provider = MetaResponsesProvider("k")
        forged = dict(LINK_OP, ingredient_id="ing-forged-by-model")
        with _queued([_msg(json.dumps({"operations": [forged]}))]):
            self.assertEqual(provider.propose("x", {}), [forged])


def _refusal_turn(call_id="call_1"):
    return {"id": "resp_t", "status": "completed", "output": [
        {"type": "message", "role": "assistant", "status": "completed",
         "content": [{"type": "refusal", "refusal": "no"}]},
        {"type": "function_call", "call_id": call_id, "name": TOOL_NAME,
         "arguments": '{"query":"トマト"}'}]}


def _text_and_call_turn(text="looking up", call_id="call_1"):
    return {"id": "resp_t", "status": "completed", "output": [
        {"type": "message", "role": "assistant", "status": "completed",
         "content": [{"type": "output_text", "text": text}]},
        {"type": "function_call", "call_id": call_id, "name": TOOL_NAME,
         "arguments": '{"query":"トマト"}'}]}


class IntermediateMessageTests(unittest.TestCase):
    """P2: assistant messages are validated on tool turns, not just finals."""

    def test_mixed_refusal_and_call_fails_closed(self):
        provider = MetaResponsesProvider("k")
        with _queued([_refusal_turn(), _msg()]):
            with self.assertRaises(ProposalProviderError):
                provider.propose_with_tools("x", {}, _search())

    def test_incomplete_status_message_with_call_fails_closed(self):
        provider = MetaResponsesProvider("k")
        turn = _text_and_call_turn()
        turn["output"][0]["status"] = "in_progress"
        with _queued([turn, _msg()]):
            with self.assertRaises(ProposalProviderError):
                provider.propose_with_tools("x", {}, _search())

    def test_non_text_content_with_call_fails_closed(self):
        provider = MetaResponsesProvider("k")
        turn = _text_and_call_turn()
        turn["output"][0]["content"] = [{"type": "output_image", "url": "x"}]
        with _queued([turn, _msg()]):
            with self.assertRaises(ProposalProviderError):
                provider.propose_with_tools("x", {}, _search())

    def test_valid_text_alongside_call_proceeds(self):
        provider = MetaResponsesProvider("k")
        with _queued([_text_and_call_turn(), _msg()]) as opened:
            self.assertEqual(provider.propose_with_tools("x", {}, _search()), [])
        self.assertEqual(opened.call_count, 2)


class ToolEndpointWiringTests(unittest.TestCase):
    """P1: the endpoint searches owner-scoped and validates tool-resolved links."""

    def _client(self, repo, provider):
        from fastapi.testclient import TestClient
        from chef_ai_workspace.api import app
        from chef_ai_workspace.demo_api import router
        if not any(getattr(r, "path", None) == "/demo/recipes" for r in app.routes):
            app.include_router(router)
        owner = str(uuid4())
        app.state.demo_owner_id = owner
        app.state.demo_access_token = "secret-w"
        app.state.repository_factory = lambda: repo
        app.state.ai_provider = provider
        self.addCleanup(self._clear_state)
        return TestClient(app), owner

    def _clear_state(self):
        from chef_ai_workspace.api import app
        for attr in ("demo_owner_id", "demo_access_token",
                     "repository_factory", "ai_provider"):
            try:
                delattr(app.state, attr)
            except AttributeError:
                pass

    def _recipe(self, rid):
        from chef_ai_workspace.models import (
            MaterialLine, PriceQuote, Recipe, TrackedValue)
        quote = PriceQuote(TrackedValue("300", "confirmed", "user"),
                           "100", "g", "manual")
        line = MaterialLine(id="mat-1",
                            material_name=TrackedValue("トマト", "confirmed", "user"),
                            quantity=TrackedValue("200", "confirmed", "user"),
                            unit="g", price_mode="override",
                            price_override=quote)
        return Recipe(rid, TrackedValue("Soup", "confirmed", "user"),
                      materials=(line,), revision=0)

    def test_owner_scoped_search_is_used(self):
        from chef_ai_workspace.models import Ingredient
        calls = []

        class Repo:
            def load_owned_recipe(self, owner, recipe_id):
                return self.recipe
            def load_owned_catalog(self, owner, recipe):
                return {}
            def search_owned_ingredients(self, owner_id, query, limit=20):
                calls.append((owner_id, query, limit))
                return [{"id": "ing-t", "name": "トマト"}]

        class Provider:
            identity = {"name": "meta_responses", "model": "muse-spark-1.3"}
            def propose_with_tools(self, instruction, context, search, **kwargs):
                return search("トマト", 8) and []

        repo = Repo()
        rid = str(uuid4())
        repo.recipe = self._recipe(rid)
        client, owner = self._client(repo, Provider())
        try:
            r = client.post(f"/demo/recipes/{rid}/propose", json={"instruction": "x"},
                            params={"tools": "ledger"},
                            headers={"X-Demo-Access": "secret-w"})
        finally:
            client.close()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(calls, [(owner, "トマト", 8)])

    def test_tool_resolved_link_passes_validation(self):
        from chef_ai_workspace.models import Ingredient
        owned_id = str(uuid4())
        owned = Ingredient(owned_id, "トマト", None)

        class Repo:
            def load_owned_recipe(self, owner, recipe_id):
                return self.recipe
            def load_owned_catalog(self, owner, recipe):
                return {}  # Unlinked recipe: recipe-costing catalog is empty.
            def search_owned_ingredients(self, owner_id, query, limit=20):
                return [{"id": owned_id, "name": "トマト"}]
            def load_owned_ingredients(self, owner_id, ids):
                assert owner_id == self.owner
                return {i: owned for i in ids if i == owned_id}

        class Provider:
            identity = {"name": "meta_responses", "model": "muse-spark-1.3"}
            def propose_with_tools(self, instruction, context, search, **kwargs):
                found = search("トマト", 8)
                return [{"op": "link_ingredient", "material_id": "mat-1",
                         "ingredient_id": found[0]["id"], "price_mode": "inherit"}]

        repo = Repo()
        rid = str(uuid4())
        repo.recipe = self._recipe(rid)
        client, owner = self._client(repo, Provider())
        repo.owner = owner
        try:
            r = client.post(f"/demo/recipes/{rid}/propose", json={"instruction": "x"},
                            params={"tools": "ledger"},
                            headers={"X-Demo-Access": "secret-w"})
        finally:
            client.close()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["operations"][0]["ingredient_id"], owned_id)

    def test_fallback_without_owner_search_method(self):
        from chef_ai_workspace.models import Ingredient

        class Repo:
            def load_owned_recipe(self, owner, recipe_id):
                return self.recipe
            def load_owned_catalog(self, owner, recipe):
                return {"ing-t": Ingredient("ing-t", "トマト", None)}

        seen = {}

        class Provider:
            identity = {"name": "meta_responses", "model": "muse-spark-1.3"}
            def propose_with_tools(self, instruction, context, search, **kwargs):
                seen["result"] = search("トマト", 8)
                return []

        repo = Repo()
        rid = str(uuid4())
        repo.recipe = self._recipe(rid)
        client, owner = self._client(repo, Provider())
        try:
            r = client.post(f"/demo/recipes/{rid}/propose", json={"instruction": "x"},
                            params={"tools": "ledger"},
                            headers={"X-Demo-Access": "secret-w"})
        finally:
            client.close()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(seen["result"], [{"id": "ing-t", "name": "トマト"}])

    def test_normal_edit_tool_endpoint_reuses_owned_recipe_and_price_handlers(self):
        seen = []
        class Repo:
            def load_owned_recipe(self, owner, recipe_id):
                seen.append(("recipe", owner))
                return self.recipe
            def list_owned_recipes(self, owner, **kwargs):
                seen.append(("search", owner))
                return [{"id": self.recipe.id, "title": "Soup"}]
            def search_owned_ingredients(self, owner, query, limit=20):
                seen.append(("ingredient", owner))
                return []
            def list_ingredient_offers(self, owner, ingredient_id):
                return []
            def list_latest_observations_for_offers(self, owner, offer_ids):
                return {}
        repo = Repo()
        rid = str(uuid4())
        repo.recipe = self._recipe(rid)
        client, owner = self._client(repo, MetaResponsesProvider("fixture"))
        first = _call_turn(name="search_recipes", arguments='{"query":"Soup"}')
        second = _call_turn(call_id="read", name="get_recipe", arguments=json.dumps({"recipe_id": rid}))
        second["output"].append({"type": "function_call", "call_id": "price", "name": "get_price_reference", "arguments": '{"query":"トマト"}'})
        operations = [{"op": "set_material_quantity", "material_id": "mat-1", "value": "15", "unit": "g"}]
        responses = iter([first, second, _msg(json.dumps({"operations": operations}))])
        payloads = []
        def transport(request, timeout):
            payload = json.loads(request.data)
            payloads.append(payload)
            return io.BytesIO(json.dumps(next(responses)).encode())
        try:
            with patch("urllib.request.OpenerDirector.open", side_effect=transport):
                response = client.post(f"/demo/recipes/{rid}/propose?tools=ledger", json={"instruction": "Soupを参照して使用量を15gに変更"}, headers={"X-Demo-Access": "secret-w"})
        finally:
            client.close()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["requires_confirmation"])
        self.assertEqual(response.json()["operations"], operations)
        self.assertTrue(all(found_owner == owner for _, found_owner in seen))
        outputs = {item["call_id"]: json.loads(item["output"]) for item in payloads[-1]["input"] if item["type"] == "function_call_output"}
        self.assertEqual(outputs["read"]["materials"][0]["quantity"]["value"], "200")
        self.assertEqual(outputs["price"]["adoption"], "unapproved")
        self.assertEqual(repo.recipe.materials[0].quantity.value, "200")
