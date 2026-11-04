-- Unified manager save. Existing adoption/research functions remain the only writers
-- of their respective domain state; this RPC supplies one atomic/idempotent boundary.
-- Editor selection only: never substitutes for a recipe's own offer reference.
alter table public.ingredients add column selected_offer_id uuid references public.offers(id) on delete set null;
create function public.guard_ingredient_selected_offer() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.selected_offer_id is not null and not exists(select 1 from public.offers o
  where o.id=new.selected_offer_id and o.owner_id=new.owner_id and o.ingredient_id=new.id)
 then raise exception 'ingredient_conflict'; end if;
 return new;
end $$;
revoke all on function public.guard_ingredient_selected_offer() from public,anon,authenticated;
create trigger ingredients_selected_offer_owner before insert or update on public.ingredients
 for each row execute function public.guard_ingredient_selected_offer();

create table public.ingredient_edit_receipts (
 owner_id uuid not null references auth.users(id) on delete cascade,
 request_id uuid not null,
 ingredient_id uuid not null references public.ingredients(id) on delete cascade,
 payload jsonb not null,
 result jsonb not null,
 created_at timestamptz not null default now(),
 primary key(owner_id,request_id)
);
alter table public.ingredient_edit_receipts enable row level security;
revoke all on public.ingredient_edit_receipts from public,anon,authenticated;
grant all on public.ingredient_edit_receipts to service_role;

create function public.save_owned_ingredient_edit(
 p_owner_id uuid,p_ingredient_id uuid,p_request_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.ingredients%rowtype; receipt public.ingredient_edit_receipts%rowtype;
 q jsonb; supplier uuid; unit_id uuid; unit_symbol text;
 amount numeric; qty numeric; observation uuid; offer uuid; matches integer;
 result jsonb; changed boolean:=false;
begin
 if p_owner_id is null or p_ingredient_id is null or p_request_id is null
  or jsonb_typeof(p_payload) is distinct from 'object' or length(p_payload::text)>8192
  or coalesce(length(btrim(p_payload->>'name')),0) not between 1 and 200
  or length(coalesce(p_payload->>'spec',''))>200
 then raise exception 'invalid_input'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 select * into receipt from public.ingredient_edit_receipts
  where owner_id=p_owner_id and request_id=p_request_id;
 if found then
  if receipt.ingredient_id<>p_ingredient_id or receipt.payload<>p_payload
  then raise exception 'request_conflict'; end if;
  return receipt.result||jsonb_build_object('replayed',true);
 end if;
 select * into i from public.ingredients where id=p_ingredient_id and owner_id=p_owner_id for update;
 if not found then raise exception 'ingredient_unavailable'; end if;
 if exists(select 1 from public.ingredients other where other.owner_id=p_owner_id and other.id<>p_ingredient_id
  and lower(btrim(other.name))=lower(btrim(p_payload->>'name'))
  and lower(coalesce(nullif(btrim(other.spec),''),''))=lower(coalesce(nullif(btrim(p_payload->>'spec'),''),'')))
 then raise exception 'ingredient_conflict'; end if;
 if p_payload->'price_research_enabled' is not null and p_payload->'price_research_enabled'<>'null'::jsonb
  and jsonb_typeof(p_payload->'price_research_enabled')<>'boolean'
 then raise exception 'invalid_input'; end if;
 begin supplier:=nullif(p_payload->>'supplier_id','')::uuid;
 exception when invalid_text_representation then raise exception 'supplier_unavailable'; end;
 if supplier is not null and not exists(select 1 from public.suppliers where id=supplier and owner_id=p_owner_id)
 then raise exception 'supplier_unavailable'; end if;
 q:=p_payload->'purchase';
 if q is not null and q<>'null'::jsonb then
  if p_payload->'price_confirmed' is distinct from 'true'::jsonb
  then raise exception 'price_confirmation_required'; end if;
  if jsonb_typeof(q)<>'object' then raise exception 'invalid_price'; end if;
  begin amount:=(q->>'amount_jpy')::numeric; qty:=(q->>'quantity')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'invalid_price'; end;
  if amount is null or qty is null or amount<0 or qty<=0
   or amount::text in ('NaN','Infinity','-Infinity') or qty::text in ('NaN','Infinity','-Infinity')
  then raise exception 'invalid_price'; end if;
  begin unit_id:=public.resolve_owned_unit_id(p_owner_id,q->>'unit');
  exception when raise_exception then raise exception 'unit_unknown'; end;
  select symbol into unit_symbol from public.units where id=unit_id and owner_id=p_owner_id;
  if unit_symbol is null then raise exception 'unit_unknown'; end if;
  supplier:=coalesce(supplier,public.ensure_market_reference_supplier(p_owner_id));
 end if;
 -- Identity/research update and price adoption share this enclosing transaction.
 perform public.save_owned_research_ingredient(p_owner_id,p_ingredient_id,
  btrim(p_payload->>'name'),nullif(btrim(p_payload->>'spec'),''),
  coalesce((p_payload->>'price_research_enabled')::boolean,i.price_research_enabled));
 if q is not null and q<>'null'::jsonb then
  select count(*),min(o.id::text)::uuid into matches,offer from public.offers o
   where o.owner_id=p_owner_id and o.ingredient_id=p_ingredient_id and o.supplier_id=supplier
    and case when btrim(o.package_quantity) ~ '^[+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'
         then btrim(o.package_quantity)::numeric=qty else false end
    and (o.package_unit_id=unit_id or (o.package_unit_id is null and o.package_unit=unit_symbol));
  if matches>1 then raise exception 'ingredient_conflict'; end if;
  select p.id into observation from public.offers o join public.price_observations p
   on p.id=o.adopted_observation_id and p.offer_id=o.id and p.owner_id=o.owner_id
   where o.id=offer and o.owner_id=p_owner_id and p.confirmed and p.currency='JPY' and p.amount_jpy=amount;
  if observation is null then
   observation:=public.set_owned_offer_price(p_owner_id,p_ingredient_id,supplier,amount,qty,unit_symbol);
   changed:=true;
   select offer_id into offer from public.price_observations where id=observation and owner_id=p_owner_id;
  end if;
  update public.ingredients set selected_offer_id=offer where id=p_ingredient_id and owner_id=p_owner_id;
 elsif supplier is not null then
  select count(*),min(id::text)::uuid into matches,offer from public.offers
   where owner_id=p_owner_id and ingredient_id=p_ingredient_id and supplier_id=supplier
    and package_quantity is null and package_unit is null;
  if matches>1 then raise exception 'ingredient_conflict'; end if;
  if offer is null then
   insert into public.offers(owner_id,ingredient_id,supplier_id) values(p_owner_id,p_ingredient_id,supplier)
    returning id into offer;
  end if;
  update public.ingredients set selected_offer_id=offer where id=p_ingredient_id and owner_id=p_owner_id;
 end if;
 result:=jsonb_build_object('id',p_ingredient_id,'updated',true,'observation_id',observation,'price_changed',changed,'replayed',false);
 insert into public.ingredient_edit_receipts(owner_id,request_id,ingredient_id,payload,result)
  values(p_owner_id,p_request_id,p_ingredient_id,p_payload,result);
 return result;
end $$;
revoke all on function public.save_owned_ingredient_edit(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_owned_ingredient_edit(uuid,uuid,uuid,jsonb) to service_role;
