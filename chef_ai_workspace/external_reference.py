"""External (web) reference-price seam. Retrieval means NOT configured.

Mirrors the M7 sourcing stance: instead of inventing listings, the status
says what is missing. Enabling live lookup requires, at minimum, a
configured search/fetch means with credentials, a cost cap, and terms
clearance -- none of which exists in this runtime (only the Meta model API
and the Chef Supabase project are wired). No EC-site-specific code lives
here; any future provider must fill provenance (origin, fetched_at, URL,
package terms, currency, tax/shipping notes) and stay read-only.
"""

EXTERNAL_REFERENCE_STATUS = {
    "available": False,
    "reason": ("no configured web-retrieval means: no search API credentials, "
               "cost limit, or terms clearance confirmed; only the owned "
               "ledger is available"),
    "required": ("search/fetch credentials", "cost cap",
                 "terms clearance", "provenance-preserving fetch"),
}


class ExternalReferenceUnavailable(Exception):
    """Raised when live web reference prices are requested but unavailable."""


def fetch_external_reference(query):
    """Live web reference seam. Always raises: no retrieval means exists,
    so no external price is ever faked."""
    raise ExternalReferenceUnavailable(EXTERNAL_REFERENCE_STATUS["reason"])
