"""Unit-master candidate resolution. AI can propose; it cannot persist or approve."""
from dataclasses import dataclass

@dataclass(frozen=True)
class UnitResolution:
    status: str
    unit_id: str | None
    symbol: str
    dimension: str | None

def resolve_unit(candidate: str, units: list[dict]) -> UnitResolution:
    if not isinstance(candidate, str) or not candidate.strip():
        return UnitResolution("missing", None, "", None)
    token = candidate.strip().casefold()
    exact = [unit for unit in units if str(unit["symbol"]).strip().casefold() == token]
    aliases = [unit for unit in units if any(
        isinstance(a, str) and a.strip().casefold() == token
        for a in unit.get("aliases", []))]
    matched = {row["id"]: row for row in exact + aliases}
    if len(matched) > 1:
        return UnitResolution("ambiguous", None, candidate.strip(), None)
    if matched:
        unit = next(iter(matched.values()))
        return UnitResolution("reuse", unit["id"], unit["symbol"], unit["dimension"])
    return UnitResolution("new_candidate", None, candidate.strip(), None)
