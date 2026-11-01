"""External (web) reference-price seam.

Live web retrieval is NOT configured in this runtime: only the Meta model
API and the Chef Supabase project are wired, so no search/fetch
credentials, cost cap, or terms clearance exists. This module therefore
provides the read-only provider contract -- query building, candidate
validation, and comparability grouping -- with a stub-tested
implementation, while live fetching stays disabled and never fakes prices.

Enabling live lookup requires, at minimum:
  1. a search/fetch provider with credentials (env-gated, e.g.
     EXTERNAL_PRICE_PROVIDER + provider API key),
  2. a per-request cost cap and rate limit,
  3. terms clearance for the target source(s) (no scraping of sources
     that forbid it; no EC-site-specific code lives here),
  4. provenance-preserving fetch (origin, fetched_at, URL, package terms,
     currency, tax/shipping notes).
None of the above exists in this runtime.
"""

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

EXTERNAL_REFERENCE_STATUS = {
    "available": False,
    "reason": ("no configured web-retrieval means: no search API credentials, "
               "cost limit, or terms clearance confirmed; only the owned "
               "ledger is available"),
    "required": ("search/fetch credentials", "cost cap",
                 "terms clearance", "provenance-preserving fetch"),
}

#: Concrete missing conditions blocking live retrieval. Reported (not
#: guessed around) when a caller asks what is needed.
MISSING_CONDITIONS = (
    "no EXTERNAL_PRICE_PROVIDER configured",
    "no provider API credentials in the environment",
    "no per-request cost cap / rate limit defined",
    "no terms clearance for target source(s)",
)


class ExternalReferenceUnavailable(Exception):
    """Raised when live web reference prices are requested but unavailable."""


def fetch_external_reference(query):
    """Live web reference seam. Always raises: no retrieval means exists,
    so no external price is ever faked."""
    raise ExternalReferenceUnavailable(EXTERNAL_REFERENCE_STATUS["reason"])


def build_external_query(material_name, request_text, locale="ja"):
    """Build a provider-neutral search query from a natural-language request.

    The chef's request is carried verbatim (no keyword branching); the
    provider decides how to interpret it. Returns a plain dict so any
    future provider can serialize it without new plumbing.
    """
    material = (material_name or "").strip()
    request = (request_text or "").strip()
    if not material:
        raise ValueError("material name required")
    lang = locale if locale in ("ja", "en") else "ja"
    return {"material_name": material, "request": request, "locale": lang,
            "kind": "reference_price"}


def validate_external_candidate(raw):
    """Validate one external price candidate. Returns a normalized dict or
    None when required provenance/pricing fields are missing.

    Required: name, amount (decimal string, >= 0), currency,
    package_quantity (positive decimal string), package_unit, seller,
    source. Optional: url, fetched_at, tax_note, shipping_note, maker,
    spec. Comparability is decided later; validation only rejects
    uninterpretable rows, never silently repairs them.
    """
    if not isinstance(raw, dict):
        return None
    get = raw.get
    name = get("name")
    amount = get("amount")
    currency = get("currency")
    quantity = get("package_quantity")
    unit = get("package_unit")
    seller = get("seller")
    source = get("source")
    if not all(isinstance(v, str) and v.strip()
               for v in (name, amount, currency, quantity, unit, seller,
                         source)):
        return None
    try:
        value = Decimal(amount.strip())
        base_qty = Decimal(quantity.strip())
    except (InvalidOperation, AttributeError):
        return None
    if value < 0 or base_qty <= 0 or len(amount.strip()) > 30:
        return None
    if len(name.strip()) > 200 or len(currency.strip()) > 10:
        return None
    out = {"name": name.strip(), "amount": str(value),
           "currency": currency.strip(), "package_quantity": str(base_qty),
           "package_unit": unit.strip(), "seller": seller.strip(),
           "source": source.strip()}
    for key in ("url", "fetched_at", "tax_note", "shipping_note", "maker",
                "spec"):
        val = get(key)
        if isinstance(val, str) and val.strip() and len(val) <= 500:
            out[key] = val.strip()
    return out


_MASS = {"g": Decimal(1), "kg": Decimal(1000)}
_VOLUME = {"ml": Decimal(1), "L": Decimal(1000)}


def _to_base(qty, unit):
    mapping = {**_MASS, **_VOLUME}
    factor = mapping.get(unit)
    if factor is None:
        return None, None
    dim = "mass" if unit in _MASS else "volume"
    return dim, qty * factor


def summarize_external_reference(candidates):
    """Group validated external candidates into comparable sets and report
    a sample reference from the largest group.

    Same-currency, same-dimension (mass/volume via g/kg, ml/L) candidates
    with matching tax/shipping notes form a group; anything else is listed
    under excluded with a reason and never mixed into the figure. The
    result is labelled a sample reference with its count -- never a
    general market average. Insufficient or empty input yields
    {"available": False} with the reason stated.
    """
    valid = []
    for raw in candidates or []:
        item = validate_external_candidate(raw)
        if item is None:
            continue
        dim, base_qty = _to_base(Decimal(item["package_quantity"]),
                                 item["package_unit"])
        if base_qty is None or base_qty <= 0:
            continue
        valid.append((item, dim, Decimal(item["amount"]) / base_qty))
    if not valid:
        return {"available": False,
                "reason": "no interpretable external candidates"}
    groups = {}
    for item, dim, unit_price in valid:
        key = (item["currency"], dim, (item.get("tax_note") or ""),
               (item.get("shipping_note") or ""))
        groups.setdefault(key, []).append((item, unit_price))
    currency, dim, _tax, _ship = max(groups, key=lambda k: len(groups[k]))
    members = groups[(currency, dim, _tax, _ship)]
    members.sort(key=lambda pair: pair[1])
    total = sum(price for _, price in members)
    average = (total / len(members)).quantize(Decimal("0.0001"))
    excluded = len(valid) - len(members)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return {"available": True, "origin": "external",
            "currency": currency, "dimension": dim,
            "average_unit_price": str(average),
            "sample_count": len(members), "excluded_count": excluded,
            "label": (f"{len(members)}件のサンプルからの参考値"
                      f"{'（比較対象外' + str(excluded) + '件を除外）' if excluded else ''}"),
            "fetched_at": now,
            "samples": [{"name": item["name"], "seller": item["seller"],
                         "source": item["source"],
                         "amount": item["amount"],
                         "package": (item["package_quantity"] + item["package_unit"])}
                        for item, _ in members]}
