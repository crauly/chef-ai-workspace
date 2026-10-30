"""M7: substitute / alternate-supplier sourcing suggestions. Pure functions only.

Suggestions are proposals: this module never creates, updates, or adopts
anything -- no ingredient, supplier, offer, observation, adoption, recipe,
or notification writes, and no network access. Candidates come only from
the caller's already-owned ledger rows passed in by the application layer:

- ``same_product_same_supplier``: another offer of the same ingredient
  from the same supplier as the adopted price basis (different purchase
  terms, e.g. pack size or URL).
- ``same_product_other_supplier``: an offer of the same ingredient from
  a confirmed different supplier. Each carries its latest observation,
  including user-registered ``web_reference`` rows.
- ``same_product_unknown_supplier``: an offer of the same ingredient
  whose supplier is unknown. Shown as a separate purchase term, never
  labelled as another supplier.
- ``similar_product``: different owned ingredients whose names overlap.
  Shown for the chef to judge; name proximity never merges identity.

External web retrieval is NOT available: no search service, credentials,
or cost/terms clearance has been confirmed (see ADR-009 section 6 and the
G0 decision request on retrieval means). ``EXTERNAL_PROVIDER_STATUS`` and
``fetch_external_candidates`` say so explicitly instead of inventing
listings. Price comparison reuses the M5 ``compare_observations`` rules;
incomparable terms yield reasons, never a cheap/expensive verdict.
"""
from .price_history import PriceObservation, compare_observations

MAX_CANDIDATES = 3

EXTERNAL_PROVIDER_STATUS = {
    "available": False,
    "reason": ("no configured web-retrieval means: no search API credentials, "
               "cost limit, or terms clearance confirmed"),
}


class ExternalRetrievalUnavailable(Exception):
    """Raised when live web sourcing is requested but unavailable."""


def _first_present(*values, default=None):
    """First value that is not None. Zero and "" are real values: a zero
    price is valid (schema allows amount >= 0) and must not fall through
    to a fallback or become the string "None"."""
    for value in values:
        if value is not None:
            return value
    return default


def fetch_external_candidates(query):
    """Live web sourcing seam. Always raises:実在する取得手段が未確認の
    ため、架空の候補一覧を返さない."""
    raise ExternalRetrievalUnavailable(
        EXTERNAL_PROVIDER_STATUS["reason"])


def _observation(ingredient_id, offer_id, observation, package_quantity,
                 package_unit):
    return PriceObservation(
        id=str(observation.get("id") or ""),
        ingredient_id=str(ingredient_id),
        offer_id=str(offer_id or ""),
        supplier_id=(str(observation.get("supplier_id"))
                     if observation.get("supplier_id") else None),
        amount=str(_first_present(observation.get("amount"),
                               observation.get("amount_jpy"), default="")),
        currency=str(observation.get("currency") or ""),
        tax_note=observation.get("tax_note"),
        shipping_note=observation.get("shipping_note"),
        package_quantity=str(package_quantity or ""),
        package_unit=str(package_unit or ""),
        source=str(observation.get("source") or ""),
        confirmed=bool(observation.get("confirmed")),
        observed_at=str(observation.get("observed_at") or ""))


def _present_amount(observation):
    value = _first_present(observation.get("amount"),
                           observation.get("amount_jpy"), default=None)
    return str(value) if value is not None else None


def _unknowns(*, package_quantity, package_unit, shipping_note, tax_note,
              observation, similar, supplier_known):
    gaps = []
    if observation is None:
        gaps.append("価格情報なし")
    else:
        if not observation.get("confirmed"):
            gaps.append("未確認の参考価格")
    if not supplier_known:
        gaps.append("仕入先不明")
    if not package_quantity or not package_unit:
        gaps.append("規格不明")
    if shipping_note is None and (observation is None or
                                  observation.get("shipping_note") is None):
        gaps.append("送料条件不明")
    if tax_note is None and (observation is None or
                             observation.get("tax_note") is None):
        gaps.append("税条件不明")
    if similar:
        gaps.append("別商品の可能性あり。規格・品質を人が確認")
    return gaps


def _candidate(*, kind, ingredient_id, ingredient_name, offer_id,
               supplier_id, supplier_name, product_url, package_quantity,
               package_unit, observation, adopted, data_origin):
    shipping = (observation.get("shipping_note")
                if observation else None)
    tax = observation.get("tax_note") if observation else None
    comparison = None
    if adopted is not None and observation is not None:
        result = compare_observations(
            adopted, _observation(ingredient_id, offer_id, observation,
                                  package_quantity, package_unit))
        comparison = {"comparable": result.comparable,
                      "reasons": list(result.reasons),
                      "currency": result.currency,
                      "unit_basis": result.unit_basis,
                      "base_unit_price": result.base_unit_price,
                      "new_unit_price": result.new_unit_price,
                      "diff": result.diff,
                      "rate_pct": result.rate_pct}
    return {
        "kind": kind,
        "ingredient_id": str(ingredient_id),
        "ingredient_name": ingredient_name,
        "offer_id": str(offer_id) if offer_id else None,
        "supplier_name": supplier_name,
        "product_url": product_url,
        "amount": (_present_amount(observation)
                   if observation else None),
        "currency": (str(observation.get("currency"))
                     if observation else None),
        "package_quantity": package_quantity,
        "package_unit": package_unit,
        "shipping_note": shipping,
        "tax_note": tax,
        "source": (str(observation.get("source")) if observation else None),
        "observed_at": (str(observation.get("observed_at"))
                        if observation else None),
        "data_origin": data_origin,
        "unknowns": _unknowns(
            package_quantity=package_quantity, package_unit=package_unit,
            shipping_note=shipping, tax_note=tax,
            observation=observation, similar=(kind == "similar_product"),
            supplier_known=bool(supplier_id or supplier_name)),
        "comparison": comparison,
    }


def suggest_sourcing(*, ingredient_id, ingredient_name,
                     adopted=None, same_offers=(), similar=(),
                     max_candidates=MAX_CANDIDATES,
                     reference_supplier_id=None,
                     adopted_offer_id=None):
    """Assemble up to ``max_candidates`` suggestions from owned ledger rows.

    ``adopted`` is the ingredient's adopted-basis PriceObservation or None.
    The adopted basis's own offer (``adopted_offer_id``) is excluded from
    the alternates: it is the current purchase, not an alternative, and
    must not consume the candidate limit.
    ``same_offers`` rows carry the offer (with ``supplier_id``) plus its
    latest observation (or None). Same-supplier offers are labelled
    ``same_product_same_supplier`` only when their supplier matches
    ``reference_supplier_id`` (normally the adopted basis offer's
    supplier); same-ingredient offers from any other known supplier are
    ``same_product_other_supplier``, while ones with an unknown supplier
    are ``same_product_unknown_supplier`` so the label always matches
    reality. ``similar`` rows carry another owned
    ingredient plus its latest observation (or None). Same-product offers
    come first; the result never invents prices and never labels
    incomparable candidates cheaper or pricier. Read-only: inputs are
    only read.
    """
    try:
        limit = int(max_candidates)
    except (TypeError, ValueError):
        limit = MAX_CANDIDATES
    limit = min(max(limit, 1), 10)
    pooled = []
    for offer in same_offers or ():
        if not isinstance(offer, dict):
            continue
        offer_id = offer.get("offer_id") or offer.get("id")
        if (adopted_offer_id is not None and offer_id is not None
                and str(offer_id) == str(adopted_offer_id)):
            continue
        supplier_id = offer.get("supplier_id")
        if (reference_supplier_id is not None and supplier_id is not None
                and str(supplier_id) == str(reference_supplier_id)):
            kind = "same_product_same_supplier"
        elif supplier_id is not None:
            kind = "same_product_other_supplier"
        else:
            kind = "same_product_unknown_supplier"
        pooled.append(_candidate(
            kind=kind,
            ingredient_id=ingredient_id,
            ingredient_name=ingredient_name,
            offer_id=offer_id,
            supplier_id=supplier_id,
            supplier_name=offer.get("supplier_name"),
            product_url=offer.get("product_url"),
            package_quantity=offer.get("package_quantity"),
            package_unit=offer.get("package_unit"),
            observation=offer.get("observation"),
            adopted=adopted,
            data_origin=offer.get("data_origin") or "ledger"))
    for item in similar or ():
        if not isinstance(item, dict):
            continue
        other_id = item.get("ingredient_id") or item.get("id")
        if not other_id or str(other_id) == str(ingredient_id):
            continue
        pooled.append(_candidate(
            kind="similar_product",
            ingredient_id=other_id,
            ingredient_name=item.get("ingredient_name") or item.get("name"),
            offer_id=item.get("offer_id"),
            supplier_id=item.get("supplier_id"),
            supplier_name=item.get("supplier_name"),
            product_url=item.get("product_url"),
            package_quantity=item.get("package_quantity"),
            package_unit=item.get("package_unit"),
            observation=item.get("observation") or item.get("latest_observation"),
            adopted=adopted,
            data_origin=item.get("data_origin") or "ledger"))
    total_found = len(pooled)
    chosen = pooled[:limit]
    shortage = None
    if total_found < MAX_CANDIDATES:
        shortage = (f"候補は{total_found}件のみ取得できました "
                    f"(目安{MAX_CANDIDATES}件に不足)")
    return {"ingredient_id": str(ingredient_id),
            "ingredient_name": ingredient_name,
            "candidates": chosen,
            "total_found": total_found,
            "returned": len(chosen),
            "shortage_note": shortage,
            "provider": dict(EXTERNAL_PROVIDER_STATUS)}
