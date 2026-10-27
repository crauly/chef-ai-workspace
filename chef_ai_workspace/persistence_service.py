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
    except MutationError:
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
        raise
    cost = calculate_cost(candidate, catalog)
    snapshot = asdict(cost)
    # Resolve actual effective quotes when saving, not just the line costs.
    if save_version:
        quotes = {}
        for line in candidate.materials:
            if line.price_mode == "inherit":
                ingredient = (catalog or {}).get(line.ingredient_id or "")
                quote = ingredient.current_price if ingredient is not None else None
            else:
                quote = line.price_override
            quotes[line.id] = {
                "price_mode": line.price_mode,
                "ingredient_id": line.ingredient_id,
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
