"""Owner-scoped recipe CRUD: recipe lines reference Ingredient SSOT, never line quotes."""
from dataclasses import asdict, replace
from hashlib import sha256
from uuid import uuid5, NAMESPACE_URL

from .costing import calculate_cost, unit_factor_catalog
from .models import Ingredient
from .mutations import MutationError, prepare_mutation
from .persistence_service import SavedMutation, canonical_json, _json, _validate_ledger


def save_recipe_crud(*, owner_id, proposal, repository, save_version=True, ledger=(), review_only=False):
    """Called exclusively after the authenticated HTTP confirmation boundary.

    All master writes and recipe revision CAS are committed by one database RPC.
    A failed RPC cannot leave a half-written price or ingredient.
    """
    receipt_hash = sha256(canonical_json({
        "proposal": asdict(proposal), "confirmed": True,
        "save_version": save_version,
        "ledger": [asdict(entry) for entry in ledger],
    }).encode("utf-8")).hexdigest()
    receipt = repository.get_mutation_receipt(owner_id, proposal.request_id) if not review_only else None
    if receipt is not None:
        if receipt[0] != receipt_hash:
            raise MutationError("Request ID reused with different payload")
        return SavedMutation(repository.load_owned_recipe(owner_id, proposal.recipe_id),
                             receipt[1], True)
    recipe = repository.load_owned_recipe(owner_id, proposal.recipe_id)
    if recipe.revision != proposal.base_revision:
        raise MutationError("Stale recipe revision")
    catalog = repository.load_owned_catalog(owner_id, recipe)
    ledger_ids = [entry.id for entry in ledger if entry.id]
    if ledger_ids:
        catalog = {**catalog, **repository.load_owned_ingredients(owner_id, ledger_ids)}
    prepared_ledger = _validate_ledger(tuple(ledger), catalog,
                                       request_id=proposal.request_id)
    for item in prepared_ledger:
        if item["kind"] == "new":
            catalog[item["id"]] = Ingredient(item["id"], item["name"], None)
    explicit_links = [op["ingredient_id"] for op in proposal.operations
                      if op.get("op") == "link_ingredient" and op.get("ingredient_id")]
    if explicit_links:
        catalog = {**catalog, **repository.load_owned_ingredients(owner_id, explicit_links)}
    try:
        candidate = prepare_mutation(recipe, proposal, user_confirmed=True, catalog=catalog)
    except (ValueError, ArithmeticError) as exc:
        # Value-model validation errors are invalid confirmed edits (409),
        # not missing recipe/owner lookups (404). No DB write has happened.
        raise MutationError(str(exc)) from exc
    loader = repository.load_owned_ingredients
    entries = {}
    name_to_new_id = {}
    ledger_by_id = {item["id"]: item for item in prepared_ledger if item["kind"] == "new"}
    effective = dict(catalog)
    normalized = []
    master_review=[]
    candidate_rows=None
    for line in candidate.materials:
        name = (line.material_name.value or "").strip()
        if not name:
            raise MutationError("Ingredient name required")
        key = name.casefold()
        renamed = any(op.get("op") == "set_material_name"
                      and op.get("material_id") == line.id
                      for op in proposal.operations)
        explicit_link=any(op.get("op")=="link_ingredient" and op.get("material_id")==line.id for op in proposal.operations)
        if line.ingredient_id and line.ingredient_id in effective and (not renamed or explicit_link):
            ingredient_id = line.ingredient_id
            ingredient = effective[ingredient_id]
        elif key in name_to_new_id:
            ingredient_id = name_to_new_id[key]
            ingredient = effective[ingredient_id]
        else:
            from .ingredient_assist import match_recipe_master
            if candidate_rows is None:
                candidate_loader=getattr(repository,"list_owned_ingredient_master",None)
                candidate_rows=candidate_loader(owner_id) if callable(candidate_loader) else []
            plan=match_recipe_master(owner_id,repository,name,candidate_rows=candidate_rows)
            if plan["action"]=="choose" and not review_only:
                raise MutationError("Choose an ingredient master before saving")
            if plan["action"]=="reuse":
                ingredient_id=plan["ingredient_id"]
                ingredient=loader(owner_id,[ingredient_id]).get(ingredient_id)
                if ingredient is None: raise MutationError("Ingredient not owned")
            else:
                ingredient_id=str(uuid5(NAMESPACE_URL,f"chef-ai-crud:{owner_id}:{proposal.request_id}:{key}"))
                ingredient=Ingredient(ingredient_id,name,None)
            master_review.append({**plan,"material_id":line.id})
            effective[ingredient_id] = ingredient
            if ingredient_id not in catalog:
                name_to_new_id[key] = ingredient_id
        quote = line.price_override
        # Only an explicit price edit may change the master; pre-existing
        # legacy line quotes must not silently overwrite a shared master.
        price_edited = any(
            (op.get("op") in ("set_material_price", "add_material")
             or (op.get("op") == "link_ingredient" and op.get("price_mode") == "override"))
            and op.get("material_id") == line.id for op in proposal.operations)
        if not any(p["material_id"]==line.id for p in master_review):
            master_review.append({"material_id":line.id,"name":name,"master_name":ingredient.name,
                                 "ingredient_id":ingredient_id if ingredient_id in catalog and ingredient_id not in ledger_by_id else None,
                                 "action":"reuse" if ingredient_id in catalog and ingredient_id not in ledger_by_id else "create","candidates":[]})
        if price_edited and quote is not None and not (line.supplier_id or line.offer_id):
            effective[ingredient_id] = Ingredient(ingredient_id, ingredient.name, quote)
        metadata = ledger_by_id.get(ingredient_id, {})
        entry = entries.setdefault(ingredient_id, {
            "id": ingredient_id, "name": ingredient.name,
            "brand": metadata.get("brand"), "spec": metadata.get("spec"),
            "current_price": None, "purchases":[],
        })
        if price_edited and quote is not None:
            entry["purchases"].append({"material_id":line.id,"supplier_id":line.supplier_id,"quote":asdict(quote)})
            # Compatibility snapshot for repositories without supplier-price support.
            if not (line.supplier_id or line.offer_id): entry["current_price"]=asdict(quote)
        # Renaming can resolve to a different ingredient master. Purchase
        # terms belong to the old ingredient and must not travel with it.
        purchase_identity_changed = (
            line.ingredient_id is not None and line.ingredient_id != ingredient_id
        )
        normalized.append(replace(
            line, ingredient_id=ingredient_id, price_mode="inherit",
            price_override=None,
            supplier_id=None if purchase_identity_changed and not any(op.get("op")=="set_material_supplier" and op.get("material_id")==line.id for op in proposal.operations) else line.supplier_id,
            offer_id=None if purchase_identity_changed else line.offer_id,
        ))
    candidate = replace(candidate, materials=tuple(normalized))
    for item in prepared_ledger:
        if item["kind"] == "new" and not any(
                line.ingredient_id == item["id"] for line in candidate.materials):
            raise MutationError("New ledger ingredient must be linked to a recipe material")
    from decimal import Decimal
    unit_rows=repository.list_owned_units(owner_id)
    unit_ids={}
    for row in unit_rows:
        for term in [row["symbol"],*(row.get("aliases") or [])]:
            token=term.strip().casefold()
            if token in unit_ids and unit_ids[token]!=row["id"]: raise MutationError("Unknown or ambiguous unit")
            unit_ids[token]=row["id"]
    seen={}
    for entry in entries.values():
        for purchase in entry["purchases"]:
            q=purchase["quote"];unit=unit_ids.get(q["per_unit"].strip().casefold())
            if unit is None: raise MutationError("Unknown or ambiguous unit")
            key=(entry["id"],purchase["supplier_id"],Decimal(q["per_quantity"]),unit)
            amount=Decimal(q["amount_jpy"]["value"])
            if key in seen and seen[key]!=amount: raise MutationError("Conflicting purchase prices")
            seen[key]=amount
    if review_only:
        return {"ingredients":master_review,"materials":[asdict(line) for line in candidate.materials],
                "purchases":[purchase for entry in entries.values() for purchase in entry["purchases"]],
                "requires_selection":any(p["action"]=="choose" for p in master_review)}
    units = unit_factor_catalog(unit_rows)
    price_loader = getattr(repository, "load_owned_supplier_prices", None)
    supplier_prices = price_loader(owner_id, candidate) if callable(price_loader) else {}
    try:
        cost = calculate_cost(candidate, effective, units, supplier_prices)
    except (ValueError, ArithmeticError) as exc:
        raise MutationError(str(exc)) from exc
    snapshot = asdict(cost)
    if save_version:
        snapshots = {}
        for line in candidate.materials:
            if line.offer_id:
                quote = supplier_prices.get((line.ingredient_id, f"offer:{line.offer_id}"))
            elif line.supplier_id:
                quote = supplier_prices.get((line.ingredient_id, line.supplier_id))
            else:
                ingredient = effective.get(line.ingredient_id or "")
                quote = ingredient.current_price if ingredient else None
            snapshots[line.id] = {
                "price_mode": "inherit",
                "ingredient_id": line.ingredient_id,
                "supplier_id": line.supplier_id,
                "offer_id": line.offer_id,
                "effective_quote": asdict(quote) if quote is not None else None,
            }
        snapshot["effective_quotes"] = snapshots
    revision = repository.commit_recipe_crud(
        owner_id=owner_id, recipe_id=recipe.id, request_id=proposal.request_id,
        base_revision=proposal.base_revision, state=asdict(candidate),
        title=candidate.title.value or "", cost_snapshot=_json(snapshot),
        payload_hash=receipt_hash, save_version=save_version,
        ingredient_entries=tuple(entries.values()))
    persisted = repository.load_owned_recipe(owner_id, recipe.id)
    return SavedMutation(persisted, revision, revision != candidate.revision)
