"""Atomic manager save against disposable local PostgreSQL; never a hosted DB."""
import os
import re
import unittest
from uuid import uuid4
from types import SimpleNamespace
import test_procurement_postgres as base
from test_procurement_postgres import sql, literal
from chef_ai_workspace.api import app
from chef_ai_workspace.supabase_adapter import SupabasePersistence


class RpcFailure(Exception):
    def __init__(self,message): self.message=message; super().__init__(message)


class Client(base.LocalClient):
    def rpc(self,name,params):
        query=super().rpc(name,params)
        def execute():
            try: return query.execute()
            except ValueError as exc:
                match=re.search(r'ERROR:\s+([^\n]+)',str(exc))
                raise RpcFailure(match.group(1) if match else 'unknown') from exc
        return SimpleNamespace(execute=execute)


@unittest.skipUnless(os.environ.get('CHEF_TEST_PGPORT'),'requires disposable local PostgreSQL')
class IngredientEditPostgresTests(unittest.TestCase):
    tearDown=base.ProcurementPostgresTests.tearDown
    body=base.ProcurementPostgresTests.body
    save=base.ProcurementPostgresTests.save
    count=base.ProcurementPostgresTests.count
    def setUp(self):
        base.ProcurementPostgresTests.setUp(self)
        self.repo=SupabasePersistence(Client());app.state.repository_factory=lambda:self.repo
        self.recipe=self.save(self.body())
        line=self.recipe['materials'][0];self.ingredient=line['ingredient_id'];self.supplier=line['supplier_id']
        self.path='/demo/ingredients/'+self.ingredient
    def payload(self,**overrides):
        return {'request_id':str(uuid4()),'name':'乾燥パスタ','spec':'500g入り','price_research_enabled':True,**overrides}
    def put(self,body,status=200):
        response=self.client.put(self.path,json=body,headers=self.headers)
        self.assertEqual(response.status_code,status,response.text);return response.json()
    def row(self):
        return sql(f'select row_to_json(i) from public.ingredients i where id={literal(self.ingredient)};')
    def quote(self,**changes):
        return {'amount_jpy':'400','quantity':'500','unit':'g',**changes}
    def test_identity_and_research_without_price_preserve_history_and_unpriced_save(self):
        before=self.count('price_observations');self.put(self.payload())
        self.assertEqual(self.row()['name'],'乾燥パスタ');self.assertEqual(self.row()['spec'],'500g入り')
        self.assertTrue(self.row()['price_research_enabled']);self.assertEqual(self.count('price_observations'),before)
        self.put(self.payload(price_research_enabled=False));self.assertFalse(self.row()['price_research_enabled'])
        unpriced=self.repo.create_owned_ingredient_master(self.owner,'塩',None);self.path='/demo/ingredients/'+unpriced
        self.put(self.payload(name='粗塩'));self.assertEqual(self.count('price_observations'),before)
    def test_combined_save_updates_matching_recipe_only_and_listing_reload(self):
        other=self.save(self.body('Rakuten','600'))
        self.put(self.payload(supplier_id=self.supplier,purchase=self.quote(),price_confirmed=True))
        for recipe,expected in [(self.recipe,'80'),(other,'120')]:
            response=self.client.get('/demo/recipes/'+recipe['id']+'/cost',headers=self.headers)
            self.assertEqual(response.json()['total_cost_jpy'],expected)
        snapshot=sql(f"select cost_snapshot from public.recipe_versions where recipe_id={literal(self.recipe['id'])};")
        self.assertEqual(snapshot['total_cost_jpy'],'70')
        listing=self.client.get('/demo/ingredients',headers=self.headers).json()
        item=next(i for i in listing['items'] if i['id']==self.ingredient)
        self.assertEqual(item['name'],'乾燥パスタ');self.assertTrue(item['price_research_enabled'])
        quotes=listing['approved_prices_by_ingredient'][self.ingredient]
        self.assertEqual({q['supplier_name']:q['amount_jpy'] for q in quotes},{'Amazon':'400','Rakuten':'600'})
        detail=self.client.get('/demo/ingredients/'+self.ingredient+'/offer-prices',headers=self.headers).json()
        self.assertEqual(len(detail['items']),2)
    def test_replay_and_unchanged_quote_never_duplicate_history(self):
        body=self.payload(supplier_id=self.supplier,purchase=self.quote(),price_confirmed=True)
        result=self.put(body);count=self.count('price_observations')
        again=self.put(body);self.assertTrue(again['replayed']);self.assertEqual(result['observation_id'],again['observation_id'])
        self.assertEqual(self.count('price_observations'),count)
        conflict=self.put({**body,'name':'変更された再送'},409);self.assertEqual(conflict['error'],'request_conflict')
        unchanged=self.put({**body,'request_id':str(uuid4()),'purchase':self.quote(amount_jpy='400.00',quantity='500.0')})
        self.assertFalse(unchanged['price_changed']);self.assertEqual(self.count('price_observations'),count)
    def test_specific_validation_errors_and_owner_isolation_leave_everything_unchanged(self):
        original=self.row();count=self.count('price_observations')
        for extra,code in [
            ({'supplier_id':str(uuid4()),'purchase':self.quote(),'price_confirmed':True},'supplier_unavailable'),
            ({'supplier_id':self.supplier,'purchase':self.quote(unit='未登録'),'price_confirmed':True},'unit_unknown'),
            ({'supplier_id':self.supplier,'purchase':self.quote(quantity='0'),'price_confirmed':True},'invalid_price'),
            ({'supplier_id':self.supplier,'purchase':self.quote(amount_jpy='NaN'),'price_confirmed':True},'invalid_price'),
            ({'supplier_id':self.supplier,'purchase':self.quote(),'price_confirmed':False},'price_confirmation_required')]:
            with self.subTest(code=code): self.assertEqual(self.put(self.payload(**extra),422)['error'],code)
        self.repo.create_owned_ingredient_master(self.owner,'重複','規格')
        self.assertEqual(self.put(self.payload(name='重複',spec='規格'),409)['error'],'ingredient_conflict')
        self.assertEqual(self.row(),original);self.assertEqual(self.count('price_observations'),count)
        self.assertEqual(self.count('ingredient_edit_receipts'),0)
        other=str(uuid4());sql(f'insert into auth.users(id) values({literal(other)});')
        try:
            foreign=str(uuid4());sql(f"insert into public.suppliers(id,owner_id,name) values({literal(foreign)},{literal(other)},'他ユーザー');")
            self.assertEqual(self.put(self.payload(supplier_id=foreign),422)['error'],'supplier_unavailable')
            app.state.demo_owner_id=other
            self.assertEqual(self.put(self.payload(),404)['error'],'ingredient_unavailable')
        finally: app.state.demo_owner_id=self.owner;sql(f'delete from auth.users where id={literal(other)};')
    def test_failure_after_identity_update_rolls_back_all_writes_and_receipt(self):
        original=self.row();before=self.count('price_observations')
        sql(f"""create function public.test_ingredient_failure() returns trigger language plpgsql as $$
        begin if new.owner_id={literal(self.owner)} then raise exception 'private injected database failure'; end if;return new;end $$;
        create trigger test_ingredient_failure before insert on public.price_observations for each row execute function public.test_ingredient_failure();""")
        body=self.payload(supplier_id=self.supplier,purchase=self.quote(),price_confirmed=True)
        try:
            result=self.put(body,503);self.assertEqual(result,{'error':'database_error'})
            self.assertEqual(self.row(),original);self.assertEqual(self.count('price_observations'),before)
            self.assertEqual(self.count('ingredient_edit_receipts'),0)
        finally: sql('drop trigger test_ingredient_failure on public.price_observations;drop function public.test_ingredient_failure();')
        self.put(body);self.assertEqual(self.count('price_observations'),before+1)
    def test_rpc_is_not_callable_by_browser_roles(self):
        for role in ('anon','authenticated'):
            allowed=sql(f"select to_json(has_function_privilege('{role}','public.save_owned_ingredient_edit(uuid,uuid,uuid,jsonb)','EXECUTE'));")
            self.assertFalse(allowed)
        self.assertTrue(sql("select to_json(has_function_privilege('service_role','public.save_owned_ingredient_edit(uuid,uuid,uuid,jsonb)','EXECUTE'));"))

    def test_different_supplier_quantity_and_master_unit_create_only_the_new_terms(self):
        supplier=str(uuid4());sql(f"insert into public.suppliers(id,owner_id,name) values({literal(supplier)},{literal(self.owner)},'B食品');")
        sql(f"insert into public.units(owner_id,symbol,dimension) values({literal(self.owner)},'ケース','count');")
        result=self.put(self.payload(supplier_id=supplier,purchase=self.quote(amount_jpy='1000',quantity='2',unit='ケース'),price_confirmed=True))
        self.assertTrue(result['price_changed'])
        comparison=self.client.get(self.path+'/offer-prices',headers=self.headers).json()['items']
        selected=next(q for q in comparison if q['supplier_id']==supplier)
        self.assertEqual((selected['amount_jpy'],selected['quantity'],selected['unit']),('1000','2','ケース'))
        cost=self.client.get('/demo/recipes/'+self.recipe['id']+'/cost',headers=self.headers).json()
        self.assertEqual(cost['total_cost_jpy'],'70')

    def test_market_reference_updates_shared_price_without_affecting_named_supplier(self):
        market=self.save(self.body(None))
        self.put(self.payload(purchase=self.quote(amount_jpy='450'),price_confirmed=True))
        shared=self.repo.load_owned_ingredients(self.owner,[self.ingredient])[self.ingredient].current_price
        self.assertEqual(shared.amount_jpy.value,'450')
        for recipe,expected in ((market,'90'),(self.recipe,'70')):
            self.assertEqual(self.client.get('/demo/recipes/'+recipe['id']+'/cost',headers=self.headers).json()['total_cost_jpy'],expected)

    def test_selected_offer_can_switch_to_existing_quote_without_new_history(self):
        other=self.save(self.body('Rakuten','600'));before=self.count('price_observations')
        result=self.put(self.payload(supplier_id=self.supplier,purchase=self.quote(amount_jpy='350'),price_confirmed=True))
        self.assertFalse(result['price_changed']);self.assertEqual(self.count('price_observations'),before)
        listing=self.client.get('/demo/ingredients',headers=self.headers).json()
        item=next(i for i in listing['items'] if i['id']==self.ingredient)
        self.assertEqual(item['selected_supplier_id'],self.supplier)
        quote=next(q for q in listing['approved_prices_by_ingredient'][self.ingredient] if q['offer_id']==item['selected_offer_id'])
        self.assertEqual(quote['amount_jpy'],'350')
        self.put(self.payload(spec='規格の変更だけ'));self.assertEqual(self.row()['selected_offer_id'],item['selected_offer_id'])

    def test_unpriced_supplier_selection_is_retained_without_observation(self):
        supplier=str(uuid4());sql(f"insert into public.suppliers(id,owner_id,name) values({literal(supplier)},{literal(self.owner)},'価格なし仕入先');")
        before=self.count('price_observations');self.put(self.payload(supplier_id=supplier))
        item=next(i for i in self.client.get('/demo/ingredients',headers=self.headers).json()['items'] if i['id']==self.ingredient)
        self.assertEqual(item['selected_supplier_id'],supplier);self.assertIsNotNone(item['selected_offer_id'])
        self.assertEqual(self.count('price_observations'),before)
        self.assertFalse(sql("select to_json(has_table_privilege('authenticated','public.ingredient_edit_receipts','SELECT'));"))

    def test_selection_trigger_rejects_offer_for_another_ingredient(self):
        unrelated=self.repo.create_owned_ingredient_master(self.owner,'別の材料',None)
        with self.assertRaises(ValueError):
            sql(f'update public.ingredients set selected_offer_id={literal(self.recipe["materials"][0]["offer_id"])} where id={literal(unrelated)};')
