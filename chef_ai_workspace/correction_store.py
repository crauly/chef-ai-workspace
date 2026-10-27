"""Trusted server adapter for context-scoped correction preferences."""
from .correction_memory import Correction

class SupabaseCorrectionStore:
    def __init__(self, trusted_client):
        self.client=trusted_client
    def find_confirmed(self, owner_id, context, phrases, limit):
        response=(self.client.table("correction_preferences")
                  .select("heard_phrase,preferred_phrase,context,confirmed")
                  .eq("owner_id",owner_id).eq("context",context).eq("confirmed",True)
                  .in_("heard_phrase",list(phrases)).limit(limit).execute())
        return [Correction(row["heard_phrase"],row["preferred_phrase"],
                           row["context"],row["confirmed"])
                for row in (response.data or [])]
