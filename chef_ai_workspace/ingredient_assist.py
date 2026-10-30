"""M4: voice/NL ingredient assistance. Pure functions only, no persistence.

The model/voice layer proposes; the chef approves. This module never invents
ingredient IDs, never merges same-named products, and never saves anything.
Linking or registering happens only through the approved confirm path
(save_recipe_with_ledger) with an explicit human approval action.
"""
from dataclasses import dataclass
from typing import Mapping

from .models import Ingredient
from .persistence_service import LedgerIngredient

MAX_CANDIDATES = 20


def _norm(text: str) -> str:
    return "".join(text.split()).lower()


@dataclass(frozen=True)
class LinkCandidate:
    """One material's assistive outcome. 'reuse' carries exactly one owned
    ID; 'ambiguous' carries owned candidates for the chef to choose from;
    'new' means no owned match -- registration still needs approval."""
    decision: str  # "reuse" | "ambiguous" | "new"
    candidates: tuple[Ingredient, ...] = ()


def search_owned_ingredients(query: str,
                             catalog: Mapping[str, Ingredient],
                             limit: int = MAX_CANDIDATES) -> list[Ingredient]:
    """Substring search over the caller's owned catalog only (which includes
    ingredients used by past recipes once loaded). Empty query matches nothing."""
    needle = _norm(query) if isinstance(query, str) else ""
    if not needle:
        return []
    hits = [g for g in (catalog or {}).values()
            if needle in _norm(g.name)]
    hits.sort(key=lambda g: (len(g.name), g.name))
    return hits[:max(0, limit)]


def classify_material(name: str,
                      catalog: Mapping[str, Ingredient]) -> LinkCandidate:
    """Exact-name match only. One match reuses that ID; several same-named
    products stay separate IDs for the chef to pick; no match proposes a
    new registration. Proximity alone never decides identity."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Material name required")
    exact = [g for g in (catalog or {}).values() if _norm(g.name) == _norm(name)]
    if len(exact) == 1:
        return LinkCandidate("reuse", (exact[0],))
    if exact:
        return LinkCandidate("ambiguous", tuple(sorted(exact, key=lambda g: g.id)))
    return LinkCandidate("new", ())


def build_approval_request(*, material_id: str, material_name: str,
                           candidate: LinkCandidate,
                           new_brand: str | None = None,
                           new_spec: str | None = None,
                           new_id: str | None = None,
                           approved_ingredient_id: str | None = None,
                           approved_new: bool = False,
                           inherit_price: bool = False,
                           quote: dict | None = None) -> tuple[tuple[LedgerIngredient, ...], tuple[dict, ...]]:
    """Build one approval's ledger + link operations from the chef's explicit
    choice. Raises unless the choice is unambiguous:

    - reuse/ambiguous: approved_ingredient_id must be one of the candidates.
    - new: approved_new must be True (explicit registration approval).

    inherit_price links with price_mode inherit; otherwise an explicit quote
    dict (price_jpy/price_quantity/price_unit) is required -- no silent
    catalog-price adoption.
    """
    from uuid import UUID as _UUID
    try:
        _UUID(material_id)
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("Invalid material ID") from exc
    if candidate.decision in ("reuse", "ambiguous"):
        wanted = approved_ingredient_id or (candidate.candidates[0].id
                                            if candidate.decision == "reuse" and len(candidate.candidates) == 1
                                            and approved_ingredient_id is None else None)
        # Single exact reuse may default, but only to its sole candidate and
        # only from an explicit approval call -- never from model text.
        ids = {g.id for g in candidate.candidates}
        if wanted is None or wanted not in ids:
            raise ValueError("Approved ingredient must be chosen from candidates")
        if inherit_price:
            ops = ({"op": "link_ingredient", "material_id": material_id,
                     "ingredient_id": wanted, "price_mode": "inherit"},)
        else:
            if not quote or not all(k in quote for k in
                                    ("price_jpy", "price_quantity", "price_unit")):
                raise ValueError("Override link requires explicit quote")
            ops = ({"op": "link_ingredient", "material_id": material_id,
                     "ingredient_id": wanted, "price_mode": "override", **quote},)
        return (LedgerIngredient("reuse", id=wanted),), ops
    if not approved_new:
        raise ValueError("New ingredient registration requires explicit approval")
    if not material_name.strip():
        raise ValueError("New ingredient requires a name")
    if new_id is not None:
        # One-shot path: the approval action assigns the new ID, so the same
        # approved request registers the ingredient AND links the line (M2).
        from uuid import UUID as _UUID2
        try:
            _UUID2(new_id)
        except (ValueError, TypeError, AttributeError) as exc:
            raise ValueError("Invalid new ingredient ID") from exc
        ledger = (LedgerIngredient("new", id=new_id, name=material_name.strip(),
                                   brand=new_brand, spec=new_spec),)
        if inherit_price:
            ops = ({"op": "link_ingredient", "material_id": material_id,
                     "ingredient_id": new_id, "price_mode": "inherit"},)
        else:
            if not quote or not all(k in quote for k in
                                    ("price_jpy", "price_quantity", "price_unit")):
                raise ValueError("Override link requires explicit quote")
            ops = ({"op": "link_ingredient", "material_id": material_id,
                     "ingredient_id": new_id, "price_mode": "override", **quote},)
        return ledger, ops
    # Without an assigned ID the approval registers first; the saved ID is
    # linked explicitly in a follow-up approval.
    return (LedgerIngredient("new", name=material_name.strip(),
                             brand=new_brand, spec=new_spec),), ()
