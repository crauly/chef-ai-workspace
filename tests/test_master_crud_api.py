import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.demo_api import router

if not any(getattr(route,"path",None)=="/demo/ingredients" for route in app.routes):
    app.include_router(router)

class MasterRepo:
    def __init__(self):
        self.calls=[]
    def list_owned_ingredient_master(self,owner):
        self.calls.append(("list_ingredient",owner))
        return [{"id":str(uuid4()),"name":"Flour","current_price":None}]
    def list_owned_ingredient_suppliers(self, owner):
        self.calls.append(("list_suppliers_by_ingredient", owner))
        return {"11111111-1111-1111-1111-111111111111": ["A食品"]}
    def link_owned_ingredient_supplier(self, owner, ingredient_id, supplier_id):
        self.calls.append(("link_ingredient_supplier", owner, ingredient_id, supplier_id))
        return str(uuid4())
    def list_owned_units(self,owner):
        self.calls.append(("list_unit",owner))
        return []
    def create_owned_ingredient_master(self,owner,name,spec=None):
        self.calls.append(("create_ingredient",owner,name,spec))
        return str(uuid4())
    def create_owned_unit_master(self,owner,symbol,dimension):
        self.calls.append(("create_unit",owner,symbol,dimension))
        return str(uuid4())
    def update_owned_ingredient_master(self,owner,id,name,quote,spec=None):
        self.calls.append(("update_ingredient",owner,id,name,quote,spec))
        return True
    def update_owned_unit(self,owner,id,symbol,dimension,factor,aliases):
        self.calls.append(("update_unit",owner,id,symbol,dimension,factor,aliases))
        return True
    def delete_owned_ingredient_master(self,owner,id):
        self.calls.append(("delete_ingredient",owner,id))
        return True
    def delete_owned_unit_master(self,owner,id):
        self.calls.append(("delete_unit",owner,id))
        return True

class MasterCrudApiTests(unittest.TestCase):
    def setUp(self):
        self.owner=str(uuid4())
        self.repo=MasterRepo()
        app.state.demo_owner_id=self.owner
        app.state.demo_access_token="test-secret"
        app.state.repository_factory=lambda:self.repo
        self.client=TestClient(app)
        self.headers={"X-Demo-Access":"test-secret"}
    def tearDown(self):
        del app.state.demo_owner_id
        del app.state.demo_access_token
        del app.state.repository_factory
        self.client.close()

    def test_supplier_mapping_and_link_use_demo_owner(self):
        ingredients=self.client.get("/demo/ingredients",headers=self.headers)
        self.assertEqual(ingredients.status_code,200)
        self.assertEqual(ingredients.json()["suppliers_by_ingredient"],
                         {"11111111-1111-1111-1111-111111111111": ["A食品"]})
        ingredient=str(uuid4())
        supplier=str(uuid4())
        denied=self.client.post(f"/demo/ingredients/{ingredient}/suppliers",
                                json={"supplier_id":supplier})
        self.assertEqual(denied.status_code,403)
        linked=self.client.post(f"/demo/ingredients/{ingredient}/suppliers",
                                headers=self.headers,
                                json={"supplier_id":supplier})
        self.assertEqual(linked.status_code,201)
        self.assertIn(("link_ingredient_supplier",self.owner,ingredient,supplier),
                      self.repo.calls)

    def test_all_writes_reject_missing_secret_without_repository_access(self):
        id=str(uuid4())
        cases=[("post","/demo/ingredients",{"name":"Flour"}),
               ("put",f"/demo/ingredients/{id}",{"name":"Flour"}),
               ("delete",f"/demo/ingredients/{id}",None),
               ("post","/demo/units",{"symbol":"g","dimension":"mass"}),
               ("put",f"/demo/units/{id}",{"symbol":"g","dimension":"mass","aliases":[]}),
               ("delete",f"/demo/units/{id}",None)]
        for method,path,payload in cases:
            with self.subTest(method=method,path=path):
                response=getattr(self.client,method)(path,**({"json":payload} if payload is not None else {}))
                self.assertEqual(response.status_code,403,response.text)
        self.assertEqual(self.repo.calls,[])

    def test_crud_is_scoped_to_configured_owner(self):
        id=str(uuid4())
        self.assertEqual(self.client.get("/demo/ingredients",headers=self.headers).status_code,200)
        self.assertEqual(self.client.get("/demo/units",headers=self.headers).status_code,200)
        self.assertEqual(self.client.post("/demo/ingredients",json={"name":"Flour"},headers=self.headers).status_code,201)
        self.assertEqual(self.client.post("/demo/units",json={"symbol":"g","dimension":"mass"},headers=self.headers).status_code,201)
        self.assertEqual(self.client.put(f"/demo/ingredients/{id}",json={"name":"Wheat"},headers=self.headers).status_code,200)
        self.assertEqual(self.client.put(f"/demo/units/{id}",json={"symbol":"kg","dimension":"mass","aliases":["kilo"]},headers=self.headers).status_code,200)
        self.assertEqual(self.client.delete(f"/demo/ingredients/{id}",headers=self.headers).status_code,200)
        self.assertEqual(self.client.delete(f"/demo/units/{id}",headers=self.headers).status_code,200)
        self.assertEqual(len(self.repo.calls),9)
        self.assertTrue(all(call[1]==self.owner for call in self.repo.calls))

    def test_specification_is_forwarded_without_becoming_a_price_unit(self):
        ident=str(uuid4())
        self.assertEqual(self.client.post("/demo/ingredients",headers=self.headers,json={"name":"トマト水煮","spec":"1号缶"}).status_code,201)
        self.assertIn(("create_ingredient",self.owner,"トマト水煮","1号缶"),self.repo.calls)
        self.assertEqual(self.client.put(f"/demo/ingredients/{ident}",headers=self.headers,json={"name":"トマト水煮","spec":"6号缶"}).status_code,200)
        self.assertIn(("update_ingredient",self.owner,ident,"トマト水煮",None,"6号缶"),self.repo.calls)

    def test_invalid_payloads_do_not_write(self):
        id=str(uuid4())
        cases=[("post","/demo/ingredients",{"name":""}),
               ("post","/demo/units",{"symbol":"x","dimension":"invalid"}),
               ("put",f"/demo/ingredients/{id}",{"name":"Flour","price_jpy":"100"}),
               ("put",f"/demo/units/{id}",{"symbol":"g","dimension":"mass","aliases":[""]})]
        for method,path,payload in cases:
            with self.subTest(path=path):
                r=getattr(self.client,method)(path,json=payload,headers=self.headers)
                self.assertEqual(r.status_code,422,r.text)
        self.assertEqual(self.repo.calls,[])
