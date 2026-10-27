"""Real FastAPI + mutation/cost path with an isolated in-memory repository."""
import unittest
from dataclasses import replace
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.models import Recipe, MaterialLine, PriceQuote, TrackedValue
from chef_ai_workspace.supabase_adapter import decode_recipe


class ReviewWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.owner, self.rid, self.mid = (str(uuid4()) for _ in range(3))
        value = lambda v: TrackedValue(v, "confirmed", "user")
        self.recipe = Recipe(self.rid, value("片栗粉"), materials=(
            MaterialLine(self.mid, value("片栗粉"), value("10"), "g",
                         price_override=PriceQuote(value("1000"), "1", "kg", "manual")),),
            selling_price_jpy=value("1000"))
        self.operations = [{"op": "set_material_quantity", "material_id": self.mid, "value": "15", "unit": "g"},
                           {"op": "set_selling_price", "value_jpy": "1800"}]
        self.writes, self.corrections, self.receipts = [], [], {}
        app.state.demo_owner_id = self.owner
        app.state.demo_access_token = "test-secret"
        app.state.repository_factory = lambda: self
        app.state.ai_provider = self
        app.state.correction_hints = self
        self.client = TestClient(app)
        self.headers = {"X-Demo-Access": "test-secret"}
        self.path = f"/demo/recipes/{self.rid}"

    def tearDown(self):
        self.client.close()
        for key in ("demo_owner_id", "demo_access_token", "repository_factory", "ai_provider", "correction_hints"):
            delattr(app.state, key)

    def load_owned_recipe(self, owner, rid):
        assert (owner, rid) == (self.owner, self.rid)
        return self.recipe

    def relevant(self, owner, rid, instruction):
        return []

    def record(self, owner, rid, heard, preferred):
        self.corrections.append((owner, rid, heard, preferred))

    def propose(self, instruction, context):
        self.assertEqual(instruction, "片栗粉10g、いや15g。売価1800円に")
        self.assertEqual(context["materials"][0]["material_name"]["value"], "片栗粉")
        return self.operations

    def get_mutation_receipt(self, owner, request_id):
        return self.receipts.get(request_id)

    def commit_recipe_revision(self, **kwargs):
        self.writes.append(kwargs)
        self.recipe = decode_recipe(kwargs["state"])
        self.receipts[kwargs["request_id"]] = (kwargs["payload_hash"], self.recipe.revision)
        return self.recipe.revision

    def proposal(self):
        return self.client.post(self.path + "/propose", headers=self.headers,
                                json={"instruction": "片栗粉10g、いや15g。売価1800円に"})

    def test_proposal_confirm_recalculate_correction_and_replay(self):
        response = self.proposal()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.writes, [])
        self.assertEqual(self.recipe.materials[0].quantity.value, "10")
        proposal = response.json()
        body = {"base_revision": proposal["base_revision"], "operations": proposal["operations"],
                "request_id": str(uuid4()), "save_version": True}
        saved = self.client.post(self.path + "/confirm", headers=self.headers, json=body)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(self.recipe.materials[0].quantity.status, "confirmed")
        self.assertEqual(self.writes[0]["cost_snapshot"]["total_cost_jpy"], "15")
        self.assertTrue(self.writes[0]["save_version"])
        replay = self.client.post(self.path + "/confirm", headers=self.headers, json=body)
        self.assertTrue(replay.json()["replayed"])
        self.assertEqual(len(self.writes), 1)
        correction = self.client.post(self.path + "/corrections", headers=self.headers,
                                       json={"heard": "澱粉", "preferred": "片栗粉"})
        self.assertEqual(correction.status_code, 201)
        self.assertEqual(self.corrections, [(self.owner, self.rid, "澱粉", "片栗粉")])

    def test_invalid_model_confidence_is_rejected_without_write(self):
        self.operations[0]["status"] = "confirmed"
        self.assertEqual(self.proposal().status_code, 422)
        self.assertEqual(self.writes, [])

    def test_stale_approval_rejected_without_write(self):
        proposal = self.proposal().json()
        self.recipe = replace(self.recipe, revision=1)
        response = self.client.post(self.path + "/confirm", headers=self.headers,
            json={"base_revision": proposal["base_revision"], "operations": proposal["operations"],
                  "request_id": str(uuid4()), "save_version": True})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.writes, [])
