"""Trusted-server orchestration: validated edit -> cost snapshot -> atomic revision RPC.

This is not an HTTP endpoint. Authentication and a database client are injected
by the server; never accept an owner ID or a service-role key from model output.
"""
from dataclasses import asdict, dataclass
from decimal import Decimal
from hashlib import sha256
import json
from typing import Mapping, Protocol

from .costing import calculate_cost
from .models import Ingredient, Recipe
from .mutations import Proposal, prepare_mutation, MutationError


def _json(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, tuple):
        return [_json(v) for v in value]
    if isinstance(value, list):
        return [_json(v) for v in value]
    if isinstance(value, dict):
        return {k: _json(v) for k, v in value.items()}
    return value


def canonical_json(value) -> str:
    return json.dumps(_json(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class TrustedPersistence(Protocol):
    """Implemented only inside authenticated server code."""
    def load_owned_recipe(self, owner_id: str, recipe_id: str) -> Recipe: ...
    def get_mutation_receipt(self, owner_id: str, request_id: str) -> tuple[str, int] | None: ...
    def load_owned_catalog(self, owner_id: str, recipe: Recipe) -> Mapping[str, Ingredient]: ...
    def commit_recipe_revision(self, *, owner_id: str, recipe_id: str,
                               request_id: str, base_revision: int,
                               state: dict, title: str, cost_snapshot: dict,
                               payload_hash: str, save_version: bool) -> int: ...


@dataclass(frozen=True)
class LedgerIngredient:
    """A ledger write validated before any persistence.

    kind "new": register under the caller's ownership. kind "reuse": reference
    an ingredient already owned by the caller. No cross-owner references.
    """
    kind: str
    id: str | None = None
    name: str | None = None
    brand: str | None = None
    spec: str | None = None


@dataclass(frozen=True)
class SavedRecipeWithLedger:
    recipe: Recipe
    resulting_revision: int
    replayed: bool
    saved_ingredient_ids: tuple[str, ...]


class LedgerPersistence(TrustedPersistence, Protocol):
    """Extended repository. Adds one atomic commit; all other methods stay.

    The atomic commit returns a non-negative revision on a fresh commit and
    the negated revision (negative int) when an existing receipt is replayed,
    so concurrent losers can distinguish replay from a fresh commit at the
    same revision number.
    """
    def commit_recipe_with_ledger(self, *, owner_id: str, recipe_id: str,
                                  request_id: str, base_revision: int,
                                  state: dict, title: str, cost_snapshot: dict,
                                  payload_hash: str, save_version: bool,
                                  new_ingredients: tuple[dict, ...]) -> int: ...


def _validate_ledger(ledger: tuple[LedgerIngredient, ...],
                     owned: Mapping[str, Ingredient],
                     request_id: str | None = None) -> tuple[dict, ...]:
    from uuid import UUID as _UUID, NAMESPACE_URL as _NS, uuid4 as _uuid4, uuid5 as _uuid5
    prepared: list[dict] = []
    seen: set[str] = set()
    for index, entry in enumerate(ledger):
        if entry.kind == "reuse":
            if not entry.id or entry.id not in owned:
                raise MutationError("Reuse requires an ingredient owned by the caller")
            if entry.id in seen:
                raise MutationError("Duplicate ledger ingredient")
            seen.add(entry.id)
            prepared.append({"kind": "reuse", "id": entry.id})
        elif entry.kind == "new":
            if not entry.name or not entry.name.strip():
                raise MutationError("New ingredient requires a name")
            # Deterministic IDs keep concurrent retries with the same request_id
            # on the same identity; explicit IDs stay caller-supplied.
            if entry.id:
                new_id = entry.id
            elif request_id:
                new_id = str(_uuid5(_NS, f"{request_id}:ledger-new:{index}"))
            else:
                new_id = str(_uuid4())
            try:
                _UUID(new_id)
            except (ValueError, TypeError, AttributeError) as exc:
                raise MutationError("Invalid ingredient ID") from exc
            if new_id in owned or new_id in seen:
                raise MutationError("Ingredient already registered")
            seen.add(new_id)
            prepared.append({"kind": "new", "id": new_id,
                             "name": entry.name.strip(),
                             "brand": entry.brand, "spec": entry.spec})
        else:
            raise MutationError("Unknown ledger ingredient kind")
    return tuple(prepared)


def save_recipe_with_ledger(*, owner_id: str, trusted_user_confirmed: bool,
                            proposal: Proposal,
                            ledger: tuple[LedgerIngredient, ...] = (),
                            repository: LedgerPersistence,
                            catalog: Mapping[str, Ingredient] | None = None,
                            save_version: bool = False) -> SavedRecipeWithLedger:
    """Validate recipe edits and ledger writes before any persistence.

    Existing save_validated_mutation is untouched; this is the additive path
    for "new ingredients + recipe references saved as one approved request".
    Price proposals alone never adopt master prices: new ingredients carry no
    price or adopted reference unless explicitly supplied through later
    adoption flows. Confirmation binding follows prepare_mutation exactly.

    Human Gate: calling this function IS the save. The caller must invoke it
    only from an explicit user approval action (POST /recipes/{id}/confirm
    or the operator-gated demo confirm). trusted_user_confirmed selects
    value provenance (True: attributable instructions become "confirmed";
    False: values stay "assumed"/estimate) -- it is NOT a save-approval
    flag, and False still persists. Never derive either argument from
    model output or client fields.
    """
    if not isinstance(owner_id, str) or not owner_id.strip():
        raise MutationError("Verified user ID required")
    if type(trusted_user_confirmed) is not bool:
        raise MutationError("Trusted confirmation decision required")
    commit = getattr(repository, "commit_recipe_with_ledger", None)
    if not callable(commit):
        raise MutationError("Ledger commit not supported by repository")
    payload_hash = sha256(canonical_json({
        "proposal": asdict(proposal), "confirmed": trusted_user_confirmed,
        "save_version": save_version,
        "ledger": [asdict(e) for e in ledger],
    }).encode("utf-8")).hexdigest()
    receipt = repository.get_mutation_receipt(owner_id, proposal.request_id)
    if receipt is not None:
        saved_hash, saved_revision = receipt
        if saved_hash != payload_hash:
            raise MutationError("Request ID reused with different payload")
        existing = repository.load_owned_recipe(owner_id, proposal.recipe_id)
        if existing.revision < saved_revision:
            raise MutationError("Stored receipt ahead of recipe revision")
        return SavedRecipeWithLedger(existing, saved_revision, True, ())
    recipe = repository.load_owned_recipe(owner_id, proposal.recipe_id)
    if catalog is None:
        catalog = repository.load_owned_catalog(owner_id, recipe)
    # Load explicitly named IDs (reuse targets and explicit new IDs) so
    # _validate_ledger can reject collisions with owned ingredients that the
    # recipe-scoped catalog does not contain.
    explicit_ids = [e.id for e in ledger if e.id]
    loader = getattr(repository, "load_owned_ingredients", None)
    if explicit_ids and callable(loader):
        owned_extra = loader(owner_id, explicit_ids) or {}
        catalog = {**(catalog or {}), **owned_extra}
    prepared_ledger = _validate_ledger(ledger, catalog or {},
                                       request_id=proposal.request_id)
    effective = dict(catalog or {})
    for item in prepared_ledger:
        if item["kind"] == "new":
            effective[item["id"]] = Ingredient(id=item["id"], name=item["name"],
                                              current_price=None)
    try:
        candidate = prepare_mutation(recipe, proposal,
                                     user_confirmed=trusted_user_confirmed,
                                     catalog=effective)
    except ValueError as exc:
        raise MutationError(str(exc)) from exc
    try:
        from .costing import unit_factor_catalog
        unit_loader = getattr(repository, "list_owned_units", None)
        units = unit_factor_catalog(unit_loader(owner_id)) if callable(unit_loader) else {}
        price_loader = getattr(repository, "load_owned_supplier_prices", None)
        supplier_prices = price_loader(owner_id, candidate) if callable(price_loader) else {}
        cost = calculate_cost(candidate, effective, units, supplier_prices)
    except ValueError as exc:
        raise MutationError(str(exc)) from exc
    snapshot = asdict(cost)
    if save_version:
        quotes = {}
        for line in candidate.materials:
            if line.price_mode == "inherit":
                if line.offer_id:
                    quote = supplier_prices.get((line.ingredient_id, line.offer_id))
                elif line.supplier_id:
                    quote = supplier_prices.get((line.ingredient_id, line.supplier_id))
                else:
                    ingredient = effective.get(line.ingredient_id or "")
                    quote = ingredient.current_price if ingredient is not None else None
            else:
                quote = line.price_override
            quotes[line.id] = {
                "price_mode": line.price_mode,
                "ingredient_id": line.ingredient_id,
                "supplier_id": line.supplier_id,
                "offer_id": line.offer_id,
                "effective_quote": asdict(quote) if quote is not None else None,
            }
        snapshot["effective_quotes"] = quotes
    state = asdict(candidate)
    revised = commit(
        owner_id=owner_id, recipe_id=recipe.id,
        request_id=proposal.request_id, base_revision=proposal.base_revision,
        state=state, title=candidate.title.value or "",
        cost_snapshot=_json(snapshot), payload_hash=payload_hash,
        save_version=save_version, new_ingredients=tuple(
            item for item in prepared_ledger if item["kind"] == "new"))
    if revised < 0 or revised != candidate.revision:
        # Negative values are explicit receipt replays from the atomic RPC;
        # a matching positive value at an unexpected number is also treated
        # as a replay for backward compatibility with the previous RPC.
        canonical = repository.load_owned_recipe(owner_id, recipe.id)
        return SavedRecipeWithLedger(canonical, abs(revised), True, ())
    saved_ids = tuple(item["id"] for item in prepared_ledger if item["kind"] == "new")
    return SavedRecipeWithLedger(candidate, revised, False, saved_ids)

@dataclass(frozen=True)
class SavedMutation:
    recipe: Recipe
    resulting_revision: int
    replayed: bool


def save_validated_mutation(*, owner_id: str, trusted_user_confirmed: bool,
                            proposal: Proposal, repository: TrustedPersistence,
                            catalog: Mapping[str, Ingredient] | None = None,
                            save_version: bool = False) -> SavedMutation:
    """Prepare all operations before invoking the database transaction.

    The repository's atomic RPC enforces request-id replay and revision CAS.
    The caller MUST derive owner_id and confirmation evidence from auth/session,
    not from client/AI-provided fields.

    Human Gate: calling this function IS the save -- invoke only from an
    explicit user approval action (POST /recipes/{id}/confirm or the
    operator-gated demo confirm). trusted_user_confirmed=False still
    persists; it only keeps values "assumed" (estimate) instead of
    promoting them to "confirmed".
    """
    if not isinstance(owner_id, str) or not owner_id.strip():
        raise MutationError("Verified user ID required")
    if type(trusted_user_confirmed) is not bool:
        raise MutationError("Trusted confirmation decision required")
    payload_hash = sha256(canonical_json({
        "proposal": asdict(proposal), "confirmed": trusted_user_confirmed,
        "save_version": save_version,
    }).encode("utf-8")).hexdigest()
    receipt = repository.get_mutation_receipt(owner_id, proposal.request_id)
    if receipt is not None:
        saved_hash, saved_revision = receipt
        if saved_hash != payload_hash:
            raise MutationError("Request ID reused with different payload")
        existing = repository.load_owned_recipe(owner_id, proposal.recipe_id)
        if existing.revision < saved_revision:
            raise MutationError("Stored receipt ahead of recipe revision")
        return SavedMutation(existing, saved_revision, True)
    recipe = repository.load_owned_recipe(owner_id, proposal.recipe_id)
    if catalog is None and any(m.price_mode == "inherit" for m in recipe.materials):
        catalog = repository.load_owned_catalog(owner_id, recipe)
    try:
        candidate = prepare_mutation(recipe, proposal,
                                     user_confirmed=trusted_user_confirmed,
                                     catalog=catalog)
    except ValueError as exc:
        if recipe.revision != proposal.base_revision:
            late_receipt = repository.get_mutation_receipt(owner_id, proposal.request_id)
            if late_receipt is not None:
                saved_hash, saved_revision = late_receipt
                if saved_hash != payload_hash:
                    raise MutationError("Request ID reused with different payload")
                canonical = repository.load_owned_recipe(owner_id, proposal.recipe_id)
                if canonical.revision < saved_revision:
                    raise MutationError("Stored receipt ahead of recipe revision")
                return SavedMutation(canonical, saved_revision, True)
        raise MutationError(str(exc)) from exc
    try:
        from .costing import unit_factor_catalog
        unit_loader = getattr(repository, "list_owned_units", None)
        units = unit_factor_catalog(unit_loader(owner_id)) if callable(unit_loader) else {}
        price_loader = getattr(repository, "load_owned_supplier_prices", None)
        supplier_prices = price_loader(owner_id, candidate) if callable(price_loader) else {}
        cost = calculate_cost(candidate, catalog, units, supplier_prices)
    except ValueError as exc:
        raise MutationError(str(exc)) from exc
    snapshot = asdict(cost)
    if save_version:
        quotes = {}
        for line in candidate.materials:
            if line.price_mode == "inherit":
                if line.offer_id:
                    quote = supplier_prices.get((line.ingredient_id, line.offer_id))
                elif line.supplier_id:
                    quote = supplier_prices.get((line.ingredient_id, line.supplier_id))
                else:
                    ingredient = (catalog or {}).get(line.ingredient_id or "")
                    quote = ingredient.current_price if ingredient is not None else None
            else:
                quote = line.price_override
            quotes[line.id] = {
                "price_mode": line.price_mode,
                "ingredient_id": line.ingredient_id,
                "supplier_id": line.supplier_id,
                "offer_id": line.offer_id,
                "effective_quote": asdict(quote) if quote is not None else None,
            }
        snapshot["effective_quotes"] = quotes
    state = asdict(candidate)
    revised = repository.commit_recipe_revision(
        owner_id=owner_id, recipe_id=recipe.id,
        request_id=proposal.request_id, base_revision=proposal.base_revision,
        state=state, title=candidate.title.value or "",
        cost_snapshot=_json(snapshot), payload_hash=payload_hash,
        save_version=save_version)
    if revised != candidate.revision:
        # Existing receipt: the same request was already committed.
        # Caller must reload canonical state; never display candidate as freshly saved.
        canonical = repository.load_owned_recipe(owner_id, recipe.id)
        return SavedMutation(canonical, revised, True)
    return SavedMutation(candidate, revised, False)
