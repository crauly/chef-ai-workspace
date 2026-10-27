"""Deterministic food cost calculation; no model calls or floating-point math."""
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Mapping
from .models import Ingredient, Recipe, PriceQuote, decimal

_FACTORS = {"g": ("mass", Decimal("1")), "kg": ("mass", Decimal("1000")),
            "ml": ("volume", Decimal("1")), "L": ("volume", Decimal("1000"))}


def convert_quantity(qty: Decimal, from_unit: str, to_unit: str) -> Decimal | None:
    if from_unit == to_unit:
        return qty
    a, b = _FACTORS.get(from_unit), _FACTORS.get(to_unit)
    if not a or not b or a[0] != b[0]:
        return None
    return qty * a[1] / b[1]


@dataclass(frozen=True)
class CostResult:
    partial: bool
    line_costs: Mapping[str, Decimal]
    line_price_sources: Mapping[str, str]
    unresolved_line_ids: tuple[str, ...]
    subtotal_jpy: Decimal
    total_cost_jpy: Decimal | None
    cost_rate_pct: Decimal | None
    estimated: bool


def calculate_cost(recipe: Recipe, ingredients: Mapping[str, Ingredient] | None = None) -> CostResult:
    catalog = ingredients or {}
    costs: dict[str, Decimal] = {}
    price_sources: dict[str, str] = {}
    unresolved: list[str] = []
    estimated = False
    for line in recipe.materials:
        quote: PriceQuote | None = line.price_override if line.price_mode == "override" else None
        if line.price_mode == "inherit":
            ingredient = catalog.get(line.ingredient_id or "")
            quote = ingredient.current_price if ingredient else None
        q = line.quantity
        if q.value is None or line.unit is None or quote is None or quote.amount_jpy.value is None:
            unresolved.append(line.id)
            continue
        qty = convert_quantity(decimal(q.value), line.unit, quote.per_unit)
        if qty is None:
            unresolved.append(line.id)
            continue
        costs[line.id] = qty / decimal(quote.per_quantity) * decimal(quote.amount_jpy.value)
        price_sources[line.id] = "line_override" if line.price_mode == "override" else "shared_ingredient"
        if q.status == "assumed" or quote.amount_jpy.status == "assumed":
            estimated = True
    subtotal = sum(costs.values(), Decimal("0"))
    adj = recipe.cost_adjustment_jpy
    partial = bool(unresolved) or adj.value is None
    if adj.status == "assumed":
        estimated = True
    if partial:
        return CostResult(True, costs, price_sources, tuple(unresolved), subtotal, None, None, estimated)
    total_raw = subtotal + decimal(adj.value)
    if total_raw < 0:
        raise ValueError("Adjusted total cost cannot be negative")
    total = total_raw.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    selling = recipe.selling_price_jpy
    rate = None
    if selling.value is not None:
        rate = (total / decimal(selling.value) * Decimal("100")).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
        if selling.status == "assumed":
            estimated = True
    return CostResult(False, costs, price_sources, (), subtotal, total, rate, estimated)
