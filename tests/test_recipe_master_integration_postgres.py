"""Real local PostgreSQL recipe → master → offer → price → shared costing flow."""
import os
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
import test_ingredient_edit_postgres as fixture_mod
from test_procurement_postgres import sql,literal

@__import__('unittest').skipUnless(os.environ.get('CHEF_TEST_PGPORT'),'requires disposable local PostgreSQL')
class RecipeMasterIntegrationTests(__import__('unittest').TestCase):
    def setUp(self):
        self.fixture=fixture_mod.IngredientEditPostgresTests();self.fixture.setUp();self.client=self.fixture.client
        self.repo=self.fixture.repo;self.owner=self.fixture.owner;self.headers=self.fixture.headers
        self.recipe=self.fixture.recipe;self.material=self.recipe['materials'][0];self.path='/demo/recipes/'+self.recipe['id']+'/confirm'
    def tearDown(self): self.fixture.tearDown()
    def body(self,*operations): return {'base_revision':self.recipe['revision'],'request_id':str(uuid4()),'operations':list(operations),'save_version':True}
    def price(self,amount='400',**changes):return {'op':'set_material_price','material_id':self.material['id'],'price_jpy':amount,'price_quantity':'500','price_unit':'g',**changes}
    def cost(self,id):return self.client.get('/demo/recipes/'+id+'/cost',headers=self.headers).json()
    def test_supplier_price_is_adopted_atomically_and_updates_other_matching_recipe(self):
        second=self.fixture.save(self.fixture.body());other=self.fixture.save(self.fixture.body('Rakuten','600'))
        body=self.body(self.price())
        before=self.fixture.count('price_observations')
        review=self.client.post(self.path+'/review',json=body,headers=self.headers)
        self.assertEqual(review.status_code,200,review.text);self.assertEqual(self.fixture.count('price_observations'),before)
        self.assertEqual(review.json()['ingredients'][0]['action'],'reuse')
        response=self.client.post(self.path,json=body,headers=self.headers);self.assertEqual(response.status_code,200,response.text)
        line=response.json()['recipe']['materials'][0]
        self.assertEqual(line['ingredient_id'],self.material['ingredient_id']);self.assertEqual(line['offer_id'],self.material['offer_id'])
        self.assertEqual(line['effective_price']['amount_jpy']['value'],'400')
        self.assertEqual(self.cost(self.recipe['id'])['total_cost_jpy'],'80');self.assertEqual(self.cost(second['id'])['total_cost_jpy'],'80');self.assertEqual(self.cost(other['id'])['total_cost_jpy'],'120')
        before=self.fixture.count('price_observations');again=self.client.post(self.path,json=body,headers=self.headers)
        self.assertTrue(again.json()['replayed']);self.assertEqual(self.fixture.count('price_observations'),before)
        version=sql(f"select cost_snapshot from public.recipe_versions where recipe_id={literal(self.recipe['id'])} and revision=1;")
        self.assertEqual(version['total_cost_jpy'],'80')
        old=sql(f"select cost_snapshot from public.recipe_versions where recipe_id={literal(self.recipe['id'])} and revision=0;")
        self.assertEqual(old['total_cost_jpy'],'70')
    def test_new_supplier_purchase_terms_do_not_change_old_offer(self):
        supplier=str(uuid4());sql(f"insert into public.suppliers(id,owner_id,name) values({literal(supplier)},{literal(self.owner)},'別仕入れ先');")
        body=self.body({'op':'set_material_supplier','material_id':self.material['id'],'supplier_id':supplier,'offer_id':''},self.price('1000',price_quantity='1',price_unit='kg'))
        response=self.client.post(self.path,json=body,headers=self.headers);self.assertEqual(response.status_code,200,response.text)
        line=response.json()['recipe']['materials'][0];self.assertEqual(line['supplier_id'],supplier);self.assertNotEqual(line['offer_id'],self.material['offer_id'])
        self.assertEqual(self.cost(self.recipe['id'])['total_cost_jpy'],'100')
        quotes=self.client.get('/demo/ingredients/'+self.material['ingredient_id']+'/offer-prices',headers=self.headers).json()['items']
        self.assertEqual({q['supplier_name']:q['amount_jpy'] for q in quotes},{'Amazon':'350','別仕入れ先':'1000'})
    def test_unpriced_add_and_master_search_listing(self):
        body=self.body({'op':'add_unpriced_material','material_id':str(uuid4()),'name':'鶏卵','quantity':'2','unit':'g'})
        response=self.client.post(self.path,json=body,headers=self.headers);self.assertEqual(response.status_code,200,response.text)
        line=response.json()['recipe']['materials'][1];self.assertTrue(line['ingredient_id']);self.assertIsNone(line['effective_price'])
        self.assertTrue(self.cost(self.recipe['id'])['partial'])
        listing=self.client.get('/demo/ingredients',headers=self.headers).json()['items'];self.assertTrue(any(i['id']==line['ingredient_id'] for i in listing))
        search=self.client.get('/demo/ingredients/search?q=鶏卵',headers=self.headers).json()['items'];self.assertEqual(search[0]['id'],line['ingredient_id'])
    def test_similar_names_require_choice_and_explicit_reuse_preserves_identity(self):
        chosen=self.repo.create_owned_ingredient_master(self.owner,'ペコリーノロマーノ','1kg')
        line_id=str(uuid4());body=self.body({'op':'add_unpriced_material','material_id':line_id,'name':'ペコリーノ・ロマーノ','quantity':'20','unit':'g'})
        review=self.client.post(self.path+'/review',json=body,headers=self.headers);self.assertEqual(review.status_code,200,review.text)
        match=next(m for m in review.json()['ingredients'] if m['material_id']==line_id);self.assertEqual(match['action'],'choose');self.assertEqual(match['candidates'][0]['id'],chosen)
        self.assertEqual(self.client.post(self.path,json=body,headers=self.headers).status_code,409)
        body['operations'].append({'op':'link_ingredient','material_id':line_id,'ingredient_id':chosen,'price_mode':'inherit'})
        response=self.client.post(self.path,json=body,headers=self.headers);self.assertEqual(response.status_code,200,response.text);self.assertEqual(response.json()['recipe']['materials'][1]['ingredient_id'],chosen)
    def test_full_registration_reviews_all_four_ingredients_and_explicit_choices(self):
        chosen=self.repo.create_owned_ingredient_master(self.owner,'ペコリーノロマーノ',None)
        names=['自家製グアンチャーレ','ペコリーノ・ロマーノ','乾燥パスタ 1.9ミリ ディチェコ','鶏卵']
        body={'request_id':str(uuid4()),'title':'カルボナーラ','materials':[{'name':n,'quantity':'30','unit':'g'} for n in names]}
        review=self.client.post('/demo/recipes/full/review',json=body,headers=self.headers);self.assertEqual(review.status_code,200,review.text)
        self.assertEqual(len(review.json()['materials']),4);self.assertEqual(review.json()['ingredients'][1]['action'],'choose')
        body['materials'][1]['ingredient_id']=chosen
        body['materials'][2]['new_master']=True
        response=self.client.post('/demo/recipes/full',json=body,headers=self.headers);self.assertEqual(response.status_code,201,response.text)
        self.assertEqual(len(response.json()['materials']),4);self.assertEqual(response.json()['materials'][1]['ingredient_id'],chosen)
        self.assertEqual(len({m['ingredient_id'] for m in response.json()['materials']}),4)
    def test_price_failure_rolls_back_new_master_recipe_and_receipt(self):
        before={t:self.fixture.count(t) for t in ('ingredients','offers','price_observations','mutation_receipts')}
        sql(f"""create function public.test_recipe_price_failure() returns trigger language plpgsql as $$begin if new.owner_id={literal(self.owner)} then raise exception 'private db failure';end if;return new;end$$;
        create trigger test_recipe_price_failure before insert on public.price_observations for each row execute function public.test_recipe_price_failure();""")
        body=self.body({'op':'add_material','material_id':str(uuid4()),'name':'鶏卵','quantity':'2','unit':'g','price_jpy':'200','price_quantity':'10','price_unit':'g'},self.price())
        try:
            with TestClient(app,raise_server_exceptions=False) as client:
                response=client.post(self.path,json=body,headers=self.headers);self.assertGreaterEqual(response.status_code,500)
                self.assertNotIn('private',response.text)
            self.assertEqual(self.repo.load_owned_recipe(self.owner,self.recipe['id']).revision,0)
            for t,count in before.items():self.assertEqual(self.fixture.count(t),count,t)
        finally:sql('drop trigger test_recipe_price_failure on public.price_observations;drop function public.test_recipe_price_failure();')
        response=self.client.post(self.path,json=body,headers=self.headers);self.assertEqual(response.status_code,200,response.text)

    def test_master_listing_is_complete_beyond_a_database_page(self):
        sql(f"insert into public.ingredients(owner_id,name) select {literal(self.owner)},case when n=501 then '自家製グアンチャーレ' else '材料'||n::text end from generate_series(1,501) n;")
        response=self.client.get('/demo/ingredients',headers=self.headers);self.assertEqual(response.status_code,200,response.text)
        rows=response.json()['items'];self.assertEqual(len(rows),502);self.assertTrue(any(r['name']=='自家製グアンチャーレ' for r in rows))
    def test_conflicting_quotes_for_shared_terms_and_unknown_unit_never_write(self):
        before=self.fixture.count('price_observations')
        body=self.body(self.price(price_unit='未登録'))
        self.assertEqual(self.client.post(self.path+'/review',json=body,headers=self.headers).status_code,409)
        new_line=str(uuid4());body=self.body({'op':'add_material','material_id':new_line,'name':'パスタ','quantity':'50','unit':'g','price_jpy':'500','price_quantity':'500','price_unit':'g'},
          {'op':'set_material_supplier','material_id':new_line,'supplier_id':self.material['supplier_id'],'offer_id':''},self.price())
        response=self.client.post(self.path,json=body,headers=self.headers);self.assertEqual(response.status_code,409,response.text)
        self.assertEqual(self.fixture.count('price_observations'),before);self.assertEqual(self.repo.load_owned_recipe(self.owner,self.recipe['id']).revision,0)

    def test_legacy_price_entry_fails_instead_of_silently_ignoring_price(self):
        from dataclasses import asdict,replace
        before=self.fixture.count('price_observations')
        state=asdict(replace(self.repo.load_owned_recipe(self.owner,self.recipe['id']),revision=1))
        with self.assertRaises(Exception) as error:
            self.repo.commit_recipe_crud(owner_id=self.owner,recipe_id=self.recipe['id'],request_id=str(uuid4()),base_revision=0,
                state=state,title='旧APIの保存',cost_snapshot={},payload_hash='a'*64,save_version=False,
                ingredient_entries=[{'id':self.material['ingredient_id'],'name':'パスタ','current_price':{'amount_jpy':{'value':'400','status':'confirmed','origin':'user'},'per_quantity':'500','per_unit':'g','source':'manual'}}])
        self.assertIn('Updated API required',str(error.exception))
        self.assertEqual(self.repo.load_owned_recipe(self.owner,self.recipe['id']).revision,0)
        self.assertEqual(self.fixture.count('price_observations'),before)
