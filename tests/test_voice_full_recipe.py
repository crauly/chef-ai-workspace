import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app


class Repository:
    def __init__(self):
        self.stored = {}
        self.writes = 0
    def load_owned_recipe(self, owner_id, recipe_id):
        key = (owner_id, recipe_id)
        if key not in self.stored:
            raise ValueError("Not found")
        return self.stored[key]
    def create_owned_recipe(self, owner_id, recipe, snapshot):
        key = (owner_id, recipe.id)
        if key in self.stored:
            raise ValueError("Duplicate")
        assert "total_cost_jpy" in snapshot
        self.stored[key] = recipe
        self.writes += 1


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
        self.assertEqual(recipe["revision"], 1)
        self.assertEqual(self.repo.writes, 1)

    def test_exact_request_retry_does_not_duplicate(self):
        payload = self.payload()
        first = self.client.post("/demo/recipes/full", json=payload, headers=self.headers)
        second = self.client.post("/demo/recipes/full", json=payload, headers=self.headers)
        self.assertEqual(first.status_code, 201, first.text)
        self.assertEqual(second.status_code, 201, second.text)
        self.assertEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(self.repo.writes, 1)

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


if __name__ == "__main__":
    unittest.main()
