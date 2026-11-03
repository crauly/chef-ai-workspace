-- Chef AI Workspace V1: user-owned unit master, no fixed unit whitelist.
-- Execute only against the dedicated Chef AI Workspace database.
create table public.units (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 symbol text not null check (length(btrim(symbol)) between 1 and 32),
 dimension text not null check (dimension in ('mass','volume','count','other')),
 base_factor numeric check (base_factor > 0),
 aliases text[] not null default '{}',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (owner_id, id)
);
create unique index units_owner_symbol_normalized_idx on public.units(owner_id, lower(symbol));
create index units_owner_idx on public.units(owner_id);
alter table public.units enable row level security;
create policy units_owner_read on public.units for select to authenticated
 using (owner_id = (select auth.uid()));
-- Writes use only the trusted server: no authenticated insert/update/delete policy.
revoke insert, update, delete on public.units from anon, authenticated;

-- Resolve both canonical symbol and spoken aliases without choosing between
-- conflicting candidates. The owning user boundary is mandatory.
create or replace function public.resolve_owned_unit_id(
 p_owner_id uuid,p_spoken text
) returns uuid
language plpgsql stable security definer set search_path=''
as $$
declare v_ids uuid[];
begin
 select array_agg(u.id) into v_ids
 from public.units u where u.owner_id=p_owner_id
   and (lower(u.symbol)=lower(btrim(p_spoken)) or exists(
     select 1 from unnest(u.aliases) a
     where lower(btrim(a))=lower(btrim(p_spoken))
   ));
 if v_ids is null or cardinality(v_ids)<>1 then
   raise exception 'Unknown or ambiguous unit';
 end if;
 return v_ids[1];
end; $$;
revoke all on function public.resolve_owned_unit_id(uuid,text)
 from public,anon,authenticated;
grant execute on function public.resolve_owned_unit_id(uuid,text) to service_role;

-- A unit can be created only by the same transaction that creates an approved
-- recipe. The old standalone create RPC is deliberately absent.
-- In a private V1 test DB, this migration replaces the old recipe-create
-- signature: no alternate initial-save route remains available.
drop function if exists public.create_owned_recipe(uuid,uuid,text,jsonb,jsonb);
create or replace function public.create_owned_recipe(
 p_owner_id uuid, p_recipe_id uuid, p_title text,
 p_initial_state jsonb, p_cost_snapshot jsonb,
 p_unit_candidates jsonb, p_ingredient_entries jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_item jsonb;
declare v_unit_id uuid;
declare v_ing_id uuid;
declare v_ing_name text;
declare v_ing_owner uuid;
declare v_ing_existing_name text;
declare v_price jsonb;
declare v_symbol text;
declare v_dim text;
declare v_material jsonb;
declare v_materials jsonb := '[]'::jsonb;
declare v_state jsonb := p_initial_state;
declare v_unit_ids uuid[] := '{}';
begin
 if p_owner_id is null or p_recipe_id is null
    or p_title is null or btrim(p_title) = ''
    or v_state is null or jsonb_typeof(v_state) <> 'object'
    or v_state->>'id' is distinct from p_recipe_id::text
    or v_state->>'revision' is distinct from '0'
    or p_cost_snapshot is null or jsonb_typeof(p_cost_snapshot) <> 'object'
    or p_unit_candidates is null or jsonb_typeof(p_unit_candidates) <> 'array'
    or p_ingredient_entries is null or jsonb_typeof(p_ingredient_entries) <> 'array'
 then raise exception 'Invalid initial recipe'; end if;
 -- Serializes unit token admission and alias edits for this owner.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 -- User-confirmed server-side proposal must supply canonical strings and
 -- dimensions. Canonical IDs are resolved under this transaction only.
 for v_item in select * from jsonb_array_elements(p_unit_candidates) loop
   v_symbol := btrim(coalesce(v_item->>'symbol',''));
   v_dim := v_item->>'dimension';
   if length(v_symbol) not between 1 and 32
      or v_dim not in ('mass','volume','count','other')
      or exists(select 1 from public.units u where u.owner_id<>p_owner_id
                   and u.id::text=v_item->>'unit_id')
   then raise exception 'Invalid unit proposal'; end if;
   if exists(
     select 1 from public.units u where u.owner_id=p_owner_id
       and (lower(u.symbol)=lower(v_symbol) or exists(
         select 1 from unnest(u.aliases) a where lower(btrim(a))=lower(v_symbol)
       ))
       and (lower(u.symbol)<>lower(v_symbol) or u.dimension<>v_dim)
   ) then raise exception 'Unit identity collision'; end if;
   insert into public.units(owner_id,symbol,dimension)
   values(p_owner_id,v_symbol,v_dim) on conflict do nothing;
 end loop;
 -- Ingredient is the only price SSOT. Register/reuse/modify it under
 -- this SAME recipe-save transaction and owner-scoped lock. No recipe quote
 -- can be persisted, even if the backend is compromised or out of date.
 for v_item in select * from jsonb_array_elements(p_ingredient_entries) loop
   if jsonb_typeof(v_item)<>'object' then raise exception 'Invalid ingredient entry'; end if;
   begin
     v_ing_id := (v_item->>'id')::uuid;
   exception when others then raise exception 'Invalid ingredient ID'; end;
   v_ing_name := btrim(coalesce(v_item->>'name',''));
   v_price := v_item->'current_price';
   if length(v_ing_name) not between 1 and 200 or
      (v_price is not null and jsonb_typeof(v_price) not in ('object','null'))
   then raise exception 'Invalid ingredient entry'; end if;
   if jsonb_typeof(v_price)='object' then
     v_unit_id := public.resolve_owned_unit_id(p_owner_id,v_price->>'per_unit');
     v_price := jsonb_set(v_price,'{per_unit_id}',to_jsonb(v_unit_id::text),true);
   end if;
   select i.owner_id,i.name into v_ing_owner,v_ing_existing_name
     from public.ingredients i where i.id=v_ing_id for update;
   if found then
     if v_ing_owner<>p_owner_id or lower(btrim(v_ing_existing_name))<>lower(v_ing_name)
     then raise exception 'Ingredient identity mismatch'; end if;
     if jsonb_typeof(v_price)='object' then
       update public.ingredients set current_price=v_price
         where id=v_ing_id and owner_id=p_owner_id;
     end if;
   else
     if exists(select 1 from public.ingredients i where i.owner_id=p_owner_id
                  and lower(btrim(i.name))=lower(v_ing_name))
     then raise exception 'Existing ingredient ID must be reused'; end if;
     insert into public.ingredients(id,owner_id,name,current_price)
     values(v_ing_id,p_owner_id,v_ing_name,
            case when jsonb_typeof(v_price)='object' then v_price else null end);
   end if;
 end loop;
 -- No missing or foreign unit can enter the saved recipe.
 if jsonb_typeof(v_state->'materials') <> 'array'
 then raise exception 'Invalid material lines'; end if;
 for v_material in select * from jsonb_array_elements(v_state->'materials') loop
   if jsonb_typeof(v_material)<>'object'
      or v_material->>'price_mode' is distinct from 'inherit'
      or (v_material->'price_override' is not null
          and jsonb_typeof(v_material->'price_override')<>'null')
   then raise exception 'Recipe-specific prices prohibited'; end if;
   begin
     v_ing_id := (v_material->>'ingredient_id')::uuid;
   exception when others then raise exception 'Ingredient link required'; end;
   if not exists(select 1 from public.ingredients i
                 where i.owner_id=p_owner_id and i.id=v_ing_id)
   then raise exception 'Foreign or missing ingredient link'; end if;
   if v_material->>'unit' is not null then
     v_unit_id := public.resolve_owned_unit_id(p_owner_id,v_material->>'unit');
     v_material := jsonb_set(v_material,'{unit_id}',to_jsonb(v_unit_id::text),true);
   end if;
   if v_material->'price_override' is not null
      and jsonb_typeof(v_material->'price_override')='object' then
     v_unit_id := public.resolve_owned_unit_id(
         p_owner_id, v_material #>> '{price_override,per_unit}');
     v_material := jsonb_set(v_material,
        '{price_override,per_unit_id}',to_jsonb(v_unit_id::text),true);
   end if;
   v_materials := v_materials || jsonb_build_array(v_material);
 end loop;
 v_state := jsonb_set(v_state,'{materials}',v_materials);
 insert into public.recipes(id,owner_id,title,revision,state)
 values(p_recipe_id,p_owner_id,p_title,0,v_state);
 insert into public.recipe_versions(recipe_id,owner_id,revision,snapshot,cost_snapshot)
 values(p_recipe_id,p_owner_id,0,v_state,p_cost_snapshot);
 return p_recipe_id;
end; $$;
revoke all on function public.create_owned_recipe(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)
 from public,anon,authenticated;
grant execute on function public.create_owned_recipe(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)
 to service_role;

-- Explicit chef-approved master edit. Preserve canonical ID and the old
-- symbol as an alias so existing recipe snapshots remain readable.
create or replace function public.update_owned_unit(
 p_owner_id uuid, p_unit_id uuid, p_symbol text,
 p_dimension text, p_base_factor numeric, p_aliases text[]
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_symbol text := btrim(p_symbol);
declare v_aliases text[] := coalesce(p_aliases, '{}');
declare v_old_symbol text;
begin
 if p_owner_id is null or p_unit_id is null
    or length(v_symbol) not between 1 and 32
    or p_dimension not in ('mass','volume','count','other')
    or (p_base_factor is not null and p_base_factor <= 0)
    or cardinality(v_aliases)>20
    or exists(select 1 from unnest(v_aliases) a
              where length(btrim(a)) not between 1 and 32)
 then raise exception 'Invalid unit edit'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 select symbol into v_old_symbol from public.units
 where owner_id=p_owner_id and id=p_unit_id for update;
 if not found then raise exception 'Unit not found'; end if;
 if lower(v_old_symbol)<>lower(v_symbol) then
   v_aliases := array_append(v_aliases,v_old_symbol);
 end if;
 if cardinality(v_aliases)>20 or exists(
   select 1 from unnest(v_aliases) a
   where lower(btrim(a))=lower(v_symbol)
 ) or exists(
   select 1 from unnest(v_aliases) a group by lower(btrim(a)) having count(*)>1
 ) then raise exception 'Duplicate unit token'; end if;
 if exists(
   select 1 from public.units other
   where other.owner_id=p_owner_id and other.id<>p_unit_id
     and (
       lower(other.symbol)=lower(v_symbol)
       or lower(other.symbol)=any(select lower(btrim(a)) from unnest(v_aliases) a)
       or exists(
         select 1 from unnest(other.aliases) old_alias
         where lower(btrim(old_alias))=lower(v_symbol)
            or lower(btrim(old_alias))=any(select lower(btrim(a)) from unnest(v_aliases) a)
       )
     )
 ) then raise exception 'Unit identity collision'; end if;
 update public.units set symbol=v_symbol,dimension=p_dimension,
                         base_factor=p_base_factor,aliases=v_aliases,updated_at=now()
 where owner_id=p_owner_id and id=p_unit_id;
 return true;
end; $$;
revoke all on function public.update_owned_unit(uuid,uuid,text,text,numeric,text[])
 from public,anon,authenticated;
grant execute on function public.update_owned_unit(uuid,uuid,text,text,numeric,text[])
 to service_role;

-- V1 Ingredient identity and price are owned by the master, not individual recipes.
-- The existing test DB has no products with duplicate normalized names.
create unique index if not exists ingredients_owner_name_norm_idx
  on public.ingredients(owner_id,lower(btrim(name)));
drop policy if exists ingredients_owner on public.ingredients;
create policy ingredients_owner_read on public.ingredients
  for select to authenticated using (owner_id=(select auth.uid()));
revoke insert,update,delete on public.ingredients from anon,authenticated;

-- Explicit manager save: changing a master price automatically changes every
-- linked recipe's current valuation; saved recipe-version cost snapshots remain.
create or replace function public.update_owned_ingredient(
 p_owner_id uuid,p_ingredient_id uuid,p_name text,p_price jsonb
) returns boolean
language plpgsql security definer set search_path=''
as $ingredient_manager$
declare v_name text := btrim(p_name);
declare v_unit_id uuid;
declare v_price jsonb := p_price;
begin
 if p_owner_id is null or p_ingredient_id is null or length(v_name) not between 1 and 200
 or (v_price is not null and jsonb_typeof(v_price) not in ('object','null'))
 then raise exception 'Invalid ingredient update'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 if not exists(select 1 from public.ingredients
               where owner_id=p_owner_id and id=p_ingredient_id for update)
 then raise exception 'Ingredient not owned'; end if;
 if exists(select 1 from public.ingredients i where i.owner_id=p_owner_id
           and i.id<>p_ingredient_id and lower(btrim(i.name))=lower(v_name))
 then raise exception 'Ingredient identity collision'; end if;
 if jsonb_typeof(v_price)='object' then
   v_unit_id := public.resolve_owned_unit_id(p_owner_id,v_price->>'per_unit');
   v_price := jsonb_set(v_price,'{per_unit_id}',to_jsonb(v_unit_id::text),true);
 end if;
 update public.ingredients
 set name=v_name,current_price=case when v_price is null or jsonb_typeof(v_price)='null'
                                     then current_price else v_price end
 where owner_id=p_owner_id and id=p_ingredient_id;
 return true;
end; $ingredient_manager$;
revoke all on function public.update_owned_ingredient(uuid,uuid,text,jsonb)
 from public,anon,authenticated;
grant execute on function public.update_owned_ingredient(uuid,uuid,text,jsonb)
 to service_role;

-- V1 pricing invariant: no legacy or alternative recipe write may persist
-- a line-owned quote. This trigger covers both recipe creation and subsequent
-- old commit RPCs. Only owner-owned concrete Ingredient IDs may be linked.
create or replace function public.enforce_recipe_ingredient_ssot()
returns trigger language plpgsql security invoker set search_path=''
as $$
declare v_line jsonb;
declare v_ingredient_id uuid;
begin
 if jsonb_typeof(new.state->'materials') is distinct from 'array'
 then raise exception 'Invalid recipe materials'; end if;
 for v_line in select value from jsonb_array_elements(new.state->'materials') loop
   if jsonb_typeof(v_line) is distinct from 'object'
      or v_line->>'price_mode' is distinct from 'inherit'
      or jsonb_typeof(v_line->'price_override') is distinct from 'null'
   then raise exception 'Per-recipe purchase price is prohibited'; end if;
   begin
     v_ingredient_id := (v_line->>'ingredient_id')::uuid;
   exception when others then raise exception 'Recipe ingredient ID required'; end;
   if v_ingredient_id is null or not exists(
     select 1 from public.ingredients i
     where i.id=v_ingredient_id and i.owner_id=new.owner_id
   ) then raise exception 'Ingredient must belong to recipe owner'; end if;
   if v_line->>'unit' is not null and
      nullif(v_line->>'unit_id','') is null
   then raise exception 'Canonical recipe unit ID required'; end if;
 end loop;
 return new;
end; $$;
revoke all on function public.enforce_recipe_ingredient_ssot() from public,anon,authenticated;
drop trigger if exists recipe_ingredient_ssot on public.recipes;
create trigger recipe_ingredient_ssot
 before insert or update of state on public.recipes
 for each row execute function public.enforce_recipe_ingredient_ssot();

-- Writes to masters go through server-approved RPCs, not direct Data API.
revoke insert,update,delete on public.ingredients from anon,authenticated;
revoke insert,update,delete on public.units from anon,authenticated;
