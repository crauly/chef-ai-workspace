"""M6: price-change bell notifications. Pure helpers only.

A notification is created only from an explicit price confirmation:
the candidate observation is compared (M5) against the ingredient's
adopted price basis. Incomparable candidates and missing bases yield
reasons, never a notification. Thresholds, cadence, and re-notify
rules are undecided (ADR-009) and deliberately absent: every explicit
confirmation of a comparable observation notifies exactly once.

Reading or acknowledging a notification never adopts a price and never
rewrites recipes or cost snapshots; adoption stays an explicit,
separately approved write outside M6's scope.
"""
from .price_history import ComparisonResult, PriceObservation, compare_observations

STATUSES = ("unread", "acknowledged", "resolved")

TRANSITIONS = {
    "unread": ("acknowledged", "resolved"),
    "acknowledged": ("unread", "resolved"),
    "resolved": (),
}

# Reverse index of TRANSITIONS: which stored states may move to the key.
# Used for compare-and-swap status writes so a stale read can never
# force an illegal move.
ALLOWED_SOURCES = {
    "unread": ("acknowledged",),
    "acknowledged": ("unread",),
    "resolved": ("unread", "acknowledged"),
}


class NotificationConflict(ValueError):
    """A status write lost a race: the stored status moved first."""


def check_transition(current: str, nxt: str) -> None:
    """Raise ValueError unless current -> nxt is an allowed status move."""
    if current not in STATUSES:
        raise ValueError(f"Unknown notification status: {current}")
    if nxt not in STATUSES:
        raise ValueError(f"Unknown notification status: {nxt}")
    if nxt not in TRANSITIONS[current]:
        raise ValueError(f"Cannot move notification from {current} to {nxt}")


def decide_notification(base: PriceObservation | None,
                        candidate: PriceObservation,
                        units=None) -> tuple[bool, ComparisonResult | None, list[str]]:
    """Decide whether an explicit confirmation should notify.

    Returns (should_notify, comparison, reasons). No basis, a foreign
    basis, or unmet purchase terms suppress the notification with
    reasons instead of numbers. Comparable observations always notify
    -- direction and size included -- because cadence/threshold policy
    is undecided and must not be invented here.
    """
    if base is None:
        return False, None, ["no adopted price basis"]
    comparison = compare_observations(base, candidate, units)
    if not comparison.comparable:
        return False, comparison, list(comparison.reasons)
    if candidate.currency != "JPY" or base.currency != "JPY":
        return False, comparison, ["non-JPY currency cannot be used for JPY cost impact"]
    return True, comparison, []


def comparison_payload(comparison: ComparisonResult,
                       basis_observation_id: str | None) -> dict:
    """JSON-ready comparison with the unit basis retained.

    ``diff`` is a unit-price difference in ``currency`` per
    ``unit_basis`` -- never a recipe total. Callers must render the
    unit (e.g. "0.14円/g"), not a hardcoded one.
    """
    return {"comparable": bool(comparison.comparable),
            "reasons": list(comparison.reasons),
            "currency": comparison.currency,
            "unit_basis": comparison.unit_basis,
            "base_unit_price": comparison.base_unit_price,
            "new_unit_price": comparison.new_unit_price,
            "diff": comparison.diff,
            "rate_pct": comparison.rate_pct,
            "basis_observation_id": basis_observation_id}
