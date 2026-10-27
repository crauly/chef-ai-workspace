import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.demo_api import router

if not any(route.path == "/demo/recipes" for route in app.routes):
    app.include_router(router)

class FakeRepo:
    def __init__(self): self.calls=[]
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
