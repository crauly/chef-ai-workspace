"""Opt-in, real PostgreSQL API/RPC integration. Never connects to a live service.
Run after migrations: CHEF_TEST_PGPORT=55441 python -m unittest discover -s tests -p test_procurement_postgres.py
The test connection is hardcoded to a local socket and disposable *_test database.
"""
import json
import os
import re
import subprocess
import unittest
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.demo_api import router
from chef_ai_workspace.supabase_adapter import SupabasePersistence

if not any(getattr(r, 'path', '') == '/demo/recipes/full' for r in app.routes):
    app.include_router(router)


def literal(value):
    if value is None: return 'null'
    if isinstance(value, (dict, list)): return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"
    return "'" + str(value).replace("'", "''") + "'"


def sql(command):
    host=os.environ.get('CHEF_TEST_PGHOST','/tmp')
    assert host in ('/tmp','localhost','127.0.0.1'), 'Only disposable local databases are permitted'
    result = subprocess.run(['psql', '-X', '-qAt', '-h', host, '-p', os.environ['CHEF_TEST_PGPORT'],
                             '-d', 'chef_procurement_test', '-v', 'ON_ERROR_STOP=1'],
                            input=command, text=True, capture_output=True)
    if result.returncode: raise ValueError(result.stderr)
    return json.loads(result.stdout) if result.stdout.strip() else None


class Query:
    def __init__(self, table): self.table=table; self.fields='*'; self.where=[]; self.one=False; self.start=0; self.take=None; self.sort=[]
    def select(self, fields): self.fields=fields; return self
    def eq(self, field, value): self.where.append(f'{field}={literal(value)}'); return self
    def in_(self, field, values): self.where.append(f'{field} in ({",".join(literal(v) for v in values)})'); return self
    def ilike(self, field, value): self.where.append(f'{field} ilike {literal(value)}'); return self
    def order(self, field, **kwargs): self.sort.append(field); return self
    def range(self, start, end): self.start=start; self.take=end-start+1; return self
    def limit(self, take): self.take=take; return self
    def single(self): self.one=True; return self
    def execute(self):
        assert re.fullmatch(r'[a-z_,*]+', self.fields)
        query=f'select {self.fields} from public.{self.table}'
        if self.where: query+=' where '+' and '.join(self.where)
        if self.sort: query+=' order by '+','.join(self.sort)
        if self.take is not None: query+=f' limit {self.take} offset {self.start}'
        data=sql(f"select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from ({query}) x;")
        return SimpleNamespace(data=(data[0] if data else None) if self.one else data)


class LocalClient:
    def table(self, name): return Query(name)
    def rpc(self, name, params):
        args=','.join(f'{key}=>{literal(value)}' for key,value in params.items())
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=sql(f'select to_json(public.{name}({args}));')))


@unittest.skipUnless(os.environ.get('CHEF_TEST_PGPORT'), 'requires disposable PostgreSQL migrations')
class ProcurementPostgresTests(unittest.TestCase):
    def setUp(self):
        self.owner=str(uuid4()); self.repo=SupabasePersistence(LocalClient())
        sql(f'insert into auth.users(id) values({literal(self.owner)});')
        sql(f"insert into public.units(owner_id,symbol,dimension,base_factor) values({literal(self.owner)},'g','mass',1),({literal(self.owner)},'kg','mass',1000);")
        app.state.demo_owner_id=self.owner; app.state.demo_access_token='test-only-procurement-token'
        app.state.repository_factory=lambda:self.repo
        self.client=TestClient(app); self.headers={'X-Demo-Access':app.state.demo_access_token}
    def tearDown(self):
        self.client.close()
        sql(f'delete from auth.users where id={literal(self.owner)};')
        for key in ('demo_owner_id','demo_access_token','repository_factory'): delattr(app.state,key)
    def body(self, supplier='Amazon', price='350'):
        return {'request_id':str(uuid4()),'title':'承認済みパスタ','materials':[{'name':'パスタ','quantity':'100','unit':'g',
                'supplier':supplier,'price_jpy':price,'price_quantity':'500' if price else None,'price_unit':'g' if price else None}]}
    def save(self, body):
        result=self.client.post('/demo/recipes/full',json=body,headers=self.headers)
        self.assertEqual(result.status_code,201,result.text); return result.json()
    def count(self, table): return sql(f'select count(*) from public.{table} where owner_id={literal(self.owner)};')

    def test_amazon_price_survives_reload_and_costs_seventy(self):
        body=self.body(); saved=self.save(body); line=saved['materials'][0]
        self.assertEqual(line['supplier_name'],'Amazon'); self.assertTrue(line['supplier_id']); self.assertTrue(line['offer_id'])
        self.assertEqual(line['effective_price']['amount_jpy']['value'],'350')
        detail=self.client.get('/demo/recipes/'+saved['id'],headers=self.headers).json()
        self.assertEqual(detail['materials'][0]['supplier_name'],'Amazon')
        cost=self.client.get('/demo/recipes/'+saved['id']+'/cost',headers=self.headers).json()
        self.assertFalse(cost['partial']); self.assertEqual(cost['total_cost_jpy'],'70')
        self.assertEqual(cost['line_costs'][line['id']],'70')
        snapshot=sql(f"select cost_snapshot from public.recipe_versions where recipe_id={literal(saved['id'])};")
        self.assertEqual(snapshot['total_cost_jpy'],'70')
        self.assertEqual(snapshot['effective_quotes'][line['id']]['offer_id'],line['offer_id'])
        self.assertEqual(self.save(body)['id'],saved['id']); self.assertEqual(self.count('price_observations'),1)
        changed={**body,'title':'different'}
        self.assertEqual(self.client.post('/demo/recipes/full',json=changed,headers=self.headers).status_code,409)
        suppliers=self.client.get('/demo/suppliers',headers=self.headers).json()['items']
        self.assertEqual(sum(s['name']=='Amazon' for s in suppliers),1)
        self.assertEqual(sum(s['is_market_reference'] for s in suppliers),1)

    def test_unpriced_other_supplier_does_not_borrow_amazon_or_market(self):
        self.save(self.body()); other=self.save(self.body('Rakuten',None))
        line=other['materials'][0]; self.assertEqual(line['supplier_name'],'Rakuten'); self.assertIsNone(line['effective_price'])
        cost=self.client.get('/demo/recipes/'+other['id']+'/cost',headers=self.headers).json()
        self.assertTrue(cost['partial']); self.assertIsNone(cost['total_cost_jpy'])

    def test_market_reference_has_a_real_id_and_legacy_null_keeps_compatibility(self):
        saved=self.save(self.body(None)); line=saved['materials'][0]
        self.assertEqual(line['supplier_name'],'相場参考価格'); self.assertTrue(line['supplier_id']); self.assertTrue(line['offer_id'])
        ingredient=self.repo.load_owned_ingredients(self.owner,[line['ingredient_id']])[line['ingredient_id']]
        self.assertEqual(ingredient.current_price.amount_jpy.value,'350')
        legacy=self.repo.load_owned_recipe(self.owner,saved['id'])
        from dataclasses import replace
        from chef_ai_workspace.costing import calculate_cost
        legacy=replace(legacy,materials=(replace(legacy.materials[0],supplier_id=None,offer_id=None),))
        self.assertEqual(str(calculate_cost(legacy,{ingredient.id:ingredient}).total_cost_jpy),'70')
        self.client.get('/demo/suppliers',headers=self.headers); self.client.get('/demo/suppliers',headers=self.headers)
        self.assertEqual(self.count('suppliers'),1)

    def test_explicit_market_update_precedes_inherited_price_in_either_order(self):
        for priced_first in (False, True):
            with self.subTest(priced_first=priced_first):
                self.save(self.body(None))  # Previously approved market price: 350/500g.
                body=self.body(None,None)
                inherited=body['materials'][0]
                explicit={**inherited,'supplier':'相場参考価格','quantity':'50',
                          'price_jpy':'400','price_quantity':'500','price_unit':'g'}
                body['materials']=[explicit,inherited] if priced_first else [inherited,explicit]
                saved=self.save(body)
                lines=saved['materials']
                self.assertEqual([line['quantity']['value'] for line in lines],
                                 ['50','100'] if priced_first else ['100','50'])
                self.assertEqual(len({line['offer_id'] for line in lines}),1)
                self.assertTrue(lines[0]['offer_id'])
                self.assertEqual([line['effective_price']['amount_jpy']['value'] for line in lines],['400','400'])
                current=self.client.get('/demo/recipes/'+saved['id']+'/cost',headers=self.headers).json()
                snapshot=sql(f"select cost_snapshot from public.recipe_versions where recipe_id={literal(saved['id'])};")
                for cost in (current,snapshot):
                    self.assertFalse(cost['partial'])
                    self.assertEqual(cost['total_cost_jpy'],'120')
                    self.assertEqual({key:Decimal(value) for key,value in cost['line_costs'].items()},
                                     {line['id']:40 if line['quantity']['value']=='50' else 80 for line in lines})
                observations=self.count('price_observations')
                self.save(body)
                self.assertEqual(self.count('price_observations'),observations)

    def test_multiple_terms_remain_partial_without_exact_offer(self):
        self.save(self.body())
        second=self.body();second['materials'][0].update(price_quantity='1000',price_jpy='600');self.save(second)
        saved=self.save(self.body('Amazon',None));line=saved['materials'][0]
        self.assertIsNone(line['offer_id']);self.assertIsNone(line['effective_price'])
        self.assertTrue(self.client.get('/demo/recipes/'+saved['id']+'/cost',headers=self.headers).json()['partial'])

    def test_conflict_rolls_back_recipe_supplier_offer_and_price(self):
        body=self.body();body['materials'].append({**body['materials'][0],'price_jpy':'999','price_quantity':'500.0'})
        response=self.client.post('/demo/recipes/full',json=body,headers=self.headers)
        self.assertEqual(response.status_code,422,response.text)
        for table in ('recipes','suppliers','ingredients','offers','price_observations','recipe_versions'): self.assertEqual(self.count(table),0,table)

    def test_owner_isolation_even_for_the_same_supplier_name(self):
        body=self.body(); original=self.save(body)
        other=str(uuid4());sql(f"insert into auth.users(id) values({literal(other)});")
        sql(f"insert into public.units(owner_id,symbol,dimension,base_factor) values({literal(other)},'g','mass',1);")
        try:
            app.state.demo_owner_id=other
            self.assertEqual(self.client.post('/demo/recipes/full',json=body,headers=self.headers).status_code,409)
            second=self.save(self.body())
            self.assertNotEqual(second['materials'][0]['supplier_id'],original['materials'][0]['supplier_id'])
            with self.assertRaises(ValueError): self.repo.load_owned_recipe(other,original['id'])
        finally:
            app.state.demo_owner_id=self.owner
            sql(f'delete from auth.users where id={literal(other)};')

    def test_unknown_conversion_stays_partial_in_live_and_saved_costs(self):
        sql(f"update public.units set base_factor=null where owner_id={literal(self.owner)};")
        body=self.body();body['materials'][0].update(price_quantity='1',price_unit='kg')
        saved=self.save(body)
        current=self.client.get('/demo/recipes/'+saved['id']+'/cost',headers=self.headers).json()
        snapshot=sql(f"select cost_snapshot from public.recipe_versions where recipe_id={literal(saved['id'])};")
        self.assertTrue(current['partial']);self.assertTrue(snapshot['partial'])
        self.assertIsNone(current['total_cost_jpy']);self.assertIsNone(snapshot['total_cost_jpy'])

    def test_supplier_reuse_and_distinct_prices_for_one_ingredient(self):
        first=self.save(self.body()); amazon=first['materials'][0]['supplier_id']
        body=self.body(' amazon ')
        body['materials'].append({**body['materials'][0],'supplier':'Rakuten','price_jpy':'400'})
        saved=self.save(body); a,b=saved['materials']
        self.assertEqual(a['supplier_id'],amazon)
        self.assertEqual(a['ingredient_id'],b['ingredient_id'])
        self.assertNotEqual(a['offer_id'],b['offer_id'])
        cost=self.client.get('/demo/recipes/'+saved['id']+'/cost',headers=self.headers).json()
        self.assertEqual(cost['line_costs'],{a['id']:'70',b['id']:'80'})
        self.assertEqual(cost['total_cost_jpy'],'150')

    def test_unadopted_latest_observation_does_not_change_cost(self):
        saved=self.save(self.body()); line=saved['materials'][0]
        sql(f"insert into public.price_observations(owner_id,offer_id,amount_jpy,currency,source,confirmed) values({literal(self.owner)},{literal(line['offer_id'])},999,'JPY','manual_entry',true);")
        cost=self.client.get('/demo/recipes/'+saved['id']+'/cost',headers=self.headers).json()
        self.assertEqual(cost['total_cost_jpy'],'70')

    def test_default_reuses_existing_trimmed_name_and_is_protected(self):
        sql(f"insert into public.suppliers(owner_id,name) values({literal(self.owner)},' 相場参考価格 ');")
        suppliers=self.client.get('/demo/suppliers',headers=self.headers).json()['items']
        self.assertEqual(len(suppliers),1);self.assertTrue(suppliers[0]['is_market_reference'])
        self.assertEqual(suppliers[0]['name'],'相場参考価格')
        with self.assertRaises(ValueError):
            sql(f"delete from public.suppliers where owner_id={literal(self.owner)};")
        with self.assertRaises(ValueError):
            sql(f"update public.suppliers set name='Amazon' where owner_id={literal(self.owner)};")

    def test_saved_cost_matches_decimal_current_cost_at_rounding_boundaries(self):
        cases=[('repeating fractions',[('1','1','3')]*3+[('1','1','2')]),
               ('half-even down',[('1.2345678901234567890123456785','1','1')]),
               ('half-even up',[('1.2345678901234567890123456795','1','1')]),
               ('tiny fraction',[('1e-30','7','3e30')])]
        for name,terms in cases:
            with self.subTest(name=name):
                body=self.body(None,'1');body['selling_price_jpy']='7'
                body['materials']=[{**body['materials'][0],'name':f'{name}-{i}','new_master':True,
                                    'quantity':qty,'price_jpy':price,'price_quantity':denominator}
                                   for i,(qty,price,denominator) in enumerate(terms)]
                saved=self.save(body)
                current=self.client.get('/demo/recipes/'+saved['id']+'/cost',headers=self.headers).json()
                snapshot=sql(f"select cost_snapshot from public.recipe_versions where recipe_id={literal(saved['id'])};")
                for key in ('subtotal_jpy','total_cost_jpy','cost_rate_pct'):
                    self.assertEqual(Decimal(snapshot[key]),Decimal(current[key]),key)
                self.assertEqual({k:Decimal(v) for k,v in snapshot['line_costs'].items()},
                                 {k:Decimal(v) for k,v in current['line_costs'].items()})
                if name=='repeating fractions': self.assertEqual(current['total_cost_jpy'],'2')

    def test_auth_refusal_has_no_side_effects(self):
        self.assertEqual(self.client.post('/demo/recipes/full',json=self.body()).status_code,403)
        for table in ('recipes','suppliers','ingredients','offers','price_observations'):self.assertEqual(self.count(table),0)
