"""Headless FastAPI boundary. Auth verifier and service-role repository are server-injected.

Never use a client-provided owner_id or a model-supplied confirmed flag.
POST /confirm constitutes an explicit authenticated user confirmation action.
"""
from dataclasses import asdict
from uuid import UUID

from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, ConfigDict

from .mutations import MutationError, Proposal
from .persistence_service import save_validated_mutation

bearer = HTTPBearer(auto_error=False)
app = FastAPI(title="Chef AI Workspace", version="0.1.0")


class MutationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_revision: int = Field(ge=0)
    request_id: UUID
    operations: list[dict] = Field(min_length=1, max_length=40)
    save_version: bool = False


def verified_owner(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authentication required")
    verifier = getattr(request.app.state, "verify_token", None)
    if verifier is None:
        raise HTTPException(status_code=503, detail="Authentication not configured")
    try:
        owner = verifier(credentials.credentials)
        UUID(str(owner))
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid authentication")
    return str(owner)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/recipes/{recipe_id}/confirm")
def confirm_recipe_mutation(recipe_id: UUID, body: MutationBody,
                            request: Request, owner_id: str = Depends(verified_owner)):
    factory = getattr(request.app.state, "repository_factory", None)
    if factory is None:
        raise HTTPException(status_code=503, detail="Persistence not configured")
    proposal = Proposal(str(recipe_id), body.base_revision, str(body.request_id),
                        tuple(body.operations))
    try:
        outcome = save_validated_mutation(
            owner_id=owner_id, trusted_user_confirmed=True,
            proposal=proposal, repository=factory(),
            save_version=body.save_version)
    except MutationError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"recipe": asdict(outcome.recipe),
            "revision": outcome.resulting_revision,
            "replayed": outcome.replayed}

# Operator-gated hackathon library; independent of production Supabase login.
from .demo_api import router as demo_router
app.include_router(demo_router)
