"""Bounded, owner- and recipe-scoped hints: never silently rewrite chef input."""
from .correction_memory import Correction

class SupabaseCorrectionHints:
    def __init__(self, client): self.client=client
    def relevant(self, owner_id: str, recipe_id: str, instruction: str, limit: int=5) -> list[dict]:
        if not 1 <= limit <= 10: raise ValueError("Invalid limit")
        if not instruction.strip(): return []
        context="recipe:"+recipe_id
        response=(self.client.table("correction_preferences")
                  .select("heard_phrase,preferred_phrase,context,confirmed")
                  .eq("owner_id",owner_id).eq("context",context).eq("confirmed",True)
                  .order("created_at",desc=True).limit(50).execute())
        return [{"heard":row["heard_phrase"],"candidate":row["preferred_phrase"]}
                for row in (response.data or [])
                if row["heard_phrase"] and row["heard_phrase"] in instruction][:limit]
    def record(self, owner_id: str, recipe_id: str, heard: str, preferred: str):
        if not heard.strip() or not preferred.strip() or heard.strip()==preferred.strip():
            raise ValueError("Meaningful correction required")
        self.client.table("correction_preferences").upsert({
            "owner_id":owner_id,"context":"recipe:"+recipe_id,
            "heard_phrase":heard.strip(),"preferred_phrase":preferred.strip(),
            "confirmed":True},on_conflict="owner_id,context,heard_phrase,preferred_phrase").execute()
