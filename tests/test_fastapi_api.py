import unittest
from uuid import uuid4

try:
    from fastapi.testclient import TestClient
    from chef_ai_workspace.api import app
except ImportError:
    TestClient = None

@unittest.skipIf(TestClient is None, "FastAPI test dependencies absent")
class APITests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.user = str(uuid4())
        app.state.verify_token = lambda token: self.user if token == "valid" else None
        app.state.repository_factory = lambda: object()

    def tearDown(self):
        del app.state.verify_token
        del app.state.repository_factory

    def test_health(self):
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_missing_token_rejected(self):
        self.assertEqual(self.client.post(
            f"/recipes/{uuid4()}/confirm", json={}).status_code, 401)

    def test_invalid_token_rejected(self):
        self.assertEqual(self.client.post(
            f"/recipes/{uuid4()}/confirm",
            headers={"Authorization": "Bearer invalid"}, json={}).status_code, 401)

    def test_untrusted_payload_rejected(self):
        self.assertEqual(self.client.post(
            f"/recipes/{uuid4()}/confirm",
            headers={"Authorization": "Bearer valid"},
            json={"base_revision": 0, "request_id": str(uuid4()),
                  "operations": [{"op":"set_title","value":"Soup"}],
                  "owner_id": str(uuid4())}).status_code, 422)

if __name__ == "__main__":
    unittest.main()
