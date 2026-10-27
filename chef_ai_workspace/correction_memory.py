"""Small correction-memory harness: exact, context-scoped, confirmed preferences.

Do not apply substitutions silently. These are suggestions, not facts or mutations.
The store protocol can later be backed by existing Supabase PostgreSQL.
"""
from dataclasses import dataclass
from typing import Protocol

@dataclass(frozen=True)
class Correction:
    phrase: str
    preferred: str
    context: str
    confirmed: bool

    def __post_init__(self):
        if not self.phrase.strip() or not self.preferred.strip() or not self.context.strip():
            raise ValueError("Correction requires phrase, preferred name and context")

class CorrectionStore(Protocol):
    def find_confirmed(self, owner_id: str, context: str, phrases: tuple[str, ...], limit: int) -> list[Correction]: ...

def retrieve_suggestions(store: CorrectionStore, *, owner_id: str,
                         context: str, phrases: tuple[str,...], limit: int = 5) -> list[dict]:
    if not owner_id.strip() or not context.strip() or not 1 <= limit <= 10:
        raise ValueError("Invalid correction lookup")
    normalized = tuple(dict.fromkeys(p.strip() for p in phrases if p.strip()))[:20]
    if not normalized:
        return []
    records = store.find_confirmed(owner_id, context, normalized, limit)
    return [{"heard":r.phrase,"candidate":r.preferred,"context":r.context}
            for r in records[:limit] if r.confirmed
            and r.context == context and r.phrase in normalized]

def context_for_recipe(recipe_id: str) -> str:
    return "recipe:" + recipe_id
