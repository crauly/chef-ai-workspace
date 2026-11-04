"""Server-only Supabase PostgREST adapter; inject a trusted authenticated transport.

This module never reads credentials or creates a browser-facing service-role client.
A trusted backend supplies the transport and derives owner_id from verified auth.
"""
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
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
                      source=raw["source"], per_unit_id=raw.get("per_unit_id"))

def decode_recipe(raw):
    materials = tuple(MaterialLine(
        id=m["id"], material_name=_tracked(m["material_name"]),
        quantity=_tracked(m["quantity"]), unit=m["unit"],
        ingredient_id=m.get("ingredient_id"),
        price_override=_quote(m.get("price_override")),
        price_mode=m.get("price_mode", "override"),
        unit_id=m.get("unit_id"), supplier_id=m.get("supplier_id"),
        offer_id=m.get("offer_id")) for m in raw.get("materials", ()))
    return Recipe(id=raw["id"], title=_tracked(raw["title"]),
                  materials=materials,
                  selling_price_jpy=_tracked(raw["selling_price_jpy"]),
                  cost_adjustment_jpy=_tracked(raw["cost_adjustment_jpy"]),
                  revision=raw["revision"])

class SupabasePersistence:
    def __init__(self, trusted_client):
        """trusted_client must be a server-owned Supabase SDK client."""
        self.client = trusted_client

    def create_owned_recipe(self, owner_id, recipe, cost_snapshot, unit_candidates=(), ingredient_entries=()):
        response = self.client.rpc("create_owned_recipe", {
            "p_owner_id": owner_id,
            "p_recipe_id": recipe.id,
            "p_title": recipe.title.value,
            "p_initial_state": asdict(recipe),
            "p_cost_snapshot": cost_snapshot,
            "p_unit_candidates": list(unit_candidates),
            "p_ingredient_entries": list(ingredient_entries),
        }).execute()
        if str(response.data) != recipe.id:
            raise RuntimeError("Unexpected create RPC result")
        return recipe.id

    @staticmethod
    def _creation_hash(payload):
        from hashlib import sha256
        from .persistence_service import canonical_json
        return sha256(canonical_json(payload).encode("utf-8")).hexdigest()

    def verify_owned_creation_payload(self, owner_id, recipe_id, payload):
        rows=(self.client.table("recipes").select("creation_payload_hash")
              .eq("owner_id",owner_id).eq("id",recipe_id).execute()).data or []
        if not rows or (rows[0].get("creation_payload_hash") is not None and
                        rows[0]["creation_payload_hash"] != self._creation_hash(payload)):
            raise ValueError("Creation request conflict")

    def create_owned_procured_recipe(self, owner_id, recipe, cost_snapshot, *, unit_candidates=(),
                                     ingredient_entries=(), procurement=(), request_payload):
        try:
            result=self.client.rpc("create_owned_procured_recipe",{
                "p_owner_id":owner_id,"p_recipe_id":recipe.id,"p_title":recipe.title.value,
                "p_initial_state":asdict(recipe),"p_cost_snapshot":cost_snapshot,
                "p_unit_candidates":list(unit_candidates),"p_ingredient_entries":list(ingredient_entries),
                "p_procurement":list(procurement),"p_payload_hash":self._creation_hash(request_payload),
            }).execute()
        except APIError as exc:
            if str(getattr(exc,"code","")) in ("P0001","23505","23503"):
                raise ValueError("Procurement identity or creation conflict") from exc
            raise
        if str(result.data)!=recipe.id: raise RuntimeError("Unexpected procurement result")
        return recipe.id

    def ensure_market_reference_supplier(self, owner_id):
        return self.client.rpc("ensure_market_reference_supplier",{"p_owner_id":owner_id}).execute().data

    def load_owned_supplier_names(self, owner_id, ids):
        rows=(self.client.table("suppliers").select("id,name").eq("owner_id",owner_id).in_("id",ids).execute()).data or []
        return {row["id"]:row["name"] for row in rows}

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

    def delete_owned_recipe(self, owner_id, recipe_id):
        """Delete only a recipe owned by the authenticated demo owner.

        Recipe versions and mutation receipts have ON DELETE CASCADE
        constraints; unrelated ingredient master records are preserved.
        """
        image_rows = (self.client.table("recipe_dish_images")
                      .select("storage_path").eq("owner_id",owner_id)
                      .eq("recipe_id",recipe_id).limit(1).execute()).data or []
        rows = (self.client.table("recipes").delete()
                .eq("owner_id", owner_id)
                .eq("id", recipe_id)
                .execute()).data or []
        if rows and image_rows:
            # Metadata is cascaded by SQL; delete the private object via the
            # Storage API, never by directly removing storage.objects rows.
            try:
                self.client.storage.from_("chef-recipe-dishes").remove(
                    [image_rows[0]["storage_path"]])
            except Exception:
                pass
        return bool(rows)

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

    def create_owned_ingredient_master(self, owner_id, name, spec=None):
        result=self.client.rpc("create_owned_ingredient_master",{
            "p_owner_id":owner_id,"p_name":name,"p_spec":spec}).execute()
        return result.data

    def delete_owned_ingredient_master(self, owner_id, ingredient_id):
        result=self.client.rpc("delete_owned_ingredient_master",{
            "p_owner_id":owner_id,"p_id":ingredient_id}).execute()
        return result.data is True

    def create_owned_unit_master(self, owner_id, symbol, dimension):
        result=self.client.rpc("create_owned_unit_master",{
            "p_owner_id":owner_id,"p_symbol":symbol,"p_dimension":dimension}).execute()
        return result.data

    def delete_owned_unit_master(self, owner_id, unit_id):
        result=self.client.rpc("delete_owned_unit_master",{
            "p_owner_id":owner_id,"p_id":unit_id}).execute()
        return result.data is True

    def list_owned_units(self, owner_id):
        """List the complete owner-scoped vocabulary for contextual AI matching."""
        rows = []
        page_size = 500
        while True:
            # Stable order is essential: an omitted page could turn reuse into
            # an unsafe new registration or hide an ambiguous alias.
            response = (self.client.table("units")
                        .select("id,symbol,dimension,base_factor,aliases")
                        .eq("owner_id", owner_id)
                        .order("id")
                        .range(len(rows), len(rows) + page_size - 1)
                        .execute())
            batch = response.data or []
            rows.extend(batch)
            if not batch:
                return rows

    def update_owned_unit(self, owner_id, unit_id, symbol, dimension, base_factor, aliases):
        response = self.client.rpc("update_owned_unit", {
            "p_owner_id": owner_id,
            "p_unit_id": unit_id,
            "p_symbol": symbol,
            "p_dimension": dimension,
            "p_base_factor": base_factor,
            "p_aliases": list(aliases),
        }).execute()
        return bool(response.data)

    def list_owned_ingredient_master(self, owner_id):
        """Complete owner-scoped ingredient SSOT for the manager."""
        rows=[]
        while True:
            response=(self.client.table("ingredients")
                      .select("id,name,spec,current_price")
                      .eq("owner_id",owner_id)
                      .order("id").range(len(rows),len(rows)+499).execute())
            batch=response.data or []
            if not batch:
                return rows
            rows.extend(batch)

    def list_owned_ingredient_suppliers(self, owner_id):
        """Supplier names from owned purchase offers, not guessed from master price.

        An ingredient may have multiple suppliers. Entries without a supplier
        are not considered evidence that no other supplier is linked.
        """
        offers = []
        while True:
            batch = (self.client.table("offers")
                     .select("ingredient_id,supplier_id")
                     .eq("owner_id", owner_id)
                     .order("id")
                     .range(len(offers), len(offers) + 499).execute()).data or []
            if not batch:
                break
            offers.extend(batch)
        supplier_ids = sorted({row["supplier_id"] for row in offers
                               if row.get("supplier_id")})
        names = {}
        for start in range(0, len(supplier_ids), 200):
            batch = (self.client.table("suppliers").select("id,name")
                     .eq("owner_id", owner_id)
                     .in_("id", supplier_ids[start:start + 200])
                     .execute()).data or []
            names.update({row["id"]: row["name"] for row in batch})
        linked = {}
        for row in offers:
            supplier = names.get(row.get("supplier_id"))
            if supplier:
                linked.setdefault(str(row["ingredient_id"]), set()).add(supplier)
        return {ingredient_id: sorted(suppliers)
                for ingredient_id, suppliers in linked.items()}

    def link_owned_ingredient_supplier(self, owner_id, ingredient_id, supplier_id):
        """Explicit supplier link through an owned purchase offer; no overwrite."""
        existing = (self.client.table("offers").select("id")
                    .eq("owner_id", owner_id)
                    .eq("ingredient_id", ingredient_id)
                    .eq("supplier_id", supplier_id)
                    .limit(1).execute()).data or []
        if existing:
            return existing[0]["id"]
        return self.create_owned_offer(owner_id, ingredient_id, supplier_id)

    def update_owned_ingredient_master(self, owner_id, ingredient_id, name, quote, spec=None):
        result=self.client.rpc("update_owned_ingredient",{
            "p_owner_id":owner_id,
            "p_ingredient_id":ingredient_id,
            "p_name":name,
            "p_price":quote,
            "p_spec":spec,
        }).execute()
        return result.data is True

    def find_owned_ingredients_exact(self, owner_id, name):
        """Owner-scoped exact product identity lookup (never fuzzy merge)."""
        if not isinstance(name,str) or not name.strip():
            return []
        # Escape LIKE metacharacters; exact match is checked again after
        # receipt because SQL matching and Python casefold differ by locale.
        token=name.strip().replace("\\","\\\\").replace("%","\\%").replace("_","\\_")
        response=(self.client.table("ingredients")
                  .select("id,name,current_price").eq("owner_id",owner_id)
                  .ilike("name",token).execute())
        return [row for row in (response.data or [])
                if row["name"].strip().casefold()==name.strip().casefold()]

    def search_owned_ingredients(self, owner_id, query, limit=20):
        """Owner-scoped ingredient search for reuse candidates and past-recipe
        references. Returns id/name rows only; identity decisions stay with
        the chef's explicit approval, never with proximity."""
        if not isinstance(query, str) or not query.strip() or limit < 1:
            return []
        pattern = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        matches = {}
        for column in ("name", "spec"):
            response = (self.client.table("ingredients")
                        .select("id,name,brand,spec").eq("owner_id", owner_id)
                        .ilike(column, "%" + pattern + "%")
                        .order("name").limit(min(limit, 50)).execute())
            for row in response.data or []:
                matches[row["id"]] = row
        return sorted(matches.values(), key=lambda row: (row.get("name") or "", row.get("spec") or "", row["id"]))[:limit]

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

    def list_owned_suppliers(self, owner_id, limit=50, offset=0):
        response = (self.client.table("suppliers")
                    .select("id,name,note,is_market_reference").eq("owner_id", owner_id)
                    .order("name").order("id")
                    .range(max(offset, 0), max(offset, 0) + min(max(limit, 1), 100) - 1).execute())
        return response.data or []

    def update_owned_supplier(self, owner_id, supplier_id, name, note=None):
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Supplier name required")
        rows = (self.client.table("suppliers").update({"name": name.strip(), "note": note})
                .eq("owner_id", owner_id).eq("id", supplier_id).execute()).data or []
        if not rows:
            raise ValueError("Supplier not owned by caller")
        return rows[0]

    def delete_owned_supplier(self, owner_id, supplier_id):
        # Never silently detach purchase history from its supplier.
        owned = (self.client.table("suppliers").select("id").eq("owner_id", owner_id)
                 .eq("id", supplier_id).limit(1).execute()).data or []
        if not owned:
            raise ValueError("Supplier not owned by caller")
        offers = (self.client.table("offers").select("id").eq("owner_id", owner_id)
                  .eq("supplier_id", supplier_id).limit(1).execute()).data or []
        if offers:
            raise ValueError("Supplier is used by purchase offers")
        try:
            self.client.table("suppliers").delete().eq("owner_id", owner_id).eq("id", supplier_id).execute()
        except APIError as exc:
            if str(exc.code) == "23503":
                raise ValueError("Supplier is used by purchase offers") from exc
            if exc.code == "P0001" and exc.message == "Supplier is used by recipe materials":
                raise ValueError("Supplier is used by recipe materials") from exc
            raise

    def list_owned_approved_prices(self, owner_id, ingredient_id):
        """Compare explicitly adopted quotes; observations not adopted are omitted."""
        if ingredient_id not in self.load_owned_ingredients(owner_id, [ingredient_id]):
            raise ValueError("Ingredient not owned")
        offers = (self.client.table("offers")
                  .select("id,ingredient_id,supplier_id,package_quantity,"
                          "package_unit,adopted_observation_id")
                  .eq("owner_id", owner_id).eq("ingredient_id", ingredient_id)
                  .order("id").execute()).data or []
        relevant = [o for o in offers if o.get("adopted_observation_id")]
        if not relevant:
            return []
        observation_ids = [o["adopted_observation_id"] for o in relevant]
        observations = (self.client.table("price_observations")
                        .select("id,offer_id,amount_jpy,currency,confirmed,"
                                "source,observed_at")
                        .eq("owner_id", owner_id).in_("id", observation_ids)
                        .execute()).data or []
        obs_by_id = {o["id"]: o for o in observations}
        supplier_ids = sorted({o["supplier_id"] for o in relevant
                               if o.get("supplier_id")})
        suppliers = (self.client.table("suppliers")
                     .select("id,name").eq("owner_id", owner_id)
                     .in_("id", supplier_ids).execute()).data or [] if supplier_ids else []
        names = {s["id"]: s["name"] for s in suppliers}
        output = []
        for offer in relevant:
            obs = obs_by_id.get(offer["adopted_observation_id"])
            if not obs or obs["offer_id"] != offer["id"] or not obs["confirmed"]:
                continue
            output.append({
                "offer_id": offer["id"], "supplier_id": offer.get("supplier_id"),
                "supplier_name": names.get(offer.get("supplier_id")),
                "amount_jpy": str(obs["amount_jpy"]), "currency": obs["currency"],
                "quantity": offer.get("package_quantity"),
                "unit": offer.get("package_unit"),
                "source": obs["source"], "observed_at": obs["observed_at"],
            })
        return output

    def set_owned_offer_price(self, owner_id, ingredient_id, supplier_id,
                              amount_jpy, quantity, unit):
        """Explicit chef approval: store and adopt a JPY quote atomically.

        Only the SQL RPC writes the adoption pointer. An ordinary observation
        is never adopted by sorting, guessing or reading the newest row.
        """
        from .models import decimal as parse_decimal
        price, qty = parse_decimal(amount_jpy), parse_decimal(quantity)
        if not price.is_finite() or price < 0 or not qty.is_finite() or qty <= 0:
            raise ValueError("Invalid offer price")
        if not isinstance(unit, str) or not 1 <= len(unit.strip()) <= 32:
            raise ValueError("Invalid offer unit")
        result = self.client.rpc("set_owned_offer_price", {
            "p_owner_id": owner_id, "p_ingredient_id": ingredient_id,
            "p_supplier_id": supplier_id, "p_amount_jpy": str(price),
            "p_quantity": str(qty), "p_unit": unit.strip(),
        }).execute()
        if not result.data:
            raise RuntimeError("Price adoption did not produce an observation")
        return str(result.data)

    def load_owned_supplier_prices(self, owner_id, recipe):
        """Load only owner-owned adopted offers matching the selected recipe line.

        Explicit offer IDs select a single purchase term; legacy supplier-only
        selections resolve only when exactly one adopted term is available.
        No other supplier, market reference, or newest-price fallback is allowed.
        """
        selections = [m for m in recipe.materials
                      if m.price_mode == "inherit" and m.ingredient_id
                      and (m.supplier_id or m.offer_id)]
        if not selections:
            return {}
        ingredient_ids = sorted({m.ingredient_id for m in selections})
        offers = (self.client.table("offers")
                  .select("id,ingredient_id,supplier_id,package_quantity,"
                          "package_unit,package_unit_id,adopted_observation_id")
                  .eq("owner_id", owner_id)
                  .in_("ingredient_id", ingredient_ids).execute()).data or []
        selected = [
            o for o in offers if o.get("adopted_observation_id") and any(
                m.ingredient_id == o["ingredient_id"]
                and (m.offer_id == o["id"] if m.offer_id else m.supplier_id == o.get("supplier_id"))
                and (m.supplier_id is None or m.supplier_id == o.get("supplier_id"))
                for m in selections)
        ]
        ids = sorted({o["adopted_observation_id"] for o in selected})
        if not ids:
            return {}
        observations = (self.client.table("price_observations")
                        .select("id,offer_id,amount_jpy,currency,confirmed")
                        .eq("owner_id", owner_id).in_("id", ids).execute()).data or []
        by_obs = {o["id"]: o for o in observations}
        from .models import PriceQuote, TrackedValue
        by_offer = {}
        by_supplier = {}
        ambiguous = set()
        for offer in selected:
            obs = by_obs.get(offer["adopted_observation_id"])
            if (not obs or obs["offer_id"] != offer["id"]
                    or obs["currency"] != "JPY" or not obs["confirmed"]
                    or not offer.get("package_quantity")
                    or not offer.get("package_unit")):
                continue
            try:
                quote = PriceQuote(
                    amount_jpy=TrackedValue(str(obs["amount_jpy"]), "confirmed", "user"),
                    per_quantity=str(offer["package_quantity"]),
                    per_unit=str(offer["package_unit"]), source="manual",
                    per_unit_id=offer.get("package_unit_id"))
            except (ValueError, TypeError):
                continue
            by_offer[(offer["ingredient_id"], f"offer:{offer['id']}")] = quote
            key = (offer["ingredient_id"], offer.get("supplier_id"))
            if key in by_supplier:
                ambiguous.add(key)
            else:
                by_supplier[key] = quote
        for key in ambiguous:
            by_supplier.pop(key, None)
        # Prefix offer keys so UUID equality across different entity types
        # cannot accidentally select a supplier-level quote.
        return {**by_supplier, **by_offer}

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

    def create_owned_observation(self, owner_id, offer_id, amount_jpy,
                                   currency="JPY", tax_note=None,
                                   shipping_note=None, source="manual_entry",
                                   confirmed=False, observed_at=None):
        """Append one price fact to an owned offer's history. Appending
        never adopts a price: ingredients.current_price and
        adopted_observation_id are untouched. observed_at defaults to now
        and must not be in the future."""
        from .models import decimal as _decimal
        from .price_history import SOURCES
        offers = (self.client.table("offers")
                  .select("id,ingredient_id").eq("owner_id", owner_id)
                  .eq("id", offer_id).limit(1).execute()).data or []
        if not offers:
            raise ValueError("Offer not owned by caller")
        try:
            amount = _decimal(amount_jpy)
        except ValueError as exc:
            raise ValueError("Invalid amount") from exc
        if amount < 0:
            raise ValueError("Negative amount")
        if not isinstance(currency, str) or not 1 <= len(currency) <= 10:
            raise ValueError("Invalid currency")
        for note in (tax_note, shipping_note):
            if note is not None and (not isinstance(note, str) or len(note) > 200):
                raise ValueError("Invalid price condition note")
        if source not in SOURCES:
            raise ValueError("Unknown observation source")
        if type(confirmed) is not bool:
            raise ValueError("Confirmed flag must be boolean")
        now = datetime.now(timezone.utc)
        if observed_at is None:
            stamp = now.isoformat()
        else:
            try:
                moment = datetime.fromisoformat(str(observed_at))
            except (ValueError, TypeError) as exc:
                raise ValueError("Invalid observed_at") from exc
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=timezone.utc)
            if moment > now + timedelta(seconds=60):
                raise ValueError("observed_at is in the future")
            stamp = moment.isoformat()
        response = (self.client.table("price_observations").insert({
            "owner_id": owner_id, "offer_id": offer_id,
            "amount_jpy": str(amount), "currency": currency,
            "tax_note": tax_note, "shipping_note": shipping_note,
            "source": source, "confirmed": confirmed,
            "observed_at": stamp}).execute())
        rows = response.data or []
        if not rows or "id" not in rows[0]:
            raise RuntimeError("Unexpected observation insert response")
        return rows[0]["id"]

    def list_ingredient_observations(self, owner_id, ingredient_id, limit=100):
        """Append-only history for one owned ingredient, newest first, with
        each observation's offer terms and supplier name attached."""
        owned = self.load_owned_ingredients(owner_id, [ingredient_id])
        if ingredient_id not in owned:
            raise ValueError("Ingredient not owned by caller")
        offers = (self.client.table("offers")
                  .select("id,supplier_id,product_url,package_quantity,"
                          "package_unit,shipping_note")
                  .eq("owner_id", owner_id)
                  .eq("ingredient_id", ingredient_id).execute()).data or []
        by_offer = {row["id"]: row for row in offers}
        if not by_offer:
            return []
        supplier_ids = sorted({row["supplier_id"] for row in offers
                               if row.get("supplier_id")})
        names: dict[str, str] = {}
        if supplier_ids:
            suppliers = (self.client.table("suppliers").select("id,name")
                         .eq("owner_id", owner_id).in_("id", supplier_ids)
                         .execute()).data or []
            names = {row["id"]: row["name"] for row in suppliers}
        observations = (self.client.table("price_observations")
                        .select("id,offer_id,amount_jpy,currency,tax_note,"
                                "shipping_note,source,confirmed,observed_at")
                        .eq("owner_id", owner_id)
                        .in_("offer_id", list(by_offer))
                        .order("observed_at", desc=True)
                        .limit(min(max(limit, 1), 200)).execute()).data or []
        out = []
        for row in observations:
            offer = by_offer.get(row["offer_id"], {})
            supplier_id = offer.get("supplier_id")
            out.append({**row, "ingredient_id": ingredient_id,
                        "package_quantity": offer.get("package_quantity"),
                        "package_unit": offer.get("package_unit"),
                        "supplier_id": supplier_id,
                        "supplier_name": names.get(supplier_id or ""),
                        "product_url": offer.get("product_url")})
        return out

    def get_owned_observation(self, owner_id, observation_id):
        """One observation with its offer terms, or ValueError when the
        caller does not own it. Read-only; history rows are never updated."""
        rows = (self.client.table("price_observations")
                .select("id,offer_id,amount_jpy,currency,tax_note,"
                        "shipping_note,source,confirmed,observed_at")
                .eq("owner_id", owner_id).eq("id", observation_id)
                .limit(1).execute()).data or []
        if not rows:
            raise ValueError("Observation not owned by caller")
        row = rows[0]
        offers = (self.client.table("offers")
                  .select("id,ingredient_id,supplier_id,package_quantity,"
                          "package_unit")
                  .eq("owner_id", owner_id).eq("id", row["offer_id"])
                  .limit(1).execute()).data or []
        if not offers:
            raise ValueError("Observation offer not owned by caller")
        return {**row, "ingredient_id": offers[0]["ingredient_id"],
                "supplier_id": offers[0].get("supplier_id"),
                "package_quantity": offers[0].get("package_quantity"),
                "package_unit": offers[0].get("package_unit")}

    def get_owned_ingredient_adoption(self, owner_id, ingredient_id):
        """Read-only adoption reference. Kept separate from the hot catalog
        paths so M5 never widens their column requirements."""
        rows = (self.client.table("ingredients")
                .select("id,adopted_observation_id,adopted_at")
                .eq("owner_id", owner_id).eq("id", ingredient_id)
                .limit(1).execute()).data or []
        if not rows:
            raise ValueError("Ingredient not owned by caller")
        return {"ingredient_id": rows[0]["id"],
                "adopted_observation_id": rows[0].get("adopted_observation_id"),
                "adopted_at": rows[0].get("adopted_at")}

    def list_recipes_using_ingredient(self, owner_id, ingredient_id,
                                      limit=None, page_size=200):
        """Decode every owned recipe referencing one ingredient.

        Pages through the owner's full recipe set in stable ``id``
        order, so matches beyond the first window are never silently
        dropped. ``limit=None`` (default) returns all matches;
        callers may pass an explicit positive ``limit`` to bound the
        result. ``page_size`` bounds each state query. Seen ids guard
        page-boundary duplicates.
        """
        owned = self.load_owned_ingredients(owner_id, [ingredient_id])
        if ingredient_id not in owned:
            raise ValueError("Ingredient not owned by caller")
        if limit is None:
            wanted = None
        else:
            try:
                wanted = int(limit)
            except (TypeError, ValueError):
                raise ValueError("Invalid limit")
            if wanted <= 0:
                return []
        try:
            stride = int(page_size)
        except (TypeError, ValueError):
            stride = 200
        stride = min(max(stride, 1), 1000)
        out: list = []
        seen: set = set()
        offset = 0
        while True:
            rows = (self.client.table("recipes").select("id,state")
                    .eq("owner_id", owner_id)
                    .order("id")
                    .range(offset, offset + stride - 1).execute()).data or []
            for row in rows:
                try:
                    recipe = decode_recipe(row.get("state") or {})
                except (ValueError, TypeError, KeyError, AttributeError):
                    continue
                if recipe.id in seen:
                    continue
                seen.add(recipe.id)
                if any(m.ingredient_id == ingredient_id
                       for m in recipe.materials):
                    out.append(recipe)
                    if wanted is not None and len(out) >= wanted:
                        return out
            if len(rows) < stride:
                return out
            offset += stride

    # --- M6: price-change notifications (explicit confirmation only) ---

    # price_notifications columns. The basis snapshot (migration 0004)
    # may be absent on databases created before it is applied; reads
    # and writes fall back to the legacy column set in that case.
    _NOTIFICATION_COLS_FULL = ("id,observation_id,ingredient_id,"
                               "basis_observation_id,unit_basis,change_jpy,"
                               "status,created_at")
    _NOTIFICATION_COLS_LEGACY = ("id,observation_id,ingredient_id,change_jpy,"
                                 "status,created_at")

    @staticmethod
    def _is_missing_column(exc: Exception) -> bool:
        code = str(getattr(exc, "code", "") or "")
        message = str(getattr(exc, "message", None) or exc).lower()
        return code == "42703" or "basis_observation_id" in message or (
            "unit_basis" in message and "column" in message)

    def _exec_notification_query(self, build):
        """Run a notification SELECT, tolerating pre-0004 schemas."""
        try:
            return build(self._NOTIFICATION_COLS_FULL).execute()
        except APIError as exc:
            if not self._is_missing_column(exc):
                raise
            return build(self._NOTIFICATION_COLS_LEGACY).execute()

    def confirm_observation_notification(self, owner_id, observation_id):
        """Confirm one price observation and notify exactly once.

        Compares the candidate against the ingredient's adopted basis
        (M5 rules). Missing bases and incomparable terms raise
        ValueError with reasons and create nothing. The insert relies
        on unique(observation_id); a conflicting concurrent insert or
        resend returns the existing row with created=False instead of
        a duplicate. change_jpy stores the unit-price difference in
        JPY per comparison unit_basis -- never a recipe total. Never
        adopts prices or rewrites recipes.
        """
        from .price_history import compare_observations
        from .price_notifications import decide_notification
        candidate = self.get_owned_observation(owner_id, observation_id)
        ingredient_id = candidate["ingredient_id"]
        ref = self.get_owned_ingredient_adoption(owner_id, ingredient_id)
        basis_id = ref.get("adopted_observation_id")
        if not basis_id:
            raise ValueError("no adopted price basis")
        basis = self.get_owned_observation(owner_id, basis_id)
        from .price_history import PriceObservation as _Obs
        base = _Obs(
            id=str(basis["id"]), ingredient_id=str(basis["ingredient_id"]),
            offer_id=str(basis["offer_id"]),
            supplier_id=(str(basis["supplier_id"]) if basis.get("supplier_id") else None),
            amount=str(basis["amount_jpy"]), currency=str(basis["currency"]),
            tax_note=basis.get("tax_note"), shipping_note=basis.get("shipping_note"),
            package_quantity=str(basis.get("package_quantity") or ""),
            package_unit=str(basis.get("package_unit") or ""),
            source=str(basis["source"]), confirmed=bool(basis.get("confirmed")),
            observed_at=str(basis.get("observed_at") or ""))
        cand = _Obs(
            id=str(candidate["id"]), ingredient_id=str(candidate["ingredient_id"]),
            offer_id=str(candidate["offer_id"]),
            supplier_id=(str(candidate["supplier_id"]) if candidate.get("supplier_id") else None),
            amount=str(candidate["amount_jpy"]), currency=str(candidate["currency"]),
            tax_note=candidate.get("tax_note"),
            shipping_note=candidate.get("shipping_note"),
            package_quantity=str(candidate.get("package_quantity") or ""),
            package_unit=str(candidate.get("package_unit") or ""),
            source=str(candidate["source"]),
            confirmed=bool(candidate.get("confirmed")),
            observed_at=str(candidate.get("observed_at") or ""))
        from .costing import unit_factor_catalog
        units = unit_factor_catalog(self.list_owned_units(owner_id))
        should, comparison, reasons = decide_notification(base, cand, units)
        comparison = comparison if comparison is not None else compare_observations(base, cand, units)
        if not should:
            raise ValueError("incomparable: " + "; ".join(reasons))
        from .price_notifications import comparison_payload
        payload = comparison_payload(comparison, str(basis_id))
        try:
            try:
                response = (self.client.table("price_notifications").insert({
                    "owner_id": owner_id, "observation_id": observation_id,
                    "ingredient_id": ingredient_id,
                    "basis_observation_id": str(basis_id),
                    "unit_basis": comparison.unit_basis,
                    "change_jpy": comparison.diff,
                    "status": "unread"}).execute())
            except APIError as column_exc:
                if not self._is_missing_column(column_exc):
                    raise
                response = (self.client.table("price_notifications").insert({
                    "owner_id": owner_id, "observation_id": observation_id,
                    "ingredient_id": ingredient_id,
                    "change_jpy": comparison.diff,
                    "status": "unread"}).execute())
        except Exception as exc:
            if "23505" in str(getattr(exc, "code", "") or "") or \
               "duplicate" in str(exc).lower() or "unique" in str(exc).lower() or \
               "conflict" in str(exc).lower():
                existing = self._exec_notification_query(
                    lambda cols: self.client.table("price_notifications")
                    .select(cols)
                    .eq("owner_id", owner_id)
                    .eq("observation_id", observation_id)
                    .limit(1)).data or []
                if not existing:
                    raise
                note = dict(existing[0])
                stored_basis = note.get("basis_observation_id")
                if stored_basis:
                    try:
                        basis_row = self.get_owned_observation(
                            owner_id, str(stored_basis))
                    except ValueError:
                        basis_row = None
                    if basis_row is not None:
                        base_snap = _Obs(
                            id=str(basis_row["id"]),
                            ingredient_id=str(basis_row["ingredient_id"]),
                            offer_id=str(basis_row["offer_id"]),
                            supplier_id=(str(basis_row["supplier_id"])
                                         if basis_row.get("supplier_id") else None),
                            amount=str(basis_row["amount_jpy"]),
                            currency=str(basis_row["currency"]),
                            tax_note=basis_row.get("tax_note"),
                            shipping_note=basis_row.get("shipping_note"),
                            package_quantity=str(
                                basis_row.get("package_quantity") or ""),
                            package_unit=str(basis_row.get("package_unit") or ""),
                            source=str(basis_row["source"]),
                            confirmed=bool(basis_row.get("confirmed")),
                            observed_at=str(basis_row.get("observed_at") or ""))
                        cand_snap = _Obs(
                            id=str(candidate["id"]),
                            ingredient_id=str(candidate["ingredient_id"]),
                            offer_id=str(candidate["offer_id"]),
                            supplier_id=(str(candidate["supplier_id"])
                                         if candidate.get("supplier_id") else None),
                            amount=str(candidate["amount_jpy"]),
                            currency=str(candidate["currency"]),
                            tax_note=candidate.get("tax_note"),
                            shipping_note=candidate.get("shipping_note"),
                            package_quantity=str(
                                candidate.get("package_quantity") or ""),
                            package_unit=str(candidate.get("package_unit") or ""),
                            source=str(candidate["source"]),
                            confirmed=bool(candidate.get("confirmed")),
                            observed_at=str(candidate.get("observed_at") or ""))
                        _should, snap_comp, _reasons = decide_notification(
                            base_snap, cand_snap)
                        snap_comp = (snap_comp if snap_comp is not None
                                     else compare_observations(base_snap, cand_snap))
                        snap_payload = comparison_payload(
                            snap_comp, str(stored_basis))
                        return {"created": False, "notification": note,
                                "comparison": snap_payload}
                # Legacy rows (pre-0004, no stored basis) or a basis that
                # is no longer readable: history cannot be guaranteed, so
                # return no invented numbers.
                legacy_payload = {
                    "comparable": False,
                    "reasons": ["original price basis unavailable"],
                    "currency": None,
                    "unit_basis": note.get("unit_basis"),
                    "base_unit_price": None,
                    "new_unit_price": None,
                    "diff": None,
                    "rate_pct": None,
                    "basis_observation_id": stored_basis,
                }
                return {"created": False, "notification": note,
                        "comparison": legacy_payload}
            raise
        rows = response.data or []
        if not rows or "id" not in rows[0]:
            raise RuntimeError("Unexpected notification insert response")
        note = dict(rows[0])
        note.setdefault("basis_observation_id", str(basis_id))
        note.setdefault("unit_basis", comparison.unit_basis)
        return {"created": True, "notification": note,
                "comparison": payload}

    def get_owned_observations(self, owner_id, ids):
        """Bulk owned observations with offer terms, keyed by id.

        Fail-closed: any missing or foreign id raises ValueError and
        nothing is returned.
        """
        uniq = list(dict.fromkeys(str(i) for i in ids))
        if not uniq:
            return {}
        rows = (self.client.table("price_observations")
                .select("id,offer_id,amount_jpy,currency,tax_note,"
                        "shipping_note,source,confirmed,observed_at")
                .eq("owner_id", owner_id).in_("id", uniq)
                .execute()).data or []
        by_id = {row["id"]: row for row in rows}
        missing = [i for i in uniq if i not in by_id]
        if missing:
            raise ValueError("Observation not owned by caller")
        offers = (self.client.table("offers")
                  .select("id,ingredient_id,supplier_id,package_quantity,"
                          "package_unit")
                  .eq("owner_id", owner_id)
                  .in_("id", [row["offer_id"] for row in rows])
                  .execute()).data or []
        by_offer = {row["id"]: row for row in offers}
        out = {}
        for oid, row in by_id.items():
            offer = by_offer.get(row["offer_id"])
            if offer is None:
                raise ValueError("Observation offer not owned by caller")
            out[oid] = {**row, "ingredient_id": offer["ingredient_id"],
                        "supplier_id": offer.get("supplier_id"),
                        "package_quantity": offer.get("package_quantity"),
                        "package_unit": offer.get("package_unit")}
        return out

    def list_owned_notifications(self, owner_id, status=None, limit=100):
        """Owner-scoped notifications, newest first. Optional status filter."""
        from .price_notifications import STATUSES
        if status is not None and status not in STATUSES:
            raise ValueError("Unknown notification status")
        def _build(cols):
            query = (self.client.table("price_notifications")
                     .select(cols)
                     .eq("owner_id", owner_id))
            if status is not None:
                query = query.eq("status", status)
            return query.order("created_at", desc=True).limit(
                min(max(int(limit), 1), 200))
        return self._exec_notification_query(_build).data or []

    def get_owned_notification(self, owner_id, notification_id):
        """One owned notification, or ValueError when inaccessible."""
        rows = self._exec_notification_query(
            lambda cols: self.client.table("price_notifications")
            .select(cols)
            .eq("owner_id", owner_id).eq("id", notification_id)
            .limit(1)).data or []
        if not rows:
            raise ValueError("Notification not owned by caller")
        return rows[0]

    def update_notification_status(self, owner_id, notification_id, status):
        """Move a notification's status with compare-and-swap.

        The write only applies when the stored status is a legal
        predecessor of the target, so a concurrent move is detected
        instead of silently overwritten: no rows then means either a
        lost race (NotificationConflict) or a foreign id
        (ValueError). Status only: prices, suppliers, recipes, and
        snapshots are never touched here.
        """
        from .price_notifications import (
            ALLOWED_SOURCES, STATUSES, NotificationConflict, check_transition)
        if status not in STATUSES:
            raise ValueError("Unknown notification status")
        response = (self.client.table("price_notifications")
                    .update({"status": status})
                    .eq("owner_id", owner_id).eq("id", notification_id)
                    .in_("status", [status, *ALLOWED_SOURCES[status]])
                    .execute())
        rows = response.data or []
        if rows:
            current_status = rows[0]["status"]
            if current_status != status:
                raise RuntimeError("Unexpected notification update response")
            return rows[0]
        try:
            current = self.get_owned_notification(owner_id, notification_id)
        except ValueError:
            raise ValueError("Notification not owned by caller") from None
        if current["status"] == status:
            return current
        check_transition(current["status"], status)
        raise NotificationConflict(
            f"Notification {notification_id} moved concurrently; "
            f"stored status is {current['status']}")

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

    def list_latest_observations_for_offers(self, owner_id, offer_ids):
        """Latest observation per offer, owner-scoped, exact for long histories.

        One paginated SELECT series over price_observations -- never one
        query per offer. Newest-first pages of 1000 rows are folded with
        first-row wins, so every requested offer's latest is found no
        matter how many older rows exist. Read-only.
        """
        uniq = [i for i in dict.fromkeys(
            str(x) for x in (offer_ids or []) if x)]
        if not uniq:
            return {}
        offers = (self.client.table("offers")
                  .select("id,ingredient_id,supplier_id,product_url,"
                          "package_quantity,package_unit,shipping_note")
                  .eq("owner_id", owner_id).in_("id", uniq)
                  .execute()).data or []
        by_offer = {row["id"]: row for row in offers}
        if not by_offer:
            return {}
        supplier_ids = sorted({row["supplier_id"] for row in offers
                               if row.get("supplier_id")})
        names: dict[str, str] = {}
        if supplier_ids:
            suppliers = (self.client.table("suppliers").select("id,name")
                         .eq("owner_id", owner_id).in_("id", supplier_ids)
                         .execute()).data or []
            names = {row["id"]: row["name"] for row in suppliers}
        latest: dict[str, dict] = {}
        offset = 0
        stride = 1000
        while True:
            rows = (self.client.table("price_observations")
                    .select("id,offer_id,amount_jpy,currency,tax_note,"
                            "shipping_note,source,confirmed,observed_at")
                    .eq("owner_id", owner_id)
                    .in_("offer_id", list(by_offer))
                    .order("observed_at", desc=True)
                    .range(offset, offset + stride - 1)
                    .execute()).data or []
            for row in rows:
                oid = row.get("offer_id")
                if oid in by_offer and oid not in latest:
                    offer = by_offer[oid]
                    supplier_id = offer.get("supplier_id")
                    latest[oid] = {
                        **row, "ingredient_id": offer["ingredient_id"],
                        "package_quantity": offer.get("package_quantity"),
                        "package_unit": offer.get("package_unit"),
                        "supplier_id": supplier_id,
                        "supplier_name": names.get(supplier_id or ""),
                        "product_url": offer.get("product_url")}
                    if len(latest) >= len(by_offer):
                        return latest
            if len(rows) < stride:
                return latest
            offset += stride

    def list_latest_observations_for_ingredients(self, owner_id,
                                                 ingredient_ids):
        """Latest observation per ingredient, owner-scoped. A fixed small
        number of owner-filtered SELECTs (offers, then the per-offer
        latest above) regardless of ingredient count -- never one query
        per ingredient. Read-only.
        """
        uniq = [i for i in dict.fromkeys(
            str(x) for x in (ingredient_ids or []) if x)]
        if not uniq:
            return {}
        offers = (self.client.table("offers")
                  .select("id,ingredient_id")
                  .eq("owner_id", owner_id).in_("ingredient_id", uniq)
                  .execute()).data or []
        offer_ids = [row["id"] for row in offers]
        if not offer_ids:
            return {}
        per_offer = self.list_latest_observations_for_offers(
            owner_id, offer_ids)
        best: dict[str, dict] = {}
        for row in per_offer.values():
            iid = row.get("ingredient_id")
            current = best.get(iid)
            if current is None or str(row.get("observed_at") or "") > str(
                    current.get("observed_at") or ""):
                best[iid] = row
        return best

    def commit_recipe_crud(self, *, owner_id, recipe_id, request_id,
                           base_revision, state, title, cost_snapshot,
                           payload_hash, save_version, ingredient_entries):
        params = dict(p_owner_id=owner_id, p_recipe_id=recipe_id,
                      p_request_id=request_id, p_expected_revision=base_revision,
                      p_new_state=state, p_title=title,
                      p_cost_snapshot=cost_snapshot, p_payload_hash=payload_hash,
                      p_save_version=save_version,
                      p_ingredient_entries=list(ingredient_entries))
        try:
            response = self.client.rpc("commit_recipe_crud", params).execute()
        except APIError as exc:
            if exc.code == "P0001" and exc.message in (
                "Stale recipe revision", "Request ID reused with a different mutation",
                "Ingredient identity collision", "Recipe ingredient must belong to owner",
                "Unknown or ambiguous unit", "Recipe price override forbidden",
            ):
                raise MutationError(exc.message) from exc
            raise
        if not isinstance(response.data, int):
            raise RuntimeError("Unexpected recipe CRUD RPC response")
        return response.data

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

    # Generated dish art: independent of recipe revision/Human Gate. The
    # server-supplied owner is checked against the actual saved recipe.
    def _owned_dish_recipe(self, owner_id, recipe_id):
        rows = (self.client.table("recipes").select("id")
                .eq("id", recipe_id).eq("owner_id", owner_id)
                .limit(1).execute()).data or []
        return bool(rows)

    def load_owned_dish_image(self, owner_id, recipe_id):
        if not self._owned_dish_recipe(owner_id, recipe_id):
            raise ValueError("Recipe not found")
        rows = (self.client.table("recipe_dish_images")
                .select("storage_path,mime_type")
                .eq("owner_id", owner_id).eq("recipe_id", recipe_id)
                .limit(1).execute()).data or []
        if not rows:
            return None
        row = rows[0]
        data = self.client.storage.from_("chef-recipe-dishes").download(row["storage_path"])
        return {"bytes": bytes(data), "mime_type": row["mime_type"]}

    def save_owned_dish_image(self, owner_id, recipe_id, mime_type, image_bytes):
        from uuid import uuid4
        from datetime import datetime, timezone
        if not self._owned_dish_recipe(owner_id, recipe_id):
            raise ValueError("Recipe not found")
        ext = {"image/png":"png", "image/jpeg":"jpg", "image/webp":"webp"}[mime_type]
        path = f"{owner_id}/{recipe_id}/{uuid4()}.{ext}"
        storage = self.client.storage.from_("chef-recipe-dishes")
        # New immutable object first. Never overwrite existing art before
        # the metadata points at a successfully uploaded image.
        storage.upload(path, image_bytes, file_options={"content-type":mime_type,"upsert":"false"})
        try:
            previous = (self.client.table("recipe_dish_images")
                        .select("storage_path").eq("owner_id",owner_id)
                        .eq("recipe_id",recipe_id).limit(1).execute()).data or []
            # An ownership check against the recipe is repeated inside the
            # SQL upsert's FK and owner-path constraints.
            self.client.table("recipe_dish_images").upsert({
                "owner_id":owner_id,"recipe_id":recipe_id,
                "storage_path":path,"mime_type":mime_type,
                "updated_at":datetime.now(timezone.utc).isoformat()
            },on_conflict="recipe_id").execute()
        except Exception:
            try:
                storage.remove([path])
            except Exception:
                pass
            raise
        # Cleanup is best-effort; never fail the confirmed new image because
        # obsolete-object cleanup fails.
        if previous and previous[0]["storage_path"] != path:
            try:
                storage.remove([previous[0]["storage_path"]])
            except Exception:
                pass
        return True
