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
        # The approved ID must always be stated explicitly, even for a single
        # exact match: silence never implies the chef's choice.
        ids = {g.id for g in candidate.candidates}
        if approved_ingredient_id is None or approved_ingredient_id not in ids:
            raise ValueError("Approved ingredient must be chosen from candidates")
        wanted = approved_ingredient_id
        if inherit_price:
            ops = ({"op": "link_ingredient", "material_id": material_id,
                     "ingredient_id": wanted, "price_mode": "inherit"},)
        else:
            if not quote or not all(k in quote for k in
                                    ("price_jpy", "price_quantity", "price_unit")):
                raise ValueError("Override link requires explicit quote")
            # Copy only the three price fields: extra quote keys (e.g. a
            # foreign ingredient_id/material_id/price_mode) must never
            # redirect the chef's approved link.
            ops = ({"op": "link_ingredient", "material_id": material_id,
                     "ingredient_id": wanted, "price_mode": "override",
                     "price_jpy": quote["price_jpy"],
                     "price_quantity": quote["price_quantity"],
                     "price_unit": quote["price_unit"]},)
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
                     "ingredient_id": new_id, "price_mode": "override",
                     "price_jpy": quote["price_jpy"],
                     "price_quantity": quote["price_quantity"],
                     "price_unit": quote["price_unit"]},)
        return ledger, ops
    # Without an assigned ID no executable request can be built: the
    # confirm boundary requires at least one operation and the persistence
    # layer rejects empty operations. Callers must use the server-issued
    # suggested ID (one-shot path above) so registration and linking
    # complete as one approved request.
    raise ValueError("New ingredient approval requires an assigned ID")


def match_recipe_master(owner, repository, name, *, ingredient_id=None, new_master=False, spec=None, candidate_rows=None, similarity_action="choose"):
    """Single identity policy for registration and editing.

    Exact matches (including spec) always retain their existing contract.
    Registration chooses create for similarity-only results; editing chooses
    a candidate. Similarity never selects an existing ingredient ID.
    """
    if similarity_action not in ("choose", "create"):
        raise ValueError("Invalid similarity action")
    from .mutations import MutationError
    if ingredient_id:
        ingredient=repository.load_owned_ingredients(owner,[ingredient_id]).get(ingredient_id)
        if ingredient is None: raise MutationError("Ingredient not owned")
        return {"name":name,"master_name":ingredient.name,"ingredient_id":ingredient_id,"action":"reuse","spec":spec,"candidates":[]}
    exact=repository.find_owned_ingredients_exact(owner,name)
    if spec is not None:
        exact=[row for row in exact if (row.get("spec") or "").strip().casefold()==spec.strip().casefold()]
    if new_master:
        if exact: raise MutationError("Ingredient identity collision; reuse the existing master")
        return {"name":name,"master_name":name,"ingredient_id":None,"action":"create","spec":spec,"candidates":[]}
    if len(exact)==1:
        row=exact[0]
        return {"name":name,"master_name":row["name"],"ingredient_id":str(row["id"]),"action":"reuse","spec":row.get("spec"),"candidates":[]}
    candidates=exact
    if not candidates and similarity_action=="choose":
        import unicodedata
        from difflib import SequenceMatcher
        def normalize(value): return ''.join(c for c in unicodedata.normalize('NFKC',value).casefold() if c.isalnum())
        needle=normalize(name)
        loader=getattr(repository,"list_owned_ingredient_master",None)
        rows=candidate_rows if candidate_rows is not None else (loader(owner) if callable(loader) else [])
        scored=[]
        for row in rows:
            label=normalize(row["name"])
            score=SequenceMatcher(None,needle,label).ratio()
            if needle and label and (needle in label or label in needle or score>=0.68): scored.append((score,row))
        candidates=[r for _,r in sorted(scored,key=lambda x:(-x[0],x[1]["name"],x[1]["id"]))[:20]]
    return {"name":name,"master_name":name,"ingredient_id":None,"action":"choose" if candidates else "create","spec":spec,
            "candidates":[{k:r.get(k) for k in ("id","name","spec","brand")} for r in candidates]}
