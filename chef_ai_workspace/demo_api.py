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
from .costing import calculate_cost, unit_factor_catalog
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


def _owned_unit_definitions(owner, repository):
    loader = getattr(repository, "list_owned_units", None)
    return unit_factor_catalog(loader(owner)) if callable(loader) else {}


@router.get("/units")
def list_demo_units(ctx=Depends(demo_context)):
    """Owner-scoped vocabulary for Muse proposals and the unit manager."""
    owner, repository = ctx
    loader = getattr(repository, "list_owned_units", None)
    if not callable(loader):
        raise HTTPException(503, "Unit master repository unavailable")
    return {"items": loader(owner)}


class UnitCreateBody(BaseModel):
    model_config=ConfigDict(extra="forbid")
    symbol: str=Field(min_length=1,max_length=32)
    dimension: str=Field(pattern=r"^(mass|volume|count|other)$")


@router.post("/units",status_code=201)
def create_demo_unit(body:UnitCreateBody,ctx=Depends(demo_context)):
    owner,repo=ctx
    create=getattr(repo,"create_owned_unit_master",None)
    if not callable(create): raise HTTPException(503,"Unit manager unavailable")
    return {"id":str(create(owner,body.symbol.strip(),body.dimension))}


@router.delete("/units/{unit_id}")
def delete_demo_unit(unit_id:UUID,ctx=Depends(demo_context)):
    owner,repo=ctx
    delete=getattr(repo,"delete_owned_unit_master",None)
    if not callable(delete): raise HTTPException(503,"Unit manager unavailable")
    if not delete(owner,str(unit_id)): raise HTTPException(404,"Unit not found")
    return {"deleted":True}


@router.get("/units/resolve")
def resolve_demo_unit(
    q: str = Query(min_length=1, max_length=32),
    ctx=Depends(demo_context),
):
    """Never creates data: AI candidates require the normal Human Gate."""
    from .unit_master import resolve_unit
    owner, repository = ctx
    loader = getattr(repository, "list_owned_units", None)
    if not callable(loader):
        raise HTTPException(503, "Unit master repository unavailable")
    return asdict(resolve_unit(q, loader(owner)))


class UnitEditBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_factor: str | None = None
    symbol: str = Field(min_length=1, max_length=32)
    dimension: str = Field(pattern=r"^(mass|volume|count|other)$")
    aliases: list[str] = Field(max_length=20)


@router.put("/units/{unit_id}")
def edit_demo_unit(unit_id: UUID, body: UnitEditBody,
                   ctx=Depends(demo_context)):
    """Explicit unit manager edit, independent from Muse proposal parsing."""
    owner, repository = ctx
    aliases = [alias.strip() for alias in body.aliases]
    if any(not alias or len(alias) > 32 for alias in aliases):
        raise HTTPException(422, "Invalid unit alias")
    if body.base_factor is not None:
        from decimal import Decimal, InvalidOperation
        try:
            factor = Decimal(body.base_factor)
            if not factor.is_finite() or factor <= 0:
                raise ValueError("factor")
        except (InvalidOperation, ValueError):
            raise HTTPException(422, "Invalid unit conversion factor")
    editor = getattr(repository, "update_owned_unit", None)
    if not callable(editor):
        raise HTTPException(503, "Unit manager unavailable")
    if not editor(owner, str(unit_id), body.symbol.strip(), body.dimension,
                  body.base_factor, aliases):
        raise HTTPException(404, "Unit not found")
    return {"id": str(unit_id), "symbol": body.symbol.strip(),
            "dimension": body.dimension, "base_factor": body.base_factor,
            "aliases": aliases}


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


def _tool_search(owner, repository, recipe):
    """Owner-scoped search callable for the Block 1 ledger tool.

    Uses repository.search_owned_ingredients (the same owner-scoped method as
    _owned_candidates), never the recipe-costing catalog that only holds
    already-linked IDs. Repositories without that method fall back to a
    substring search over the recipe catalog.
    """
    searcher = getattr(repository, "search_owned_ingredients", None)
    if callable(searcher):
        def _search(query, limit):
            rows = searcher(owner, query, limit) or []
            return [row for row in rows] if isinstance(rows, (list, tuple)) else []
        return _search

    def _fallback(query, limit):
        from .ingredient_assist import search_owned_ingredients as _substring
        try:
            catalog = repository.load_owned_catalog(owner, recipe) or {}
        except (ValueError, TypeError, AttributeError):
            return []
        return [{"id": g.id, "name": g.name}
                for g in _substring(query, catalog)][:limit]
    return _fallback


class AssistRequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    material_id: UUID
    name: str = Field(min_length=1, max_length=200)


class SupplierBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=1000)


@router.get("/suppliers")
def list_demo_suppliers(page: int = Query(default=1, ge=1),
                        page_size: int = Query(default=50, ge=1, le=100),
                        ctx=Depends(demo_context)):
    owner, repository = ctx
    return {"items": repository.list_owned_suppliers(owner, limit=page_size, offset=(page-1)*page_size),
            "page": page, "page_size": page_size}


@router.post("/suppliers", status_code=201)
def create_demo_supplier(body: SupplierBody, ctx=Depends(demo_context)):
    owner, repository = ctx
    if not body.name.strip():
        raise HTTPException(422, "Supplier name required")
    supplier_id = repository.create_owned_supplier(owner, body.name, body.note)
    return {"id": supplier_id, "name": body.name.strip(), "note": body.note}


@router.put("/suppliers/{supplier_id}")
def update_demo_supplier(supplier_id: UUID, body: SupplierBody, ctx=Depends(demo_context)):
    owner, repository = ctx
    updater = getattr(repository, "update_owned_supplier", None)
    if not callable(updater):
        raise HTTPException(503, "Supplier update not supported")
    try:
        return updater(owner, str(supplier_id), body.name, body.note)
    except ValueError as exc:
        raise HTTPException(404 if "not owned" in str(exc) else 422, str(exc)) from exc


@router.delete("/suppliers/{supplier_id}", status_code=204)
def delete_demo_supplier(supplier_id: UUID, ctx=Depends(demo_context)):
    owner, repository = ctx
    remover = getattr(repository, "delete_owned_supplier", None)
    if not callable(remover):
        raise HTTPException(503, "Supplier deletion not supported")
    try:
        remover(owner, str(supplier_id))
    except ValueError as exc:
        msg = str(exc)
        raise HTTPException(404 if "not owned" in msg else 409, msg) from exc
    from fastapi import Response
    return Response(status_code=204)


@router.get("/ingredients")
def list_demo_ingredient_master(ctx=Depends(demo_context)):
    owner, repository=ctx
    loader=getattr(repository,"list_owned_ingredient_master",None)
    if not callable(loader):
        raise HTTPException(503,"Ingredient master unavailable")
    return {"items":loader(owner)}


class IngredientMasterCreateBody(BaseModel):
    model_config=ConfigDict(extra="forbid")
    name: str=Field(min_length=1,max_length=200)


@router.post("/ingredients",status_code=201)
def create_demo_ingredient_master(body:IngredientMasterCreateBody,ctx=Depends(demo_context)):
    owner,repo=ctx
    create=getattr(repo,"create_owned_ingredient_master",None)
    if not callable(create): raise HTTPException(503,"Ingredient master unavailable")
    return {"id":str(create(owner,body.name.strip()))}


@router.delete("/ingredients/{ingredient_id}")
def delete_demo_ingredient_master(ingredient_id:UUID,ctx=Depends(demo_context)):
    owner,repo=ctx
    delete=getattr(repo,"delete_owned_ingredient_master",None)
    if not callable(delete): raise HTTPException(503,"Ingredient master unavailable")
    if not delete(owner,str(ingredient_id)): raise HTTPException(404,"Ingredient not found")
    return {"deleted":True}


class IngredientMasterEditBody(BaseModel):
    model_config=ConfigDict(extra="forbid")
    name: str=Field(min_length=1,max_length=200)
    price_jpy: str | None=None
    price_quantity: str | None=None
    price_unit: str | None=Field(default=None,min_length=1,max_length=32)


@router.put("/ingredients/{ingredient_id}")
def edit_demo_ingredient_master(ingredient_id:UUID, body:IngredientMasterEditBody,
                                ctx=Depends(demo_context)):
    """One explicitly authorized manager action changes shared master price."""
    owner, repository=ctx
    from .models import PriceQuote
    fields=(body.price_jpy,body.price_quantity,body.price_unit)
    if any(value is not None for value in fields) and not all(value is not None for value in fields):
        raise HTTPException(422,"Partial master price")
    quote=None
    if all(value is not None for value in fields):
        try:
            quote=PriceQuote(TrackedValue(body.price_jpy,"confirmed","user"),
                             body.price_quantity,body.price_unit,"manual")
        except (TypeError,ValueError) as exc:
            raise HTTPException(422,"Invalid master price") from exc
    editor=getattr(repository,"update_owned_ingredient_master",None)
    if not callable(editor):
        raise HTTPException(503,"Ingredient master unavailable")
    if not editor(owner,str(ingredient_id),body.name.strip(),
                  asdict(quote) if quote is not None else None):
        raise HTTPException(404,"Ingredient not found")
    return {"id":str(ingredient_id),"name":body.name.strip(),"updated":True}


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
    unit: str | None = Field(default=None, min_length=1, max_length=32)
    # Prices are optional (M4): missing prices save the line unpriced and the
    # cost stays partial with explicit unresolved IDs -- never zero-filled.
    price_jpy: str | None = Field(default=None, max_length=30)
    price_quantity: str | None = Field(default=None, max_length=30)
    price_unit: str | None = Field(default=None, min_length=1, max_length=32)


class UnitCandidateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    symbol: str = Field(min_length=1, max_length=32)
    dimension: str = Field(pattern=r"^(mass|volume|count|other)$")


class CompleteRecipeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    title: str = Field(min_length=1, max_length=200)
    materials: list[CompleteRecipeMaterial] = Field(max_length=40)
    unit_candidates: list[UnitCandidateBody] = Field(default_factory=list, max_length=80)
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
    recipe_id = str(body.request_id)
    try:
        existing = repository.load_owned_recipe(owner, recipe_id)
    except ValueError:
        existing = None
    if existing is not None:
        # An uncertain network retry must not create duplicates.
        return _displayed_recipe(owner, repository, existing)
    # The explicit recipe-save action is the only approval gate for new units.
    # Candidates are checked against the owned catalog; unknown spelling may
    # register only when its proposed dimension is present in the reviewed body.
    from .unit_master import prepare_unit_approval
    loader = getattr(repository, "list_owned_units", None)
    if not callable(loader):
        raise HTTPException(503, "Unit master unavailable")
    known_units = loader(owner)
    entered = list(dict.fromkeys(
        unit for material in body.materials
        for unit in (material.unit, material.price_unit) if unit is not None
    ))
    dimensions = {c.symbol: c.dimension for c in body.unit_candidates}
    if len(dimensions) != len(body.unit_candidates):
        raise HTTPException(422, "Duplicate unit candidate")
    try:
        approvals = prepare_unit_approval(entered, known_units, dimensions)
    except ValueError as exc:
        raise HTTPException(422, "Unresolved unit approval") from exc
    new_units = [{"symbol": item.symbol, "dimension": item.dimension}
                 for item in approvals if item.status == "new_candidate"]
    if any(symbol not in entered for symbol in dimensions):
        raise HTTPException(422, "Unreferenced unit candidate")
    canonical = {item.entered: item.symbol for item in approvals}
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
                               "unit": canonical[material.unit], "price_jpy": material.price_jpy,
                               "price_quantity": material.price_quantity,
                               "price_unit": canonical[material.price_unit]})
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
                op["unit"] = canonical[material.unit]
            operations.append(op)
    if body.selling_price_jpy is not None:
        operations.append({"op": "set_selling_price", "value_jpy": body.selling_price_jpy})
    recipe = Recipe(recipe_id, TrackedValue(title, "confirmed", "user"))
    if operations:
        try:
            recipe = prepare_mutation(
                recipe, Proposal(recipe_id, 0, recipe_id, tuple(operations)),
                user_confirmed=True)
        except (MutationError, ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, "Invalid spoken recipe values") from exc
    # Product V1: every recipe row references a concrete owner Ingredient.
    # A recipe never owns purchase prices; approved quotes update the same
    # master transaction and all linked recipes see the updated current cost.
    from .models import Ingredient
    finder=getattr(repository,"find_owned_ingredients_exact",None)
    if not callable(finder):
        raise HTTPException(503,"Ingredient master lookup unavailable")
    reader=getattr(repository,"load_owned_ingredients",None)
    prepared_lines=[]
    catalog={}
    entries_by_name={}
    for line in recipe.materials:
        name=(line.material_name.value or "").strip()
        key=name.casefold()
        entry=entries_by_name.get(key)
        if entry is None:
            matches=finder(owner,name)
            if len(matches)>1:
                raise HTTPException(409,"Ambiguous ingredient identity; select a master")
            if matches:
                raw=matches[0]
                ing_id=str(raw["id"])
                if not callable(reader):
                    raise HTTPException(503,"Ingredient master lookup unavailable")
                saved_catalog=reader(owner,[ing_id])
                ingredient=saved_catalog.get(ing_id)
                if ingredient is None:
                    raise HTTPException(409,"Ingredient master disappeared")
                existing_price=ingredient.current_price
            else:
                ing_id=str(uuid4())
                existing_price=None
            entry={"id":ing_id,"name":name,"current_price":None}
            entries_by_name[key]=entry
            catalog[ing_id]=Ingredient(ing_id,name,existing_price)
        ing_id=entry["id"]
        quote=line.price_override
        if quote is not None:
            if entry["current_price"] is not None and entry["current_price"]!=asdict(quote):
                raise HTTPException(422,"Conflicting quotes for one shared ingredient")
            entry["current_price"]=asdict(quote)
            catalog[ing_id]=Ingredient(ing_id,name,quote)
        prepared_lines.append(replace(line,ingredient_id=ing_id,
                                      price_mode="inherit",price_override=None))
    recipe=replace(recipe,materials=tuple(prepared_lines))
    ingredient_entries=tuple(entries_by_name.values())
    # The Supabase create_owned_recipe RPC requires initial revision 0.
    recipe = replace(recipe, revision=0)
    try:
        snapshot = _json(asdict(calculate_cost(recipe, catalog, unit_factor_catalog(known_units))))
        repository.create_owned_recipe(owner, recipe, snapshot, unit_candidates=new_units,
                                       ingredient_entries=ingredient_entries)
    except ValueError as exc:
        raise HTTPException(409, "Recipe already exists") from exc
    # The transaction resolves canonical unit IDs in the stored state.
    # Return the persisted representation, not the pre-commit proposal.
    committed = repository.load_owned_recipe(owner, recipe_id)
    return _displayed_recipe(owner, repository, committed)

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
    unit_loader = getattr(repository, "list_owned_units", None)
    units = unit_factor_catalog(unit_loader(owner)) if callable(unit_loader) else {}
    return _json(asdict(calculate_cost(recipe, catalog, units)))


class AIProposalBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    instruction: str = Field(min_length=1, max_length=4000, pattern=r".*\S.*")


@router.post("/recipes/{recipe_id}/propose")
def propose_demo_change(recipe_id: UUID, body: AIProposalBody,
                        request: Request, ctx=Depends(demo_context),
                        tools: str = ""):
    """Untrusted suggestion only. Never commit or confirm AI output here.

    tools="" (default) keeps the exact legacy path. tools="ledger" enables
    the Block 1 owned-ledger function loop (read-only ingredient-ID search);
    anything else is rejected. The tool path needs a MetaResponsesProvider.
    """
    from .ai_provider import ProposalProviderError
    owner, repository = ctx
    provider = getattr(request.app.state, "ai_provider", None)
    if provider is None:
        raise HTTPException(503, "AI provider not configured")
    if tools not in ("", "ledger"):
        raise HTTPException(422, "Unknown tools option")
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
        if tools == "ledger":
            run_tools = getattr(provider, "propose_with_tools", None)
            if run_tools is None:
                raise HTTPException(503, "Tool path requires the Meta provider")
            operations = run_tools(body.instruction, context,
                                   _tool_search(owner, repository, recipe))
        else:
            operations = provider.propose(body.instruction, context)
    except ProposalProviderError as exc:
        raise HTTPException(502, "AI provider unavailable or invalid response") from exc
    # Pure validation on a copy: reject malformed/unknown edits before showing a diff.
    if operations:
        try:
            catalog = (repository.load_owned_catalog(owner, recipe)
                       if any(m.price_mode == "inherit" for m in recipe.materials) else {})
            if tools == "ledger":
                # Tool-resolved links reference owned ingredients the
                # recipe-costing catalog does not contain yet. Load exactly
                # those IDs owner-scoped (same pattern as save_recipe_with_ledger
                # explicit IDs); ownership is enforced by the repository.
                loader = getattr(repository, "load_owned_ingredients", None)
                linked = {op["ingredient_id"] for op in operations
                          if isinstance(op, dict) and op.get("op") == "link_ingredient"
                          and isinstance(op.get("ingredient_id"), str)}
                if linked and callable(loader):
                    catalog = {**(catalog or {}), **(loader(owner, sorted(linked)) or {})}
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


# --- M5: price observations, comparison, impact (owner-scoped, read-mostly) ---

class ObservationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount_jpy: str = Field(max_length=30)
    currency: str = Field(default="JPY", max_length=10)
    tax_note: str | None = Field(default=None, max_length=200)
    shipping_note: str | None = Field(default=None, max_length=200)
    source: str = Field(default="manual_entry", max_length=20)
    confirmed: bool = False
    observed_at: str | None = Field(default=None, max_length=40)


def _observation_or_404(repository, owner: str, observation_id: str) -> dict:
    getter = getattr(repository, "get_owned_observation", None)
    if not callable(getter):
        raise HTTPException(503, "Price history not configured")
    try:
        return getter(owner, observation_id)
    except ValueError as exc:
        raise HTTPException(404, "Observation not found or inaccessible") from exc


def _to_price_observation(row: dict):
    from .price_history import PriceObservation
    return PriceObservation(
        id=str(row["id"]), ingredient_id=str(row["ingredient_id"]),
        offer_id=str(row["offer_id"]),
        supplier_id=(str(row["supplier_id"]) if row.get("supplier_id") else None),
        amount=str(row["amount_jpy"]), currency=str(row["currency"]),
        tax_note=row.get("tax_note"), shipping_note=row.get("shipping_note"),
        package_quantity=str(row.get("package_quantity") or ""),
        package_unit=str(row.get("package_unit") or ""),
        source=str(row["source"]), confirmed=bool(row.get("confirmed")),
        observed_at=str(row.get("observed_at") or ""))


@router.post("/offers/{offer_id}/observations", status_code=201)
def create_demo_observation(offer_id: UUID, body: ObservationBody,
                            ctx=Depends(demo_context)):
    """Append one price fact. Appending never adopts a price: the
    ingredient's current quote and adoption reference stay untouched."""
    owner, repository = ctx
    creator = getattr(repository, "create_owned_observation", None)
    if not callable(creator):
        raise HTTPException(409, "Price history not supported by repository")
    try:
        new_id = creator(
            owner, str(offer_id), body.amount_jpy, currency=body.currency,
            tax_note=body.tax_note, shipping_note=body.shipping_note,
            source=body.source, confirmed=body.confirmed,
            observed_at=body.observed_at)
    except ValueError as exc:
        if "not owned" in str(exc):
            raise HTTPException(404, "Offer not found or inaccessible") from exc
        raise HTTPException(422, str(exc)) from exc
    return {"id": new_id}


@router.get("/ingredients/{ingredient_id}/observations")
def list_demo_observations(ingredient_id: UUID,
                           limit: int = Query(default=100, ge=1, le=200),
                           ctx=Depends(demo_context)):
    """Append-only price history for one owned ingredient, newest first."""
    owner, repository = ctx
    lister = getattr(repository, "list_ingredient_observations", None)
    if not callable(lister):
        raise HTTPException(503, "Price history not configured")
    try:
        items = lister(owner, str(ingredient_id), limit=limit)
    except ValueError as exc:
        raise HTTPException(404, "Ingredient not found or inaccessible") from exc
    return {"items": [_json(item) for item in items]}


class CompareBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidate_observation_id: UUID
    base_observation_id: UUID | None = None
    base_adopted: bool = False


@router.post("/ingredients/{ingredient_id}/observations/compare")
def compare_demo_observations(ingredient_id: UUID, body: CompareBody,
                              ctx=Depends(demo_context)):
    """Compare a candidate observation against an explicit basis: either a
    named observation or the ingredient's adopted price. Terms must match
    exactly; otherwise reasons are returned and no numbers are invented."""
    from .price_history import compare_observations
    owner, repository = ctx
    if (body.base_observation_id is None) == (not body.base_adopted):
        raise HTTPException(422, "Exactly one comparison basis required")
    candidate = _to_price_observation(_observation_or_404(
        repository, owner, str(body.candidate_observation_id)))
    if body.base_adopted:
        adoption = getattr(repository, "get_owned_ingredient_adoption", None)
        if not callable(adoption):
            raise HTTPException(503, "Price history not configured")
        try:
            ref = adoption(owner, str(ingredient_id))
        except ValueError as exc:
            raise HTTPException(404, "Ingredient not found or inaccessible") from exc
        if not ref.get("adopted_observation_id"):
            raise HTTPException(422, "Ingredient has no adopted price")
        base = _to_price_observation(_observation_or_404(
            repository, owner, str(ref["adopted_observation_id"])))
    else:
        base = _to_price_observation(_observation_or_404(
            repository, owner, str(body.base_observation_id)))
    for obs in (base, candidate):
        if obs.ingredient_id != str(ingredient_id):
            raise HTTPException(422, "Observation does not belong to this ingredient")
    return _json(asdict(compare_observations(base, candidate, _owned_unit_definitions(owner, repository))))


def _impact_envelope(owner: str, repository, ingredient_id: str,
                   observation_id: str,
                   basis_override: str | None = None) -> dict:
    """Shared M5 envelope for price-impact and M6 notification detail.

    Compares the candidate against the adopted basis, or against
    basis_override when a notification carries its creation-time
    basis: past notifications then reproduce their original numbers
    even after the adopted price moves. Without a basis or on term
    mismatch no yen cost difference is produced. Reads only.
    """
    from .price_history import assess_impact, compare_observations, observation_quote
    finder = getattr(repository, "list_recipes_using_ingredient", None)
    if not callable(finder):
        raise HTTPException(503, "Price history not configured")
    row = _observation_or_404(repository, owner, observation_id)
    obs = _to_price_observation(row)
    if obs.ingredient_id != ingredient_id:
        raise HTTPException(422, "Observation does not belong to this ingredient")
    adoption = getattr(repository, "get_owned_ingredient_adoption", None)
    if not callable(adoption):
        raise HTTPException(503, "Price history not configured")
    try:
        ref = adoption(owner, ingredient_id)
    except ValueError as exc:
        raise HTTPException(404, "Ingredient not found or inaccessible") from exc
    if basis_override is not None:
        basis_id = basis_override
        try:
            base = _to_price_observation(_observation_or_404(
                repository, owner, str(basis_id)))
        except ValueError:
            return {"basis_observation_id": str(basis_id),
                    "comparable": False,
                    "reasons": ["original price basis unavailable"],
                    "items": []}
        if base.ingredient_id != ingredient_id:
            return {"basis_observation_id": str(basis_id),
                    "comparable": False,
                    "reasons": ["original price basis unavailable"],
                    "items": []}
        comparison = compare_observations(base, obs, _owned_unit_definitions(owner, repository))
        if not comparison.comparable:
            return {"basis_observation_id": str(basis_id),
                    "comparable": False,
                    "reasons": list(comparison.reasons), "items": []}
        if obs.currency != "JPY" or base.currency != "JPY":
            return {"basis_observation_id": str(basis_id),
                    "comparable": False,
                    "reasons": ["non-JPY currency cannot be used for JPY cost impact"],
                    "items": []}
    else:
        basis_id = ref.get("adopted_observation_id")
    if not basis_id:
        return {"basis_observation_id": None, "comparable": False,
                "reasons": ["no adopted price basis"], "items": []}
    base = _to_price_observation(_observation_or_404(
        repository, owner, str(basis_id)))
    comparison = compare_observations(base, obs)
    if not comparison.comparable:
        return {"basis_observation_id": str(basis_id), "comparable": False,
                "reasons": list(comparison.reasons), "items": []}
    if obs.currency != "JPY" or base.currency != "JPY":
        return {"basis_observation_id": str(basis_id), "comparable": False,
                "reasons": ["non-JPY currency cannot be used for JPY cost impact"],
                "items": []}
    quote = observation_quote(obs)
    if quote is None:
        raise HTTPException(422, "Observation package terms cannot price a line")
    try:
        recipes = finder(owner, ingredient_id)
    except ValueError as exc:
        raise HTTPException(404, "Ingredient not found or inaccessible") from exc
    needed = sorted({m.ingredient_id for recipe in recipes for m in recipe.materials
                     if m.price_mode == "inherit" and m.ingredient_id})
    loader = getattr(repository, "load_owned_ingredients", None)
    catalog = loader(owner, needed) if callable(loader) else {}
    impacts = assess_impact(tuple(recipes), catalog or {},
                            ingredient_id, quote)
    return {"basis_observation_id": str(basis_id), "comparable": True,
            "reasons": [],
            "items": [_json(asdict(impact)) for impact in impacts]}


@router.get("/ingredients/{ingredient_id}/price-impact")
def impact_demo_price(ingredient_id: UUID, observation_id: UUID,
                      ctx=Depends(demo_context)):
    """Hypothetical current-cost impact as if the observation were adopted.

    The candidate is gated on the adopted price basis: without an
    adopted observation, or when currency/tax/shipping/package terms do
    not match, no yen cost difference is produced -- reasons are
    returned instead and nothing is guessed. Reads only: recipes,
    snapshots, and adopted prices are never written."""
    owner, repository = ctx
    return _impact_envelope(owner, repository, str(ingredient_id),
                            str(observation_id))


# --- Price reference for natural-language research requests (read-only) ---

MAX_REFERENCE_CANDIDATES = 3


@router.get("/price-reference")
def reference_demo_price(name: str = Query(default="", max_length=200),
                         ctx=Depends(demo_context)):
    """Ledger-grounded reference price for draft creation.

    Resolves a spoken ingredient name against the caller's owned ledger
    (up to three candidates) and returns a deterministic representative
    unit price per candidate, computed only from comparable owned
    observations via summarize_reference_price. No web retrieval exists,
    so nothing here invents market prices: unknown terms stay unknown.
    Reads only; never adopts, confirms, or writes anything.
    """
    from .external_reference import EXTERNAL_REFERENCE_STATUS
    from .price_history import summarize_reference_price
    owner, repository = ctx
    query = (name or "").strip()
    if not query:
        raise HTTPException(422, "Ingredient name required")
    searcher = getattr(repository, "search_owned_ingredients", None)
    offers_of = getattr(repository, "list_ingredient_offers", None)
    latest_of = getattr(repository, "list_latest_observations_for_offers", None)
    if not callable(searcher) or not callable(offers_of) or not callable(latest_of):
        raise HTTPException(503, "Price reference not configured")
    hits = [hit for hit in (searcher(owner, query, MAX_REFERENCE_CANDIDATES) or [])
            if isinstance(hit, dict) and hit.get("id") and hit.get("name")]
    hits = hits[:MAX_REFERENCE_CANDIDATES]
    candidates = []
    for hit in hits:
        ingredient_id = str(hit["id"])
        try:
            offers = offers_of(owner, ingredient_id) or []
        except ValueError:
            continue
        offer_ids = [str(offer.get("id")) for offer in offers if offer.get("id")]
        per_offer = latest_of(owner, offer_ids) if offer_ids else {}
        observations = []
        provenance = []
        for offer in offers:
            row = per_offer.get(str(offer.get("id")))
            if not isinstance(row, dict) or not row.get("id"):
                continue
            full = {"id": row.get("id"), "ingredient_id": ingredient_id,
                    "offer_id": offer.get("id"),
                    "supplier_id": row.get("supplier_id"),
                    "amount_jpy": row.get("amount_jpy"),
                    "currency": row.get("currency"),
                    "tax_note": row.get("tax_note"),
                    "shipping_note": row.get("shipping_note"),
                    "package_quantity": (offer.get("package_quantity")
                                         or row.get("package_quantity")),
                    "package_unit": (offer.get("package_unit")
                                     or row.get("package_unit")),
                    "source": row.get("source"),
                    "confirmed": row.get("confirmed"),
                    "observed_at": row.get("observed_at")}
            try:
                observations.append(_to_price_observation(full))
            except (KeyError, TypeError, ValueError):
                continue
            provenance.append({
                "observation_id": str(row.get("id")),
                "amount": row.get("amount_jpy"),
                "currency": row.get("currency"),
                "package_quantity": full["package_quantity"],
                "package_unit": full["package_unit"],
                "source": row.get("source"),
                "observed_at": row.get("observed_at"),
                "supplier_id": row.get("supplier_id")})
        candidates.append({
            "ingredient_id": ingredient_id,
            "ingredient_name": hit.get("name"),
            "reference": summarize_reference_price(observations),
            "observations": provenance})
    return _json({"query": query, "candidates": candidates,
                 "external": dict(EXTERNAL_REFERENCE_STATUS)})


# --- M6: price-change bell notifications (explicit confirmation only) ---

class NotificationStatusBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str = Field(max_length=20)


def _notification_or_404(repository, owner: str, notification_id: str) -> dict:
    getter = getattr(repository, "get_owned_notification", None)
    if not callable(getter):
        raise HTTPException(503, "Price notifications not configured")
    try:
        return getter(owner, notification_id)
    except ValueError as exc:
        raise HTTPException(404, "Notification not found or inaccessible") from exc


@router.post("/observations/{observation_id}/confirm", status_code=201)
def confirm_demo_observation(observation_id: UUID, ctx=Depends(demo_context)):
    """Explicitly confirm one price observation, notifying exactly once.

    Comparable confirmations create (or reuse, on resend) one
    notification; missing bases and incomparable terms yield reasons
    and create nothing. Thresholds and cadence are undecided, so no
    automatic or scheduled confirmation exists here.
    """
    owner, repository = ctx
    confirmer = getattr(repository, "confirm_observation_notification", None)
    if not callable(confirmer):
        raise HTTPException(503, "Price notifications not configured")
    try:
        result = confirmer(owner, str(observation_id))
    except ValueError as exc:
        message = str(exc)
        if "not owned" in message or "not owned by caller" in message:
            raise HTTPException(404, "Observation not found or inaccessible") from exc
        raise HTTPException(422, message) from exc
    return {"created": bool(result["created"]),
            "notification": _json(result["notification"]),
            "comparison": _json(result["comparison"])}


def _load_sourcing_inputs(owner, repository, ingredient_id):
    """Shared read-only loader for sourcing suggestions (M7 pool).

    Bulk reads only: one bounded call per group, never one query per
    offer or per similar ingredient (N+1). Raises HTTPException for
    unknown/inaccessible ingredients. No writes.
    """
    loaders = ("load_owned_ingredients", "list_ingredient_offers",
               "list_latest_observations_for_offers",
               "list_latest_observations_for_ingredients",
               "get_owned_ingredient_adoption", "search_owned_ingredients")
    if any(not callable(getattr(repository, name, None)) for name in loaders):
        raise HTTPException(503, "Sourcing suggestions not configured")
    try:
        owned = repository.load_owned_ingredients(owner, [str(ingredient_id)])
    except ValueError as exc:
        raise HTTPException(404, "Ingredient not found or inaccessible") from exc
    ingredient = owned.get(str(ingredient_id))
    if ingredient is None:
        raise HTTPException(404, "Ingredient not found or inaccessible")
    name = getattr(ingredient, "name", str(ingredient_id))
    adopted = None
    try:
        ref = repository.get_owned_ingredient_adoption(owner, str(ingredient_id))
    except ValueError as exc:
        raise HTTPException(404, "Ingredient not found or inaccessible") from exc
    if ref.get("adopted_observation_id"):
        try:
            adopted = _to_price_observation(_observation_or_404(
                repository, owner, str(ref["adopted_observation_id"])))
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            adopted = None
    # Bulk latest-price reads: one bounded call per group, never one
    # query per offer or per similar ingredient (N+1), and exact even
    # when an offer's history is long (no top-N truncation dropout).
    offers = repository.list_ingredient_offers(owner, str(ingredient_id))
    per_offer = repository.list_latest_observations_for_offers(
        owner, [offer.get("id") for offer in offers])
    reference_supplier_id = (
        adopted.supplier_id if adopted is not None else None)
    adopted_offer_id = (
        adopted.offer_id if adopted is not None else None)
    same_offers = []
    for offer in offers:
        row = per_offer.get(str(offer.get("id")))
        obs = None
        if row is not None:
            obs = {"id": row.get("id"),
                   "amount": row.get("amount_jpy"),
                   "currency": row.get("currency"),
                   "tax_note": row.get("tax_note"),
                   "shipping_note": row.get("shipping_note"),
                   "source": row.get("source"),
                   "confirmed": row.get("confirmed"),
                   "observed_at": row.get("observed_at"),
                   "supplier_id": row.get("supplier_id")}
        same_offers.append({
            "offer_id": offer.get("id"),
            "supplier_id": offer.get("supplier_id"),
            "supplier_name": (row or {}).get("supplier_name"),
            "product_url": offer.get("product_url") or (row or {}).get("product_url"),
            "package_quantity": offer.get("package_quantity"),
            "package_unit": offer.get("package_unit"),
            "observation": obs,
            "data_origin": ("registered_reference"
                            if row is not None
                            and row.get("source") == "web_reference"
                            else "ledger")})
    hits = [hit for hit in
            repository.search_owned_ingredients(owner, name, limit=6)
            if str(hit.get("id")) != str(ingredient_id)][:5]
    per_ingredient = (repository.list_latest_observations_for_ingredients(
        owner, [hit.get("id") for hit in hits]) if hits else {})
    similar = []
    for hit in hits:
        row = per_ingredient.get(str(hit.get("id")))
        obs = None
        if row is not None:
            obs = {"id": row.get("id"),
                   "amount": row.get("amount_jpy"),
                   "currency": row.get("currency"),
                   "tax_note": row.get("tax_note"),
                   "shipping_note": row.get("shipping_note"),
                   "source": row.get("source"),
                   "confirmed": row.get("confirmed"),
                   "observed_at": row.get("observed_at"),
                   "supplier_id": row.get("supplier_id")}
        similar.append({"ingredient_id": hit.get("id"),
                        "ingredient_name": hit.get("name"),
                        "offer_id": row.get("offer_id") if row else None,
                        "supplier_id": row.get("supplier_id") if row else None,
                        "supplier_name": row.get("supplier_name") if row else None,
                        "product_url": row.get("product_url") if row else None,
                        "package_quantity": row.get("package_quantity") if row else None,
                        "package_unit": row.get("package_unit") if row else None,
                        "observation": obs,
                        "data_origin": "ledger"})
    return {"name": name, "adopted": adopted, "same_offers": same_offers,
            "similar": similar,
            "reference_supplier_id": reference_supplier_id,
            "adopted_offer_id": adopted_offer_id}


@router.get("/ingredients/{ingredient_id}/sourcing-suggestions")
def suggest_demo_sourcing(
        ingredient_id: UUID,
        max_candidates: int = Query(default=3, ge=1, le=10),
        ctx=Depends(demo_context)):
    """Propose alternate suppliers / substitute products (M7). Read-only.

    Candidates come only from the caller's owned ledger: other offers of
    the same ingredient, then similarly named owned ingredients (never
    merged by name). External web retrieval is unavailable, so the
    provider status says so instead of inventing listings. Nothing here
    writes, adopts, or switches anything; the chef decides.
    """
    from .substitute_sourcing import suggest_sourcing
    owner, repository = ctx
    loaded = _load_sourcing_inputs(owner, repository, str(ingredient_id))
    name = loaded["name"]
    adopted = loaded["adopted"]
    same_offers = loaded["same_offers"]
    similar = loaded["similar"]
    reference_supplier_id = loaded["reference_supplier_id"]
    adopted_offer_id = loaded["adopted_offer_id"]
    return _json(suggest_sourcing(
        ingredient_id=str(ingredient_id), ingredient_name=name,
        adopted=adopted, same_offers=same_offers, similar=similar,
        max_candidates=max_candidates,
        reference_supplier_id=reference_supplier_id,
        adopted_offer_id=adopted_offer_id))


@router.get("/ingredients/{ingredient_id}/axis-suggestions")
def suggest_demo_axis(ingredient_id: UUID,
                      max_candidates: int = Query(default=3, ge=1, le=5),
                      use_muse: bool = Query(default=True),
                      request: Request = None,
                      ctx=Depends(demo_context)):
    """3-axis picks (cost / compatibility / quality) over owned ledger rows.

    Read-only. The candidate pool is the M7 flow (other offers of the same
    ingredient, then similarly named owned ingredients, never merged by
    name; external retrieval stays unavailable). Cost is picked
    deterministically in Python from the M5 comparison; compatibility and
    quality come from at most one Muse semantic evaluation over
    ledger-registered facts. Unqualifying axes stay empty with reasons;
    nothing here writes, adopts, or switches anything.
    """
    import json
    from .axis_sourcing import (AxisEvaluationError, assign_axes,
                                build_axis_prompt)
    from .substitute_sourcing import EXTERNAL_PROVIDER_STATUS, suggest_sourcing
    owner, repository = ctx
    loaded = _load_sourcing_inputs(owner, repository, str(ingredient_id))
    pool = suggest_sourcing(
        ingredient_id=str(ingredient_id), ingredient_name=loaded["name"],
        adopted=loaded["adopted"], same_offers=loaded["same_offers"],
        similar=loaded["similar"], max_candidates=10,
        reference_supplier_id=loaded["reference_supplier_id"],
        adopted_offer_id=loaded["adopted_offer_id"])
    candidates = pool.get("candidates", [])
    evaluations, skipped, muse_used, muse_error = [], 0, False, None
    if use_muse:
        provider = getattr(request.app.state, "ai_provider", None) \
            if request is not None else None
        if provider is None or not hasattr(provider, "evaluate_sourcing_axes"):
            muse_error = "Muse axis evaluation not configured"
        else:
            try:
                prompt = json.dumps(
                    build_axis_prompt(loaded["name"], candidates),
                    ensure_ascii=False)
                evaluations = provider.evaluate_sourcing_axes(prompt)
                muse_used = True
            except AxisEvaluationError as exc:
                muse_error = f"Muse response unusable: {exc}"
            except Exception as exc:
                muse_error = (f"Muse evaluation failed: "
                              f"{type(exc).__name__}")
    result = assign_axes(
        ingredient_id=str(ingredient_id), ingredient_name=loaded["name"],
        candidates=candidates, evaluations=evaluations,
        skipped_evaluations=skipped, muse_used=muse_used,
        muse_error=muse_error, max_picks=max_candidates,
        unit_definitions=_owned_unit_definitions(owner, repository))
    result["provider"] = {"external": dict(EXTERNAL_PROVIDER_STATUS),
                          "muse": result.pop("muse_status")}
    if pool.get("shortage_note") and not result.get("shortage_note"):
        result["shortage_note"] = pool["shortage_note"]
    return _json(result)


@router.get("/notifications")
def list_demo_notifications(status: str | None = Query(default=None, max_length=20),
                            limit: int = Query(default=100, ge=1, le=200),
                            ctx=Depends(demo_context)):
    """Owner-scoped notifications, newest first, optional status filter.

    Each item carries its unit-price difference (change_jpy, JPY per
    unit_basis) with the unit retained -- never a hardcoded unit.
    """
    from .price_history import compare_observations
    owner, repository = ctx
    lister = getattr(repository, "list_owned_notifications", None)
    if not callable(lister):
        raise HTTPException(503, "Price notifications not configured")
    try:
        items = lister(owner, status=status, limit=limit)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    bulk = getattr(repository, "get_owned_observations", None)
    adoption = getattr(repository, "get_owned_ingredient_adoption", None)
    enriched = []
    candidate_rows: dict = {}
    basis_rows: dict = {}
    if callable(bulk) and items:
        try:
            candidate_rows = bulk(
                owner, [str(i["observation_id"]) for i in items])
            # Stored creation-time bases first: history must not move
            # when the adopted price changes later.
            stored_basis_ids = sorted({
                str(i["basis_observation_id"]) for i in items
                if i.get("basis_observation_id")})
            legacy_ingredient_ids: dict[str, str] = {}
            if callable(adoption):
                for i in items:
                    if not i.get("basis_observation_id"):
                        row0 = candidate_rows.get(str(i["observation_id"]))
                        if row0 is not None:
                            legacy_ingredient_ids[str(i["observation_id"])] = \
                                str(row0["ingredient_id"])
            current_basis_ids: dict[str, str] = {}
            if callable(adoption):
                for oid, iid in legacy_ingredient_ids.items():
                    try:
                        ref = adoption(owner, iid)
                    except ValueError:
                        continue
                    if ref.get("adopted_observation_id"):
                        current_basis_ids[oid] = str(
                            ref["adopted_observation_id"])
            wanted = sorted(set(stored_basis_ids)
                            | set(current_basis_ids.values()))
            if wanted:
                basis_rows = bulk(owner, wanted)
        except ValueError:
            candidate_rows, basis_rows = {}, {}
    for item in items:
        extra: dict = {"unit_basis": item.get("unit_basis"),
                       "currency": None}
        row = candidate_rows.get(str(item["observation_id"]))
        basis_id = item.get("basis_observation_id")
        if row is not None:
            if not basis_id:
                basis_id = current_basis_ids.get(str(item["observation_id"]))
            base_row = basis_rows.get(str(basis_id)) if basis_id else None
            if base_row is not None:
                comp = compare_observations(
                    _to_price_observation(base_row),
                    _to_price_observation(row))
                if comp.comparable:
                    extra = {"unit_basis": item.get("unit_basis")
                             or comp.unit_basis,
                             "currency": comp.currency}
                else:
                    extra = {"unit_basis": item.get("unit_basis"),
                             "currency": None,
                             "reasons": list(comp.reasons)}
        enriched.append({**item, **extra})
    return {"items": [_json(item) for item in enriched]}
@router.get("/notifications/{notification_id}")
def get_demo_notification(notification_id: UUID, ctx=Depends(demo_context)):
    """Notification detail with observation, basis comparison, and the
    related recipes' hypothetical cost impact. Reads only: adopted
    prices and saved recipe versions are never written."""
    owner, repository = ctx
    from .price_history import compare_observations
    note = _notification_or_404(repository, owner, str(notification_id))
    row = _observation_or_404(repository, owner, str(note["observation_id"]))
    envelope = _impact_envelope(owner, repository, str(note["ingredient_id"]),
                                str(note["observation_id"]),
                                basis_override=(str(note["basis_observation_id"])
                                    if note.get("basis_observation_id") else None))
    comparison: dict = {"comparable": envelope["comparable"],
                        "reasons": envelope["reasons"],
                        "currency": None, "unit_basis": None,
                        "base_unit_price": None, "new_unit_price": None,
                        "diff": None, "rate_pct": None,
                        "basis_observation_id": envelope["basis_observation_id"]}
    if envelope["basis_observation_id"]:
        base_row = _observation_or_404(
            repository, owner, str(envelope["basis_observation_id"]))
        comp = compare_observations(_to_price_observation(base_row),
                                    _to_price_observation(row))
        if comp.comparable:
            comparison.update(currency=comp.currency,
                              unit_basis=(note.get("unit_basis")
                                          or comp.unit_basis),
                              base_unit_price=comp.base_unit_price,
                              new_unit_price=comp.new_unit_price,
                              diff=comp.diff, rate_pct=comp.rate_pct)
    return {"notification": _json(note),
            "observation": _json(row),
            "basis_observation_id": envelope["basis_observation_id"],
            "comparable": envelope["comparable"],
            "comparison": _json(comparison),
            "reasons": envelope["reasons"],
            "items": envelope["items"]}


@router.patch("/notifications/{notification_id}")
def update_demo_notification(notification_id: UUID,
                             body: NotificationStatusBody,
                             ctx=Depends(demo_context)):
    """Move a notification unread/acknowledged/resolved. Status only:
    acknowledging never adopts a price or changes a supplier."""
    owner, repository = ctx
    from .price_notifications import NotificationConflict
    updater = getattr(repository, "update_notification_status", None)
    if not callable(updater):
        raise HTTPException(503, "Price notifications not configured")
    try:
        updated = updater(owner, str(notification_id), body.status)
    except NotificationConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        message = str(exc)
        if "not owned" in message:
            raise HTTPException(404, "Notification not found or inaccessible") from exc
        raise HTTPException(422, message) from exc
    return _json(updated)
