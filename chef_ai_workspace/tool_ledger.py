"""Block 1: read-only owned-ledger tools for Meta function calling.

A single function tool, `search_owned_ingredients`, lets the model resolve
an owned ingredient ID on demand instead of relying on caller-prefilled
candidate lists (which are capped and substring-only). The app executes the
lookup against the owned catalog, validates the arguments, and validates
that every returned ID exists in that catalog. The tool never creates,
modifies, deletes, or persists anything; linking still requires the
existing mutation validator plus explicit human approval.

Wire format is the Responses API flat function definition, verified live
against muse-spark-1.3 (function_call items with name/arguments/call_id,
manual function_call_output replay with store=false).
"""
from typing import Any, Mapping

TOOL_NAME = "search_owned_ingredients"
DEFAULT_LIMIT = 8
MAX_LIMIT = 20
MAX_QUERY_CHARS = 100

SEARCH_OWNED_INGREDIENTS_TOOL = {
    "type": "function",
    "name": TOOL_NAME,
    "description": (
        "Search the chef's OWNED ingredient catalog by name and return "
        "matching ingredient IDs and names. Call this before link_ingredient "
        "when the needed ingredient ID is not already known. "
        "Read-only: it never creates, modifies, or deletes anything."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Ingredient name or fragment as spoken, e.g. 'トマト'.",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum matches to return, 1-20.",
                "minimum": 1,
                "maximum": MAX_LIMIT,
            },
        },
        "required": ["query"],
        "additionalProperties": False,
    },
}

LEDGER_TOOLS = [SEARCH_OWNED_INGREDIENTS_TOOL]


class ToolLedgerError(Exception):
    pass


def _valid_query(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    query = value.strip()
    if not query or len(query) > MAX_QUERY_CHARS:
        return None
    return query


def _valid_limit(value: Any) -> int | None:
    if value is None:
        return DEFAULT_LIMIT
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 1 or value > MAX_LIMIT:
        return None
    return value


def execute_search_owned_ingredients(args: Any, catalog: Mapping[str, Any]) -> dict:
    """Run the owned-catalog lookup. Never raises for bad arguments: those
    become an {"error": ...} result the model can react to. IDs in the
    result always come from the supplied catalog, never from model input."""
    if not isinstance(args, dict):
        return {"error": "invalid_arguments: object required"}
    query = _valid_query(args.get("query"))
    if query is None:
        return {"error": "invalid_arguments: non-empty query up to 100 chars required"}
    limit = _valid_limit(args.get("limit"))
    if limit is None:
        return {"error": "invalid_arguments: limit must be an integer 1-20"}
    from .ingredient_assist import search_owned_ingredients
    hits = search_owned_ingredients(query, catalog or {})
    items = []
    for ingredient in hits[:limit]:
        ident = getattr(ingredient, "id", None)
        name = getattr(ingredient, "name", None)
        if not isinstance(ident, str) or not ident or not isinstance(name, str):
            continue
        if catalog is not None and ident not in catalog:
            continue
        items.append({"id": ident, "name": name})
    return {"ingredients": items}


def execute_tool(name: Any, args: Any, catalog: Mapping[str, Any]) -> dict:
    """Dispatch one validated tool call. Unknown tool names raise: answering
    them would let the model steer execution outside the owned ledger."""
    if name != TOOL_NAME:
        raise ToolLedgerError(f"Unknown tool: {name!r}")
    return execute_search_owned_ingredients(args, catalog)
