"""M5: price observations, comparability, and recipe impact. Pure functions.

Observations are append-only facts. Recording one never changes an adopted
price; adoption stays an explicit write outside M5's scope. Comparison
requires identical purchase terms (currency, tax, shipping, package spec):
anything else returns missing conditions and reasons, never guessed
conversions or name-based merges. Impact is hypothetical -- as if the
candidate observation were adopted -- and writes nothing, so saved recipe
versions and cost snapshots are never touched.
"""
from dataclasses import dataclass, replace
from decimal import Decimal, ROUND_HALF_UP
from typing import Mapping
from .costing import calculate_cost, convert_quantity
from .models import Ingredient, PriceQuote, Recipe, TrackedValue, decimal

SOURCES = ("purchase", "web_reference", "manual_entry")


@dataclass(frozen=True)
class PriceObservation:
    """One price fact joined with its offer's package terms.

    amount is a decimal string >= 0. The field name mirrors the
    price_observations table; currency may differ from JPY.
    """
    id: str
    ingredient_id: str
    offer_id: str
    supplier_id: str | None
    amount: str
    currency: str
    tax_note: str | None
    shipping_note: str | None
    package_quantity: str
    package_unit: str
    source: str
    confirmed: bool
    observed_at: str


@dataclass(frozen=True)
class ComparisonResult:
    comparable: bool
    reasons: tuple[str, ...]
    currency: str | None
    unit_basis: str | None
    base_unit_price: str | None
    new_unit_price: str | None
    diff: str | None
    rate_pct: str | None


def _terms(text: str | None) -> str:
    return (text or "").strip()


def _positive(value: str | None) -> Decimal | None:
    try:
        result = decimal(str(value))
    except (ValueError, TypeError):
        return None
    return result if result > 0 else None


def _to_base(qty: Decimal, unit: str) -> tuple[str, Decimal | None]:
    """Express a package quantity in g (mass) or ml (volume)."""
    grams = convert_quantity(qty, unit, "g")
    if grams is not None:
        return "g", grams
    ml = convert_quantity(qty, unit, "ml")
    if ml is not None:
        return "ml", ml
    return unit, None


def compare_observations(base: PriceObservation,
                         new: PriceObservation) -> ComparisonResult:
    """Compare two observations of one ingredient. Numbers only when every
    purchase term matches; otherwise reasons name each blocking condition."""
    reasons: list[str] = []
    if base.ingredient_id != new.ingredient_id:
        reasons.append("different ingredient")
    if base.currency != new.currency:
        reasons.append(f"currency differs: {base.currency} vs {new.currency}")
    if _terms(base.tax_note) != _terms(new.tax_note):
        reasons.append("tax condition differs")
    if _terms(base.shipping_note) != _terms(new.shipping_note):
        reasons.append("shipping condition differs")
    base_qty = _positive(base.package_quantity)
    new_qty = _positive(new.package_quantity)
    if base_qty is None:
        reasons.append("invalid base package quantity")
    if new_qty is None:
        reasons.append("invalid new package quantity")
    try:
        base_amount = decimal(base.amount)
        new_amount = decimal(new.amount)
        amounts_ok = base_amount >= 0 and new_amount >= 0
    except (ValueError, TypeError):
        amounts_ok = False
    if not amounts_ok:
        reasons.append("invalid amount")
    unit_basis: str | None = None
    base_unit: Decimal | None = None
    new_unit: Decimal | None = None
    if not reasons:
        if base.package_unit == new.package_unit:
            unit_basis = base.package_unit
            base_unit = base_amount / base_qty
            new_unit = new_amount / new_qty
        else:
            base_dim, base_q = _to_base(base_qty, base.package_unit)
            new_dim, new_q = _to_base(new_qty, new.package_unit)
            if base_q is None or new_q is None or base_dim != new_dim:
                reasons.append(
                    f"package units not interconvertible: "
                    f"{base.package_unit} vs {new.package_unit}")
            else:
                unit_basis = base_dim
                base_unit = base_amount / base_q
                new_unit = new_amount / new_q
    if not reasons and (base_unit is None or base_unit <= 0):
        reasons.append("zero basis unit price")
    if reasons:
        return ComparisonResult(False, tuple(reasons), None, None,
                                None, None, None, None)
    # Difference and rate come from the raw unit prices; display rounding
    # happens last so micro unit prices are not distorted. base_unit > 0
    # here, so the rate division is safe.
    diff_raw = new_unit - base_unit
    rate_raw = diff_raw / base_unit * Decimal("100")
    quant = Decimal("0.0001")
    base_out = base_unit.quantize(quant, rounding=ROUND_HALF_UP)
    new_out = new_unit.quantize(quant, rounding=ROUND_HALF_UP)
    diff = diff_raw.quantize(quant, rounding=ROUND_HALF_UP)
    rate = rate_raw.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    return ComparisonResult(True, (), base.currency, unit_basis,
                            str(base_out), str(new_out), str(diff), str(rate))


def observation_quote(obs: PriceObservation) -> PriceQuote | None:
    """Derive a hypothetical JPY quote from an observation, or None when
    its package terms cannot price anything (never guessed). Non-JPY
    observations are refused so USD amounts are never copied into
    yen recipe totals. The quote is marked assumed/estimated so impact
    results stay estimates."""
    if obs.currency != "JPY":
        return None
    if not (obs.package_unit or "").strip():
        return None
    if _positive(obs.package_quantity) is None:
        return None
    try:
        amount = decimal(obs.amount)
    except (ValueError, TypeError):
        return None
    if amount < 0:
        return None
    return PriceQuote(TrackedValue(str(amount), "assumed", "system"),
                      obs.package_quantity, obs.package_unit, "estimated")


@dataclass(frozen=True)
class LineImpact:
    line_id: str
    price_mode: str
    current_line_cost: str | None
    hypo_line_cost: str | None


@dataclass(frozen=True)
class RecipeImpact:
    recipe_id: str
    title: str | None
    current_total: str | None
    hypo_total: str | None
    diff: str | None
    current_partial: bool
    hypo_partial: bool
    affected_lines: tuple[LineImpact, ...]
    unchanged_lines: tuple[str, ...]


def assess_impact(recipes: tuple[Recipe, ...],
                  catalog: Mapping[str, Ingredient],
                  ingredient_id: str,
                  candidate: PriceQuote) -> tuple[RecipeImpact, ...]:
    """Hypothetical cost impact as if candidate were the adopted quote.

    Inherit lines follow the candidate; override lines keep their own
    quote and are reported unchanged. Unresolved lines stay partial on
    either side. Reads only; never writes recipes or snapshots.
    """
    base = catalog.get(ingredient_id)
    hypo_ingredient = replace(
        base, current_price=candidate) if base is not None else Ingredient(
            ingredient_id, "", candidate)
    hypo_catalog = {**catalog, ingredient_id: hypo_ingredient}
    out: list[RecipeImpact] = []
    for recipe in recipes:
        current = calculate_cost(recipe, catalog)
        hypo = calculate_cost(recipe, hypo_catalog)
        current_total = (None if current.total_cost_jpy is None
                         else str(current.total_cost_jpy))
        hypo_total = (None if hypo.total_cost_jpy is None
                      else str(hypo.total_cost_jpy))
        diff = (None if current.total_cost_jpy is None
                or hypo.total_cost_jpy is None
                else str(hypo.total_cost_jpy - current.total_cost_jpy))
        affected: list[LineImpact] = []
        unchanged: list[str] = []
        for line in recipe.materials:
            if line.ingredient_id != ingredient_id:
                continue
            if line.price_mode == "inherit":
                current_cost = current.line_costs.get(line.id)
                hypo_cost = hypo.line_costs.get(line.id)
                affected.append(LineImpact(
                    line.id, line.price_mode,
                    None if current_cost is None else str(current_cost),
                    None if hypo_cost is None else str(hypo_cost)))
            else:
                unchanged.append(line.id)
        out.append(RecipeImpact(
            recipe.id, recipe.title.value, current_total, hypo_total, diff,
            current.partial, hypo.partial, tuple(affected), tuple(unchanged)))
    return tuple(out)
