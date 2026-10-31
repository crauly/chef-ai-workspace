"""Phase B realtime relay: pure contract tests (no network, no audio).

Run: python -m unittest discover -s tests -v
"""
import unittest
from chef_ai_workspace.voice_realtime import (
    MAX_KEYWORDS, WsTicketStore, backlog_exceeded, build_handshake,
    build_keywords, build_language_bias,
)


class LanguageBiasTests(unittest.TestCase):
    def test_english_base_japanese_formal(self):
        self.assertEqual(build_language_bias("en"), ["English", "Japanese"])
        self.assertEqual(build_language_bias("ja"), ["Japanese", "English"])
        self.assertEqual(build_language_bias("it"), ["English", "Japanese"])
        self.assertNotIn("Italian", build_language_bias("ja"))


class KeywordTests(unittest.TestCase):
    def test_owned_rows_and_context_without_new_store(self):
        rows = [{"name": "乾燥パスタ", "supplier_name": "  日清  ", "brand": "日清"},
                {"name": "乾燥パスタ"}, {"name": "x"}]
        keywords = build_keywords(rows, ["アマトリチャーナ", "乾燥パスタ"])
        self.assertIn("乾燥パスタ", keywords)
        self.assertIn("日清", keywords)
        self.assertIn("アマトリチャーナ", keywords)
        self.assertNotIn("x", keywords)
        self.assertEqual(len(keywords), len(set(keywords)))
        self.assertEqual(build_keywords([], []), [])
        self.assertEqual(build_keywords(None, None), [])

    def test_cap_is_conservative(self):
        rows = [{"name": "食材%03d" % index} for index in range(200)]
        self.assertEqual(len(build_keywords(rows, [])), MAX_KEYWORDS)


class HandshakeTests(unittest.TestCase):
    def test_shape_session_fixed(self):
        handshake = build_handshake("secret-key", "ja", ["乾燥パスタ"])
        self.assertEqual(handshake["authorization"], {"accessToken": "Bearer secret-key"})
        self.assertEqual(handshake["mode"], "ENDPOINTING")
        self.assertEqual(handshake["audioEncoding"], "PCM_24KHZ")
        self.assertEqual(handshake["languageBias"], ["Japanese", "English"])
        self.assertEqual(handshake["keywords"], ["乾燥パスタ"])
        self.assertNotIn("keywords", build_handshake("secret-key", "en", []))


class TicketTests(unittest.TestCase):
    def test_single_use_and_expiry(self):
        now = [1000.0]
        store = WsTicketStore(ttl_s=60, now=lambda: now[0])
        ticket = store.issue("owner-1", "ja", ["a"])
        self.assertEqual(ticket.locale, "ja")
        self.assertIsNotNone(store.consume(ticket.token))
        self.assertIsNone(store.consume(ticket.token))
        expired = store.issue("owner-1", "en", [])
        now[0] += 61
        self.assertIsNone(store.consume(expired.token))


class BacklogTests(unittest.TestCase):
    def test_five_second_limit(self):
        self.assertTrue(backlog_exceeded(5 * 24000 * 2 + 2))
        self.assertFalse(backlog_exceeded(5 * 24000 * 2))


if __name__ == "__main__":
    unittest.main()


class WsTicketEndpointTests(unittest.TestCase):
    """Ticket issuance through the shared demo app (no network, no Meta)."""

    def test_issue_and_single_use(self):
        from fastapi.testclient import TestClient
        from chef_ai_workspace.api import app
        from chef_ai_workspace import voice_realtime as realtime

        saved = {name: getattr(app.state, name, None)
                 for name in ("demo_owner_id", "demo_access_token",
                              "repository_factory", "ws_ticket_store")}
        app.state.demo_owner_id = "00000000-0000-4000-8000-000000000001"
        app.state.demo_access_token = "test-only-backend-token-1234567890"

        class FakeRepo:
            def search_owned_ingredients(self, owner, query, limit=20):
                return [{"name": "乾燥パスタ"}]

        app.state.repository_factory = lambda: FakeRepo()
        store = realtime.WsTicketStore(ttl_s=120)
        app.state.ws_ticket_store = store
        try:
            client = TestClient(app)
            good = {"X-Demo-Access": "test-only-backend-token-1234567890"}
            response = client.post("/demo/ws-ticket", headers=good,
                                   json={"locale": "ja",
                                         "context_terms": ["パスタ"]})
            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertIn("ticket", body)
            self.assertEqual(body["locale"], "ja")
            self.assertIn("乾燥パスタ", body["keywords"])
            # Ticket is single-use at the store level.
            self.assertIsNotNone(store.consume(body["ticket"]))
            self.assertIsNone(store.consume(body["ticket"]))
            denied = client.post("/demo/ws-ticket",
                                 headers={"X-Demo-Access": "wrong"},
                                 json={"locale": "ja"})
            self.assertEqual(denied.status_code, 403)
        finally:
            for name, value in saved.items():
                if value is None and hasattr(app.state, name):
                    delattr(app.state, name)
                elif value is not None:
                    setattr(app.state, name, value)


if __name__ == "__main__":
    unittest.main()
