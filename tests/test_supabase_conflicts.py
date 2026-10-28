"""Late database conflicts must use the same 409 boundary as preparation conflicts."""
import unittest
from dataclasses import asdict
from types import SimpleNamespace
from uuid import uuid4
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from chef_ai_workspace.api import app
from chef_ai_workspace.models import Recipe, TrackedValue
from chef_ai_workspace.supabase_adapter import SupabasePersistence


class Query:
    def __init__(self, data=None, error=None):
        self.data, self.error = data, error
    def select(self, *args): return self
    def eq(self, *args): return self
    def single(self): return self
    def limit(self, *args): return self
    def execute(self):
        if self.error: raise self.error
        return SimpleNamespace(data=self.data)


class SupabaseConflictTests(unittest.TestCase):
    def setUp(self):
        self.owner, self.rid = str(uuid4()), str(uuid4())
        self.recipe = Recipe(self.rid, TrackedValue("Before", "confirmed", "user"))
        self.error = None
        self.calls = 0
        app.state.verify_token = lambda token: self.owner
        app.state.repository_factory = lambda: SupabasePersistence(self)
        self.api = TestClient(app, raise_server_exceptions=False)

    def tearDown(self):
        self.api.close()
        del app.state.verify_token
        del app.state.repository_factory

    def table(self, name):
        return Query({"state": asdict(self.recipe)} if name == "recipes" else [])

    def rpc(self, name, params):
        self.assertEqual(name, "commit_recipe_revision")
        self.calls += 1
        return Query(error=self.error)

    def post(self):
        return self.api.post(f"/recipes/{self.rid}/confirm",
            headers={"Authorization": "Bearer test-user-token"},
            json={"base_revision": 0, "request_id": str(uuid4()),
                  "operations": [{"op": "set_title", "value": "After"}], "save_version": True})

    def test_late_stale_revision_is_http_conflict(self):
        self.error = APIError({"code": "P0001", "message": "Stale recipe revision", "details": None, "hint": None})
        response = self.post()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "Stale recipe revision")
        self.assertEqual(self.calls, 1)  # Reached the RPC after successful preparation.
        self.assertEqual(self.recipe.revision, 0)

    def test_concurrent_request_id_payload_collision_is_http_conflict(self):
        self.error = APIError({"code": "P0001", "message": "Request ID reused with a different mutation", "details": None, "hint": None})
        self.assertEqual(self.post().status_code, 409)
        self.assertEqual(self.calls, 1)

    def test_other_database_errors_are_not_mislabeled_as_conflicts(self):
        for code, message in [("42501", "permission denied"), ("P0001", "Missing cost snapshot"),
                              ("23505", "duplicate key"), ("XX000", "Stale recipe revision")]:
            with self.subTest(code=code, message=message):
                self.error = APIError({"code": code, "message": message, "details": None, "hint": None})
                self.assertEqual(self.post().status_code, 500)
                with self.assertRaises(APIError) as caught:
                    SupabasePersistence(self).commit_recipe_revision(owner_id=self.owner,
                        recipe_id=self.rid, request_id=str(uuid4()), base_revision=0,
                        state=asdict(self.recipe), title="After", cost_snapshot={},
                        payload_hash="test", save_version=True)
                self.assertIs(caught.exception, self.error)
