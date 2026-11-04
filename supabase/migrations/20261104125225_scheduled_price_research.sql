begin;
create table public.price_research_settings(
 owner_id uuid primary key references auth.users(id) on delete cascade,
 enabled boolean not null default false,
 interval_hours integer not null default 24 check(interval_hours between 1 and 8760)
);
alter table public.price_research_settings enable row level security;
create policy price_research_settings_owner on public.price_research_settings for select to authenticated
 using(owner_id=(select auth.uid()));
revoke all on public.price_research_settings from anon,authenticated;
grant select on public.price_research_settings to authenticated;
alter table public.ingredients
 add column price_research_enabled boolean not null default false,
 add column next_research_at timestamptz not null default now(),
 add column research_generation bigint not null default 0,
 add column research_lease uuid,
 add column research_lease_until timestamptz,
 add column last_research_at timestamptz,
 add column last_research_error text;
create index ingredient_research_due on public.ingredients(owner_id,next_research_at) where price_research_enabled;
alter table public.price_observations
 add column research_generation bigint,
 add column research_run_id uuid unique,
 add column source_url text,
 add column research_evidence jsonb,
 add column research_ingredient_basis uuid,
 add column research_offer_basis uuid,
 add column approved_from_observation_id uuid unique references public.price_observations(id);

-- One transaction for identity and its explicitly selected research flag.
create function public.save_owned_research_ingredient(p_owner_id uuid,p_id uuid,p_name text,p_spec text,p_enabled boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid:=p_id;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 if v_id is null then v_id:=public.create_owned_ingredient_master(p_owner_id,p_name,p_spec);
 elsif not public.update_owned_ingredient(p_owner_id,v_id,p_name,null,p_spec) then raise exception 'Ingredient not owned'; end if;
 update public.ingredients set price_research_enabled=p_enabled,
  next_research_at=case when p_enabled and not price_research_enabled then now() else next_research_at end,
  research_lease=case when p_enabled then research_lease else null end,
  research_lease_until=case when p_enabled then research_lease_until else null end
 where id=v_id and owner_id=p_owner_id;
 return v_id;
end $$;
revoke all on function public.save_owned_research_ingredient(uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.save_owned_research_ingredient(uuid,uuid,text,text,boolean) to service_role;

-- Server-only process RPC. Owner always comes from verified backend context.
create function public.owned_price_research(p_owner_id uuid,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.price_research_settings%rowtype; i public.ingredients%rowtype;
 o public.offers%rowtype; c public.price_observations%rowtype;
 v_id uuid; v_offer uuid; v_supplier uuid; v_unit uuid; v_obs uuid; v_count integer;
 v_token uuid; v_result jsonb:='[]'::jsonb; v_sample jsonb; v_error text;
 v_qty numeric; v_amount numeric; v_symbol text;
begin
 if p_owner_id is null then raise exception 'Owner required'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 select * into s from public.price_research_settings where owner_id=p_owner_id;
 if p_action='settings' then
  if jsonb_typeof(p_payload->'enabled') is distinct from 'boolean'
    or (p_payload->>'interval_hours')::integer not between 1 and 8760 then raise exception 'Invalid settings'; end if;
  insert into public.price_research_settings(owner_id,enabled,interval_hours)
   values(p_owner_id,(p_payload->>'enabled')::boolean,(p_payload->>'interval_hours')::integer)
   on conflict(owner_id) do update set enabled=excluded.enabled,interval_hours=excluded.interval_hours;
  return '{}'::jsonb;
 elsif p_action='read' then
  select coalesce(jsonb_agg(x order by x->>'observed_at' desc),'[]'::jsonb) into v_result from (
   select distinct on (ofr.ingredient_id) jsonb_build_object(
    'id',p.id,'ingredient_id',ofr.ingredient_id,'name',ing.name,'amount_jpy',p.amount_jpy::text,
    'quantity',ofr.package_quantity,'unit',ofr.package_unit,'observed_at',p.observed_at,
    'source_url',p.source_url,'evidence',p.research_evidence,'current_price',ing.current_price,
    'offer_id',ofr.id,'supplier_name',sup.name,
    'offer_adopted_id',ofr.adopted_observation_id,'basis_offer_id',p.research_offer_basis,
    'ingredient_adopted_id',ing.adopted_observation_id,'basis_ingredient_id',p.research_ingredient_basis,
    'stale',p.research_generation is distinct from ing.research_generation,'offer_price',base.amount_jpy::text,'tax_note',p.tax_note,'shipping_note',p.shipping_note) as x
   from public.price_observations p join public.offers ofr on ofr.id=p.offer_id and ofr.owner_id=p.owner_id
   join public.ingredients ing on ing.id=ofr.ingredient_id and ing.owner_id=p.owner_id
   join public.suppliers sup on sup.id=ofr.supplier_id and sup.owner_id=p.owner_id
   left join public.price_observations base on base.id=ofr.adopted_observation_id and base.owner_id=p.owner_id
   where p.owner_id=p_owner_id and p.research_run_id is not null and p.research_generation=ing.research_generation and not exists(
    select 1 from public.price_observations approved where approved.approved_from_observation_id=p.id)
   order by ofr.ingredient_id,p.observed_at desc,p.id desc
  ) results;
  return jsonb_build_object('settings',jsonb_build_object('enabled',coalesce(s.enabled,false),'interval_hours',coalesce(s.interval_hours,24)), 'candidates',v_result);
 elsif p_action='claim' then
  if not coalesce(s.enabled,false) then return '[]'::jsonb; end if;
  for i in select * from public.ingredients where owner_id=p_owner_id and price_research_enabled
   and next_research_at<=now() and (research_lease_until is null or research_lease_until<now())
   order by next_research_at,id for update skip locked limit 3 loop
   v_token:=gen_random_uuid();
   update public.ingredients set research_generation=research_generation+1,research_lease=v_token,research_lease_until=now()+interval '5 minutes' where id=i.id;
   v_result:=v_result||jsonb_build_array(jsonb_build_object('ingredient_id',i.id,'token',v_token,'name',i.name,'brand',i.brand,'spec',i.spec));
  end loop;
  return v_result;
 elsif p_action='finish' then
  v_token:=(p_payload->>'token')::uuid;
  select id into v_obs from public.price_observations where owner_id=p_owner_id and research_run_id=v_token;
  if v_obs is not null then return jsonb_build_object('id',v_obs,'replayed',true); end if;
  select * into i from public.ingredients where id=(p_payload->>'ingredient_id')::uuid and owner_id=p_owner_id for update;
  if i.id is null or not coalesce(s.enabled,false) or not i.price_research_enabled
    or i.research_lease is distinct from v_token or i.research_lease_until<now() then return '{"discarded":true}'::jsonb; end if;
  v_sample:=p_payload->'candidate';v_error:=left(p_payload->>'error',100);
  if v_sample is not null and v_sample<>'null'::jsonb then
   v_amount:=(v_sample->>'amount')::numeric;v_qty:=(v_sample->>'package_quantity')::numeric;v_symbol:=v_sample->>'package_unit';
   if v_amount is null or v_amount<=0 or v_amount::text in ('NaN','Infinity','-Infinity')
    or v_qty is null or v_qty<=0 or v_qty::text in ('NaN','Infinity','-Infinity')
    or v_sample->>'currency' is distinct from 'JPY' or coalesce(v_sample->>'url','')!~'^https://[^/]+'
    or length(v_sample->>'url')>1000 then raise exception 'Invalid research candidate'; end if;
   v_unit:=public.resolve_owned_unit_id(p_owner_id,v_symbol);
   v_supplier:=public.ensure_market_reference_supplier(p_owner_id);
   select count(*),min(id::text)::uuid into v_count,v_offer from public.offers where owner_id=p_owner_id and ingredient_id=i.id
    and supplier_id=v_supplier and package_quantity::numeric=v_qty and package_unit_id=v_unit;
   if v_count>1 then raise exception 'Ambiguous purchase offer'; end if;
   if v_offer is null then
    insert into public.offers(owner_id,ingredient_id,supplier_id,package_quantity,package_unit,package_unit_id)
     values(p_owner_id,i.id,v_supplier,v_qty::text,v_symbol,v_unit) returning id into v_offer;
   end if;
   select * into o from public.offers where id=v_offer and owner_id=p_owner_id;
   insert into public.price_observations(owner_id,offer_id,amount_jpy,currency,source,confirmed,
    tax_note,shipping_note,research_generation,research_run_id,source_url,research_evidence,research_ingredient_basis,research_offer_basis)
   values(p_owner_id,v_offer,v_amount,'JPY','web_reference',false,v_sample->>'tax_note',v_sample->>'shipping_note',i.research_generation,v_token,
    v_sample->>'url',v_sample,i.adopted_observation_id,o.adopted_observation_id) returning id into v_obs;
   v_error:=null;
  end if;
  update public.ingredients set research_lease=null,research_lease_until=null,last_research_at=now(),
   next_research_at=now()+make_interval(hours=>s.interval_hours),last_research_error=v_error where id=i.id and owner_id=p_owner_id;
  return jsonb_build_object('id',v_obs);
 elsif p_action='adopt' then
  select * into c from public.price_observations where id=(p_payload->>'observation_id')::uuid and owner_id=p_owner_id and research_run_id is not null;
  if c.id is null then raise exception 'Candidate not owned'; end if;
  select id into v_obs from public.price_observations where owner_id=p_owner_id and approved_from_observation_id=c.id;
  if v_obs is not null then return jsonb_build_object('id',v_obs,'replayed',true); end if;
  select * into o from public.offers where id=c.offer_id and owner_id=p_owner_id for update;
  select * into i from public.ingredients where id=o.ingredient_id and owner_id=p_owner_id for update;
  if o.id is null or i.id is null or c.research_generation is distinct from i.research_generation or o.adopted_observation_id is distinct from c.research_offer_basis
   or i.adopted_observation_id is distinct from c.research_ingredient_basis
   or exists(select 1 from public.price_observations newer join public.offers nof on nof.id=newer.offer_id
    where newer.owner_id=p_owner_id and nof.ingredient_id=i.id and newer.research_run_id is not null and newer.observed_at>c.observed_at)
   then raise exception 'Stale research candidate'; end if;
  -- Reuse the established explicit Human Gate price-adoption transaction.
  v_obs:=public.set_owned_offer_price(p_owner_id,i.id,o.supplier_id,c.amount_jpy,o.package_quantity::numeric,o.package_unit);
  update public.price_observations set approved_from_observation_id=c.id,tax_note=c.tax_note,shipping_note=c.shipping_note where id=v_obs and owner_id=p_owner_id;
  return jsonb_build_object('id',v_obs,'adopted',true);
 end if;
 raise exception 'Invalid research action';
end $$;
revoke all on function public.owned_price_research(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.owned_price_research(uuid,text,jsonb) to service_role;
commit;
