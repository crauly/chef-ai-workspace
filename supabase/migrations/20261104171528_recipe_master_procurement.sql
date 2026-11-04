-- Recipe confirm remains the single atomic save boundary.
-- Atomic, owner-scoped recipe CRUD against the ingredient/unit SSOT.
-- This is a replacement for the legacy commit RPC, not a bypass of the
-- recipe_ingredient_ssot trigger. Apply only to Chef AI Workspace.
create or replace function public.commit_recipe_crud(
 p_owner_id uuid, p_recipe_id uuid, p_request_id uuid,
 p_expected_revision bigint, p_new_state jsonb, p_title text,
 p_cost_snapshot jsonb, p_payload_hash text, p_save_version boolean,
 p_ingredient_entries jsonb
) returns bigint
language plpgsql security definer set search_path=''
as $$
declare v_revision bigint;
declare v_receipt public.mutation_receipts%rowtype;
declare v_item jsonb;
declare v_line jsonb;
declare v_lines jsonb := '[]'::jsonb;
declare v_state jsonb := p_new_state;
declare v_id uuid;
declare v_name text;
declare v_unit uuid;
declare v_existing public.ingredients%rowtype;
declare plan jsonb; quote jsonb; supplier uuid; observation uuid; offer uuid;
declare amount numeric; qty numeric; line_index integer; matches integer;
declare adopted jsonb; v_cost jsonb; quotes jsonb:='{}';
declare seen jsonb:='{}'; purchase_key text; unit_symbol text;
begin
 if p_owner_id is null or p_recipe_id is null or p_request_id is null
    or p_expected_revision is null or p_expected_revision < 0
    or p_payload_hash is null or p_payload_hash=''
    or p_title is null or btrim(p_title)=''
    or jsonb_typeof(v_state) is distinct from 'object'
    or jsonb_typeof(v_state->'materials') is distinct from 'array'
    or jsonb_typeof(p_ingredient_entries) is distinct from 'array'
 then raise exception 'Invalid recipe CRUD payload'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 select revision into v_revision from public.recipes
 where id=p_recipe_id and owner_id=p_owner_id for update;
 if not found then raise exception 'Recipe not found'; end if;
 select * into v_receipt from public.mutation_receipts
 where owner_id=p_owner_id and request_id=p_request_id;
 if found then
   if v_receipt.recipe_id<>p_recipe_id or v_receipt.payload_hash<>p_payload_hash
   then raise exception 'Request ID reused with a different mutation'; end if;
   return v_receipt.resulting_revision;
 end if;
 if v_revision<>p_expected_revision then raise exception 'Stale recipe revision'; end if;
 -- Explicitly approved ingredient master updates and recipe changes are one transaction.
 for v_item in select value from jsonb_array_elements(p_ingredient_entries) loop
   v_id := (v_item->>'id')::uuid;
   v_name := btrim(coalesce(v_item->>'name',''));
   if v_id is null or length(v_name) not between 1 and 200
      or jsonb_typeof(v_item->'purchases') is distinct from 'array'
      or v_item ? 'current_price'
   then raise exception 'Invalid ingredient entry'; end if;
   select * into v_existing from public.ingredients where id=v_id for update;
   if found then
     if v_existing.owner_id<>p_owner_id then raise exception 'Foreign ingredient'; end if;
     -- Ingredient identity is managed in the master, never renamed by recipe edits.

   else
     if exists(select 1 from public.ingredients
       where owner_id=p_owner_id and lower(btrim(name))=lower(v_name)
        and coalesce(nullif(btrim(spec),''),'')=coalesce(nullif(btrim(v_item->>'spec'),''),''))
     then raise exception 'Ingredient identity collision'; end if;
     insert into public.ingredients(id,owner_id,name,spec,brand,current_price)
     values(v_id,p_owner_id,v_name,nullif(btrim(v_item->>'spec'),''),nullif(btrim(v_item->>'brand'),''),null);
   end if;
 end loop;
 -- Canonicalize units on every edit; never weaken the SSOT trigger.
 for v_line in select value from jsonb_array_elements(v_state->'materials') loop
   if v_line->>'price_mode' is distinct from 'inherit'
      or jsonb_typeof(v_line->'price_override') is distinct from 'null'
   then raise exception 'Recipe price override forbidden'; end if;
   v_id := (v_line->>'ingredient_id')::uuid;
   if not exists(select 1 from public.ingredients where id=v_id and owner_id=p_owner_id)
   then raise exception 'Recipe ingredient must belong to owner'; end if;
   if nullif(v_line->>'supplier_id','') is not null and not exists(
     select 1 from public.suppliers
     where id=(v_line->>'supplier_id')::uuid and owner_id=p_owner_id
   ) then raise exception 'Recipe supplier must belong to owner'; end if;
   if v_line->>'unit' is not null then
     v_unit := public.resolve_owned_unit_id(p_owner_id,v_line->>'unit');
     v_line := jsonb_set(v_line,'{unit_id}',to_jsonb(v_unit::text),true);
   else
     v_line := jsonb_set(v_line,'{unit_id}','null'::jsonb,true);
   end if;
   v_lines := v_lines || jsonb_build_array(v_line);
 end loop;
 -- Prices are approved as part of this same confirm, through the existing Offer path.
 for v_item in select value from jsonb_array_elements(p_ingredient_entries) loop
  if coalesce(jsonb_typeof(v_item->'purchases'),'array')<>'array' then raise exception 'Invalid procurement'; end if;
  for plan in select value from jsonb_array_elements(coalesce(v_item->'purchases','[]')) loop
   select (ordinality-1)::integer,value into line_index,v_line
    from jsonb_array_elements(v_lines) with ordinality where value->>'id'=plan->>'material_id';
   if v_line is null or v_line->>'ingredient_id'<>v_item->>'id' then raise exception 'Invalid procurement material'; end if;
   supplier:=nullif(plan->>'supplier_id','')::uuid;
   if supplier is not null and not exists(select 1 from public.suppliers where id=supplier and owner_id=p_owner_id)
    then raise exception 'Recipe supplier must belong to owner'; end if;
   supplier:=coalesce(supplier,public.ensure_market_reference_supplier(p_owner_id));
   quote:=plan->'quote';
   if jsonb_typeof(quote) is distinct from 'object' or quote->'amount_jpy'->>'status' is distinct from 'confirmed'
    then raise exception 'Price approval required'; end if;
   amount:=(quote->'amount_jpy'->>'value')::numeric;qty:=(quote->>'per_quantity')::numeric;
   if amount is null or qty is null or amount<0 or qty<=0 or amount::text in ('NaN','Infinity','-Infinity')
    or qty::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid purchase price'; end if;
   v_unit:=public.resolve_owned_unit_id(p_owner_id,quote->>'per_unit');
   select symbol into unit_symbol from public.units where id=v_unit and owner_id=p_owner_id;
   purchase_key:=(v_item->>'id')||':'||supplier::text||':'||trim_scale(qty)::text||':'||v_unit::text;
   if seen ? purchase_key and (seen->>purchase_key)::numeric<>amount then raise exception 'Conflicting purchase prices'; end if;
   seen:=seen||jsonb_build_object(purchase_key,amount::text);
   select count(*),min(o.id::text)::uuid into matches,offer from public.offers o
    where o.owner_id=p_owner_id and o.ingredient_id=(v_item->>'id')::uuid and o.supplier_id=supplier
     and case when btrim(o.package_quantity) ~ '^[+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'
          then btrim(o.package_quantity)::numeric=qty else false end
     and (o.package_unit_id=v_unit or (o.package_unit_id is null and o.package_unit=unit_symbol));
   if matches>1 then raise exception 'Ambiguous purchase offer'; end if;
   select p.id into observation from public.offers o join public.price_observations p
    on p.id=o.adopted_observation_id and p.offer_id=o.id and p.owner_id=o.owner_id
    where o.id=offer and o.owner_id=p_owner_id and p.confirmed and p.currency='JPY' and p.amount_jpy=amount;
   if observation is null then
    observation:=public.set_owned_offer_price(p_owner_id,(v_item->>'id')::uuid,supplier,amount,qty,unit_symbol);
    select offer_id into offer from public.price_observations where id=observation and owner_id=p_owner_id;
   end if;
   v_line:=v_line||jsonb_build_object('supplier_id',supplier,'offer_id',offer);
   v_lines:=jsonb_set(v_lines,array[line_index::text],v_line);
   update public.ingredients set selected_offer_id=offer where id=(v_item->>'id')::uuid and owner_id=p_owner_id;
  end loop;
 end loop;
 v_state := jsonb_set(v_state,'{materials}',v_lines);
 update public.recipes set state=v_state,title=p_title,
   revision=v_revision+1,updated_at=now()
 where id=p_recipe_id and owner_id=p_owner_id;
 if p_save_version then
   if p_cost_snapshot is null then raise exception 'Missing cost snapshot'; end if;
   v_cost:=public.procured_recipe_cost(p_owner_id,p_recipe_id);
   for v_line in select value from jsonb_array_elements(v_lines) loop
    adopted:=null;
    if nullif(v_line->>'offer_id','') is not null then
     select jsonb_build_object('amount_jpy',jsonb_build_object('value',p.amount_jpy::text,'status','confirmed','origin','user'),
       'per_quantity',o.package_quantity,'per_unit',o.package_unit,'source',p.source)
     into adopted from public.offers o join public.price_observations p on p.id=o.adopted_observation_id and p.offer_id=o.id and p.owner_id=o.owner_id
     where o.id=(v_line->>'offer_id')::uuid and o.owner_id=p_owner_id and p.confirmed;
    elsif nullif(v_line->>'supplier_id','') is not null then
     select case when count(*)=1 then (jsonb_agg(x.q)->0) else null end into adopted from (
      select jsonb_build_object('amount_jpy',jsonb_build_object('value',p.amount_jpy::text,'status','confirmed','origin','user'),
       'per_quantity',o.package_quantity,'per_unit',o.package_unit,'source',p.source) as q
      from public.offers o join public.price_observations p on p.id=o.adopted_observation_id and p.offer_id=o.id and p.owner_id=o.owner_id
      where o.owner_id=p_owner_id and o.ingredient_id=(v_line->>'ingredient_id')::uuid
       and o.supplier_id=(v_line->>'supplier_id')::uuid and p.confirmed and p.currency='JPY'
     ) x;
    else
     select current_price into adopted from public.ingredients where id=(v_line->>'ingredient_id')::uuid and owner_id=p_owner_id;
    end if;
    quotes:=quotes||jsonb_build_object(v_line->>'id',jsonb_build_object('ingredient_id',v_line->>'ingredient_id',
      'supplier_id',v_line->>'supplier_id','offer_id',v_line->>'offer_id','price_mode','inherit','effective_quote',adopted));
   end loop;
   insert into public.recipe_versions(recipe_id,owner_id,revision,snapshot,cost_snapshot)
   values(p_recipe_id,p_owner_id,v_revision+1,v_state,v_cost||jsonb_build_object('effective_quotes',quotes));
 end if;
 insert into public.mutation_receipts(owner_id,request_id,recipe_id,resulting_revision,payload_hash)
 values(p_owner_id,p_request_id,p_recipe_id,v_revision+1,p_payload_hash);
 return v_revision+1;
end;
$$;
revoke all on function public.commit_recipe_crud(uuid,uuid,uuid,bigint,jsonb,text,jsonb,text,boolean,jsonb)
 from public,anon,authenticated;
grant execute on function public.commit_recipe_crud(uuid,uuid,uuid,bigint,jsonb,text,jsonb,text,boolean,jsonb)
 to service_role;


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
                  and lower(btrim(i.name))=lower(v_ing_name)
                  and coalesce(nullif(btrim(i.spec),''),'')=coalesce(nullif(btrim(v_item->>'spec'),''),''))
     then raise exception 'Existing ingredient ID must be reused'; end if;
     insert into public.ingredients(id,owner_id,name,spec,brand,current_price)
     values(v_ing_id,p_owner_id,v_ing_name,nullif(btrim(v_item->>'spec'),''),nullif(btrim(v_item->>'brand'),''),
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
