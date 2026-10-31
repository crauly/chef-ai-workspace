"""Supabase-backed realtime WS tickets (migration 202610310001).

No network, no Meta, no real database. A fake supabase-py-shaped client
backs DbVoiceTicketStore; atomicity/expiry/replay semantics mirror the
applied consume_voice_ws_ticket RPC (single delete-if-valid).
"""
import threading
import unittest
from datetime import datetime, timedelta, timezone

from chef_ai_workspace.voice_realtime import (
    DbVoiceTicketStore, WsTicket, hash_token, resolve_ticket_store,
)


class _Result:
    def __init__(self, data):
        self.data = data


class FakeBackend:
    """Shared table+RPC state. pop() under a lock = atomic single consume."""

    def __init__(self, now=None):
        self.rows = {}
        self.fail_insert = False
        self.fail_rpc = False
        self.fail_delete = False
        self.lock = threading.Lock()
        self.consume_threads = []
        self._now = now or (lambda: datetime.now(timezone.utc))

    def purge_expired(self, cutoff_iso):
        if self.fail_delete:
            raise RuntimeError("db down")
        cutoff = datetime.fromisoformat(cutoff_iso)
        with self.lock:
            expired = [k for k, r in self.rows.items()
                       if datetime.fromisoformat(r["expires_at"]) <= cutoff]
            for key in expired:
                del self.rows[key]
        return [{"token_hash": k} for k in expired]

    def insert_row(self, row):
        if self.fail_insert:
            raise RuntimeError("db down")
        with self.lock:
            if row["token_hash"] in self.rows:
                raise RuntimeError("duplicate ticket")
            self.rows[row["token_hash"]] = dict(row)

    def consume_rpc(self, token_hash):
        self.consume_threads.append(threading.current_thread())
        if self.fail_rpc:
            raise RuntimeError("db down")
        with self.lock:
            row = self.rows.pop(token_hash, None)
        if row is None:
            return []
        # Real timestamptz comparison happens server-side; parse the ISO text.
        if datetime.fromisoformat(row["expires_at"]) <= self._now():
            return []
        return [{"owner_id": row["owner_id"], "locale": row["locale"],
                 "keywords": row["keywords"]}]


class FakeTable:
    def __init__(self, backend):
        self._backend = backend

    def insert(self, row):
        backend = self._backend

        class Exec:
            def execute(self):
                backend.insert_row(row)
                return _Result([row])
        return Exec()

    def delete(self):
        backend = self._backend

        class Chain:
            def lte(self, column, value):
                assert column == "expires_at"
                backend_holder = {"cutoff": value}

                class Exec:
                    def execute(self):
                        return _Result(backend.purge_expired(
                            backend_holder["cutoff"]))
                return Exec()
        return Chain()


class FakeRpc:
    def __init__(self, backend, name, params):
        self._backend = backend
        self._name = name
        self._params = params

    def execute(self):
        assert self._name == "consume_voice_ws_ticket"
        return _Result(self._backend.consume_rpc(
            self._params["p_token_hash"]))


class FakeClient:
    def __init__(self, backend):
        self._backend = backend

    def table(self, name):
        assert name == "voice_ws_tickets"
        return FakeTable(self._backend)

    def rpc(self, name, params):
        return FakeRpc(self._backend, name, params)


def make_store(now_value=None):
    now = [now_value or datetime.now(timezone.utc)]

    def clock():
        value = now[0]
        return value.timestamp()
    backend = FakeBackend(now=lambda: now[0])
    store = DbVoiceTicketStore(FakeClient(backend), ttl_s=120,
                               now=clock)
    return store, backend, now


class HashTests(unittest.TestCase):
    def test_hash_is_deterministic_hex_without_plaintext(self):
        digest = hash_token("abc")
        self.assertEqual(len(digest), 64)
        self.assertEqual(digest, hash_token("abc"))
        self.assertNotEqual(digest, hash_token("abd"))
        self.assertNotIn("abc", digest)


class DbTicketStoreTests(unittest.TestCase):
    def test_issue_stores_hash_only(self):
        store, backend, _ = make_store()
        ticket = store.issue("owner-1", "ja", ["乾燥パスタ"])
        self.assertEqual(len(ticket.token), 43)
        self.assertEqual(len(backend.rows), 1)
        row = next(iter(backend.rows.values()))
        self.assertEqual(row["token_hash"], hash_token(ticket.token))
        self.assertNotIn(ticket.token, repr(backend.rows))
        self.assertEqual(row["owner_id"], "owner-1")
        self.assertEqual(row["locale"], "ja")
        self.assertEqual(row["keywords"], ["乾燥パスタ"])
        second = store.issue("owner-1", "ja", [])
        self.assertNotEqual(second.token, ticket.token)

    def test_live_schema_columns(self):
        store, backend, _ = make_store()
        store.issue("owner-1", "en", [])
        row = next(iter(backend.rows.values()))
        self.assertEqual(set(row), {"token_hash", "owner_id", "locale",
                                    "keywords", "expires_at"})

    def test_consume_once_then_replay_refused(self):
        store, backend, _ = make_store()
        ticket = store.issue("owner-1", "ja", ["a"])
        got = store.consume(ticket.token)
        self.assertIsInstance(got, WsTicket)
        self.assertEqual(got.owner, "owner-1")
        self.assertEqual(got.locale, "ja")
        self.assertEqual(got.keywords, ["a"])
        self.assertEqual(got.token, "")
        self.assertIsNone(store.consume(ticket.token))

    def test_independent_instances_share_no_memory(self):
        store_a, backend, _ = make_store()
        store_b = DbVoiceTicketStore(store_a._client, ttl_s=120)
        self.assertFalse(hasattr(store_a, "_tickets"))
        self.assertFalse(hasattr(store_b, "_tickets"))
        ticket = store_a.issue("owner-1", "en", [])
        got = store_b.consume(ticket.token)
        self.assertIsNotNone(got)
        self.assertIsNone(store_a.consume(ticket.token))

    def test_parallel_consume_single_winner(self):
        store, backend, _ = make_store()
        ticket = store.issue("owner-1", "en", [])
        winners = []
        workers = [threading.Thread(
            target=lambda: winners.append(store.consume(ticket.token)))
            for _ in range(8)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        self.assertEqual(sum(1 for got in winners if got is not None), 1)

    def test_expired_ticket_refused(self):
        store, backend, now = make_store()
        ticket = store.issue("owner-1", "en", [])
        now[0] = now[0] + timedelta(seconds=121)
        self.assertIsNone(store.consume(ticket.token))

    def test_tampered_token_refused(self):
        store, backend, _ = make_store()
        ticket = store.issue("owner-1", "en", [])
        bad = ("A" if ticket.token[0] != "A" else "B") + ticket.token[1:]
        self.assertIsNone(store.consume(bad))
        self.assertIsNone(store.consume(""))
        self.assertIsNone(store.consume("not-a-token"))

    def test_issue_purges_only_expired_rows(self):
        store, backend, now = make_store()
        stale = {"token_hash": "0" * 64, "owner_id": "owner-9",
                 "locale": "en", "keywords": [],
                 "expires_at": (now[0] - timedelta(seconds=10)).isoformat()}
        backend.rows[stale["token_hash"]] = dict(stale)
        fresh = store.issue("owner-1", "en", [])
        self.assertNotIn(stale["token_hash"], backend.rows)
        self.assertIn(hash_token(fresh.token), backend.rows)
        self.assertEqual(len(backend.rows), 1)

    def test_purge_counts_expired_and_keeps_valid(self):
        store, backend, now = make_store()
        old_iso = (now[0] - timedelta(seconds=60)).isoformat()
        for digest in ("a" * 64, "b" * 64):
            backend.rows[digest] = {"token_hash": digest,
                                    "owner_id": "owner-9", "locale": "en",
                                    "keywords": [], "expires_at": old_iso}
        ticket = store.issue("owner-1", "en", [])
        # Two stale rows purged; the just-issued row survives.
        self.assertEqual(len(backend.rows), 1)
        self.assertIn(hash_token(ticket.token), backend.rows)

    def test_purge_failure_does_not_break_issue(self):
        store, backend, _ = make_store()
        backend.fail_delete = True
        ticket = store.issue("owner-1", "en", [])
        self.assertIn(hash_token(ticket.token), backend.rows)
        backend.fail_delete = False
        self.assertEqual(store.purge_expired(), 0)

    def test_db_failure_refuses(self):
        store, backend, _ = make_store()
        backend.fail_insert = True
        with self.assertRaises(Exception):
            store.issue("owner-1", "en", [])
        backend.fail_insert = False
        ticket = store.issue("owner-1", "en", [])
        backend.fail_rpc = True
        self.assertIsNone(store.consume(ticket.token))


class ResolveTests(unittest.TestCase):
    def test_explicit_store_wins(self):
        from chef_ai_workspace.voice_realtime import WsTicketStore
        memory = WsTicketStore()

        class State:
            ws_ticket_store = memory
            repository_factory = None
        self.assertIs(resolve_ticket_store(State()), memory)

    def test_factory_client_builds_db_store(self):
        store, backend, _ = make_store()

        class Repo:
            client = store._client

        class State:
            ws_ticket_store = None
            repository_factory = staticmethod(lambda: Repo())
        resolved = resolve_ticket_store(State())
        self.assertIsInstance(resolved, DbVoiceTicketStore)

    def test_no_source_returns_none(self):
        class State:
            ws_ticket_store = None
            repository_factory = None
        self.assertIsNone(resolve_ticket_store(State()))

        class NoClient:
            pass

        class State2:
            ws_ticket_store = None
            repository_factory = staticmethod(lambda: NoClient())
        self.assertIsNone(resolve_ticket_store(State2()))


class DbTicketEndpointTests(unittest.TestCase):
    """HTTP issue + WS single-use through the DB store (fake backend)."""

    def _app(self):
        from fastapi import FastAPI
        from chef_ai_workspace.voice_realtime import register_voice_realtime
        app = FastAPI()
        app.state.demo_owner_id = "00000000-0000-4000-8000-000000000001"
        app.state.demo_access_token = "test-only-backend-token-1234567890"

        class FakeRepo:
            def search_owned_ingredients(self, owner, query, limit=20):
                return []

        backend_holder = {}
        inner = FakeRepo()
        store, backend, _ = make_store()
        backend_holder["backend"] = backend

        class RepoWithClient(FakeRepo):
            client = store._client
        app.state.repository_factory = lambda: RepoWithClient()
        register_voice_realtime(app)
        return app, backend_holder

    def test_issue_without_store_config_is_503(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from chef_ai_workspace.voice_realtime import register_voice_realtime
        app = FastAPI()
        app.state.demo_owner_id = "00000000-0000-4000-8000-000000000001"
        app.state.demo_access_token = "test-only-backend-token-1234567890"
        app.state.repository_factory = lambda: None
        register_voice_realtime(app)
        client = TestClient(app)
        response = client.post(
            "/demo/ws-ticket",
            headers={"X-Demo-Access": "test-only-backend-token-1234567890"},
            json={"locale": "en"})
        self.assertEqual(response.status_code, 503)

    def test_ws_consume_runs_off_event_loop(self):
        """Sync Supabase RPC must not execute on the WS event loop thread."""
        import asyncio
        import os
        import threading
        from unittest import mock
        from fastapi.testclient import TestClient
        saved = os.environ.pop("MODEL_API_KEY", None)
        app, holder = self._app()
        try:
            client = TestClient(app)
            good = {"X-Demo-Access": "test-only-backend-token-1234567890"}
            body = client.post("/demo/ws-ticket", headers=good,
                               json={"locale": "en"}).json()
            ticket = body["ticket"]
            loop_thread = []
            calls = []
            real_to_thread = asyncio.to_thread

            async def spy(func, /, *args, **kwargs):
                calls.append(getattr(func, "__name__", repr(func)))
                loop_thread.append(threading.current_thread())
                return await real_to_thread(func, *args, **kwargs)

            with mock.patch.object(asyncio, "to_thread", spy):
                with client.websocket_connect("/demo/voice-realtime") as ws:
                    ws.send_text('{"ticket": "%s"}' % ticket)
                    # No Meta key in tests: consume succeeds, relay refuses.
                    self.assertIn("realtime_unavailable",
                                  ws.receive_text())
            self.assertEqual(calls, ["consume"])
            self.assertTrue(loop_thread)
            # The RPC executed on a worker thread, not the loop thread
            # that invoked to_thread.
            backend = holder["backend"]
            self.assertTrue(backend.consume_threads)
            for worker in backend.consume_threads:
                self.assertIsNot(worker, loop_thread[0])
            # The consume RPC itself stayed synchronous and single-use.
            self.assertIsNone(backend.rows.get(ticket, None))
        finally:
            if saved is not None:
                os.environ["MODEL_API_KEY"] = saved

    def test_db_issue_then_ws_single_use(self):
        import os
        from fastapi.testclient import TestClient
        from starlette.websockets import WebSocketDisconnect
        saved = os.environ.pop("MODEL_API_KEY", None)
        app, holder = self._app()
        try:
            client = TestClient(app)
            good = {"X-Demo-Access": "test-only-backend-token-1234567890"}
            body = client.post("/demo/ws-ticket", headers=good,
                               json={"locale": "en"}).json()
            ticket = body["ticket"]
            rows = holder["backend"].rows
            self.assertEqual(len(rows), 1)
            self.assertNotIn(ticket, repr(rows))
            with client.websocket_connect("/demo/voice-realtime") as ws:
                ws.send_text('{"ticket": "%s"}' % ticket)
                self.assertIn("realtime_unavailable", ws.receive_text())
            with client.websocket_connect("/demo/voice-realtime") as again:
                again.send_text('{"ticket": "%s"}' % ticket)
                with self.assertRaises(WebSocketDisconnect) as raised:
                    again.receive_text()
            self.assertEqual(raised.exception.code, 4401)
        finally:
            if saved is not None:
                os.environ["MODEL_API_KEY"] = saved


class TicketMigrationTests(unittest.TestCase):
    """Record-only migration matches the applied live definition."""

    PATH = "supabase/migrations/202610310001_realtime_voice_tickets.sql"

    def _sql(self):
        import pathlib
        return (pathlib.Path(__file__).resolve().parents[1] / self.PATH
                ).read_text()

    def test_function_matches_applied_definition(self):
        import re
        sql = self._sql()
        low = sql.lower()
        # Applied DB uses SECURITY INVOKER, never DEFINER.
        self.assertIn("security invoker", low)
        self.assertNotIn("security definer", low)
        # Applied DB pins an empty search_path.
        self.assertRegex(low, r"set\s+search_path\s+to\s+''")
        # Applied DB deletes via the aliased table and returns qualified cols.
        self.assertRegex(
            low, r"delete\s+from\s+public\.voice_ws_tickets\s+as\s+t\b")
        for frag in ("t.token_hash", "t.expires_at",
                     "t.owner_id", "t.locale", "t.keywords"):
            with self.subTest(frag=frag):
                self.assertIn(frag, low)
        self.assertNotIn("set search_path = public", low)
        self.assertEqual(len(re.findall(
            r"create\s+or\s+replace\s+function\s+"
            r"public\.consume_voice_ws_ticket", low)), 1)

    def test_checks_and_lockdown_present(self):
        sql = self._sql()
        low = sql.lower()
        for token in ("voice_ws_tickets_token_hash_check",
                      "voice_ws_tickets_locale_check",
                      "voice_ws_tickets_keywords_check",
                      "jsonb_typeof(keywords) = 'array'",
                      "service_role"):
            with self.subTest(token=token):
                self.assertIn(token, low)
        # CHECK intent mirrors the applied DB: 64-hex hash, en/ja, array.
        self.assertIn("^[0-9a-f]{64}$", sql)
        self.assertIn("locale in ('en', 'ja')", low)
        # CREATE OR REPLACE preserves grants, so explicit revokes including
        # PUBLIC are the enforcement point on both table and function.
        norm = " ".join(sql.lower().split())
        self.assertIn(
            "revoke all on table public.voice_ws_tickets"
            " from public, anon, authenticated", norm)
        self.assertIn(
            "revoke all on function public.consume_voice_ws_ticket(text)"
            " from public, anon, authenticated", norm)

    def test_record_only_replay_safe(self):
        import re
        sql = self._sql()
        body = "\n".join(l for l in sql.splitlines()
                         if not l.strip().startswith("--")).lower()
        for stmt in ("drop table", "truncate", "drop column",
                     "insert into", "drop function"):
            with self.subTest(stmt=stmt):
                self.assertNotIn(stmt, body)
        self.assertIn("if not exists", body)
        self.assertIn("or replace", body)
        for tag in set(re.findall(r"\$[A-Za-z_]*\$", sql)):
            self.assertEqual(sql.count(tag) % 2, 0)


if __name__ == "__main__":
    unittest.main()
