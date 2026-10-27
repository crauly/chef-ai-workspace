"""Server-only Supabase PostgREST adapter; inject a trusted authenticated transport.

This module never reads credentials or creates a browser-facing service-role client.
A trusted backend supplies the transport and derives owner_id from verified auth.
"""
from .models import Recipe, MaterialLine, Ingredient, PriceQuote, TrackedValue

def _tracked(raw):
    return TrackedValue(**raw)

def _quote(raw):
    if raw is None:
        return None
    return PriceQuote(amount_jpy=_tracked(raw["amount_jpy"]),
                      per_quantity=raw["per_quantity"], per_unit=raw["per_unit"],
                      source=raw["source"])

def decode_recipe(raw):
    materials = tuple(MaterialLine(
        id=m["id"], material_name=_tracked(m["material_name"]),
        quantity=_tracked(m["quantity"]), unit=m["unit"],
        ingredient_id=m.get("ingredient_id"),
        price_override=_quote(m.get("price_override")),
        price_mode=m.get("price_mode", "override")) for m in raw.get("materials", ()))
    return Recipe(id=raw["id"], title=_tracked(raw["title"]),
                  materials=materials,
                  selling_price_jpy=_tracked(raw["selling_price_jpy"]),
                  cost_adjustment_jpy=_tracked(raw["cost_adjustment_jpy"]),
                  revision=raw["revision"])

class SupabasePersistence:
    def __init__(self, trusted_client):
        """trusted_client must be a server-owned Supabase SDK client."""
        self.client = trusted_client

    def list_owned_recipes(self, owner_id, *, offset=0, limit=20):
        if offset < 0 or limit < 1 or limit > 50:
            raise ValueError("Invalid pagination")
        response = (self.client.table("recipes")
                    .select("id,title,revision,updated_at")
                    .eq("owner_id", owner_id)
                    .order("updated_at", desc=True)
                    .range(offset,offset+limit-1).execute())
        return response.data or []

    def load_owned_recipe(self, owner_id, recipe_id):
        response = (self.client.table("recipes").select("state")
                    .eq("owner_id", owner_id).eq("id", recipe_id).single().execute())
        if not response.data:
            raise ValueError("Recipe not found")
        return decode_recipe(response.data["state"])

    def load_owned_catalog(self, owner_id, recipe):
        ids = sorted({m.ingredient_id for m in recipe.materials
                      if m.price_mode == "inherit" and m.ingredient_id})
        if not ids:
            return {}
        response = (self.client.table("ingredients")
                    .select("id,name,current_price").eq("owner_id", owner_id)
                    .in_("id", ids).execute())
        catalog = {}
        for row in response.data or []:
            catalog[row["id"]] = Ingredient(
                id=row["id"], name=row["name"],
                current_price=_quote(row.get("current_price")))
        return catalog

    def get_mutation_receipt(self, owner_id, request_id):
        response = (self.client.table("mutation_receipts")
                    .select("payload_hash,resulting_revision").eq("owner_id", owner_id)
                    .eq("request_id", request_id).limit(1).execute())
        if not response.data:
            return None
        row = response.data[0]
        return row["payload_hash"], row["resulting_revision"]

    def commit_recipe_revision(self, *, owner_id, recipe_id, request_id,
                               base_revision, state, title, cost_snapshot,
                               payload_hash, save_version):
        params = dict(p_owner_id=owner_id, p_recipe_id=recipe_id,
                      p_request_id=request_id, p_expected_revision=base_revision,
                      p_new_state=state, p_title=title,
                      p_cost_snapshot=cost_snapshot, p_payload_hash=payload_hash,
                      p_save_version=save_version)
        response = self.client.rpc("commit_recipe_revision", params).execute()
        if not isinstance(response.data, int):
            raise RuntimeError("Unexpected commit RPC response")
        return response.data
