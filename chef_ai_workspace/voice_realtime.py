"""Phase B: Meta Muse Voice Realtime ASR server relay (authenticated).

Browser never receives MODEL_API_KEY. The browser obtains a single-use,
short-lived ticket from POST /demo/ws-ticket (via the existing Next proxy
+ DEMO_ACCESS_TOKEN chain) and opens a WebSocket to the Render Python
backend, which dials Meta wss://api.meta.ai/v1/asr/realtime as the WS client.

Speech session, transcription turns, conversation context, and recipe
persistence stay independent: silence / speechEnd / disconnect never
discard a draft and never confirm a save. POST /confirm remains the only
approval path.
"""
from __future__ import annotations

import json
import secrets
import time
from dataclasses import dataclass, field

REALTIME_URL = "wss://api.meta.ai/v1/asr/realtime"
HANDSHAKE_TIMEOUT_S = 10.0
SESSION_LIMIT_S = 60 * 60
# Meta docs do not state a keywords count limit; keep a conservative cap and
# record it here rather than guessing server behaviour.
MAX_KEYWORDS = 50
TICKET_TTL_S = 120
# Upper bound for forwarding Meta's final events after the browser ends
# audio. The browser applies its own timeout as well; neither side waits
# forever, and a timeout never touches a draft (the relay stores none).
RELAY_DRAIN_S = 4.0


def build_language_bias(locale: str) -> list[str]:
    """English base, Japanese formal support. No Italian special-casing.

    Reuses the existing UI locale (en/ja); unknown values fall back to English.
    """
    if locale == "ja":
        return ["Japanese", "English"]
    return ["English", "Japanese"]


def _clean_term(value: object) -> str:
    if not isinstance(value, str):
        return ""
    term = " ".join(value.split())
    if len(term) < 2 or len(term) > 60:
        return ""
    return term


def build_keywords(rows: object, context_terms: object = None,
                   limit: int = MAX_KEYWORDS) -> list[str]:
    """Assemble vocabulary hints from owned master rows + recipe context.

    Never creates an independent persistent dictionary; callers pass
    owner-scoped rows each time. Empty masters yield an empty list.
    """
    seen: set[str] = set()
    out: list[str] = []

    def push(term: str) -> None:
        cleaned = _clean_term(term)
        if not cleaned or cleaned in seen:
            return
        seen.add(cleaned)
        out.append(cleaned)

    if isinstance(rows, (list, tuple)):
        for row in rows:
            if isinstance(row, dict):
                for key in ("name", "product_name", "supplier_name", "brand"):
                    push(row.get(key, ""))
            else:
                push(row)
    if isinstance(context_terms, (list, tuple)):
        for term in context_terms:
            push(term)
    return out[: max(0, limit)]


def build_handshake(access_token: str, locale: str,
                    keywords: list[str] | tuple[str, ...] = ()) -> dict:
    """First JSON frame for the Meta realtime handshake (session-fixed).

    mode/audioEncoding/languageBias/keywords are fixed for the session;
    later changes apply to the next connection only.
    """
    if not access_token:
        raise ValueError("Realtime access token required")
    payload: dict = {
        "authorization": {"accessToken": "Bearer " + access_token},
        "mode": "ENDPOINTING",
        "audioEncoding": "PCM_24KHZ",
        "languageBias": build_language_bias(locale),
    }
    clean = [k for k in (keywords or []) if isinstance(k, str) and k.strip()]
    if clean:
        payload["keywords"] = clean[:MAX_KEYWORDS]
    return payload


def backlog_exceeded(pending_bytes: int, sample_rate: int = 24000) -> bool:
    """True when unsent PCM exceeds Meta's 5s backlog limit (16-bit mono)."""
    if pending_bytes <= 0 or sample_rate <= 0:
        return False
    return pending_bytes > 5 * sample_rate * 2


from fastapi import Request as _Request
from fastapi import WebSocket as _WebSocket
from pydantic import BaseModel as _BaseModel


class TicketBody(_BaseModel):
    locale: str = "en"
    context_terms: list[str] = []


@dataclass
class WsTicket:
    token: str
    owner: str
    locale: str
    keywords: list[str] = field(default_factory=list)
    expires_at: float = 0.0


class WsTicketStore:
    """Single-use in-memory tickets. No persistence, no audio, no keys logged."""

    def __init__(self, ttl_s: int = TICKET_TTL_S, now=None) -> None:
        self._ttl = ttl_s
        self._now = now or time.time
        self._tickets: dict[str, WsTicket] = {}

    def issue(self, owner: str, locale: str = "en",
              keywords: list[str] | tuple[str, ...] = ()) -> WsTicket:
        if not owner:
            raise ValueError("Ticket owner required")
        token = secrets.token_urlsafe(32)
        ticket = WsTicket(token=token, owner=str(owner),
                          locale=locale if locale == "ja" else "en",
                          keywords=list(keywords or [])[:MAX_KEYWORDS],
                          expires_at=self._now() + self._ttl)
        self._tickets[token] = ticket
        self.purge()
        return ticket

    def consume(self, token: str) -> WsTicket | None:
        self.purge()
        ticket = self._tickets.pop(token or "", None)
        return ticket

    def purge(self) -> None:
        now = self._now()
        for token in [k for k, t in self._tickets.items() if t.expires_at <= now]:
            del self._tickets[token]


def register_voice_realtime(app, ticket_store: WsTicketStore | None = None):
    """Attach POST /demo/ws-ticket + WS /demo/voice-realtime to a FastAPI app."""
    import hmac as _hmac
    from fastapi import HTTPException as _HTTPException
    from fastapi import Request as _Request

    store = ticket_store or WsTicketStore()
    app.state.ws_ticket_store = store

    @app.post("/demo/ws-ticket")
    def issue_ws_ticket(body: TicketBody, request: _Request):
        owner = getattr(request.app.state, "demo_owner_id", None)
        secret = getattr(request.app.state, "demo_access_token", None)
        factory = getattr(request.app.state, "repository_factory", None)
        raw = request.headers.get("x-demo-access", "")
        if not owner or not secret or factory is None:
            raise _HTTPException(503, "Demo not configured")
        if not raw or not _hmac.compare_digest(raw, secret):
            raise _HTTPException(403, "Demo access denied")
        locale = body.locale if body.locale == "ja" else "en"
        rows: list = []
        try:
            searcher = getattr(factory(), "search_owned_ingredients", None)
            if callable(searcher):
                for term in (body.context_terms or [])[:10]:
                    for hit in searcher(owner, str(term)[:80]) or []:
                        rows.append(hit)
        except Exception:
            rows = []
        keywords = build_keywords(rows, body.context_terms)
        live = getattr(request.app.state, "ws_ticket_store", None) or store
        ticket = live.issue(owner, locale, keywords)
        return {"ticket": ticket.token, "expires_in_s": TICKET_TTL_S,
                "locale": ticket.locale, "keywords": ticket.keywords,
                "path": "/demo/voice-realtime"}

    @app.websocket("/demo/voice-realtime")
    async def voice_realtime_endpoint(websocket: _WebSocket):
        await websocket.accept()
        try:
            first = await websocket.receive_text()
        except Exception:
            await websocket.close(code=4401)
            return
        try:
            hello = json.loads(first)
            token = hello.get("ticket", "") if isinstance(hello, dict) else ""
        except Exception:
            token = ""
        live = getattr(websocket.app.state, "ws_ticket_store", None) or store
        ticket = live.consume(str(token or ""))
        if ticket is None:
            await websocket.close(code=4401)
            return
        key = getattr(websocket.app.state, "model_api_key", None) or \
            getattr(websocket.app.state, "meta_api_key", None)
        import os as _os
        key = key or _os.environ.get("MODEL_API_KEY", "")
        if not key:
            await websocket.send_json({"type": "error", "reason": "realtime_unavailable"})
            await websocket.close(code=1013)
            return
        await _relay(websocket, key, ticket)

    return store


async def _relay(websocket, model_key: str, ticket: WsTicket) -> None:
    """Forward browser PCM to Meta and Meta events back to the browser."""
    import asyncio as _asyncio

    try:
        from websockets.asyncio.client import connect as _connect
    except Exception:
        try:
            await websocket.send_json({"type": "error", "reason": "realtime_unavailable"})
        finally:
            await websocket.close(code=1013)
        return
    handshake = json.dumps(build_handshake(model_key, ticket.locale, ticket.keywords))
    try:
        async with _connect(REALTIME_URL, max_size=1 << 20,
                            open_timeout=HANDSHAKE_TIMEOUT_S) as upstream:
            try:
                await _asyncio.wait_for(upstream.send(handshake), HANDSHAKE_TIMEOUT_S)
                raw = await _asyncio.wait_for(upstream.recv(), HANDSHAKE_TIMEOUT_S)
            except Exception:
                await websocket.send_json({"type": "error", "reason": "handshake_failed"})
                await websocket.close(code=1011)
                return
            try:
                hello = json.loads(raw) if isinstance(raw, str) else {}
            except Exception:
                hello = {}
            if not isinstance(hello, dict) or not hello.get("sessionId"):
                await websocket.send_json({"type": "error", "reason": "handshake_failed"})
                await websocket.close(code=1011)
                return
            await websocket.send_json({"type": "ready",
                                       "sessionId": str(hello["sessionId"])[:64]})

            end_stream = _asyncio.Event()

            async def browser_to_meta():
                try:
                    while True:
                        message = await websocket.receive()
                        if message.get("bytes") is not None:
                            chunk = message["bytes"]
                            if backlog_exceeded(len(chunk)):
                                continue
                            await upstream.send(chunk)
                        elif message.get("text") is not None:
                            try:
                                control = json.loads(message["text"])
                            except Exception:
                                continue
                            if isinstance(control, dict) and control.get("type") == "endStream":
                                try:
                                    await upstream.send(json.dumps({"type": "endStream"}))
                                except Exception:
                                    pass
                                end_stream.set()
                                return
                except Exception:
                    pass

            async def meta_to_browser():
                try:
                    async for frame in upstream:
                        if isinstance(frame, bytes):
                            continue
                        try:
                            event = json.loads(frame)
                        except Exception:
                            continue
                        if not isinstance(event, dict):
                            continue
                        kind = event.get("type", "")
                        if kind == "error" or "error" in event:
                            await websocket.send_json({"type": "error",
                                                       "reason": "upstream_error"})
                            return
                        # Forward only the minimal turn events; never keys/audio.
                        if kind in ("speechStart", "speechEnd", "speechComplete",
                                    "transcript"):
                            await websocket.send_json(event)
                except Exception:
                    pass

            browser_task = _asyncio.create_task(browser_to_meta())
            meta_task = _asyncio.create_task(meta_to_browser())
            await _asyncio.wait([browser_task],
                                return_when=_asyncio.FIRST_COMPLETED)
            if end_stream.is_set() and not meta_task.done():
                # Graceful stop: forward Meta's final events (including the
                # last speechComplete) before closing, with a finite bound.
                try:
                    await _asyncio.wait_for(meta_task, RELAY_DRAIN_S)
                except _asyncio.TimeoutError:
                    pass
            if not meta_task.done():
                meta_task.cancel()
    except Exception:
        try:
            await websocket.send_json({"type": "error", "reason": "realtime_failed"})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass

# Attach to the shared demo app on import (route registration only; no I/O).
try:
    from .api import app as _demo_app

    if getattr(_demo_app.state, "ws_ticket_store", None) is None:
        register_voice_realtime(_demo_app)
except Exception:
    pass
