-- Explicitly approved price per offer. No observation automatically changes costing.
-- Applies to the dedicated Chef AI Workspace database only.
alter table public.offers
  add column package_unit_id uuid references public.units(id);
alter table public.offers
  add column adopted_observation_id uuid
  references public.price_observations(id) on delete set null;

-- One approved manager action, with owner/identity/price validation inside
-- the database transaction. This does not infer package-unit conversions.
create or replace function public.set_owned_offer_price(
  p_owner_id uuid, p_ingredient_id uuid, p_supplier_id uuid,
  p_amount_jpy numeric, p_quantity numeric, p_unit text
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_offer uuid;
declare v_obs uuid;
declare v_count integer;
declare v_unit_id uuid;
declare v_quote jsonb;
begin
  if p_owner_id is null or p_ingredient_id is null
     or p_amount_jpy is null or p_amount_jpy < 0
     or p_quantity is null or p_quantity <= 0
     or p_unit is null or length(btrim(p_unit)) not between 1 and 32
  then raise exception 'Invalid adopted offer price'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner_id::text,0));
  if not exists(select 1 from public.ingredients
                where id=p_ingredient_id and owner_id=p_owner_id for update)
  then raise exception 'Ingredient not owned'; end if;
  if p_supplier_id is not null and not exists(
      select 1 from public.suppliers where id=p_supplier_id and owner_id=p_owner_id)
  then raise exception 'Supplier not owned'; end if;
  v_unit_id:=public.resolve_owned_unit_id(p_owner_id,btrim(p_unit));
  -- A purchase term is only reusable if its package quantity and unit agree.
  select count(*),min(o.id) into v_count,v_offer
  from public.offers o
  where o.owner_id=p_owner_id and o.ingredient_id=p_ingredient_id
    and o.supplier_id is not distinct from p_supplier_id
    and o.package_quantity = p_quantity::text
    and o.package_unit=btrim(p_unit);
  if v_count>1 then raise exception 'Ambiguous purchase offer'; end if;
  if v_offer is null then
    insert into public.offers(owner_id,ingredient_id,supplier_id,
                              package_quantity,package_unit,package_unit_id)
    values(p_owner_id,p_ingredient_id,p_supplier_id,p_quantity::text,btrim(p_unit),v_unit_id)
    returning id into v_offer;
  end if;
  update public.offers set package_unit_id=v_unit_id
    where id=v_offer and owner_id=p_owner_id;
  insert into public.price_observations(
    owner_id,offer_id,amount_jpy,currency,source,confirmed)
  values(p_owner_id,v_offer,p_amount_jpy,'JPY','manual_entry',true)
  returning id into v_obs;
  update public.offers set adopted_observation_id=v_obs
    where id=v_offer and owner_id=p_owner_id;
  if p_supplier_id is null then
    -- Supplier-less explicitly approved market reference remains the
    -- shared ingredient price for a recipe without a supplier selection.
    v_quote:=jsonb_build_object(
      'amount_jpy',jsonb_build_object(
         'value',p_amount_jpy::text,'status','confirmed','origin','user'),
      'per_quantity',p_quantity::text,'per_unit',btrim(p_unit),
      'per_unit_id',v_unit_id::text,'source','manual');
    update public.ingredients
      set current_price=v_quote,adopted_observation_id=v_obs,adopted_at=now()
      where id=p_ingredient_id and owner_id=p_owner_id;
  end if;
  return v_obs;
end $$;
revoke all on function public.set_owned_offer_price(uuid,uuid,uuid,numeric,numeric,text)
  from public,anon,authenticated;
grant execute on function public.set_owned_offer_price(uuid,uuid,uuid,numeric,numeric,text)
  to service_role;

-- Owner and offer identity must also be enforced against direct table writes.
create or replace function public.guard_owned_offer_adoption()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.package_unit_id is not null and not exists(
   select 1 from public.units u
   where u.id=new.package_unit_id and u.owner_id=new.owner_id
 ) then raise exception 'Offer unit not owned by caller'; end if;
 if new.adopted_observation_id is not null and not exists(
   select 1 from public.price_observations p
   where p.id=new.adopted_observation_id
     and p.owner_id=new.owner_id and p.offer_id=new.id
     and p.currency='JPY' and p.confirmed=true
 ) then raise exception 'Adopted observation does not belong to offer'; end if;
 return new;
end $$;
create trigger offers_guard_approved_price
before insert or update on public.offers
for each row execute function public.guard_owned_offer_adoption();

-- The only write path for price adoption is a server-only RPC.
-- Existing owner-scoped reads continue to operate under RLS.
revoke insert,update,delete on public.offers from anon,authenticated;
revoke insert,update,delete on public.price_observations from anon,authenticated;

-- Every recipe write path (including legacy RPCs and direct service-role writes)
-- must validate the selected purchase term independently from HTTP checks.
create or replace function public.enforce_recipe_offer_owner()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_line jsonb;
declare v_offer uuid;
begin
 if jsonb_typeof(new.state->'materials') is distinct from 'array'
 then raise exception 'Invalid recipe materials'; end if;
 for v_line in select value from jsonb_array_elements(new.state->'materials') loop
   if nullif(v_line->>'offer_id','') is not null then
     begin
       v_offer := (v_line->>'offer_id')::uuid;
     exception when invalid_text_representation then
       raise exception 'Invalid recipe offer ID';
     end;
     if nullif(v_line->>'ingredient_id','') is null
        or nullif(v_line->>'supplier_id','') is null
        or not exists(
         select 1 from public.offers o
         where o.id=v_offer and o.owner_id=new.owner_id
           and o.ingredient_id=(v_line->>'ingredient_id')::uuid
           and o.supplier_id=(v_line->>'supplier_id')::uuid
       ) then raise exception 'Recipe offer must belong to owner, ingredient and supplier'; end if;
   end if;
 end loop;
 return new;
end $$;
drop trigger if exists enforce_recipe_offer_owner on public.recipes;
create trigger enforce_recipe_offer_owner
 before insert or update of state on public.recipes
 for each row execute function public.enforce_recipe_offer_owner();

create or replace function public.protect_recipe_offer_reference()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(
   select 1 from public.recipes r
   where r.owner_id=old.owner_id and exists(
     select 1 from jsonb_array_elements(r.state->'materials') m
     where m->>'offer_id'=old.id::text
   )
 ) then raise exception 'Offer is referenced by a recipe'; end if;
 return old;
end $$;
drop trigger if exists protect_recipe_offer_reference on public.offers;
create trigger protect_recipe_offer_reference
 before delete on public.offers
 for each row execute function public.protect_recipe_offer_reference();
