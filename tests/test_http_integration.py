import unittest
from uuid import uuid4
from dataclasses import replace
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.models import Recipe, TrackedValue

class Repo:
    def __init__(self, owner, recipe_id):
        self.owner=owner
        self.recipe=Recipe(recipe_id,TrackedValue("Original","confirmed","user"))
        self.receipts={}
        self.writes=0
    def get_mutation_receipt(self, owner_id, request_id):
        return self.receipts.get((owner_id,request_id))
    def load_owned_recipe(self, owner_id, recipe_id):
        if owner_id != self.owner or recipe_id != self.recipe.id:
            raise ValueError("Unknown recipe")
        return self.recipe
    def load_owned_catalog(self, owner_id, recipe):
        return {}

    def find_owned_ingredients_exact(self, owner_id, name):
        return []

    def list_owned_units(self, owner_id):
        return []

    def commit_recipe_crud(self, *, owner_id, recipe_id, request_id, base_revision,
                           state, title, cost_snapshot, payload_hash, save_version,
                           ingredient_entries):
        if owner_id != self.owner or base_revision != self.recipe.revision:
            raise ValueError("Denied")
        self.writes+=1
        self.recipe=replace(self.recipe,revision=base_revision+1,
                            title=TrackedValue(title,"confirmed","user"))
        self.receipts[(owner_id,request_id)]=(payload_hash,self.recipe.revision)
        return self.recipe.revision

class HttpIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.owner=str(uuid4())
        self.foreign=str(uuid4())
        self.recipe_id=str(uuid4())
        self.repo=Repo(self.owner,self.recipe_id)
        app.state.verify_token=lambda token: {"owner":self.owner,"foreign":self.foreign}.get(token)
        app.state.repository_factory=lambda: self.repo
        self.client=TestClient(app)
    def tearDown(self):
        del app.state.verify_token
        del app.state.repository_factory
        self.client.close()
    def payload(self, request_id=None, price=None):
        op={"op":"set_title","value":"Pasta"} if price is None else {"op":"set_selling_price","value_jpy":price}
        return {"request_id":request_id or str(uuid4()),"base_revision":0,
                "operations":[op],"save_version":True}
    def post(self, body,token="owner"):
        return self.client.post(f"/recipes/{self.recipe_id}/confirm",json=body,
                                headers={"Authorization":"Bearer "+token})
    def test_confirmation_and_durable_replay(self):
        body=self.payload()
        r=self.post(body)
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()["revision"],1)
        repeat=self.post(body)
        self.assertEqual(repeat.status_code,200,repeat.text)
        self.assertTrue(repeat.json()["replayed"])
        self.assertEqual(self.repo.writes,1)
    def test_foreign_user_cannot_write(self):
        response=self.post(self.payload(),"foreign")
        self.assertNotEqual(response.status_code,200)
        self.assertEqual(self.repo.writes,0)
    def test_unverified_token_rejected(self):
        self.assertEqual(self.post(self.payload(),"invalid").status_code,401)
    def test_bad_numeric_value_does_not_write(self):
        response=self.post(self.payload(price="abc"))
        self.assertEqual(response.status_code,409,response.text)
        self.assertEqual(self.repo.writes,0)
    def test_id_collision_refused(self):
        body=self.payload()
        self.assertEqual(self.post(body).status_code,200)
        other=self.payload(request_id=body["request_id"],price="500")
        self.assertEqual(self.post(other).status_code,409)
        self.assertEqual(self.repo.writes,1)
