"""Server-only Supabase PostgREST adapter; inject a trusted authenticated transport.

This module never reads credentials or creates a browser-facing service-role client.
A trusted backend supplies the transport and derives owner_id from verified auth.
"""
from dataclasses import asdict
from postgrest.exceptions import APIError
from .models import Recipe, MaterialLine, Ingredient, PriceQuote, TrackedValue
from .mutations import MutationError

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

    def create_owned_recipe(self, owner_id, recipe, cost_snapshot):
        response = self.client.rpc("create_owned_recipe", {
            "p_owner_id": owner_id,
            "p_recipe_id": recipe.id,
            "p_title": recipe.title.value,
            "p_initial_state": asdict(recipe),
            "p_cost_snapshot": cost_snapshot
        }).execute()
        if str(response.data) != recipe.id:
            raise RuntimeError("Unexpected create RPC result")
        return recipe.id

    def list_owned_recipes(self, owner_id, *, offset=0, limit=20, search=""):
        if offset < 0 or limit < 1 or limit > 50:
            raise ValueError("Invalid pagination")
        query = (self.client.table("recipes")
                 .select("id,title,revision,updated_at").eq("owner_id", owner_id))
        if search:
            if len(search) > 200:
                raise ValueError("Search too long")
            pattern = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            query = query.ilike("title", "%" + pattern + "%")
        response = query.order("updated_at", desc=True).range(offset, offset+limit-1).execute()
        return response.data or []

    def load_owned_recipe(self, owner_id, recipe_id):
        try:
            response = (self.client.table("recipes").select("state")
                        .eq("owner_id", owner_id).eq("id", recipe_id).single().execute())
        except Exception as exc:
            if getattr(exc, "code", None) == "PGRST116":
                raise ValueError("Recipe not found") from exc
            raise
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

    def load_owned_ingredients(self, owner_id, ids):
        """Load owned ledger ingredients by ID, independent of recipe lines."""
        wanted = [i for i in dict.fromkeys(ids) if isinstance(i, str) and i]
        if not wanted:
            return {}
        response = (self.client.table("ingredients")
                    .select("id,name,current_price").eq("owner_id", owner_id)
                    .in_("id", wanted).execute())
        catalog = {}
        for row in response.data or []:
            catalog[row["id"]] = Ingredient(
                id=row["id"], name=row["name"],
                current_price=_quote(row.get("current_price")))
        return catalog

    def search_owned_ingredients(self, owner_id, query, limit=20):
        """Owner-scoped ingredient search for reuse candidates and past-recipe
        references. Returns id/name rows only; identity decisions stay with
        the chef's explicit approval, never with proximity."""
        if not isinstance(query, str) or not query.strip() or limit < 1:
            return []
        pattern = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        response = (self.client.table("ingredients")
                    .select("id,name,brand,spec").eq("owner_id", owner_id)
                    .ilike("name", "%" + pattern + "%")
                    .order("name").limit(min(limit, 50)).execute())
        return response.data or []

    def create_owned_supplier(self, owner_id, name, note=None):
        """Minimal supplier registration. Owner is server-derived; the
        0003 trigger rejects cross-owner references on dependent rows."""
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Supplier name required")
        response = (self.client.table("suppliers")
                    .insert({"owner_id": owner_id, "name": name.strip(),
                             "note": note}).execute())
        rows = response.data or []
        if not rows or "id" not in rows[0]:
            raise RuntimeError("Unexpected supplier insert response")
        return rows[0]["id"]

    def list_owned_suppliers(self, owner_id, limit=50):
        response = (self.client.table("suppliers")
                    .select("id,name,note").eq("owner_id", owner_id)
                    .order("name").limit(min(max(limit, 1), 100)).execute())
        return response.data or []

    def create_owned_offer(self, owner_id, ingredient_id, supplier_id=None,
                           product_url=None, package_quantity=None,
                           package_unit=None, shipping_note=None):
        """Minimal purchase-terms row. Ownership of the referenced ingredient
        (and supplier, if given) is re-checked here; the 0003 trigger
        enforces it again in the database regardless of role."""
        owned = self.load_owned_ingredients(owner_id, [ingredient_id])
        if ingredient_id not in owned:
            raise ValueError("Ingredient not owned by caller")
        if supplier_id is not None:
            suppliers = (self.client.table("suppliers").select("id")
                         .eq("owner_id", owner_id).eq("id", supplier_id)
                         .limit(1).execute()).data or []
            if not suppliers:
                raise ValueError("Supplier not owned by caller")
        response = (self.client.table("offers").insert({
            "owner_id": owner_id, "ingredient_id": ingredient_id,
            "supplier_id": supplier_id, "product_url": product_url,
            "package_quantity": package_quantity, "package_unit": package_unit,
            "shipping_note": shipping_note}).execute())
        rows = response.data or []
        if not rows or "id" not in rows[0]:
            raise RuntimeError("Unexpected offer insert response")
        return rows[0]["id"]

    def list_ingredient_offers(self, owner_id, ingredient_id):
        owned = self.load_owned_ingredients(owner_id, [ingredient_id])
        if ingredient_id not in owned:
            raise ValueError("Ingredient not owned by caller")
        response = (self.client.table("offers")
                    .select("id,supplier_id,product_url,package_quantity,"
                            "package_unit,shipping_note")
                    .eq("owner_id", owner_id).eq("ingredient_id", ingredient_id)
                    .execute())
        return response.data or []

    def commit_recipe_revision(self, *, owner_id, recipe_id, request_id,
                               base_revision, state, title, cost_snapshot,
                               payload_hash, save_version):
        params = dict(p_owner_id=owner_id, p_recipe_id=recipe_id,
                      p_request_id=request_id, p_expected_revision=base_revision,
                      p_new_state=state, p_title=title,
                      p_cost_snapshot=cost_snapshot, p_payload_hash=payload_hash,
                      p_save_version=save_version)
        try:
            response = self.client.rpc("commit_recipe_revision", params).execute()
        except APIError as exc:
            # Preparation can succeed in both writers before the RPC row lock decides
            # the winner. Surface only the RPC's known conflicts as HTTP 409 via the
            # existing application boundary; do not disguise other database failures.
            if exc.code == "P0001" and exc.message in (
                "Stale recipe revision", "Request ID reused with a different mutation"
            ):
                raise MutationError(exc.message) from exc
            raise
        if not isinstance(response.data, int):
            raise RuntimeError("Unexpected commit RPC response")
        return response.data

    def commit_recipe_with_ledger(self, *, owner_id, recipe_id, request_id,
                                  base_revision, state, title, cost_snapshot,
                                  payload_hash, save_version, new_ingredients):
        params = dict(p_owner_id=owner_id, p_recipe_id=recipe_id,
                      p_request_id=request_id, p_expected_revision=base_revision,
                      p_new_state=state, p_title=title,
                      p_cost_snapshot=cost_snapshot, p_payload_hash=payload_hash,
                      p_save_version=save_version,
                      p_new_ingredients=list(new_ingredients))
        try:
            response = self.client.rpc("commit_recipe_with_ledger", params).execute()
        except APIError as exc:
            # Negative ints pass through: they signal a receipt replay, and the
            # orchestration maps them to replayed=True with canonical state.
            if exc.code == "P0001" and exc.message in (
                "Stale recipe revision", "Request ID reused with a different mutation",
                "Ingredient not owned by caller", "Ingredient already registered",
                "Invalid ledger ingredient",
                "Invalid ledger payload", "Invalid mutation payload",
            ):
                raise MutationError(exc.message) from exc
            raise
        if not isinstance(response.data, int):
            raise RuntimeError("Unexpected commit RPC response")
        return response.data
