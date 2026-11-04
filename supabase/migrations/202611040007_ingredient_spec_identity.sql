-- Match the manager's product identity: owner + normalized name + specification.
-- Existing name-only uniqueness implies existing rows also satisfy this index.
drop index if exists public.ingredients_owner_name_norm_idx;
create unique index ingredients_owner_name_spec_norm_idx
 on public.ingredients(owner_id,lower(btrim(name)),
                      lower(coalesce(nullif(btrim(spec),''),'')));
