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


@dataclass(frozen=True)
class UnitApprovalItem:
    """Proposed canonical unit binding. No database side effects."""
    entered: str
    status: str
    unit_id: str | None
    symbol: str
    dimension: str | None


def prepare_unit_approval(
    units_entered: list[str], owned_units: list[dict], dimensions: dict[str, str]
) -> tuple[UnitApprovalItem, ...]:
    """Prepare a complete one-gate proposal; never create units during parsing.

    Dimensions for new units must be reviewed explicitly. Ambiguous matches
    cannot be written without the chef choosing the intended existing ID.
    """
    allowed_dimensions = {"mass", "volume", "count", "other"}
    proposed: list[UnitApprovalItem] = []
    for entered in units_entered:
        match = resolve_unit(entered, owned_units)
        if match.status in ("missing", "ambiguous"):
            raise ValueError(f"Unit requires clarification: {entered}")
        if match.status == "reuse":
            proposed.append(UnitApprovalItem(entered, "reuse", match.unit_id,
                                              match.symbol, match.dimension))
            continue
        dimension = dimensions.get(entered)
        if dimension not in allowed_dimensions:
            raise ValueError(f"New unit requires a reviewed dimension: {entered}")
        proposed.append(UnitApprovalItem(entered, "new_candidate", None,
                                          match.symbol, dimension))
    return tuple(proposed)
