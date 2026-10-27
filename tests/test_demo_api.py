import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.demo_api import router

if not any(getattr(route, "path", None) == "/demo/recipes" for route in app.routes):
    app.include_router(router)

class FakeRepo:
    def __init__(self): self.calls=[]; self.created=[]
    def load_owned_recipe(self, owner, recipe_id):
        from chef_ai_workspace.models import Recipe, TrackedValue
        self.calls.append(("recipe",owner,recipe_id))
        return Recipe(recipe_id,TrackedValue("Risotto","confirmed","user"))
    def create_owned_recipe(self, owner, recipe, snapshot):
        self.created.append((owner,recipe,snapshot))
    def list_owned_recipes(self, owner, *, offset, limit):
        self.calls.append((owner,offset,limit))
        return [{"id":str(uuid4()),"title":"Pasta","revision":0}]

class DemoLibraryTests(unittest.TestCase):
    def setUp(self):
        self.owner=str(uuid4())
        self.repo=FakeRepo()
        app.state.demo_owner_id=self.owner
        app.state.demo_access_token="a-secret-known-only-to-presenter"
        app.state.repository_factory=lambda:self.repo
        self.client=TestClient(app)
    def tearDown(self):
        del app.state.demo_owner_id
        del app.state.demo_access_token
        del app.state.repository_factory
        self.client.close()
    def test_cost_endpoint_requires_access_and_returns_deterministic_snapshot(self):
        rid=str(uuid4())
        self.assertEqual(self.client.get(f"/demo/recipes/{rid}/cost").status_code,403)
        r=self.client.get(f"/demo/recipes/{rid}/cost",
                          headers={"X-Demo-Access":"a-secret-known-only-to-presenter"})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()["total_cost_jpy"],"0")
        self.assertEqual(self.repo.calls,[("recipe",self.owner,rid)])

    def test_create_recipe_is_guarded_and_snapshotted(self):
        blocked=self.client.post("/demo/recipes",json={"title":"Risotto"})
        self.assertEqual(blocked.status_code,403)
        self.assertEqual(self.repo.created,[])
        response=self.client.post("/demo/recipes",json={"title":"Risotto"},
             headers={"X-Demo-Access":"a-secret-known-only-to-presenter"})
        self.assertEqual(response.status_code,201,response.text)
        self.assertEqual(response.json()["title"]["value"],"Risotto")
        self.assertEqual(len(self.repo.created),1)
        self.assertEqual(self.repo.created[0][0],self.owner)
        self.assertIn("total_cost_jpy",self.repo.created[0][2])

    def test_blank_title_rejected_before_database_call(self):
        r=self.client.post("/demo/recipes",json={"title":"   "},
                           headers={"X-Demo-Access":"a-secret-known-only-to-presenter"})
        self.assertEqual(r.status_code,422)
        self.assertEqual(self.repo.created,[])

    def test_change_requires_demo_access(self):
        r=self.client.post(f"/demo/recipes/{uuid4()}/confirm",
              json={"base_revision":0,"request_id":str(uuid4()),
                    "operations":[{"op":"set_title","value":"New"}]})
        self.assertEqual(r.status_code,403)

    def test_access_denied_without_secret(self):
        self.assertEqual(self.client.get("/demo/recipes").status_code,403)
        self.assertEqual(self.repo.calls,[])
    def test_access_denied_with_wrong_secret(self):
        self.assertEqual(self.client.get("/demo/recipes",headers={"X-Demo-Access":"wrong"}).status_code,403)
    def test_paginated_one_query(self):
        r=self.client.get("/demo/recipes?page=3&page_size=25",
                          headers={"X-Demo-Access":"a-secret-known-only-to-presenter"})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(self.repo.calls,[(self.owner,50,25)])
    def test_invalid_page_size(self):
        r=self.client.get("/demo/recipes?page_size=999",
                          headers={"X-Demo-Access":"a-secret-known-only-to-presenter"})
        self.assertEqual(r.status_code,422)
        self.assertEqual(self.repo.calls,[])

if __name__=="__main__": unittest.main()
