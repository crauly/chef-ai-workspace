"""Master CRUD authorization, owner routing and validation regression tests."""
import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.demo_api import router

if not any(getattr(route,"path",None)=="/demo/ingredients" for route in app.routes):
    app.include_router(router)

class MasterRepo:
    def __init__(self): self.calls=[]
    def create_owned_ingredient_master(self,owner,name,spec=None):
        self.calls.append(("ingredient_create",owner,name,spec));return str(uuid4())
    def delete_owned_ingredient_master(self,owner,id):
        self.calls.append(("ingredient_delete",owner,id));return True
    def create_owned_unit_master(self,owner,symbol,dimension):
        self.calls.append(("unit_create",owner,symbol,dimension));return str(uuid4())
    def delete_owned_unit_master(self,owner,id):
        self.calls.append(("unit_delete",owner,id));return True

class MasterCrudBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.owner=str(uuid4());self.repo=MasterRepo()
        app.state.demo_owner_id=self.owner
        app.state.demo_access_token="test-master-secret"
        app.state.repository_factory=lambda:self.repo
        self.client=TestClient(app)
        self.headers={"X-Demo-Access":"test-master-secret"}
    def tearDown(self):
        self.client.close()
        del app.state.demo_owner_id
        del app.state.demo_access_token
        del app.state.repository_factory
    def test_unauthorized_writes_never_reach_repository(self):
        for path,body in (("/demo/ingredients",{"name":"Salt"}),("/demo/units",{"symbol":"g","dimension":"mass"})):
            self.assertEqual(self.client.post(path,json=body).status_code,403)
        for path in ("ingredients","units"):
            self.assertEqual(self.client.delete(f"/demo/{path}/{uuid4()}").status_code,403)
        self.assertEqual(self.repo.calls,[])
    def test_owner_is_derived_from_server_not_request(self):
        self.assertEqual(self.client.post("/demo/ingredients",json={"name":"Salt"},headers=self.headers).status_code,201)
        self.assertEqual(self.client.post("/demo/units",json={"symbol":"g","dimension":"mass"},headers=self.headers).status_code,201)
        self.assertEqual(self.repo.calls,[("ingredient_create",self.owner,"Salt",None),("unit_create",self.owner,"g","mass")])
    def test_invalid_inputs_are_rejected(self):
        for path,body in (("/demo/ingredients",{"name":""}),("/demo/units",{"symbol":"g","dimension":"invalid"}),("/demo/units",{"symbol":"g","dimension":"mass","owner_id":str(uuid4())})):
            self.assertEqual(self.client.post(path,json=body,headers=self.headers).status_code,422)
        self.assertEqual(self.repo.calls,[])
    def test_explicit_delete_is_owner_scoped(self):
        iid=str(uuid4());uid=str(uuid4())
        self.assertEqual(self.client.delete(f"/demo/ingredients/{iid}",headers=self.headers).status_code,200)
        self.assertEqual(self.client.delete(f"/demo/units/{uid}",headers=self.headers).status_code,200)
        self.assertEqual(self.repo.calls,[("ingredient_delete",self.owner,iid),("unit_delete",self.owner,uid)])

if __name__=="__main__": unittest.main()
