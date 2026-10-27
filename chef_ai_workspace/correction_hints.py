"""Bounded, owner- and recipe-scoped hints: never silently rewrite chef input."""
from .correction_memory import Correction

class SupabaseCorrectionHints:
    def __init__(self, client): self.client=client
    def relevant(self, owner_id: str, recipe_id: str, instruction: str, limit: int=5) -> list[dict]:
        if not 1 <= limit <= 10: raise ValueError("Invalid limit")
        if not instruction.strip(): return []
        context="recipe:"+recipe_id
        response=self.client.rpc("find_relevant_corrections", {
            "p_owner_id":owner_id,"p_context":context,
            "p_instruction":instruction,"p_limit":limit}).execute()
        return [{"heard":row["heard_phrase"],"candidate":row["preferred_phrase"]}
                for row in (response.data or [])]

    def record(self, owner_id: str, recipe_id: str, heard: str, preferred: str):
        if not heard.strip() or not preferred.strip() or heard.strip()==preferred.strip():
            raise ValueError("Meaningful correction required")
        self.client.table("correction_preferences").upsert({
            "owner_id":owner_id,"context":"recipe:"+recipe_id,
            "heard_phrase":heard.strip(),"preferred_phrase":preferred.strip(),
            "confirmed":True},on_conflict="owner_id,context,heard_phrase,preferred_phrase").execute()
