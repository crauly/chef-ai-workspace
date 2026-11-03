"""Small, framework-independent value model for recipe costing."""
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Literal

Status = Literal["confirmed", "assumed", "unresolved"]
Origin = Literal["user", "ai", "catalog", "system"]


def decimal(value: str | int | Decimal) -> Decimal:
    if isinstance(value, bool):
        raise ValueError("Boolean is not a decimal")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError("Invalid decimal") from exc
    if not result.is_finite():
        raise ValueError("Non-finite decimal")
    return result


@dataclass(frozen=True)
class TrackedValue:
    value: str | None
    status: Status
    origin: Origin

    def __post_init__(self):
        if self.status not in ("confirmed", "assumed", "unresolved"):
            raise ValueError("Invalid status")
        if self.origin not in ("user", "ai", "catalog", "system"):
            raise ValueError("Invalid origin")
        if (self.value is None) != (self.status == "unresolved"):
            raise ValueError("Unresolved requires null; known values require non-null")
        if self.status == "confirmed" and self.origin == "ai":
            raise ValueError("AI inference cannot be confirmed")


@dataclass(frozen=True)
class PriceQuote:
    amount_jpy: TrackedValue
    per_quantity: str
    per_unit: str
    source: Literal["manual", "estimated", "shared-ingredient"]
    per_unit_id: str | None = None

    def __post_init__(self):
        if decimal(self.per_quantity) <= 0:
            raise ValueError("Price denominator must be positive")
        if self.amount_jpy.value is not None and decimal(self.amount_jpy.value) < 0:
            raise ValueError("Negative price")
        if not self.per_unit:
            raise ValueError("Missing quote unit")
        if self.source not in ("manual", "estimated", "shared-ingredient"):
            raise ValueError("Invalid price source")


@dataclass(frozen=True)
class Ingredient:
    id: str
    name: str
    current_price: PriceQuote | None = None
    # M5: reference to the adopted price observation (ingredients
    # table). Observations never write these fields; adoption stays an
    # explicit, separately approved write outside M5's scope.
    adopted_observation_id: str | None = None
    adopted_at: str | None = None


@dataclass(frozen=True)
class MaterialLine:
    id: str
    material_name: TrackedValue
    quantity: TrackedValue
    unit: str | None
    ingredient_id: str | None = None
    price_override: PriceQuote | None = None
    price_mode: Literal["override", "inherit"] = "override"
    unit_id: str | None = None

    def __post_init__(self):
        if self.price_mode not in ("override", "inherit"):
            raise ValueError("Invalid price mode")
        if self.quantity.value is not None and decimal(self.quantity.value) < 0:
            raise ValueError("Negative quantity")
        if self.quantity.value is not None and not self.unit:
            raise ValueError("Known quantity requires unit")
        if self.price_mode == "inherit" and self.ingredient_id is None:
            raise ValueError("Inherit requires linked ingredient")
        if self.price_mode == "inherit" and self.price_override is not None:
            raise ValueError("Inherit cannot silently override a line quote")


@dataclass(frozen=True)
class Recipe:
    id: str
    title: TrackedValue
    materials: tuple[MaterialLine, ...] = ()
    selling_price_jpy: TrackedValue = field(default_factory=lambda: TrackedValue(None, "unresolved", "system"))
    cost_adjustment_jpy: TrackedValue = field(default_factory=lambda: TrackedValue("0", "confirmed", "system"))
    revision: int = 0

    def __post_init__(self):
        if self.cost_adjustment_jpy.value is not None:
            decimal(self.cost_adjustment_jpy.value)
        if self.selling_price_jpy.value is not None and decimal(self.selling_price_jpy.value) <= 0:
            raise ValueError("Selling price must be positive")
        if self.revision < 0 or len({m.id for m in self.materials}) != len(self.materials):
            raise ValueError("Invalid revision or duplicate material IDs")
