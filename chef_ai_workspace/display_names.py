"""Display-name resolution: linked ingredient name first, material name kept.

Pure function for API/UI layers. Never renames the stored material_name;
unlinked or unresolvable lines fall back to the recipe-facing name.
"""
from typing import Mapping
from .models import Ingredient, Recipe


def resolve_display_names(recipe: Recipe,
                          catalog: Mapping[str, Ingredient] | None = None
                          ) -> dict[str, dict[str, str | None]]:
    table = catalog or {}
    resolved = {}
    for line in recipe.materials:
        ingredient = table.get(line.ingredient_id or "") if line.ingredient_id else None
        if ingredient is not None:
            resolved[line.id] = {"display": ingredient.name,
                                 "material": line.material_name.value}
        else:
            resolved[line.id] = {"display": line.material_name.value,
                                 "material": line.material_name.value}
    return resolved
