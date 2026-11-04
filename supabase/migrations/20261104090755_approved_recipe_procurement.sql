-- Approved voice procurement: additive, dedicated Chef database only.
-- Old NULL recipe states / immutable snapshots are intentionally not rewritten.
begin;

alter table public.suppliers add column is_market_reference boolean not null default false;
create unique index suppliers_one_market_reference on public.suppliers(owner_id) where is_market_reference;
create index suppliers_owner_normalized_name on public.suppliers(owner_id,lower(btrim(name)));
alter table public.recipes add column creation_payload_hash text;

create function public.ensure_market_reference_supplier(p_owner_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_count integer;
begin
 if p_owner_id is null then raise exception 'Owner required'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 select id into v_id from public.suppliers where owner_id=p_owner_id and is_market_reference;
 if v_id is not null then return v_id; end if;
 select count(*),min(id::text)::uuid into v_count,v_id from public.suppliers
 where owner_id=p_owner_id and lower(btrim(name))=lower('相場参考価格');
 if v_count>1 then raise exception 'Ambiguous market reference supplier'; end if;
 if v_id is null then
  insert into public.suppliers(owner_id,name,note,is_market_reference)
  values(p_owner_id,'相場参考価格','平均・参考価格の抽象仕入先',true) returning id into v_id;
 else update public.suppliers set name='相場参考価格',is_market_reference=true where id=v_id; end if;
 return v_id;
end $$;
revoke all on function public.ensure_market_reference_supplier(uuid) from public,anon,authenticated;
grant execute on function public.ensure_market_reference_supplier(uuid) to service_role;

create function public.guard_supplier_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then
  if old.is_market_reference and exists(select 1 from auth.users where id=old.owner_id) then raise exception 'Default supplier cannot be deleted'; end if;
  return old;
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.owner_id::text,0));
 if length(btrim(new.name)) not between 1 and 200 then raise exception 'Invalid supplier name'; end if;
 if exists(select 1 from public.suppliers s where s.owner_id=new.owner_id and s.id<>new.id
  and lower(btrim(s.name))=lower(btrim(new.name))) then raise exception 'Supplier identity collision'; end if;
 if tg_op='UPDATE' and old.is_market_reference and
   (not new.is_market_reference or new.owner_id<>old.owner_id or new.name<>'相場参考価格')
 then raise exception 'Default supplier identity is immutable'; end if;
 if new.is_market_reference and new.name<>'相場参考価格' then raise exception 'Invalid default supplier'; end if;
 return new;
end $$;
create trigger guard_supplier_identity before insert or update of name,owner_id,is_market_reference or delete
 on public.suppliers for each row execute function public.guard_supplier_identity();
revoke all on function public.guard_supplier_identity() from public,anon,authenticated;

-- Seed one real abstract supplier per existing owner, preserving an existing
-- unambiguous matching row. New owners are seeded by the same idempotent RPC.
do $$ declare v_owner uuid; begin
 for v_owner in select id from auth.users loop
  perform public.ensure_market_reference_supplier(v_owner);
 end loop;
end $$;
-- Preserve the IDs/history of legacy supplier-less offers. Never choose between
-- duplicate terms or silently adopt an observation. NULL recipe states still use
-- the existing Ingredient.current_price compatibility rule.
update public.offers o set supplier_id=s.id from public.suppliers s
 where o.owner_id=s.owner_id and s.is_market_reference and o.supplier_id is null;

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
declare v_supplier uuid;
declare v_market boolean;
begin
  if p_owner_id is null or p_ingredient_id is null
     or p_amount_jpy is null or p_amount_jpy < 0
     or p_amount_jpy::text in ('NaN','Infinity','-Infinity')
     or p_quantity is null or p_quantity <= 0 or p_quantity::text in ('NaN','Infinity','-Infinity')
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
  v_supplier:=coalesce(p_supplier_id,public.ensure_market_reference_supplier(p_owner_id));
  select is_market_reference into v_market from public.suppliers where id=v_supplier and owner_id=p_owner_id;
  v_unit_id:=public.resolve_owned_unit_id(p_owner_id,btrim(p_unit));
  -- A purchase term is only reusable if its package quantity and unit agree.
  select count(*),min(o.id::text)::uuid into v_count,v_offer
  from public.offers o
  where o.owner_id=p_owner_id and o.ingredient_id=p_ingredient_id
    and o.supplier_id = v_supplier
    and case
      when btrim(o.package_quantity) ~ '^[+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'
      then btrim(o.package_quantity)::numeric = p_quantity
      else false
    end
    and (o.package_unit_id=v_unit_id or (o.package_unit_id is null and o.package_unit=btrim(p_unit)));
  if v_count>1 then raise exception 'Ambiguous purchase offer'; end if;
  if v_offer is null then
    insert into public.offers(owner_id,ingredient_id,supplier_id,
                              package_quantity,package_unit,package_unit_id)
    values(p_owner_id,p_ingredient_id,v_supplier,p_quantity::text,btrim(p_unit),v_unit_id)
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
  if v_market then
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


-- Resolve the cost snapshot inside the SAME transaction as price adoption.
-- This mirrors calculate_cost: explicit offer > unambiguous supplier > legacy
-- shared price; only approved Unit Master factors permit cross-unit conversion.
create function public.procured_recipe_cost(p_owner_id uuid,p_recipe_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare st jsonb; m jsonb; q jsonb; o record; a record; b record; n integer;
declare costs jsonb:='{}'; sources jsonb:='{}'; quotes jsonb:='{}'; missing jsonb:='[]';
declare amount numeric; qty numeric; denominator numeric; converted numeric; subtotal numeric:=0;
declare adjustment numeric; total numeric; rate numeric; estimated boolean:=false;
begin
 select state into st from public.recipes where id=p_recipe_id and owner_id=p_owner_id;
 if st is null then raise exception 'Recipe not owned'; end if;
 for m in select value from jsonb_array_elements(st->'materials') loop
  q:=null;
  if nullif(m->>'supplier_id','') is null and nullif(m->>'offer_id','') is null then
   select current_price into q from public.ingredients where id=(m->>'ingredient_id')::uuid and owner_id=p_owner_id;
  else
   select count(*) into n from public.offers x join public.price_observations p on p.id=x.adopted_observation_id
    and p.offer_id=x.id and p.owner_id=p_owner_id and p.confirmed and p.currency='JPY'
      and p.amount_jpy>=0 and p.amount_jpy::text not in ('NaN','Infinity','-Infinity')
      and nullif(btrim(x.package_unit),'') is not null
      and case when btrim(x.package_quantity) ~ '^[+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'
        then x.package_quantity::numeric>0 else false end
    where x.owner_id=p_owner_id and x.ingredient_id=(m->>'ingredient_id')::uuid
      and x.supplier_id=(m->>'supplier_id')::uuid
      and (nullif(m->>'offer_id','') is null or x.id=(m->>'offer_id')::uuid);
   if n=1 then
    select x.*,p.amount_jpy into o from public.offers x join public.price_observations p on p.id=x.adopted_observation_id
      and p.offer_id=x.id and p.owner_id=p_owner_id and p.confirmed and p.currency='JPY'
      and p.amount_jpy>=0 and p.amount_jpy::text not in ('NaN','Infinity','-Infinity')
      and nullif(btrim(x.package_unit),'') is not null
      and case when btrim(x.package_quantity) ~ '^[+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'
        then x.package_quantity::numeric>0 else false end
      where x.owner_id=p_owner_id and x.ingredient_id=(m->>'ingredient_id')::uuid
       and x.supplier_id=(m->>'supplier_id')::uuid
       and (nullif(m->>'offer_id','') is null or x.id=(m->>'offer_id')::uuid);
    q:=jsonb_build_object('amount_jpy',jsonb_build_object('value',o.amount_jpy::text,'status','confirmed','origin','user'),
      'per_quantity',o.package_quantity,'per_unit',o.package_unit,'per_unit_id',o.package_unit_id,'source','manual');
   end if;
  end if;
  quotes:=quotes||jsonb_build_object(m->>'id',jsonb_build_object('ingredient_id',m->'ingredient_id',
    'supplier_id',m->'supplier_id','offer_id',m->'offer_id','price_mode','inherit','effective_quote',q));
  converted:=null;
  begin
   qty:=(m#>>'{quantity,value}')::numeric; amount:=(q#>>'{amount_jpy,value}')::numeric; denominator:=(q->>'per_quantity')::numeric;
   if qty is not null and amount is not null and denominator>0 and m->>'unit' is not null then
    if nullif(m->>'unit_id','') is not null and m->>'unit_id'=q->>'per_unit_id' then converted:=qty;
    elsif nullif(m->>'unit_id','') is null and nullif(q->>'per_unit_id','') is null and m->>'unit'=q->>'per_unit' then converted:=qty;
    else
     select * into a from public.units where owner_id=p_owner_id and id=(m->>'unit_id')::uuid;
     select * into b from public.units where owner_id=p_owner_id and
      id=coalesce(nullif(q->>'per_unit_id','')::uuid,public.resolve_owned_unit_id(p_owner_id,q->>'per_unit'));
     if a.dimension=b.dimension and a.base_factor>0 and b.base_factor>0 then converted:=qty*a.base_factor/b.base_factor; end if;
    end if;
   end if;
  exception when invalid_text_representation or numeric_value_out_of_range or raise_exception then converted:=null;
  end;
  if converted is null then missing:=missing||jsonb_build_array(m->>'id');
  else
   costs:=costs||jsonb_build_object(m->>'id',(converted*amount/denominator)::text);
   sources:=sources||jsonb_build_object(m->>'id','shared_ingredient');
   subtotal:=subtotal+converted*amount/denominator;
   estimated:=estimated or m#>>'{quantity,status}'='assumed' or q#>>'{amount_jpy,status}'='assumed';
  end if;
 end loop;
 adjustment:=(st#>>'{cost_adjustment_jpy,value}')::numeric;
 estimated:=estimated or st#>>'{cost_adjustment_jpy,status}'='assumed' or st#>>'{selling_price_jpy,status}'='assumed';
 if jsonb_array_length(missing)=0 and adjustment is not null then
  if subtotal+adjustment<0 then raise exception 'Adjusted cost cannot be negative'; end if;
  total:=round(subtotal+adjustment,0);
  if (st#>>'{selling_price_jpy,value}')::numeric>0 then rate:=round(total/(st#>>'{selling_price_jpy,value}')::numeric*100,1); end if;
 end if;
 return jsonb_build_object('partial',total is null,'line_costs',costs,'line_price_sources',sources,
  'unresolved_line_ids',missing,'subtotal_jpy',subtotal::text,'total_cost_jpy',total::text,'cost_rate_pct',rate::text,
  'estimated',coalesce(estimated,false),'effective_quotes',quotes);
end $$;
revoke all on function public.procured_recipe_cost(uuid,uuid) from public,anon,authenticated;
grant execute on function public.procured_recipe_cost(uuid,uuid) to service_role;

create function public.create_owned_procured_recipe(
 p_owner_id uuid,p_recipe_id uuid,p_title text,p_initial_state jsonb,p_cost_snapshot jsonb,
 p_unit_candidates jsonb,p_ingredient_entries jsonb,p_procurement jsonb,p_payload_hash text
) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.recipes%rowtype; st jsonb; m jsonb; plan jsonb; lines jsonb:='[]'; quote jsonb;
declare supplier uuid; obs uuid; offer uuid; n integer; supplier_name text;
declare seen jsonb:='{}'; key text;
begin
 if p_owner_id is null or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$'
  or jsonb_typeof(p_procurement) is distinct from 'array' then raise exception 'Invalid procurement'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 select * into r from public.recipes where id=p_recipe_id for update;
 if found then
  if r.owner_id<>p_owner_id or r.creation_payload_hash is distinct from p_payload_hash then raise exception 'Creation request conflict'; end if;
  return p_recipe_id;
 end if;
 -- Existing ingredient/unit creation and all subsequent procurement share this
 -- transaction. Any identity/adoption failure rolls EVERYTHING back.
 perform public.create_owned_recipe(p_owner_id,p_recipe_id,p_title,p_initial_state,p_cost_snapshot,p_unit_candidates,p_ingredient_entries);
 perform public.ensure_market_reference_supplier(p_owner_id);
 select state into st from public.recipes where id=p_recipe_id and owner_id=p_owner_id;
 if jsonb_array_length(p_procurement)<>jsonb_array_length(st->'materials') then raise exception 'Procurement coverage mismatch'; end if;
 for m in select value from jsonb_array_elements(st->'materials') loop
  select count(*) into n from jsonb_array_elements(p_procurement) e where e->>'material_id'=m->>'id';
  if n<>1 then raise exception 'Procurement identity mismatch'; end if;
  select value into plan from jsonb_array_elements(p_procurement) where value->>'material_id'=m->>'id';
  supplier_name:=btrim(coalesce(plan->>'supplier',''));
  if supplier_name='' or supplier_name='相場参考価格' then supplier:=public.ensure_market_reference_supplier(p_owner_id);
  else
   if length(supplier_name)>200 then raise exception 'Invalid supplier'; end if;
   select count(*),min(id::text)::uuid into n,supplier from public.suppliers
    where owner_id=p_owner_id and lower(btrim(name))=lower(supplier_name);
   if n>1 then raise exception 'Ambiguous supplier'; end if;
   if supplier is null then
    insert into public.suppliers(owner_id,name) values(p_owner_id,supplier_name) returning id into supplier;
   end if;
  end if;
  quote:=plan->'quote'; offer:=null;
  -- Reuse the legacy market master only when it was already explicitly
  -- confirmed by a human. Never borrow a real supplier's or assumed price.
  if (quote is null or jsonb_typeof(quote)='null') and exists(
    select 1 from public.suppliers where id=supplier and owner_id=p_owner_id and is_market_reference) then
   select current_price into quote from public.ingredients where id=(m->>'ingredient_id')::uuid and owner_id=p_owner_id;
   if quote#>>'{amount_jpy,status}' is distinct from 'confirmed' or quote#>>'{amount_jpy,origin}' is distinct from 'user' then quote:=null; end if;
  end if;
  if jsonb_typeof(quote)='object' then
   if quote#>>'{amount_jpy,status}' is distinct from 'confirmed' or quote#>>'{amount_jpy,origin}' is distinct from 'user'
    then raise exception 'Price is not explicitly approved'; end if;
   key:=(m->>'ingredient_id')||':'||supplier::text||':'||pg_catalog.trim_scale((quote->>'per_quantity')::numeric)::text||':'||public.resolve_owned_unit_id(p_owner_id,quote->>'per_unit')::text;
   if seen?key and (seen->>key)::numeric<>(quote#>>'{amount_jpy,value}')::numeric then raise exception 'Conflicting approved quotes'; end if;
   seen:=seen||jsonb_build_object(key,quote#>>'{amount_jpy,value}');
   obs:=public.set_owned_offer_price(p_owner_id,(m->>'ingredient_id')::uuid,supplier,
     (quote#>>'{amount_jpy,value}')::numeric,(quote->>'per_quantity')::numeric,quote->>'per_unit');
   select offer_id into offer from public.price_observations where id=obs and owner_id=p_owner_id;
  else
   -- Preserve a real unpriced supplier link. Multiple or absent adopted terms
   -- remain supplier-only/partial; never select the latest observation.
   select count(*),min(x.id::text)::uuid into n,offer from public.offers x
    where x.owner_id=p_owner_id and x.ingredient_id=(m->>'ingredient_id')::uuid
      and x.supplier_id=supplier and x.adopted_observation_id is not null;
   if n<>1 then offer:=null; end if;
   if not exists(select 1 from public.offers x where x.owner_id=p_owner_id
     and x.ingredient_id=(m->>'ingredient_id')::uuid and x.supplier_id=supplier) then
    insert into public.offers(owner_id,ingredient_id,supplier_id) values(p_owner_id,(m->>'ingredient_id')::uuid,supplier);
   end if;
  end if;
  m:=m||jsonb_build_object('supplier_id',supplier,'offer_id',offer);
  lines:=lines||jsonb_build_array(m);
 end loop;
 st:=jsonb_set(st,'{materials}',lines);
 update public.recipes set state=st,creation_payload_hash=p_payload_hash where id=p_recipe_id and owner_id=p_owner_id;
 update public.recipe_versions set snapshot=st,cost_snapshot=public.procured_recipe_cost(p_owner_id,p_recipe_id)
  where recipe_id=p_recipe_id and owner_id=p_owner_id and revision=0;
 return p_recipe_id;
end $$;
revoke all on function public.create_owned_procured_recipe(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_owned_procured_recipe(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,text) to service_role;

commit;
