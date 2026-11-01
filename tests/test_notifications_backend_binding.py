"""Notifications routes must prefer the Vercel Services internal binding.

Public Vercel provides CHEF_FASTAPI_INTERNAL_URL via vercel.json bindings.
FASTAPI_BASE_URL fallback is loopback-only (local mock), mirroring proxy.ts.
Production must never fall back to an arbitrary Render origin.

The backend origin allow-list lives in web/app/api/backend-url.ts (shared
SSOT): https anywhere, loopback http, and the configured internal binding
host over http (Render private address / Vercel service mesh). Route files
must reuse it instead of carrying their own copies.
"""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
HELPER = ROOT / "web/app/api/backend-url.ts"
COLLECTION = ROOT / "web/app/api/notifications/route.ts"
MEMBER = ROOT / "web/app/api/notifications/[id]/route.ts"
VOICE_RECIPE = ROOT / "web/app/api/voice-recipe/route.ts"


class NotificationsBackendBindingTests(unittest.TestCase):
    def read(self, path):
        return path.read_text(encoding="utf-8")

    def test_helper_is_the_allow_list_ssot(self):
        src = self.read(HELPER)
        self.assertIn("CHEF_FASTAPI_INTERNAL_URL", src)
        self.assertIn("http://127.0.0.1:", src)
        self.assertIn("http://localhost:", src)
        self.assertIn("LOOPBACK", src)
        self.assertIn("username", src)

    def test_routes_reuse_the_shared_helper(self):
        for path in (COLLECTION, MEMBER, VOICE_RECIPE):
            with self.subTest(path=str(path)):
                src = self.read(path)
                self.assertIn("backend-url", src)
                self.assertIn("backendUrl", src)

    def test_no_duplicate_allow_list_in_routes(self):
        for path in (COLLECTION, MEMBER, VOICE_RECIPE):
            with self.subTest(path=str(path)):
                src = self.read(path)
                self.assertNotIn("127.0.0.1", src)
                self.assertNotIn("FASTAPI_BASE_URL", src)


if __name__ == "__main__":
    unittest.main()
