-- Disposable migration fixture, applied immediately before 20261104090755.
insert into auth.users(id) values('10000000-0000-4000-8000-000000000001');
insert into public.suppliers(id,owner_id,name) values('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','相場参考価格');
insert into public.units(id,owner_id,symbol,dimension,base_factor) values('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','g','mass',1);
insert into public.ingredients(id,owner_id,name,current_price) values('10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','Legacy pasta',
 '{"amount_jpy":{"value":"350","status":"confirmed","origin":"user"},"per_quantity":"500","per_unit":"g","per_unit_id":"10000000-0000-4000-8000-000000000003","source":"manual"}');
insert into public.offers(id,owner_id,ingredient_id,supplier_id,package_quantity,package_unit,package_unit_id)
 values('10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004',null,'500','g','10000000-0000-4000-8000-000000000003');
insert into public.recipes(id,owner_id,title,state) values('10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','Legacy',
 '{"materials":[{"id":"legacy-line","ingredient_id":"10000000-0000-4000-8000-000000000004","supplier_id":null,"offer_id":null,"quantity":{"value":"100","status":"confirmed","origin":"user"},"unit":"g","unit_id":"10000000-0000-4000-8000-000000000003","price_mode":"inherit","price_override":null}],"selling_price_jpy":{"value":null,"status":"unresolved","origin":"system"},"cost_adjustment_jpy":{"value":"0","status":"confirmed","origin":"user"}}');
insert into public.recipe_versions(recipe_id,owner_id,revision,snapshot,cost_snapshot) select id,owner_id,0,state,'{"legacy_snapshot":true}'::jsonb from public.recipes where id='10000000-0000-4000-8000-000000000006';
