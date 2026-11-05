"""Block 1: read-only owned-ledger tools for Meta function calling.

A single function tool, `search_owned_ingredients`, lets the model resolve
an owned ingredient ID on demand instead of relying on caller-prefilled
candidate lists (which are capped and substring-only). The app executes the
lookup through an owner-scoped search callable (never the recipe-costing
catalog, which only holds already-linked IDs), validates the arguments,
and returns only well-formed id/name rows from that search. The tool never
creates, modifies, deletes, or persists anything; linking still requires
the existing mutation validator plus explicit human approval.

Wire format is the Responses API flat function definition, verified live
against muse-spark-1.3 (function_call items with name/arguments/call_id,
manual function_call_output replay with store=false).
"""
from typing import Any, Callable

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
WORKSPACE_TOOLS = LEDGER_TOOLS + [
    {"type": "function", "name": name, "description": description,
     "parameters": {"type": "object", "properties": {key: {"type": "string"}},
                    "required": [key], "additionalProperties": False}}
    for name, key, description in [
        ("search_recipes", "query", "Search the chef's saved recipes; read only."),
        ("get_recipe", "recipe_id", "Read an owned recipe found by search_recipes; use as reference, never change it."),
        ("get_price_reference", "query", "Read owned ledger price evidence. A reference is not an adopted price; only propose prices explicitly requested by the chef for review."),
    ]
]


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


def _row_id_name(row: Any) -> tuple[str, str] | None:
    """Accept id/name dict rows or Ingredient-like objects; reject the rest."""
    if isinstance(row, dict):
        ident, name = row.get("id"), row.get("name")
    else:
        ident, name = getattr(row, "id", None), getattr(row, "name", None)
    if not isinstance(ident, str) or not ident or not isinstance(name, str):
        return None
    return ident, name


def execute_search_owned_ingredients(args: Any, search: Callable[[str, int], Any]) -> dict:
    """Run the owner-scoped lookup. Never raises for bad arguments: those
    become an {"error": ...} result the model can react to. IDs in the
    result always come from the search callable, never from model input."""
    if not isinstance(args, dict):
        return {"error": "invalid_arguments: object required"}
    query = _valid_query(args.get("query"))
    if query is None:
        return {"error": "invalid_arguments: non-empty query up to 100 chars required"}
    limit = _valid_limit(args.get("limit"))
    if limit is None:
        return {"error": "invalid_arguments: limit must be an integer 1-20"}
    try:
        hits = search(query, limit)
    except (ValueError, TypeError, AttributeError, KeyError):
        return {"error": "search_failed"}
    if not isinstance(hits, (list, tuple)):
        return {"error": "search_failed"}
    items = []
    for row in hits[:limit]:
        parsed = _row_id_name(row)
        if parsed is None:
            continue
        items.append({"id": parsed[0], "name": parsed[1]})
    return {"ingredients": items}


def execute_tool(name: Any, args: Any, search: Callable[[str, int], Any], read: Callable | None = None) -> dict:
    """Dispatch one validated tool call. Unknown tool names raise: answering
    them would let the model steer execution outside the owned ledger."""
    if read is not None and name in {"search_recipes", "get_recipe", "get_price_reference"}:
        key = "recipe_id" if name == "get_recipe" else "query"
        if not isinstance(args, dict) or set(args) != {key} or _valid_query(args.get(key)) is None:
            return {"error": "invalid_arguments"}
        return read(name, args[key])
    if name != TOOL_NAME:
        raise ToolLedgerError(f"Unknown tool: {name!r}")
    return execute_search_owned_ingredients(args, search)
