do $$ declare c jsonb; begin
 if (select supplier_id from public.offers where id='10000000-0000-4000-8000-000000000005') is distinct from '10000000-0000-4000-8000-000000000002'::uuid then raise exception 'Legacy offer identity lost'; end if;
 if (select count(*) from public.suppliers where owner_id='10000000-0000-4000-8000-000000000001' and is_market_reference)<>1 then raise exception 'Default duplicated'; end if;
 if (select state#>>'{materials,0,supplier_id}' from public.recipes where id='10000000-0000-4000-8000-000000000006') is not null then raise exception 'Legacy recipe rewritten'; end if;
 if (select cost_snapshot from public.recipe_versions where recipe_id='10000000-0000-4000-8000-000000000006')<>'{"legacy_snapshot":true}'::jsonb then raise exception 'Historical cost rewritten'; end if;
 c:=public.procured_recipe_cost('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000006');
 if (c->>'total_cost_jpy')::numeric<>70 then raise exception 'Legacy costing changed'; end if;
 if has_function_privilege('authenticated','public.create_owned_procured_recipe(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,text)','EXECUTE')
  or has_function_privilege('anon','public.ensure_market_reference_supplier(uuid)','EXECUTE') then raise exception 'Procurement RPC exposed'; end if;
end $$;
delete from auth.users where id='10000000-0000-4000-8000-000000000001';
