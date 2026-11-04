"""Real local DB/API tests. Never connects to live Supabase."""
import os
import unittest
from uuid import uuid4
from decimal import Decimal
import test_procurement_postgres as base
from test_procurement_postgres import sql, literal

@unittest.skipUnless(os.environ.get('CHEF_TEST_PGPORT'), 'disposable local PostgreSQL only')
class ScheduledResearchPostgresTests(unittest.TestCase):
    setUp=base.ProcurementPostgresTests.setUp
    tearDown=base.ProcurementPostgresTests.tearDown
    body=base.ProcurementPostgresTests.body
    save=base.ProcurementPostgresTests.save
    count=base.ProcurementPostgresTests.count

    def setup_price(self):
        saved=self.save(self.body(supplier=None))
        line=saved['materials'][0]
        self.ingredient=line['ingredient_id']
        self.repo.save_research_ingredient(self.owner,self.ingredient,'パスタ',None,True)
        self.repo.price_research(self.owner,'settings',{'enabled':True,'interval_hours':24})
        return saved

    def candidate(self):
        jobs=self.repo.price_research(self.owner,'claim')
        self.assertEqual(len(jobs),1)
        self.assertEqual(self.repo.price_research(self.owner,'claim'),[])
        payload={**jobs[0],'candidate':{'name':'パスタ','amount':'400','currency':'JPY','package_quantity':'500','package_unit':'g','url':'https://shop.example/pasta','seller':'販売元','tax_note':'税込','shipping_note':'送料別'}}
        result=self.repo.price_research(self.owner,'finish',payload)
        self.assertEqual(self.repo.price_research(self.owner,'finish',payload)['id'],result['id'])
        return result['id']

    def cost(self,recipe_id):
        response=self.client.get('/demo/recipes/'+recipe_id+'/cost',headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        return response.json()['total_cost_jpy']

    def test_candidates_never_change_cost_until_approved_then_both_recipes_update(self):
        a=self.setup_price(); b=self.save(self.body(supplier=None)); amazon=self.save(self.body(supplier='Amazon',price='600'))
        self.assertEqual(Decimal(self.cost(a['id'])),Decimal('70'));self.assertEqual(Decimal(self.cost(b['id'])),Decimal('70'))
        candidate=self.candidate()
        self.assertEqual(Decimal(self.cost(a['id'])),Decimal('70'))
        state=self.repo.price_research(self.owner,'read');self.assertEqual(len(state['candidates']),1)
        self.assertEqual(sql(f'select to_json(confirmed) from public.price_observations where id={literal(candidate)};'),False)
        response=self.client.post('/demo/price-research/adopt',json={'observation_id':candidate},headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        before=self.count('price_observations')
        again=self.client.post('/demo/price-research/adopt',json={'observation_id':candidate},headers=self.headers)
        self.assertEqual(again.status_code,200,again.text);self.assertEqual(before,self.count('price_observations'))
        self.assertEqual(Decimal(self.cost(a['id'])),Decimal('80'));self.assertEqual(Decimal(self.cost(b['id'])),Decimal('80'))
        self.assertEqual(self.repo.price_research(self.owner,'read')['candidates'],[])
        self.assertEqual(Decimal(self.cost(amazon['id'])),Decimal('120'))

    def test_global_and_ingredient_switch_matrix_and_duplicate_claim(self):
        ingredient=self.repo.save_research_ingredient(self.owner,None,'塩',None,False)
        self.assertFalse(self.repo.price_research(self.owner,'read')['settings']['enabled'])
        for master in (False,True):
            for individual in (False,True):
                self.repo.save_research_ingredient(self.owner,ingredient,'塩',None,individual)
                self.repo.price_research(self.owner,'settings',{'enabled':master,'interval_hours':12})
                jobs=self.repo.price_research(self.owner,'claim')
                self.assertEqual(bool(jobs),master and individual)
                if jobs:self.assertEqual(self.repo.price_research(self.owner,'claim'),[])

    def test_late_result_after_off_is_discarded(self):
        self.setup_price();job=self.repo.price_research(self.owner,'claim')[0]
        self.repo.price_research(self.owner,'settings',{'enabled':False,'interval_hours':24})
        result=self.repo.price_research(self.owner,'finish',{**job,'error':'timeout'})
        self.assertTrue(result['discarded'])

    def test_stale_basis_and_other_owner_cannot_adopt(self):
        self.setup_price();candidate=self.candidate()
        other=str(uuid4());sql(f'insert into auth.users(id) values({literal(other)});')
        try:
            with self.assertRaises(ValueError):self.repo.price_research(other,'adopt',{'observation_id':candidate})
        finally:sql(f'delete from auth.users where id={literal(other)};')
        self.repo.set_owned_offer_price(self.owner,self.ingredient,None,'450','500','g')
        result=self.client.post('/demo/price-research/adopt',json={'observation_id':candidate},headers=self.headers)
        self.assertEqual(result.status_code,409,result.text)

    def test_expired_worker_and_failed_research_never_write_prices(self):
        self.setup_price();old=self.repo.price_research(self.owner,'claim')[0]
        before=self.count('price_observations')
        sql(f"update public.ingredients set research_lease_until=now()-interval '1 second' where id={literal(self.ingredient)};")
        self.assertTrue(self.repo.price_research(self.owner,'finish',{**old,'error':'timeout'})['discarded'])
        new=self.repo.price_research(self.owner,'claim')[0]
        self.assertNotEqual(old['token'],new['token'])
        self.assertTrue(self.repo.price_research(self.owner,'finish',{**old,'error':'timeout'})['discarded'])
        self.repo.price_research(self.owner,'finish',{**new,'error':'timeout'})
        self.assertEqual(self.count('price_observations'),before)
        self.assertEqual(self.repo.price_research(self.owner,'claim'),[])
        self.assertFalse(sql("select to_json(has_function_privilege('authenticated','public.owned_price_research(uuid,text,jsonb)','execute'));"))

    def test_new_generation_rejects_older_candidate_even_without_price_changes(self):
        self.setup_price();candidate=self.candidate()
        sql(f"update public.ingredients set next_research_at=now() where id={literal(self.ingredient)};")
        self.repo.price_research(self.owner,'claim')
        with self.assertRaises(ValueError):self.repo.price_research(self.owner,'adopt',{'observation_id':candidate})

    def test_api_ingredient_flag_is_persisted_and_owner_scoped(self):
        response=self.client.post('/demo/ingredients',json={'name':'調査対象','price_research_enabled':True},headers=self.headers)
        self.assertEqual(response.status_code,201,response.text)
        ingredient=response.json()['id']
        items=self.client.get('/demo/ingredients',headers=self.headers).json()['items']
        self.assertTrue(next(i for i in items if i['id']==ingredient)['price_research_enabled'])
        response=self.client.put('/demo/ingredients/'+ingredient,json={'name':'調査対象','price_research_enabled':False},headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertFalse(sql(f'select to_json(price_research_enabled) from public.ingredients where id={literal(ingredient)};'))

    def test_parallel_claims_do_not_duplicate_ingredients(self):
        from concurrent.futures import ThreadPoolExecutor
        for n in range(4):self.repo.save_research_ingredient(self.owner,None,'並列'+str(n),None,True)
        self.repo.price_research(self.owner,'settings',{'enabled':True,'interval_hours':24})
        with ThreadPoolExecutor(2) as pool:
            jobs=list(pool.map(lambda _:self.repo.price_research(self.owner,'claim'),range(2)))
        ids=[j['ingredient_id'] for batch in jobs for j in batch]
        self.assertEqual(len(ids),4);self.assertEqual(len(set(ids)),4)

    def test_latest_adoption_does_not_resurface_old_candidates(self):
        self.setup_price();old=self.candidate()
        sql(f"update public.ingredients set next_research_at=now() where id={literal(self.ingredient)};")
        latest=self.candidate()
        self.assertEqual([c['id'] for c in self.repo.price_research(self.owner,'read')['candidates']],[latest])
        self.repo.price_research(self.owner,'adopt',{'observation_id':latest})
        self.assertEqual(self.repo.price_research(self.owner,'read')['candidates'],[])
        with self.assertRaises(ValueError):self.repo.price_research(self.owner,'adopt',{'observation_id':old})
