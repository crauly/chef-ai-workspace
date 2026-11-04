-- Run after all migrations against a disposable database: psql -v ON_ERROR_STOP=1 -f ...
begin;
do $$
declare
 owner_id uuid := gen_random_uuid();
 v_ingredient uuid;
 supplier_id uuid := gen_random_uuid();
 first_observation uuid;
 next_observation uuid;
 first_offer uuid;
 quantity_text text;
begin
 insert into auth.users(id) values(owner_id);
 v_ingredient := public.create_owned_ingredient_master(owner_id,'Quantity regression',null);
 insert into public.suppliers(id,owner_id,name) values(supplier_id,owner_id,'Supplier');
 insert into public.units(owner_id,symbol,dimension,base_factor) values(owner_id,'g','mass',1);
 perform public.create_owned_ingredient_master(owner_id,'Quantity regression','1号缶');
 perform public.create_owned_ingredient_master(owner_id,'Quantity regression','6号缶');
 first_observation := public.set_owned_offer_price(owner_id,v_ingredient,supplier_id,100,3500,'g');
 select offer_id into first_offer from public.price_observations where id=first_observation;
 foreach quantity_text in array array['3500.0','3500.00','3.5e3','03500'] loop
   next_observation := public.set_owned_offer_price(owner_id,v_ingredient,supplier_id,200,quantity_text::numeric,'g');
   if (select offer_id from public.price_observations where id=next_observation) <> first_offer
   then raise exception 'Equivalent quantity created another offer: %',quantity_text; end if;
   if (select adopted_observation_id from public.offers where id=first_offer) <> next_observation
   then raise exception 'Existing offer adoption was not updated'; end if;
 end loop;
 -- Non-numeric legacy purchase descriptions must remain untouched and not fail the RPC.
 insert into public.offers(owner_id,ingredient_id,supplier_id,package_quantity,package_unit)
 values(owner_id,v_ingredient,supplier_id,'one case','g');
 perform public.set_owned_offer_price(owner_id,v_ingredient,supplier_id,300,3500,'g');
 if (select count(*) from public.offers where offers.ingredient_id=v_ingredient and package_quantity <> 'one case') <> 1
 then raise exception 'Duplicate numeric purchase offers'; end if;
 if has_function_privilege('authenticated','public.set_owned_offer_price(uuid,uuid,uuid,numeric,numeric,text)','EXECUTE')
 then raise exception 'Price RPC exposed to authenticated'; end if;
end $$;
rollback;

-- Recipe offer identity and owner checks across real database trigger paths.
begin;
do $$
declare
 v_owner uuid := gen_random_uuid();
 v_foreign uuid := gen_random_uuid();
 v_ingredient uuid;
 v_other_ingredient uuid;
 v_supplier uuid := gen_random_uuid();
 v_offer uuid;
 v_obs uuid;
 v_recipe uuid := gen_random_uuid();
 v_unit uuid;
 v_state jsonb;
 v_rejected boolean;
begin
 insert into auth.users(id) values(v_owner),(v_foreign);
 v_ingredient := public.create_owned_ingredient_master(v_owner,'Recipe ingredient','1号缶');
 v_other_ingredient := public.create_owned_ingredient_master(v_owner,'Recipe ingredient','6号缶');
 insert into public.suppliers(id,owner_id,name) values(v_supplier,v_owner,'Supplier');
 insert into public.units(owner_id,symbol,dimension,base_factor) values(v_owner,'g','mass',1) returning id into v_unit;
 v_obs := public.set_owned_offer_price(v_owner,v_ingredient,v_supplier,100,3500,'g');
 select offer_id into v_offer from public.price_observations where id=v_obs;
 v_state := jsonb_build_object('materials',jsonb_build_array(jsonb_build_object(
    'id',gen_random_uuid(),'ingredient_id',v_ingredient,'supplier_id',v_supplier,
    'offer_id',v_offer,'price_mode','inherit','price_override',null,'unit','g','unit_id',v_unit)));
 insert into public.recipes(id,owner_id,title,state) values(v_recipe,v_owner,'Recipe',v_state);
 v_rejected := false;
 begin
   update public.recipes set state=jsonb_set(v_state,'{materials,0,ingredient_id}',to_jsonb(v_other_ingredient::text)) where id=v_recipe;
 exception when others then v_rejected := true; end;
 if not v_rejected then raise exception 'Mismatched ingredient/offer accepted'; end if;
 v_rejected := false;
 begin
   perform public.set_owned_offer_price(v_foreign,v_ingredient,v_supplier,200,3500,'g');
 exception when others then v_rejected := true; end;
 if not v_rejected then raise exception 'Foreign owner price adopted'; end if;
 v_rejected := false;
 begin delete from public.offers where id=v_offer;
 exception when others then v_rejected := true; end;
 if not v_rejected then raise exception 'Referenced offer deleted'; end if;
 if (select state from public.recipes where id=v_recipe) <> v_state
 then raise exception 'Rejected mutation changed recipe state'; end if;
end $$;
rollback;
