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

    def test_empty_string_prices_rejected_not_zero_filled(self):
        # The voice UI must normalize missing prices to null before saving;
        # raw empty strings are explicit input errors, never silent zeroes.
        body = self.payload()
        body["materials"][1] = {"name": "卵", "quantity": "100", "unit": "g",
                                "price_jpy": "", "price_quantity": "",
                                "price_unit": ""}
        response = self.client.post("/demo/recipes/full", json=body, headers=self.headers)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.repo.writes, 0)

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
