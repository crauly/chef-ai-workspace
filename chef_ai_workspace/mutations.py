"""Validated, all-or-nothing recipe edits. Persistence is a separate future boundary."""
from dataclasses import dataclass, replace
from uuid import UUID
from typing import Mapping
from .models import Recipe, TrackedValue, Ingredient, MaterialLine, PriceQuote, decimal
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
    if not isinstance(proposal.base_revision, int) or isinstance(proposal.base_revision, bool):
        raise MutationError("Invalid revision")
    if recipe.id != proposal.recipe_id or recipe.revision != proposal.base_revision:
        raise MutationError("Recipe ID or revision mismatch")
    if not isinstance(proposal.request_id, str) or not proposal.request_id.strip() or not proposal.operations:
        raise MutationError("Request ID and operations required")
    candidate = recipe
    for op in proposal.operations:
        if not isinstance(op, dict):
            raise MutationError("Operation must be an object")
        kind = op.get("op")
        if kind == "add_material":
            _fields(op, {"op", "material_id", "name", "quantity", "unit", "price_jpy", "price_quantity", "price_unit"})
            try:
                UUID(op["material_id"])
            except (ValueError, TypeError, AttributeError) as exc:
                raise MutationError("Invalid material ID") from exc
            if any(m.id == op["material_id"] for m in candidate.materials):
                raise MutationError("Duplicate material ID")
            name = _value(op["name"], user_confirmed)
            quantity = _value(op["quantity"], user_confirmed)
            amount = _value(op["price_jpy"], user_confirmed)
            unit = op["unit"]
            if decimal(quantity.value) < 0 or not isinstance(unit, str) or not unit.strip():
                raise MutationError("Invalid material quantity")
            quote = PriceQuote(amount_jpy=amount, per_quantity=op["price_quantity"],
                               per_unit=op["price_unit"], source="manual" if user_confirmed else "estimated")
            line = MaterialLine(id=op["material_id"], material_name=name, quantity=quantity,
                                unit=unit, price_override=quote)
            candidate = replace(candidate, materials=candidate.materials + (line,))
        elif kind == "set_material_price":
            _fields(op, {"op", "material_id", "price_jpy", "price_quantity", "price_unit"})
            if not any(m.id == op["material_id"] for m in candidate.materials):
                raise MutationError("Unknown material ID")
            quote = PriceQuote(amount_jpy=_value(op["price_jpy"], user_confirmed),
                               per_quantity=op["price_quantity"], per_unit=op["price_unit"],
                               source="manual" if user_confirmed else "estimated")
            candidate = replace(candidate, materials=tuple(
                replace(m, price_mode="override", price_override=quote)
                if m.id == op["material_id"] else m for m in candidate.materials))
        elif kind == "set_material_quantity":
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
            if kind == "adjust_cost_adjustment" and candidate.cost_adjustment_jpy.status == "assumed":
                candidate = replace(candidate, cost_adjustment_jpy=TrackedValue(str(number), "assumed", "ai"))
            else:
                candidate = replace(candidate, cost_adjustment_jpy=_value(str(number), user_confirmed))
        elif kind == "link_ingredient":
            _fields(op, {"op", "material_id", "ingredient_id", "price_mode"},
                    {"price_jpy", "price_quantity", "price_unit"})
            try:
                UUID(op["ingredient_id"])
            except (ValueError, TypeError, AttributeError) as exc:
                raise MutationError("Invalid ingredient ID") from exc
            matches = [m for m in candidate.materials if m.id == op["material_id"]]
            if len(matches) != 1:
                raise MutationError("Unknown material ID")
            mode = op["price_mode"]
            if mode not in ("inherit", "override"):
                raise MutationError("Link requires explicit inherit or override")
            if catalog is None or op["ingredient_id"] not in catalog:
                raise MutationError("Linked ingredient not in catalog")
            if mode == "inherit":
                new_line = replace(matches[0], ingredient_id=op["ingredient_id"],
                                   price_mode="inherit", price_override=None)
            else:
                for key in ("price_jpy", "price_quantity", "price_unit"):
                    if key not in op:
                        raise MutationError("Override link requires explicit quote")
                quote = PriceQuote(amount_jpy=_value(op["price_jpy"], user_confirmed),
                                   per_quantity=op["price_quantity"], per_unit=op["price_unit"],
                                   source="manual" if user_confirmed else "estimated")
                new_line = replace(matches[0], ingredient_id=op["ingredient_id"],
                                   price_mode="override", price_override=quote)
            candidate = replace(candidate, materials=tuple(
                new_line if m.id == op["material_id"] else m for m in candidate.materials))
        elif kind == "unlink_ingredient":
            _fields(op, {"op", "material_id", "on_unlink"},
                    {"price_jpy", "price_quantity", "price_unit"})
            matches = [m for m in candidate.materials if m.id == op["material_id"]]
            if len(matches) != 1:
                raise MutationError("Unknown material ID")
            line = matches[0]
            policy = op["on_unlink"]
            if policy not in ("preserve_quote", "mark_unresolved"):
                raise MutationError("Unlink requires explicit preserve_quote or mark_unresolved")
            if line.price_mode == "inherit" or policy == "mark_unresolved":
                if policy == "preserve_quote":
                    for key in ("price_jpy", "price_quantity", "price_unit"):
                        if key not in op:
                            raise MutationError("Preserving a quote requires explicit quote")
                    quote = PriceQuote(amount_jpy=_value(op["price_jpy"], user_confirmed),
                                       per_quantity=op["price_quantity"], per_unit=op["price_unit"],
                                       source="manual" if user_confirmed else "estimated")
                else:
                    quote = None
                new_line = replace(line, ingredient_id=None, price_mode="override",
                                   price_override=quote)
            else:
                new_line = replace(line, ingredient_id=None)
            candidate = replace(candidate, materials=tuple(
                new_line if m.id == op["material_id"] else m for m in candidate.materials))
        elif kind == "set_title":
            _fields(op, {"op", "value"})
            candidate = replace(candidate, title=_value(op["value"], user_confirmed))
        else:
            raise MutationError(f"Unsupported operation: {kind}")
    candidate = replace(candidate, revision=recipe.revision + 1)
    # Check calculated constraints before any state is returned to caller.
    calculate_cost(candidate, catalog)
    return candidate
