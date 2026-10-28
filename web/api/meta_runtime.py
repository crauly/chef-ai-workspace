"""Isolated Vercel Python function to compare Meta egress against Render.

Only responds to authorized server-side requests; no recipe data is accessed.
"""
import json
import os
import hmac
import urllib.request
import urllib.error
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class ProbeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = "muse-spark-1.3"


@app.post("/")
def probe(body: ProbeBody, x_demo_access: str | None = Header(default=None)):
    token = os.environ.get("DEMO_ACCESS_TOKEN")
    if not token or not x_demo_access or not hmac.compare_digest(x_demo_access, token):
        raise HTTPException(status_code=403, detail="Not authorized")
    key = os.environ.get("MODEL_API_KEY")
    if not key:
        return {"status": "missing_vercel_model_key"}
    if body.model != "muse-spark-1.3":
        raise HTTPException(status_code=400, detail="Invalid model")
    payload = json.dumps({
        "model": body.model,
        "messages": [{"role": "user", "content": "Say ready"}],
    }).encode()
    request = urllib.request.Request(
        "https://api.meta.ai/v1/chat/completions",
        data=payload,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read(32769))
        valid = isinstance(data, dict) and isinstance(data.get("choices"), list) and bool(data["choices"])
        return {"status": "inference_ready" if valid else "invalid_response"}
    except urllib.error.HTTPError as exc:
        code = exc.code
        reason = "unspecified"
        try:
            data = json.loads(exc.read(8193))
            error = data.get("error", {}) if isinstance(data, dict) else {}
            if isinstance(error, dict) and error.get("code") == "model_not_found":
                reason = "model_not_found"
        except (ValueError, OSError):
            pass
        finally:
            exc.close()
        statuses = {400: "request_rejected", 401: "unauthorized", 403: "forbidden",
                    404: "model_unavailable", 429: "rate_limited"}
        return {"status": statuses.get(code, "provider_error"), "reason": reason}
    except (OSError, ValueError):
        return {"status": "transport_or_parse_error"}
