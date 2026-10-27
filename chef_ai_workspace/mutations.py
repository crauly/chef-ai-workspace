"""Validated, all-or-nothing recipe edits. Persistence is a separate future boundary."""
from dataclasses import dataclass, replace
from typing import Mapping
from uuid import UUID
from .models import Recipe, MaterialLine, TrackedValue, PriceQuote, Ingredient, decimal
from .costing import calculate_cost

class MutationError(ValueError):
    pass

@dataclass(frozen=True)
class Proposal:
    recipe_id: str
    base_revision: int
    request_id: str
    operations: tuple[dict, ...]

def _value(v: object, confirmed: bool) -> TrackedValue:
    if not isinstance(v, str) or not v.strip():
        raise MutationError("Missing value")
    return TrackedValue(v, "confirmed" if confirmed else "assumed", "user" if confirmed else "ai")

def _fields(op: dict, required: set[str], optional: set[str] = frozenset()) -> None:
    if set(op) - required - optional or not required <= set(op):
        raise MutationError("Unknown or missing operation fields")
    if "status" in op or "origin" in op:
        raise MutationError("Untrusted confidence claim")

def prepare_mutation(recipe: Recipe, proposal: Proposal, *, user_confirmed: bool,
                     catalog: Mapping[str, Ingredient] | None = None) -> Recipe:
    """Pure preparation only. Caller must perform durable revision/ID dedup atomically."""
    if recipe.id != proposal.recipe_id or recipe.revision != proposal.base_revision:
        raise MutationError("Recipe ID or revision mismatch")
    if not proposal.request_id or not proposal.operations:
        raise MutationError("Request ID and operations required")
    candidate = recipe
    for op in proposal.operations:
        if not isinstance(op, dict):
            raise MutationError("Operation must be an object")
        kind = op.get("op")
        if kind == "set_material_quantity":
            _fields(op, {"op", "material_id", "value", "unit"})
            value = _value(op["value"], user_confirmed)
            if decimal(value.value) < 0 or not isinstance(op["unit"], str) or not op["unit"]:
                raise MutationError("Invalid quantity or unit")
            matches = [m for m in candidate.materials if m.id == op["material_id"]]
            if len(matches) != 1:
                raise MutationError("Unknown material ID")
            materials = tuple(replace(m, quantity=value, unit=op["unit"]) if m.id == op["material_id"] else m
                              for m in candidate.materials)
            candidate = replace(candidate, materials=materials)
        elif kind == "set_selling_price":
            _fields(op, {"op", "value_jpy"})
            value = _value(op["value_jpy"], user_confirmed)
            if decimal(value.value) <= 0:
                raise MutationError("Selling price must be positive")
            candidate = replace(candidate, selling_price_jpy=value)
        elif kind in ("set_cost_adjustment", "adjust_cost_adjustment"):
            key = "value_jpy" if kind == "set_cost_adjustment" else "delta_jpy"
            _fields(op, {"op", key})
            value = _value(op[key], user_confirmed)
            number = decimal(value.value)
            if kind == "adjust_cost_adjustment":
                if candidate.cost_adjustment_jpy.value is None:
                    raise MutationError("Cannot increment unresolved adjustment")
                number += decimal(candidate.cost_adjustment_jpy.value)
            candidate = replace(candidate, cost_adjustment_jpy=_value(str(number), user_confirmed))
        elif kind == "set_title":
            _fields(op, {"op", "value"})
            candidate = replace(candidate, title=_value(op["value"], user_confirmed))
        else:
            raise MutationError(f"Unsupported operation: {kind}")
    candidate = replace(candidate, revision=recipe.revision + 1)
    # Check calculated constraints before any state is returned to caller.
    calculate_cost(candidate, catalog)
    return candidate
