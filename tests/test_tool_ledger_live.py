"""Opt-in live Meta tool-calling acceptance. Never runs in CI by default.

Requires CHEF_LIVE_META=1 and MODEL_API_KEY in the backend environment.
Uses random UUID ingredient IDs the model cannot guess, proving the
link_ingredient reference came from the tool result, not pretraining.
"""
import os
import unittest
from uuid import uuid4

from chef_ai_workspace.meta_responses import MetaResponsesProvider
from chef_ai_workspace.models import Ingredient


@unittest.skipUnless(os.environ.get("CHEF_LIVE_META") == "1", "Opt-in real Meta inference")
class LiveToolLedgerTests(unittest.TestCase):
    def test_tool_resolved_id_used_for_link(self):
        provider = MetaResponsesProvider(os.environ["MODEL_API_KEY"])
        owned_id = str(uuid4())  # Valid UUID, but random: un-guessable without the tool.
        marker = "Zzxq" + uuid4().hex[:8]
        recipe = {"revision": 0, "materials": [
            {"id": "mat-1", "material_id": "mat-1", "name": marker + "トマト",
             "quantity": {"value": "200", "unit": "g"},
             "price_mode": "inherit", "linked_ingredient_id": None}]}
        owned = Ingredient(owned_id, marker + "トマト", None)
        def search(query, limit):
            needle = "".join(query.split()).lower()
            if needle in "".join(owned.name.split()).lower():
                return [{"id": owned.id, "name": owned.name}]
            return []
        # Live sampling is nondeterministic: the model occasionally abstains
        # without calling the tool. Retry boundedly; the assertion itself is
        # not relaxed (the final attempt must still prove tool use).
        links: list = []
        operations: list = []
        for _ in range(3):
            operations = provider.propose_with_tools(
                f"材料mat-1（{marker}トマト）を所有カタログにリンクして。"
                "IDが不明ならsearch_owned_ingredientsツールで検索し、"
                "link_ingredient操作でprice_modeはinheritとして。", recipe, search)
            links = [op for op in operations if op.get("op") == "link_ingredient"]
            if links:
                break
        self.assertTrue(links, operations)
        self.assertEqual(links[0].get("ingredient_id"), owned_id)


if __name__ == "__main__":
    unittest.main()
