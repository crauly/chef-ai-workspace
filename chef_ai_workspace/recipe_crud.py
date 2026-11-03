"""Owner-scoped recipe CRUD: recipe lines reference Ingredient SSOT, never line quotes."""
from dataclasses import asdict, replace
from hashlib import sha256
from uuid import uuid5, NAMESPACE_URL

from .costing import calculate_cost, unit_factor_catalog
from .models import Ingredient
from .mutations import MutationError, prepare_mutation
from .persistence_service import SavedMutation, canonical_json, _json


def save_recipe_crud(*, owner_id, proposal, repository, save_version=True):
    """Called exclusively after the authenticated HTTP confirmation boundary.

    All master writes and recipe revision CAS are committed by one database RPC.
    A failed RPC cannot leave a half-written price or ingredient.
    """
    receipt_hash = sha256(canonical_json({
        "proposal": asdict(proposal), "confirmed": True,
        "save_version": save_version,
    }).encode("utf-8")).hexdigest()
    receipt = repository.get_mutation_receipt(owner_id, proposal.request_id)
    if receipt is not None:
        if receipt[0] != receipt_hash:
            raise MutationError("Request ID reused with different payload")
        return SavedMutation(repository.load_owned_recipe(owner_id, proposal.recipe_id),
                             receipt[1], True)
    recipe = repository.load_owned_recipe(owner_id, proposal.recipe_id)
    if recipe.revision != proposal.base_revision:
        raise MutationError("Stale recipe revision")
    catalog = repository.load_owned_catalog(owner_id, recipe)
    candidate = prepare_mutation(recipe, proposal, user_confirmed=True, catalog=catalog)
    finder = repository.find_owned_ingredients_exact
    loader = repository.load_owned_ingredients
    entries = {}
    effective = dict(catalog)
    normalized = []
    for line in candidate.materials:
        name = (line.material_name.value or "").strip()
        if not name:
            raise MutationError("Ingredient name required")
        key = name.casefold()
        if line.ingredient_id and line.ingredient_id in effective:
            ingredient_id = line.ingredient_id
            ingredient = effective[ingredient_id]
        elif key in entries:
            ingredient_id = entries[key]["id"]
            ingredient = effective[ingredient_id]
        else:
            matches = finder(owner_id, name)
            if len(matches) > 1:
                raise MutationError("Ambiguous ingredient identity")
            if matches:
                ingredient_id = str(matches[0]["id"])
                owned = loader(owner_id, [ingredient_id])
                ingredient = owned.get(ingredient_id)
                if ingredient is None:
                    raise MutationError("Ingredient not owned")
            else:
                ingredient_id = str(uuid5(NAMESPACE_URL,
                    f"chef-ai-crud:{owner_id}:{proposal.request_id}:{key}"))
                ingredient = Ingredient(ingredient_id, name, None)
            effective[ingredient_id] = ingredient
        quote = line.price_override
        # Only an explicit price edit may change the master; pre-existing
        # legacy line quotes must not silently overwrite a shared master.
        price_edited = any(op.get("op") in ("set_material_price", "add_material")
                           and op.get("material_id") == line.id for op in proposal.operations)
        if price_edited and quote is not None:
            effective[ingredient_id] = Ingredient(ingredient_id, ingredient.name, quote)
        entry = entries.setdefault(key, {"id": ingredient_id, "name": ingredient.name,
                                         "current_price": None})
        if price_edited and quote is not None:
            value = asdict(quote)
            if entry["current_price"] is not None and entry["current_price"] != value:
                raise MutationError("Conflicting prices for shared ingredient")
            entry["current_price"] = value
        normalized.append(replace(line, ingredient_id=ingredient_id,
                                  price_mode="inherit", price_override=None))
    candidate = replace(candidate, materials=tuple(normalized))
    units = unit_factor_catalog(repository.list_owned_units(owner_id))
    cost = calculate_cost(candidate, effective, units)
    snapshot = asdict(cost)
    if save_version:
        snapshot["effective_quotes"] = {
            line.id: {"price_mode": "inherit", "ingredient_id": line.ingredient_id,
                      "effective_quote": asdict(effective[line.ingredient_id].current_price)
                      if effective[line.ingredient_id].current_price else None}
            for line in candidate.materials
        }
    revision = repository.commit_recipe_crud(
        owner_id=owner_id, recipe_id=recipe.id, request_id=proposal.request_id,
        base_revision=proposal.base_revision, state=asdict(candidate),
        title=candidate.title.value or "", cost_snapshot=_json(snapshot),
        payload_hash=receipt_hash, save_version=save_version,
        ingredient_entries=tuple(entries.values()))
    persisted = repository.load_owned_recipe(owner_id, recipe.id)
    return SavedMutation(persisted, revision, revision != candidate.revision)
