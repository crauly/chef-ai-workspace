"""Deterministic food cost calculation; no model calls or floating-point math."""
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Mapping
from .models import Ingredient, Recipe, PriceQuote, decimal

def unit_factor_catalog(rows: list[dict]) -> dict[str, tuple[str, Decimal | None]]:
    """Index owned Unit Master IDs and terms; never invent exchange ratios."""
    values: dict[str, tuple[str, Decimal | None]] = {}
    for row in rows:
        factor_raw = row.get("base_factor")
        factor = Decimal(str(factor_raw)) if factor_raw is not None else None
        if factor is not None and (not factor.is_finite() or factor <= 0):
            raise ValueError("Invalid master unit factor")
        definition = (row["dimension"], factor)
        for key in [row["id"], row["symbol"], *(row.get("aliases") or [])]:
            if key in values and values[key] != definition:
                raise ValueError("Conflicting unit identity")
            values[key] = definition
    return values


def convert_quantity(
    qty: Decimal, from_unit: str, to_unit: str,
    units: Mapping[str, tuple[str, Decimal | None]] | None = None,
    from_id: str | None = None, to_id: str | None = None,
) -> Decimal | None:
    """Convert only using approved Unit Master dimensions and factors.

    Matching canonical IDs have a 1:1 ratio. All other conversions require
    both verified ratios and matching dimensions. Nothing is hardcoded.
    """
    if from_id and to_id and from_id == to_id:
        return qty
    if not from_id and not to_id and from_unit == to_unit:
        return qty
    catalog = units or {}
    a = catalog.get(from_id or from_unit)
    b = catalog.get(to_id or to_unit)
    if not a or not b or a[0] != b[0] or a[1] is None or b[1] is None:
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


def calculate_cost(recipe: Recipe, ingredients: Mapping[str, Ingredient] | None = None,
                   units: Mapping[str, tuple[str, Decimal | None]] | None = None,
                   supplier_prices: Mapping[tuple[str, str], PriceQuote] | None = None) -> CostResult:
    catalog = ingredients or {}
    costs: dict[str, Decimal] = {}
    price_sources: dict[str, str] = {}
    unresolved: list[str] = []
    estimated = False
    for line in recipe.materials:
        quote: PriceQuote | None = line.price_override if line.price_mode == "override" else None
        if line.price_mode == "inherit":
            ingredient = catalog.get(line.ingredient_id or "")
            # A recipe-selected supplier MUST have its own approved quote.
            # Never silently fall back to another supplier or a market average.
            if line.offer_id:
                # The repository verifies offer ownership and parent identity.
                # An explicit offer must never fall back to a different purchase term.
                quote = (supplier_prices or {}).get((line.ingredient_id or "", f"offer:{line.offer_id}"))
            elif line.supplier_id:
                quote = (supplier_prices or {}).get((line.ingredient_id or "", line.supplier_id))
            else:
                quote = ingredient.current_price if ingredient else None
        q = line.quantity
        if q.value is None or line.unit is None or quote is None or quote.amount_jpy.value is None:
            unresolved.append(line.id)
            continue
        qty = convert_quantity(decimal(q.value), line.unit, quote.per_unit,
                               units, line.unit_id, quote.per_unit_id)
        if qty is None:
            unresolved.append(line.id)
            continue
        costs[line.id] = (qty * decimal(quote.amount_jpy.value)) / decimal(quote.per_quantity)
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
