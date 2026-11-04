import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app


class Repository:
    def __init__(self):
        self.stored = {}
        self.snapshots = {}
        self.catalog = {}
        self.writes = 0
        self.ingredients = {}
    def load_owned_recipe(self, owner_id, recipe_id):
        key = (owner_id, recipe_id)
        if key not in self.stored:
            raise ValueError("Not found")
        return self.stored[key]
    def list_owned_units(self, owner_id):
        return [{"id": f"unit-{symbol}", "symbol": symbol, "dimension": "other", "aliases": []}
                for symbol in ("g", "kg", "ml", "L")]
    def find_owned_ingredients_exact(self, owner_id, name):
        return [{"id":id,"name":v.name} for id,v in self.ingredients.items()
                if v.name.casefold()==name.casefold()]
    def load_owned_ingredients(self, owner_id, ids):
        return {id:self.ingredients[id] for id in ids if id in self.ingredients}
    def create_owned_recipe(self, owner_id, recipe, snapshot, unit_candidates=(), ingredient_entries=()):
        from chef_ai_workspace.models import Ingredient
        from chef_ai_workspace.supabase_adapter import _quote
        for entry in ingredient_entries:
            existing=self.ingredients.get(entry["id"])
            current=_quote(entry["current_price"]) if entry["current_price"] else (
                existing.current_price if existing else None)
            self.ingredients[entry["id"]]=Ingredient(entry["id"],entry["name"],current)
        key = (owner_id, recipe.id)
        if key in self.stored:
            raise ValueError("Duplicate")
        assert "total_cost_jpy" in snapshot
        self.stored[key] = recipe
        self.snapshots[key] = snapshot
        self.writes += 1
        self.unit_candidates = tuple(unit_candidates)


class VoiceFullRecipeTests(unittest.TestCase):
    def setUp(self):
        self.repo = Repository()
        self.owner = str(uuid4())
        app.state.demo_owner_id = self.owner
        app.state.demo_access_token = "test-long-demo-operator-secret"
        app.state.repository_factory = lambda: self.repo
        self.client = TestClient(app)
        self.headers = {"X-Demo-Access": "test-long-demo-operator-secret"}

    def tearDown(self):
        self.client.close()
        del app.state.demo_owner_id
        del app.state.demo_access_token
        del app.state.repository_factory

    def payload(self):
        return {
            "request_id": str(uuid4()),
            "title": "カルボナーラ",
            "materials": [
                {"name": "グアンチャーレ", "quantity": "80", "unit": "g",
                 "price_jpy": "1500", "price_quantity": "1", "price_unit": "kg"},
                {"name": "卵", "quantity": "100", "unit": "g",
                 "price_jpy": "60", "price_quantity": "50", "price_unit": "g"},
            ],
            "selling_price_jpy": "2200"
        }

    def test_new_unit_is_proposed_only_in_approved_recipe_save(self):
        body = self.payload()
        body["materials"] = [{
            "name": "香草", "quantity": "2", "unit": "束",
            "price_jpy": "300", "price_quantity": "1", "price_unit": "束",
        }]
        body["unit_candidates"] = [{"symbol": "束", "dimension": "count"}]
        response = self.client.post("/demo/recipes/full", json=body, headers=self.headers)
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(self.repo.unit_candidates,
                         ({"symbol": "束", "dimension": "count"},))
        self.assertEqual(self.repo.writes, 1)

    def test_unknown_unit_without_approved_candidate_cannot_save(self):
        body = self.payload()
        body["materials"][0]["unit"] = "束"
        response = self.client.post("/demo/recipes/full", json=body, headers=self.headers)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.repo.writes, 0)

    def test_full_recipe_requires_authorized_session(self):
        response = self.client.post("/demo/recipes/full", json=self.payload())
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.repo.writes, 0)

    def test_full_recipe_is_single_create_with_materials_and_price(self):
        response = self.client.post("/demo/recipes/full", json=self.payload(), headers=self.headers)
        self.assertEqual(response.status_code, 201, response.text)
        recipe = response.json()
        self.assertEqual(recipe["title"]["value"], "カルボナーラ")
        self.assertEqual(len(recipe["materials"]), 2)
        self.assertEqual(recipe["materials"][0]["material_name"]["value"], "グアンチャーレ")
        self.assertEqual(recipe["selling_price_jpy"]["value"], "2200")
        self.assertEqual(recipe["revision"], 0)
        self.assertEqual(self.repo.writes, 1)

    def test_exact_request_retry_does_not_duplicate(self):
        payload = self.payload()
        first = self.client.post("/demo/recipes/full", json=payload, headers=self.headers)
        second = self.client.post("/demo/recipes/full", json=payload, headers=self.headers)
        self.assertEqual(first.status_code, 201, first.text)
        self.assertEqual(second.status_code, 201, second.text)
        self.assertEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(self.repo.writes, 1)

    def test_unconfirmed_save_with_missing_prices_stays_partial(self):
        # Voice unconfirmed scenario: unknown prices arrive as null (the UI
        # normalizes missing strings), lines store no override, and the cost
        # stays partial with a null total -- never zero-filled or guessed.
        body = self.payload()
        body["materials"][1] = {"name": "卵", "quantity": "100", "unit": "g",
                                "price_jpy": None, "price_quantity": None,
                                "price_unit": None}
        response = self.client.post("/demo/recipes/full", json=body, headers=self.headers)
        self.assertEqual(response.status_code, 201, response.text)
        recipe = response.json()
        line = [m for m in recipe["materials"]
                if m["material_name"]["value"] == "卵"][0]
        self.assertIsNone(line["price_override"])
        snapshot = self.repo.snapshots[(self.owner, recipe["id"])]
        self.assertTrue(snapshot["partial"])
        self.assertIsNone(snapshot["total_cost_jpy"])
        self.assertIn(line["id"], snapshot["unresolved_line_ids"])
        self.assertEqual(self.repo.writes, 1)

    def test_empty_string_prices_normalize_to_unresolved_not_zero(self):
        # Empty optional fields have the same unresolved meaning at the API boundary.
        body = self.payload()
        body["materials"][1] = {"name": "卵", "quantity": "100", "unit": "g",
                                "price_jpy": "", "price_quantity": "",
                                "price_unit": ""}
        response = self.client.post("/demo/recipes/full", json=body, headers=self.headers)
        self.assertEqual(response.status_code, 201, response.text)
        self.assertIsNone(response.json()["materials"][1]["effective_price"])
        self.assertEqual(self.repo.writes, 1)

    def test_known_price_can_save_without_usage_and_retry_does_not_duplicate(self):
        body=self.payload();body['materials'][0].update(quantity=None,unit=None,price_jpy='１，５００.００')
        review=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(review.status_code,200,review.text);self.assertEqual(self.repo.writes,0)
        self.assertEqual(review.json()['materials'][0]['price_jpy'],'1500')
        response=self.client.post('/demo/recipes/full',json=body,headers=self.headers)
        self.assertEqual(response.status_code,201,response.text)
        line=response.json()['materials'][0]
        self.assertIsNone(line['quantity']['value']);self.assertEqual(line['quantity']['status'],'unresolved')
        self.assertEqual(line['effective_price']['amount_jpy']['value'],'1500')
        self.client.post('/demo/recipes/full',json=body,headers=self.headers);self.assertEqual(self.repo.writes,1)

    def test_review_reports_field_errors_and_service_outages(self):
        body=self.payload();body['materials'][0]['unit']=None
        response=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(response.status_code,422,response.text)
        self.assertEqual(response.json()['detail'][0]['loc'],['body','materials',0,'quantity'])
        body=self.payload();body['materials'][0]['price_quantity']='0'
        response=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(response.status_code,422,response.text);self.assertEqual(response.json()['detail'][0]['loc'],['body','materials',0,'price_quantity'])
        self.repo.list_owned_units=lambda owner:(_ for _ in ()).throw(RuntimeError('private service detail'))
        response=self.client.post('/demo/recipes/full/review',json=self.payload(),headers=self.headers)
        self.assertEqual(response.status_code,503);self.assertNotIn('private',response.text)
        self.assertEqual(self.repo.writes,0)

    def test_invalid_numbers_fail_before_database_write(self):
        for quantity in ["abc", "-10", "NaN"]:
            with self.subTest(quantity=quantity):
                body = self.payload()
                body["materials"][0]["quantity"] = quantity
                response = self.client.post("/demo/recipes/full", json=body, headers=self.headers)
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.repo.writes, 0)

    def test_unknown_fields_and_units_rejected(self):
        body = self.payload()
        body["owner_id"] = str(uuid4())
        self.assertEqual(self.client.post("/demo/recipes/full", json=body, headers=self.headers).status_code, 422)
        body = self.payload()
        body["materials"][0]["unit"] = "pinch"
        self.assertEqual(self.client.post("/demo/recipes/full", json=body, headers=self.headers).status_code, 422)
        self.assertEqual(self.repo.writes, 0)

    def test_review_is_read_only_then_commit_reuses_master(self):
        body = self.payload()
        response = self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.repo.writes,0)
        self.assertEqual(len(self.repo.ingredients),0)
        self.assertTrue(all(m['action']=='create' for m in response.json()['ingredients']))
        saved=self.client.post('/demo/recipes/full',json=body,headers=self.headers)
        self.assertEqual(saved.status_code,201,saved.text)
        body['request_id']=str(uuid4())
        again=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(again.status_code,200,again.text)
        self.assertTrue(all(m['action']=='reuse' for m in again.json()['ingredients']))
        self.assertEqual(self.repo.writes,1)

    def test_similarity_only_creates_a_distinct_master_and_retries_once(self):
        from chef_ai_workspace.models import Ingredient,PriceQuote,TrackedValue
        from chef_ai_workspace.ingredient_assist import match_recipe_master
        old_id=str(uuid4())
        old=Ingredient(old_id,"自家製グアンチャーレ",PriceQuote(TrackedValue("999","confirmed","user"),"1","kg","manual"))
        self.repo.ingredients[old_id]=old
        self.repo.list_owned_ingredient_master=lambda owner:[{"id":old_id,"name":old.name}]
        body=self.payload();body["materials"]=body["materials"][:1]
        review=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(review.status_code,200,review.text)
        self.assertEqual(review.json()['ingredients'][0]['action'],'create')
        self.assertEqual(self.repo.writes,0)
        saved=self.client.post('/demo/recipes/full',json=body,headers=self.headers)
        self.assertEqual(saved.status_code,201,saved.text)
        line=saved.json()['materials'][0]
        self.assertNotEqual(line['ingredient_id'],old_id)
        self.assertEqual(self.repo.ingredients[old_id],old)
        self.assertEqual(self.repo.ingredients[line['ingredient_id']].current_price.amount_jpy.value,'1500')
        again=self.client.post('/demo/recipes/full',json=body,headers=self.headers)
        self.assertEqual(again.status_code,201,again.text);self.assertEqual(self.repo.writes,1)
        self.assertEqual(again.json()['materials'][0]['ingredient_id'],line['ingredient_id'])
        self.assertEqual(match_recipe_master(self.owner,self.repo,'自家製グアンチャーレ薄切り')['action'],'choose')

    def test_spec_filtered_similarity_does_not_block_registration(self):
        from chef_ai_workspace.models import Ingredient
        old_id=str(uuid4());self.repo.ingredients[old_id]=Ingredient(old_id,'グアンチャーレ',None)
        row={"id":old_id,"name":"グアンチャーレ","spec":"旧規格"}
        self.repo.find_owned_ingredients_exact=lambda owner,name:[row]
        self.repo.list_owned_ingredient_master=lambda owner:[row]
        body=self.payload();body['materials']=body['materials'][:1];body['materials'][0]['spec']='新規格'
        result=self.client.post('/demo/recipes/full',json=body,headers=self.headers)
        self.assertEqual(result.status_code,201,result.text)
        self.assertNotEqual(result.json()['materials'][0]['ingredient_id'],old_id)

    def test_shared_matcher_owns_policy_without_repeated_exact_lookup(self):
        from chef_ai_workspace.ingredient_assist import match_recipe_master
        from unittest.mock import Mock
        self.repo.find_owned_ingredients_exact=Mock(return_value=[])
        self.repo.list_owned_ingredient_master=Mock(return_value=[{"id":str(uuid4()),"name":"自家製グアンチャーレ"}])
        registration=match_recipe_master(self.owner,self.repo,'グアンチャーレ',similarity_action='create')
        self.assertEqual(registration['action'],'create')
        self.assertIsNone(registration['ingredient_id'])
        self.repo.find_owned_ingredients_exact.assert_called_once_with(self.owner,'グアンチャーレ')
        self.repo.list_owned_ingredient_master.assert_not_called()
        editing=match_recipe_master(self.owner,self.repo,'グアンチャーレ')
        self.assertEqual(editing['action'],'choose')
        self.assertIsNone(editing['ingredient_id'])
        self.assertEqual(len(editing['candidates']),1)

    def test_exact_duplicate_still_rejects_save_without_writing(self):
        self.repo.find_owned_ingredients_exact=lambda owner,name:[{'id':'a'},{'id':'b'}]
        result=self.client.post('/demo/recipes/full',json=self.payload(),headers=self.headers)
        self.assertEqual(result.status_code,409,result.text)
        self.assertEqual(self.repo.writes,0)

    def test_review_duplicate_master_and_invalid_quantity_never_write(self):
        body=self.payload()
        self.repo.find_owned_ingredients_exact=lambda owner,name:[{'id':'a'},{'id':'b'}]
        response=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertTrue(all(m["action"]=="choose" for m in response.json()["ingredients"]))
        self.assertEqual(self.repo.writes,0)
        body['materials'][0]['quantity']='NaN'
        response=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(response.status_code,422,response.text)
        self.assertEqual(self.repo.writes,0)

    def test_matching_saved_request_can_be_reviewed_and_retried_without_writing(self):
        import copy
        body=self.payload()
        saved=self.client.post('/demo/recipes/full',json=body,headers=self.headers)
        self.assertEqual(saved.status_code,201,saved.text)
        from chef_ai_workspace.demo_api import CompleteRecipeBody
        expected=CompleteRecipeBody.model_validate(copy.deepcopy(body)).model_dump(mode="json")
        def verify(owner, recipe_id, payload):
            if payload != expected: raise ValueError("conflicting retry")
        self.repo.verify_owned_creation_payload=verify
        review=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(review.status_code,200,review.text)
        self.assertTrue(review.json()['already_saved'])
        retry=self.client.post('/demo/recipes/full',json=body,headers=self.headers)
        self.assertEqual(retry.status_code,201,retry.text)
        self.assertEqual(self.repo.writes,1)
        body['materials'][0]['quantity']='999'
        conflict=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(conflict.status_code,409,conflict.text)
        self.assertEqual(self.repo.writes,1)

    def test_package_terms_distinguish_quotes_and_same_terms_still_conflict(self):
        body=self.payload()
        body['materials']=[
            {"name":"パスタ","quantity":"100","unit":"g","supplier":"スーパーA",
             "price_jpy":"600","price_quantity":"500","price_unit":"g"},
            {"name":"パスタ","quantity":"100","unit":"g","supplier":"スーパーA",
             "price_jpy":"1000","price_quantity":"1","price_unit":"kg"}]
        self.repo.create_owned_procured_recipe=lambda *args,**kwargs:None
        self.repo.list_owned_suppliers=lambda *args,**kwargs:[]
        review=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(review.status_code,200,review.text)
        body['materials'][1].update(price_quantity='500.0',price_unit='g')
        conflict=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(conflict.status_code,422,conflict.text)
        body['materials'][1]['price_jpy']='600.00'
        same=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers)
        self.assertEqual(same.status_code,200,same.text)
        self.assertEqual(self.repo.writes,0)


if __name__ == "__main__":
    unittest.main()
