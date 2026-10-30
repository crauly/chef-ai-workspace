"""Operator-gated hackathon demo library, independent of production login.

Demo access token lives in a private backend environment and must be entered
by the presenter, never embedded in the public frontend bundle. Never enable
the demo routes without an isolated demo owner and a long random secret.
"""
import hmac
from dataclasses import asdict
from uuid import uuid4
from pydantic import BaseModel, Field, ConfigDict
from .models import Recipe, TrackedValue
from .costing import calculate_cost
from .mutations import Proposal, MutationError, prepare_mutation
from .persistence_service import save_validated_mutation, _json
from uuid import UUID
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Query

router = APIRouter(prefix="/demo", tags=["Hackathon demo"])


def demo_context(request: Request, x_demo_access: str | None = Header(default=None)):
    owner = getattr(request.app.state, "demo_owner_id", None)
    secret = getattr(request.app.state, "demo_access_token", None)
    factory = getattr(request.app.state, "repository_factory", None)
    if not owner or not secret or factory is None:
        raise HTTPException(503, "Demo not configured")
    try:
        UUID(str(owner))
    except ValueError:
        raise HTTPException(503, "Demo owner misconfigured")
    if not x_demo_access or not hmac.compare_digest(x_demo_access, secret):
        raise HTTPException(403, "Demo access denied")
    return str(owner), factory()


@router.get("/recipes")
def list_demo_recipes(page: int = 1, page_size: int = 20,
                      q: str = Query(default="", max_length=200), ctx=Depends(demo_context)):
    if page < 1 or page_size < 1 or page_size > 50:
        raise HTTPException(422, "Invalid pagination")
    owner, repository = ctx
    search = {"search": q.strip()} if q.strip() else {}
    return {"items": repository.list_owned_recipes(owner, offset=(page-1)*page_size,
                                                   limit=page_size, **search),
            "page":page, "page_size":page_size}


@router.get("/recipes/{recipe_id}")
def get_demo_recipe(recipe_id: UUID, ctx=Depends(demo_context)):
    owner, repository=ctx
    try:
        found = repository.load_owned_recipe(owner, str(recipe_id))
    except ValueError:
        raise HTTPException(404, "Recipe not found")
    # M4: linked ingredient names lead; material names are kept and used as
    # fallback for unlinked lines. Resolution never renames stored data.
    return _displayed_recipe(owner, repository, found)


class CreateRecipeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=200)


def _displayed_recipe(owner, repository, found):
    """Attach resolved display names without renaming stored data."""
    from .display_names import resolve_display_names
    ids = [m.ingredient_id for m in found.materials if m.ingredient_id]
    loader = getattr(repository, "load_owned_ingredients", None)
    if ids and callable(loader):
        catalog = loader(owner, ids) or {}
    elif any(m.price_mode == "inherit" for m in found.materials):
        loader2 = getattr(repository, "load_owned_catalog", None)
        catalog = loader2(owner, found) if callable(loader2) else {}
    else:
        catalog = {}
    out = asdict(found)
    out["display_names"] = resolve_display_names(found, catalog)
    return out


def _owned_candidates(owner, repository, recipe, name):
    """Owned-only candidate pool: search hits plus the recipe catalog."""
    from .models import Ingredient as _Ingredient
    pool: dict[str, _Ingredient] = {}
    searcher = getattr(repository, "search_owned_ingredients", None)
    if callable(searcher):
        for row in searcher(owner, name) or []:
            if isinstance(row, dict) and row.get("id") and row.get("name"):
                pool[row["id"]] = _Ingredient(row["id"], row["name"], None)
    try:
        for gid, g in (repository.load_owned_catalog(owner, recipe) or {}).items():
            pool.setdefault(gid, g)
    except (ValueError, TypeError, AttributeError):
        pass
    return pool


class AssistRequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    material_id: UUID
    name: str = Field(min_length=1, max_length=200)


@router.get("/ingredients/search")
def search_demo_ingredients(q: str = Query(default="", max_length=200),
                            limit: int = Query(default=20, ge=1, le=50),
                            ctx=Depends(demo_context)):
    """Owner-scoped ingredient search for reuse candidates (M4)."""
    owner, repository = ctx
    searcher = getattr(repository, "search_owned_ingredients", None)
    if not callable(searcher):
        raise HTTPException(503, "Ingredient search not configured")
    return {"items": searcher(owner, q.strip(), limit) or []}


@router.post("/recipes/{recipe_id}/ingredient-assist")
def assist_demo_ingredient(recipe_id: UUID, body: AssistRequestBody,
                           ctx=Depends(demo_context)):
    """Classify one material against owned ingredients (M4).

    Returns reuse/ambiguous/new with owned candidates only. For "new" the
    server issues a suggested ID so the follow-up confirm can register and
    link in one approved request; the suggestion itself saves nothing.
    """
    from .ingredient_assist import classify_material
    owner, repository = ctx
    try:
        recipe = repository.load_owned_recipe(owner, str(recipe_id))
    except ValueError:
        raise HTTPException(404, "Recipe not found")
    if not any(m.id == str(body.material_id) for m in recipe.materials):
        raise HTTPException(404, "Material not found")
    try:
        candidate = classify_material(body.name, _owned_candidates(
            owner, repository, recipe, body.name))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    out = {"decision": candidate.decision,
           "candidates": [{"id": g.id, "name": g.name} for g in candidate.candidates]}
    if candidate.decision == "new":
        out["suggested_new_id"] = str(uuid4())
    return out


class LedgerEntryBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = Field(pattern=r"^(new|reuse)$")
    id: UUID | None = None
    name: str | None = Field(default=None, max_length=200)
    brand: str | None = Field(default=None, max_length=200)
    spec: str | None = Field(default=None, max_length=200)

    from pydantic import model_validator as _mv

    @_mv(mode="after")
    def _require_complete_spec(self):
        # Incomplete specs are explicit input errors: a nameless new entry
        # or an ID-less reuse must never be silently dropped or guessed.
        if self.kind == "new" and not (self.name or "").strip():
            raise ValueError("New ledger entry requires a name")
        if self.kind == "reuse" and self.id is None:
            raise ValueError("Reuse ledger entry requires an ingredient ID")
        return self


class ConfirmChangeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_revision: int = Field(ge=0)
    request_id: UUID
    operations: list[dict] = Field(min_length=1, max_length=40)
    save_version: bool = True
    # Optional ledger (M4): new-ingredient registration and recipe linking
    # complete as one approved request. Absent ledger keeps the legacy path.
    ledger: list[LedgerEntryBody] = Field(default_factory=list)


@router.post("/recipes", status_code=201)
def create_demo_recipe(body: CreateRecipeBody, ctx=Depends(demo_context)):
    owner, repository = ctx
    name = body.title.strip()
    if not name:
        raise HTTPException(422, "Recipe title required")
    recipe = Recipe(str(uuid4()), TrackedValue(name, "confirmed", "user"))
    snapshot = _json(asdict(calculate_cost(recipe)))
    repository.create_owned_recipe(owner, recipe, snapshot)
    return asdict(recipe)



class CompleteRecipeMaterial(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    quantity: str | None = Field(default=None, max_length=30)
    unit: str | None = Field(default=None, pattern=r"^(g|kg|ml|L)$")
    # Prices are optional (M4): missing prices save the line unpriced and the
    # cost stays partial with explicit unresolved IDs -- never zero-filled.
    price_jpy: str | None = Field(default=None, max_length=30)
    price_quantity: str | None = Field(default=None, max_length=30)
    price_unit: str | None = Field(default=None, pattern=r"^(g|kg|ml|L)$")


class CompleteRecipeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    title: str = Field(min_length=1, max_length=200)
    materials: list[CompleteRecipeMaterial] = Field(max_length=40)
    selling_price_jpy: str | None = None


@router.post("/recipes/full", status_code=201)
def create_complete_demo_recipe(body: CompleteRecipeBody, ctx=Depends(demo_context)):
    """Validate every field before a single durable create. Idempotent recipe UUID."""
    from .mutations import prepare_mutation
    from dataclasses import replace
    owner, repository = ctx
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "Recipe title required")
    operations = []
    for material in body.materials:
        if not material.name.strip():
            raise HTTPException(422, "Ingredient name required")
        priced = (material.price_jpy is not None and material.price_quantity is not None
                  and material.price_unit is not None)
        if priced:
            if material.quantity is None or material.unit is None:
                raise HTTPException(422, "Priced lines require quantity and unit")
            operations.append({"op": "add_material", "material_id": str(uuid4()),
                               "name": material.name.strip(), "quantity": material.quantity,
                               "unit": material.unit, "price_jpy": material.price_jpy,
                               "price_quantity": material.price_quantity,
                               "price_unit": material.price_unit})
        else:
            # Price trio is all-or-nothing: any single field (including a lone
            # price_unit) is an explicit input error, never silently dropped.
            if (material.price_jpy is not None or material.price_quantity is not None
                    or material.price_unit is not None):
                raise HTTPException(422, "Partial price fields are rejected")
            op = {"op": "add_unpriced_material", "material_id": str(uuid4()),
                  "name": material.name.strip()}
            if material.quantity is not None:
                if material.unit is None:
                    raise HTTPException(422, "Quantity requires unit")
                op["quantity"] = material.quantity
                op["unit"] = material.unit
            operations.append(op)
    if body.selling_price_jpy is not None:
        operations.append({"op": "set_selling_price", "value_jpy": body.selling_price_jpy})
    recipe_id = str(body.request_id)
    try:
        existing = repository.load_owned_recipe(owner, recipe_id)
    except ValueError:
        existing = None
    if existing is not None:
        # An uncertain network retry must not create duplicates.
        return _displayed_recipe(owner, repository, existing)
    recipe = Recipe(recipe_id, TrackedValue(title, "confirmed", "user"))
    if operations:
        try:
            recipe = prepare_mutation(
                recipe, Proposal(recipe_id, 0, recipe_id, tuple(operations)),
                user_confirmed=True)
        except (MutationError, ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, "Invalid spoken recipe values") from exc
    # The Supabase create_owned_recipe RPC requires initial revision 0.
    recipe = replace(recipe, revision=0)
    try:
        snapshot = _json(asdict(calculate_cost(recipe)))
        repository.create_owned_recipe(owner, recipe, snapshot)
    except ValueError as exc:
        raise HTTPException(409, "Recipe already exists") from exc
    return _displayed_recipe(owner, repository, recipe)

@router.post("/recipes/{recipe_id}/confirm")
def confirm_demo_change(recipe_id: UUID, body: ConfirmChangeBody,
                        ctx=Depends(demo_context)):
    owner, repository = ctx
    proposal = Proposal(str(recipe_id), body.base_revision, str(body.request_id),
                        tuple(body.operations))
    try:
        if body.ledger:
            from .persistence_service import LedgerIngredient, save_recipe_with_ledger
            if not callable(getattr(repository, "commit_recipe_with_ledger", None)):
                raise HTTPException(409, "Ledger commit not supported by repository")
            ledger = tuple(LedgerIngredient(
                e.kind, id=str(e.id) if e.id is not None else None,
                name=e.name, brand=e.brand, spec=e.spec) for e in body.ledger)
            saved = save_recipe_with_ledger(
                owner_id=owner, trusted_user_confirmed=True,
                proposal=proposal, ledger=ledger, repository=repository,
                save_version=body.save_version)
            shown = _displayed_recipe(owner, repository, saved.recipe)
            return {"recipe": shown, "revision": saved.resulting_revision,
                    "replayed": saved.replayed,
                    "saved_ingredient_ids": list(saved.saved_ingredient_ids)}
        saved = save_validated_mutation(
            owner_id=owner, trusted_user_confirmed=True,
            proposal=proposal, repository=repository,
            save_version=body.save_version)
    except MutationError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(404, "Recipe not found or inaccessible") from exc
    return {"recipe": _displayed_recipe(owner, repository, saved.recipe),
            "revision": saved.resulting_revision,
            "replayed": saved.replayed}


@router.get("/recipes/{recipe_id}/cost")
def get_demo_recipe_cost(recipe_id: UUID, ctx=Depends(demo_context)):
    """Calculate current cost from saved recipe and one batch catalog lookup."""
    owner, repository = ctx
    try:
        recipe = repository.load_owned_recipe(owner, str(recipe_id))
    except ValueError as exc:
        raise HTTPException(404, "Recipe not found") from exc
    catalog = (repository.load_owned_catalog(owner, recipe)
               if any(m.price_mode == "inherit" for m in recipe.materials) else {})
    return _json(asdict(calculate_cost(recipe, catalog)))


class AIProposalBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    instruction: str = Field(min_length=1, max_length=4000, pattern=r".*\S.*")


@router.post("/recipes/{recipe_id}/propose")
def propose_demo_change(recipe_id: UUID, body: AIProposalBody,
                        request: Request, ctx=Depends(demo_context)):
    """Untrusted suggestion only. Never commit or confirm AI output here."""
    from .ai_provider import ProposalProviderError
    owner, repository = ctx
    provider = getattr(request.app.state, "ai_provider", None)
    if provider is None:
        raise HTTPException(503, "AI provider not configured")
    try:
        recipe = repository.load_owned_recipe(owner, str(recipe_id))
    except ValueError as exc:
        raise HTTPException(404, "Recipe not found") from exc
    try:
        hints = getattr(request.app.state, "correction_hints", None)
        suggestions = hints.relevant(owner, str(recipe_id), body.instruction) if hints else []
        context = asdict(recipe)
        if suggestions:
            context["correction_suggestions"] = suggestions
        operations = provider.propose(body.instruction, context)
    except ProposalProviderError as exc:
        raise HTTPException(502, "AI provider unavailable or invalid response") from exc
    # Pure validation on a copy: reject malformed/unknown edits before showing a diff.
    if operations:
        try:
            catalog = (repository.load_owned_catalog(owner, recipe)
                       if any(m.price_mode == "inherit" for m in recipe.materials) else {})
            prepare_mutation(recipe, Proposal(str(recipe_id), recipe.revision,
                             str(uuid4()), tuple(operations)), user_confirmed=False,
                             catalog=catalog)
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, "AI proposal failed validation") from exc
    return {"recipe_id":str(recipe_id),"base_revision":recipe.revision,
            "operations":operations,"requires_confirmation":True,
            "provider":getattr(provider, "identity", None)}


class CorrectionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    heard: str = Field(min_length=1, max_length=200)
    preferred: str = Field(min_length=1, max_length=200)


@router.post("/recipes/{recipe_id}/corrections", status_code=201)
def record_demo_correction(recipe_id: UUID, body: CorrectionBody,
                           request: Request, ctx=Depends(demo_context)):
    """An explicit chef correction; never inferred from a model suggestion."""
    owner, repository = ctx
    hints = getattr(request.app.state, "correction_hints", None)
    if hints is None:
        raise HTTPException(503, "Correction memory not configured")
    try:
        repository.load_owned_recipe(owner, str(recipe_id))
    except ValueError as exc:
        raise HTTPException(404, "Recipe not found") from exc
    try:
        hints.record(owner, str(recipe_id), body.heard, body.preferred)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"saved":True}


class IntentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    utterance: str = Field(min_length=1, max_length=1000)
    current_mode: str = Field(default="idle", pattern="^(idle|create|browse|edit)$")


@router.post("/intent")
def classify_demo_intent(body: IntentBody, request: Request, ctx=Depends(demo_context)):
    """Voice navigation classification; read-only and never an authorization decision."""
    provider = getattr(request.app.state, "ai_provider", None)
    if provider is None or not hasattr(provider, "classify_intent"):
        raise HTTPException(503, "Meta intent model not configured")
    from .ai_provider import ProposalProviderError
    try:
        return provider.classify_intent(body.utterance, body.current_mode)
    except ProposalProviderError as exc:
        raise HTTPException(502, "Voice intent model unavailable") from exc


@router.get("/model-connection")
def check_demo_model_connection(request: Request, ctx=Depends(demo_context)):
    """Authorized operator-only connectivity check. No credentials or raw errors."""
    provider = getattr(request.app.state, "ai_provider", None)
    if provider is None:
        return {"status": "not_configured"}
    if not hasattr(provider, "check_connection"):
        return {"status": "unsupported_provider"}
    return provider.check_connection()


class ModelInferenceCheckBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = Field(default="muse-spark-1.3", pattern=r"^muse-spark-1\.[123]$")


@router.post("/model-inference-check")
def check_demo_model_inference(body: ModelInferenceCheckBody, request: Request, ctx=Depends(demo_context)):
    """Explicit operator-only real Muse inference, no recipe mutations or secrets."""
    provider = getattr(request.app.state, "ai_provider", None)
    if provider is None:
        return {"status": "not_configured"}
    if not hasattr(provider, "check_inference"):
        return {"status": "unsupported_provider"}
    return provider.check_inference(body.model)


@router.post("/model-chat-check")
def check_demo_chat_completions(request: Request, ctx=Depends(demo_context)):
    """Operator-only official Chat Completions comparison; no recipe data."""
    provider = getattr(request.app.state, "ai_provider", None)
    if provider is None:
        return {"status": "not_configured"}
    if not hasattr(provider, "check_chat_completions"):
        return {"status": "unsupported_provider"}
    return provider.check_chat_completions()
