-- Explicitly approved price per offer. No observation automatically changes costing.
-- Applies to the dedicated Chef AI Workspace database only.
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
                              package_quantity,package_unit)
    values(p_owner_id,p_ingredient_id,p_supplier_id,p_quantity::text,btrim(p_unit))
    returning id into v_offer;
  end if;
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
