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
    def delete_owned_recipe(self, owner, recipe_id):
        self.calls.append(("delete",owner,recipe_id))
        return True
    def create_owned_recipe(self, owner, recipe, snapshot):
        self.created.append((owner,recipe,snapshot))
    def list_owned_recipes(self, owner, *, offset, limit, search=""):
        self.calls.append((owner,offset,limit))
        self.search = search
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
    def test_edit_model_receives_only_owned_supplier_ids_and_can_propose_unpriced_material(self):
        import io,json
        from unittest.mock import patch
        from chef_ai_workspace.meta_responses import MetaResponsesProvider
        from chef_ai_workspace.mutations import prepare_mutation
        from chef_ai_workspace.mutations import Proposal
        rid,mid,sid=str(uuid4()),str(uuid4()),str(uuid4())
        calls=[]
        def suppliers(owner,*,limit,offset):
            calls.append((owner,offset))
            return [{"id":sid,"name":"東京市場","private_note":"do not send"}]
        self.repo.list_owned_suppliers=suppliers
        operations=[{"op":"add_unpriced_material","material_id":mid,"name":"卵"},
                    {"op":"set_material_supplier","material_id":mid,"supplier_id":sid}]
        raw={"status":"completed","output":[{"type":"message","role":"assistant","status":"completed",
             "content":[{"type":"output_text","text":json.dumps({"operations":operations})}]}]}
        previous=getattr(app.state,"ai_provider",None)
        app.state.ai_provider=MetaResponsesProvider("test-key")
        try:
            with patch("urllib.request.OpenerDirector.open",return_value=io.BytesIO(json.dumps(raw).encode())) as call:
                result=self.client.post(f"/demo/recipes/{rid}/propose",json={"instruction":"東京市場の卵を追加。数量と価格は未定"},headers={"X-Demo-Access":"a-secret-known-only-to-presenter"})
            self.assertEqual(result.status_code,200,result.text)
            sent=json.loads(json.loads(call.call_args.args[0].data)["input"])["recipe"]
            self.assertEqual(sent["supplier_candidates"],[{"id":sid,"name":"東京市場"}])
            self.assertEqual(calls,[(self.owner,0)])
            self.assertEqual(result.json()["supplier_names"],{sid:"東京市場"})
            proposed=prepare_mutation(self.repo.load_owned_recipe(self.owner,rid),Proposal(rid,0,str(uuid4()),tuple(result.json()["operations"])),user_confirmed=False)
            self.assertIsNone(proposed.materials[0].quantity.value)
            self.assertIsNone(proposed.materials[0].price_override)
            self.assertEqual(proposed.materials[0].supplier_id,sid)
        finally:
            if previous is None:del app.state.ai_provider
            else:app.state.ai_provider=previous

    def test_recipe_deletion_requires_demo_auth_and_scopes_to_owner(self):
        rid=str(uuid4())
        denied=self.client.delete(f"/demo/recipes/{rid}")
        self.assertEqual(denied.status_code,403)
        self.assertEqual(self.repo.calls,[])
        accepted=self.client.delete(f"/demo/recipes/{rid}",
            headers={"X-Demo-Access":"a-secret-known-only-to-presenter"})
        self.assertEqual(accepted.status_code,200)
        self.assertEqual(accepted.json(),{"deleted":True})
        self.assertEqual(self.repo.calls,[("delete",self.owner,rid)])

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

    def test_search_is_scoped_and_validated_before_repository_access(self):
        headers={"X-Demo-Access":"a-secret-known-only-to-presenter"}
        response=self.client.get("/demo/recipes",params={"q":" 片栗粉 ","page":2},headers=headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.repo.search,"片栗粉")
        self.assertEqual(self.repo.calls,[(self.owner,20,20)])
        self.repo.calls=[]
        self.assertEqual(self.client.get("/demo/recipes",params={"q":"x"*201},headers=headers).status_code,422)
        self.assertEqual(self.repo.calls,[])

if __name__=="__main__": unittest.main()

class SaveBoundaryContractTests(unittest.TestCase):
    """The approved body preserves a supplier name; IDs are resolved server-side."""

    def test_material_with_supplier_is_accepted_for_atomic_save(self):
        from chef_ai_workspace.demo_api import CompleteRecipeBody
        body = {"request_id": str(uuid4()), "title": "ペペロンチーノ",
                "materials": [{"name": "パスタ", "quantity": "100", "unit": "g",
                               "price_jpy": "350", "price_quantity": "500",
                               "price_unit": "g", "supplier": "築地場外"}]}
        parsed = CompleteRecipeBody.model_validate(body)
        self.assertEqual(parsed.materials[0].supplier, "築地場外")

    def test_projected_material_without_supplier_is_accepted(self):
        from chef_ai_workspace.demo_api import CompleteRecipeBody
        body = {"request_id": str(uuid4()), "title": "ペペロンチーノ",
                "materials": [{"name": "パスタ", "quantity": "100", "unit": "g",
                               "price_jpy": "350", "price_quantity": "500",
                               "price_unit": "g"}]}
        self.assertEqual(CompleteRecipeBody.model_validate(body).title, "ペペロンチーノ")
