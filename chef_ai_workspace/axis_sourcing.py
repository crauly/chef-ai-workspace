"""3-axis sourcing picks over M7 candidates. Pure functions only.

Axes (one pick each, never force-filled):
- ``cost``: decided ONLY by Python from the M5 comparison already attached
  to each M7 candidate (lowest comparable unit price). Muse never decides
  cost and its ``cost`` labels are ignored.
- ``compatibility`` / ``quality``: decided from Muse semantic evaluations
  over ledger-registered candidates. Quality is claimed only with evidence
  (confirmed observation / stated source); otherwise the reason must say
  the basis is uncertain and confidence stays ``low``.

Candidates come only from the caller's owned ledger rows (the M7 pool);
this module performs no network access, no database access, and no writes.
External web retrieval stays unavailable (see ``substitute_sourcing``):
only retrieved-with-source rows may be treated as real data.
"""
from decimal import Decimal, InvalidOperation


AXES = ("cost", "compatibility", "quality")
AXIS_LABELS = {
    "cost": "コスト重視",
    "compatibility": "互換性・類似性重視",
    "quality": "品質・評価重視",
}
MUSE_AXES = ("compatibility", "quality")
CONFIDENCES = ("high", "medium", "low")
STANDARD_PICKS = 3
MAX_PICKS = 5
MAX_REASON_CHARS = 300
MAX_PROMPT_CANDIDATES = 10


class AxisEvaluationError(ValueError):
    """Raised when a Muse axis-evaluation payload is not usable."""


def _unit_price(candidate, units):
    """Price per approved base unit; unknown factors are not ranked."""
    comparison = candidate.get("comparison") if isinstance(candidate, dict) else None
    if not isinstance(comparison, dict) or not comparison.get("comparable"):
        return None
    try:
        price = Decimal(str(comparison.get("new_unit_price")))
        basis = str(comparison.get("unit_basis") or "")
    except (InvalidOperation, ValueError, TypeError, AttributeError):
        return None
    if price < 0:
        return None
    definition = (units or {}).get(basis)
    if not definition or definition[1] is None or definition[1] <= 0:
        return None
    return (definition[0], price / definition[1])


def build_axis_prompt(ingredient_name, candidates):
    """Bounded prompt input: candidate facts only, never owner IDs."""
    rows = []
    for index, candidate in enumerate(list(candidates or [])[:MAX_PROMPT_CANDIDATES]):
        if not isinstance(candidate, dict):
            continue
        comparison = candidate.get("comparison") if isinstance(
            candidate.get("comparison"), dict) else None
        rows.append({
            "candidate_index": index,
            "kind": str(candidate.get("kind") or "")[:60],
            "ingredient_name": str(candidate.get("ingredient_name") or "")[:120],
            "supplier_name": str(candidate.get("supplier_name") or "")[:120],
            "package": ("%s%s" % (candidate.get("package_quantity") or "",
                                  candidate.get("package_unit") or ""))[:40],
            "amount": str(candidate.get("amount") or "")[:40],
            "currency": str(candidate.get("currency") or "")[:12],
            "tax_note": str(candidate.get("tax_note") or "")[:80],
            "shipping_note": str(candidate.get("shipping_note") or "")[:80],
            "source": str(candidate.get("source") or "")[:60],
            "confirmed": bool(candidate.get("source") and _confirmed(candidate)),
            "observed_at": str(candidate.get("observed_at") or "")[:40],
            "data_origin": str(candidate.get("data_origin") or "")[:40],
            "comparison": ({
                "comparable": bool(comparison.get("comparable")),
                "unit_basis": str(comparison.get("unit_basis") or "")[:20],
                "diff": str(comparison.get("diff") or "")[:40],
                "rate_pct": str(comparison.get("rate_pct") or "")[:20],
                "reasons": [str(r)[:120] for r in
                            (comparison.get("reasons") or [])[:3]],
            } if comparison else None),
            "unknowns": [str(u)[:80] for u in
                         (candidate.get("unknowns") or [])[:6]],
        })
    return {"ingredient_name": str(ingredient_name or "")[:120],
            "candidates": rows}


def _confirmed(candidate):
    unknowns = candidate.get("unknowns") or []
    return not any("未確認" in str(u) for u in unknowns)


def parse_axis_evaluations(text, candidate_count):
    """Strict-parse a Muse ``{"evaluations": [...]}`` payload.

    Returns ``(evaluations, skipped)`` where evaluations hold only
    compatibility/quality entries with valid indexes. Malformed JSON or a
    wrong top-level shape raises ``AxisEvaluationError``; per-entry
    problems (bad axis/index/reason/confidence, duplicates, Muse ``cost``
    labels) are skipped and counted, never applied.
    """
    import json
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        raise AxisEvaluationError("Axis evaluations are not JSON") from None
    if not isinstance(parsed, dict) or set(parsed) != {"evaluations"}:
        raise AxisEvaluationError("Invalid axis evaluation shape")
    raw = parsed["evaluations"]
    if not isinstance(raw, list) or len(raw) > MAX_PROMPT_CANDIDATES:
        raise AxisEvaluationError("Invalid evaluations list")
    try:
        total = int(candidate_count)
    except (TypeError, ValueError):
        total = 0
    evaluations, skipped, seen = [], 0, set()
    for entry in raw:
        if (not isinstance(entry, dict) or set(entry) !=
                {"candidate_index", "axis", "reason", "confidence"}):
            skipped += 1
            continue
        axis = entry.get("axis")
        index = entry.get("candidate_index")
        reason = entry.get("reason")
        confidence = entry.get("confidence")
        if axis not in MUSE_AXES:
            skipped += 1
            continue
        if (not isinstance(index, int) or isinstance(index, bool)
                or index < 0 or index >= total):
            skipped += 1
            continue
        if (not isinstance(reason, str) or not reason.strip()
                or len(reason) > MAX_REASON_CHARS):
            skipped += 1
            continue
        if confidence not in CONFIDENCES:
            skipped += 1
            continue
        if index in seen:
            skipped += 1
            continue
        seen.add(index)
        evaluations.append({"candidate_index": index, "axis": axis,
                            "reason": reason.strip(),
                            "confidence": confidence})
    return evaluations, skipped


def _cost_reason(candidate):
    comparison = candidate.get("comparison") or {}
    basis = comparison.get("unit_basis")
    diff = comparison.get("diff")
    currency = comparison.get("currency") or "JPY"
    if basis:
        return ("比較可能条件での最安単位価格"
                f"（{diff} {currency}/{basis}、採用基準比）")
    return "比較可能条件での最安単位価格（採用基準比）"


def assign_axes(*, ingredient_id, ingredient_name, candidates,
                evaluations=None, skipped_evaluations=0,
                muse_used=False, muse_error=None, max_picks=STANDARD_PICKS,
                unit_definitions=None):
    """Pick at most one candidate per axis. Deterministic, read-only.

    ``candidates`` is the M7 pool in priority order. ``max_picks`` clamps
    to 1..5 (standard 3). Axes without a qualifying candidate stay empty
    with an explicit reason; similar products never auto-fill a slot.
    """
    try:
        limit = int(max_picks)
    except (TypeError, ValueError):
        limit = STANDARD_PICKS
    limit = min(max(limit, 1), MAX_PICKS)
    pool = [c for c in (candidates or []) if isinstance(c, dict)]

    picks = []
    picked_indexes = set()

    # Cost compares same-ingredient offers only: a similar (different)
    # product is never auto-picked as cheaper; substitutability needs
    # Muse/human judgment on the compatibility axis.
    # All comparable candidates passed M5 against the same adopted
    # basis, so they share one dimension; the dimension check below is a
    # guard, not a cross-dimension ranking (mass vs volume never competes).
    normalized = []
    for i, c in enumerate(pool):
        if c.get("kind") == "similar_product":
            continue
        ranked = _unit_price(c, unit_definitions)
        if ranked is not None:
            normalized.append((i,) + ranked)
    dimension = normalized[0][1] if normalized else None
    priced = sorted(
        ((index, value) for index, dim, value in normalized
         if dim == dimension),
        key=lambda pair: pair[1])
    cost_pick = None
    if priced:
        cost_pick = priced[0][0]
        picks.append({"axis": "cost", "candidate_index": cost_pick,
                      "candidate": pool[cost_pick],
                      "reason": _cost_reason(pool[cost_pick]),
                      "reason_source": "deterministic",
                      "confidence": None})
        picked_indexes.add(cost_pick)
    cost_reason = (None if cost_pick is not None else
                   "比較可能な候補がありません（規格・税・送料条件の不一致、"
                   "採用基準なし、価格情報なしのいずれか）")

    by_axis = {}
    for evaluation in evaluations or ():
        if (not isinstance(evaluation, dict)
                or evaluation.get("axis") not in MUSE_AXES):
            continue
        index = evaluation.get("candidate_index")
        if (not isinstance(index, int) or isinstance(index, bool)
                or index < 0 or index >= len(pool)
                or index in picked_indexes):
            continue
        if evaluation["axis"] not in by_axis:
            by_axis[evaluation["axis"]] = evaluation
            picks.append({"axis": evaluation["axis"],
                          "candidate_index": index,
                          "candidate": pool[index],
                          "reason": evaluation["reason"],
                          "reason_source": "muse",
                          "confidence": evaluation["confidence"]})
            picked_indexes.add(index)

    for index, _ in priced:
        if len(picks) >= limit:
            break
        if index in picked_indexes:
            continue
        if pool[index].get("kind") == "similar_product":
            continue
        picks.append({"axis": "cost", "candidate_index": index,
                      "candidate": pool[index],
                      "reason": "比較可能条件の次点単位価格（同種商品の予備候補）",
                      "reason_source": "deterministic",
                      "confidence": None})
        picked_indexes.add(index)

    picks = picks[:limit]
    axes = {}
    for axis in AXES:
        found = next((p for p in picks if p["axis"] == axis), None)
        if found is not None:
            axes[axis] = {"pick": found,
                          "label": AXIS_LABELS[axis]}
        elif axis == "cost":
            axes[axis] = {"pick": None, "label": AXIS_LABELS[axis],
                          "empty_reason": cost_reason}
        elif not muse_used:
            axes[axis] = {"pick": None, "label": AXIS_LABELS[axis],
                          "empty_reason": ("Muse評価が未実行のため選定なし"
                                           + (f"（{muse_error}）"
                                              if muse_error else ""))}
        else:
            axes[axis] = {"pick": None, "label": AXIS_LABELS[axis],
                          "empty_reason": "条件に合う候補がありません"}
    shortage = None
    if len(picks) < STANDARD_PICKS:
        shortage = (f"軸別の候補は{len(picks)}件のみ選定できました "
                    f"(目安{STANDARD_PICKS}件に不足。無理な埋め合わせはしません)")
    return {"ingredient_id": str(ingredient_id),
            "ingredient_name": ingredient_name,
            "axes": axes,
            "picks": picks,
            "total_found": len(pool),
            "returned": len(picks),
            "shortage_note": shortage,
            "muse_status": {"used": bool(muse_used),
                            "evaluated": len(evaluations or ()),
                            "skipped": int(skipped_evaluations or 0),
                            "error": muse_error}}
