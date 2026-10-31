"""Notifications routes must prefer the Vercel Services internal binding.

Public Vercel provides CHEF_FASTAPI_INTERNAL_URL via vercel.json bindings.
FASTAPI_BASE_URL fallback is loopback-only (local mock), mirroring proxy.ts.
Production must never fall back to an arbitrary Render origin.
"""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
COLLECTION = ROOT / "web/app/api/notifications/route.ts"
MEMBER = ROOT / "web/app/api/notifications/[id]/route.ts"


class NotificationsBackendBindingTests(unittest.TestCase):
    def read(self, path):
        return path.read_text(encoding="utf-8")

    def test_collection_prefers_internal_binding(self):
        src = self.read(COLLECTION)
        self.assertIn("CHEF_FASTAPI_INTERNAL_URL", src)
        self.assertIn("http://127.0.0.1:", src)
        self.assertIn("http://localhost:", src)

    def test_member_prefers_internal_binding(self):
        src = self.read(MEMBER)
        self.assertIn("CHEF_FASTAPI_INTERNAL_URL", src)
        self.assertIn("http://127.0.0.1:", src)
        self.assertIn("http://localhost:", src)

    def test_no_direct_render_fallback(self):
        for path in (COLLECTION, MEMBER):
            with self.subTest(path=str(path)):
                src = self.read(path)
                # Must not resolve FASTAPI_BASE_URL unconditionally.
                self.assertNotIn("process.env.FASTAPI_BASE_URL,token", src)
                self.assertNotIn("const base=process.env.FASTAPI_BASE_URL", src)


if __name__ == "__main__":
    unittest.main()
