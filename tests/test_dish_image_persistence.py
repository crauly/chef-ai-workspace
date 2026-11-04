"""Owner-scoped generated dish images: auth and validation regressions."""
import base64
import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.demo_api import router

if not any(getattr(route, "path", None) == "/demo/recipes" for route in app.routes):
    app.include_router(router)

PNG = b"\x89PNG\r\n\x1a\n" + b"test-image"
DATA = "data:image/png;base64," + base64.b64encode(PNG).decode()


class DishRepo:
    def __init__(self):
        self.saved = None
        self.owner = None

    def save_owned_dish_image(self, owner, recipe_id, mime, data):
        self.owner = owner
        self.saved = (recipe_id, mime, data)

    def load_owned_dish_image(self, owner, recipe_id):
        self.owner = owner
        if self.saved and self.saved[0] == recipe_id:
            return {"mime_type": self.saved[1], "bytes": self.saved[2]}
        return None


class DishImageTests(unittest.TestCase):
    def setUp(self):
        self.repo = DishRepo()
        self.owner = str(uuid4())
        app.state.demo_owner_id = self.owner
        app.state.demo_access_token = "test-secret-32-characters-long-only"
        app.state.repository_factory = lambda: self.repo
        self.client = TestClient(app)
        self.path = f"/demo/recipes/{uuid4()}/dish-image"
        self.headers = {"X-Demo-Access": "test-secret-32-characters-long-only"}

    def tearDown(self):
        self.client.close()
        del app.state.demo_owner_id
        del app.state.demo_access_token
        del app.state.repository_factory

    def test_access_denied_without_operator_gate(self):
        self.assertEqual(self.client.get(self.path).status_code, 403)
        self.assertEqual(self.client.post(self.path, json={"image": DATA}).status_code, 403)
        self.assertIsNone(self.repo.saved)

    def test_save_then_read_with_trusted_owner(self):
        put = self.client.post(self.path, json={"image": DATA}, headers=self.headers)
        self.assertEqual(put.status_code, 200, put.text)
        self.assertEqual(self.repo.owner, self.owner)
        self.assertEqual(self.repo.saved[1:], ("image/png", PNG))
        get = self.client.get(self.path, headers=self.headers)
        self.assertEqual(get.status_code, 200)
        self.assertEqual(get.json()["image"], DATA)

    def test_accept_valid_jpeg_signature(self):
        jpeg = b"\\xff\\xd8\\xff" + b"test-jpeg"
        data = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        response = self.client.post(self.path, json={"image": data}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.repo.saved[1:], ("image/jpeg", jpeg))

    def test_reject_invalid_image_payload_and_type(self):
        bad = "data:image/jpeg;base64," + base64.b64encode(PNG).decode()
        self.assertEqual(self.client.post(self.path, json={"image": bad}, headers=self.headers).status_code, 422)
        self.assertEqual(self.client.post(self.path, json={"image": "https://example.org/img"}, headers=self.headers).status_code, 422)
        self.assertIsNone(self.repo.saved)

    def test_missing_image_not_misrepresented_as_success(self):
        self.assertEqual(self.client.get(self.path, headers=self.headers).status_code, 404)


if __name__ == "__main__":
    unittest.main()
