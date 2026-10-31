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


class WsAuthTests(unittest.TestCase):
    """Unauthenticated and replayed realtime connections are refused."""

    def _client(self):
        import os
        from fastapi.testclient import TestClient
        from chef_ai_workspace.api import app
        from chef_ai_workspace import voice_realtime as realtime
        saved = {name: getattr(app.state, name, None)
                 for name in ("demo_owner_id", "demo_access_token",
                              "repository_factory", "ws_ticket_store",
                              "model_api_key", "meta_api_key")}
        saved_env = os.environ.pop("MODEL_API_KEY", None)
        saved["_env_MODEL_API_KEY"] = saved_env
        app.state.demo_owner_id = "00000000-0000-4000-8000-000000000001"
        app.state.demo_access_token = "test-only-backend-token-1234567890"

        class FakeRepo:
            def search_owned_ingredients(self, owner, query, limit=20):
                return []

        app.state.repository_factory = lambda: FakeRepo()
        app.state.ws_ticket_store = realtime.WsTicketStore(ttl_s=120)
        return TestClient(app), app, saved

    def _restore(self, app, saved):
        import os
        previous_key = saved.pop("_env_MODEL_API_KEY", None)
        if previous_key is None:
            os.environ.pop("MODEL_API_KEY", None)
        else:
            os.environ["MODEL_API_KEY"] = previous_key
        for name, value in saved.items():
            if value is None and hasattr(app.state, name):
                delattr(app.state, name)
            elif value is not None:
                setattr(app.state, name, value)

    def test_connect_without_ticket_refused(self):
        from starlette.websockets import WebSocketDisconnect
        client, app, saved = self._client()
        try:
            with client.websocket_connect("/demo/voice-realtime") as ws:
                ws.send_text("{}")
                with self.assertRaises(WebSocketDisconnect) as raised:
                    ws.receive_text()
            self.assertEqual(raised.exception.code, 4401)
        finally:
            self._restore(app, saved)

    def test_ticket_replay_refused(self):
        from starlette.websockets import WebSocketDisconnect
        client, app, saved = self._client()
        try:
            good = {"X-Demo-Access": "test-only-backend-token-1234567890"}
            first = client.post("/demo/ws-ticket", headers=good,
                                json={"locale": "en"}).json()["ticket"]
            # First use consumes the ticket; the relay then reports the demo
            # backend as unavailable (no MODEL_API_KEY in tests) instead of
            # an auth failure.
            with client.websocket_connect("/demo/voice-realtime") as ws:
                ws.send_text('{"ticket": "%s"}' % first)
                body = ws.receive_text()
                self.assertIn("realtime_unavailable", body)
            # Replay of the consumed ticket is an auth failure.
            with client.websocket_connect("/demo/voice-realtime") as again:
                again.send_text('{"ticket": "%s"}' % first)
                with self.assertRaises(WebSocketDisconnect) as raised:
                    again.receive_text()
            self.assertEqual(raised.exception.code, 4401)
        finally:
            self._restore(app, saved)


    def test_relay_drains_final_transcript_after_end_stream(self):
        """endStream -> Meta's final speechComplete is forwarded, then close.

        The Meta upstream is faked (no network); the browser side is the
        TestClient websocket. Proves the relay does not cut the final turn.
        """
        import asyncio
        import json
        from unittest import mock
        from starlette.websockets import WebSocketDisconnect
        client, app, saved = self._client()
        try:
            app.state.model_api_key = "fixture-key"
            store = app.state.ws_ticket_store
            ticket = store.issue(app.state.demo_owner_id, "en", [])

            class FakeUpstream:
                def __init__(self):
                    self.sent = []
                    self.incoming = asyncio.Queue()

                async def send(self, data):
                    self.sent.append(data)
                    try:
                        body = json.loads(data) if isinstance(data, str) else None
                    except Exception:
                        body = None
                    if isinstance(body, dict) and body.get("type") == "endStream":
                        self.incoming.put_nowait(json.dumps(
                            {"type": "speechComplete", "turnId": "t1",
                             "transcript": "エビ2尾"}))
                        self.incoming.put_nowait(None)

                async def recv(self):
                    return '{"sessionId": "fixture-session"}'

                def __aiter__(self):
                    return self

                async def __anext__(self):
                    frame = await self.incoming.get()
                    if frame is None:
                        raise StopAsyncIteration
                    return frame

            upstream = FakeUpstream()

            class FakeConnect:
                async def __aenter__(self):
                    return upstream

                async def __aexit__(self, *args):
                    return False

            with mock.patch("websockets.asyncio.client.connect",
                            lambda *args, **kwargs: FakeConnect()):
                with client.websocket_connect("/demo/voice-realtime") as ws:
                    ws.send_text(json.dumps({"ticket": ticket.token}))
                    ready = json.loads(ws.receive_text())
                    self.assertEqual(ready["type"], "ready")
                    ws.send_text(json.dumps({"type": "endStream"}))
                    final = json.loads(ws.receive_text())
                    self.assertEqual(final["type"], "speechComplete")
                    self.assertEqual(final["transcript"], "エビ2尾")
                    with self.assertRaises(WebSocketDisconnect):
                        ws.receive_text()
            sent_types = [json.loads(m).get("type") for m in upstream.sent
                          if isinstance(m, str) and m.startswith("{")]
            self.assertIn("endStream", sent_types)
        finally:
            self._restore(app, saved)


if __name__ == "__main__":
    unittest.main()
