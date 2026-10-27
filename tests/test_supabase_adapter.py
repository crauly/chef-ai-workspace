import unittest
from types import SimpleNamespace
from chef_ai_workspace.supabase_adapter import SupabasePersistence, decode_recipe

class Query:
    def __init__(self, result): self.result=result; self.filters=[]
    def select(self, fields): return self
    def eq(self,key,value): self.filters.append((key,value)); return self
    def in_(self,key,values): self.filters.append((key,tuple(values))); return self
    def single(self): return self
    def limit(self,n): return self
    def execute(self): return SimpleNamespace(data=self.result)

class Client:
    def __init__(self): self.tables={}; self.calls=[]; self.queries=[]
    def table(self,name):
        self.calls.append(name)
        q=Query(self.tables.get(name)); self.queries.append(q); return q
    def rpc(self,name,params):
        self.rpc_name=name; self.params=params
        return Query(1)

def value(v):
    return {"value":str(v),"status":"confirmed","origin":"user"}

def sample():
    return {"id":"r1","title":value("Pasta"),"revision":0,
        "materials":[{"id":"m1","material_name":value("海老"),
            "quantity":value("3"),"unit":"尾","ingredient_id":None,
            "price_mode":"override","price_override":{
                "amount_jpy":value("150"),"per_quantity":"1",
                "per_unit":"尾","source":"manual"}}],
        "selling_price_jpy":value("1000"),
        "cost_adjustment_jpy":value("0")}

class AdapterTests(unittest.TestCase):
    def test_decoding_preserves_provenance_and_quotes(self):
        r=decode_recipe(sample())
        self.assertEqual(r.materials[0].price_override.amount_jpy.value,"150")
        self.assertEqual(r.title.status,"confirmed")
    def test_missing_postgrest_row_is_not_found(self):
        class NotFound(Exception):
            code = "PGRST116"
        class BrokenQuery(Query):
            def execute(self): raise NotFound("No rows")
        class BrokenClient(Client):
            def table(self, name): return BrokenQuery(None)
        with self.assertRaises(ValueError):
            SupabasePersistence(BrokenClient()).load_owned_recipe("owner","missing")

    def test_scoped_reads(self):
        c=Client();c.tables["recipes"]={"state":sample()}
        repo=SupabasePersistence(c)
        self.assertEqual(repo.load_owned_recipe("user-a","r1").id,"r1")
        self.assertEqual(c.calls,["recipes"])
    def test_missing_receipt_and_existing_receipt(self):
        c=Client();c.tables["mutation_receipts"]=[]
        repo=SupabasePersistence(c)
        self.assertIsNone(repo.get_mutation_receipt("user-a","req"))
        c.tables["mutation_receipts"]=[{"payload_hash":"abc","resulting_revision":4}]
        self.assertEqual(repo.get_mutation_receipt("user-a","req"),("abc",4))
    def test_catalog_batch_query_deduplicates_ingredient_ids(self):
        from chef_ai_workspace import Recipe, MaterialLine, TrackedValue
        from dataclasses import replace
        c=Client()
        c.tables["ingredients"]=[
            {"id":"a","name":"海老","current_price":{"amount_jpy":value("150"),"per_quantity":"1","per_unit":"尾","source":"shared-ingredient"}},
            {"id":"b","name":"塩","current_price":None}]
        repo=SupabasePersistence(c)
        base=decode_recipe(sample())
        first=replace(base.materials[0],ingredient_id="a",price_mode="inherit",price_override=None)
        rows=[replace(first,id=f"m{i}") for i in range(50)]
        rows.append(replace(first,id="m50",ingredient_id="b"))
        data=replace(base,materials=tuple(rows))
        catalog=repo.load_owned_catalog("user-a",data)
        self.assertEqual(c.calls,["ingredients"])
        self.assertEqual(catalog["a"].current_price.amount_jpy.value,"150")
        self.assertIsNone(catalog["b"].current_price)
        self.assertIn(("owner_id","user-a"),c.queries[0].filters)
        self.assertIn(("id",("a","b")),c.queries[0].filters)
        self.assertEqual(len({m.ingredient_id for m in data.materials}),2)

    def test_empty_catalog_does_not_hit_database(self):
        c=Client()
        repo=SupabasePersistence(c)
        self.assertEqual(repo.load_owned_catalog("user-a",decode_recipe(sample())),{})
        self.assertEqual(c.calls,[])

    def test_commit_rpc_parameter_names(self):
        c=Client();repo=SupabasePersistence(c)
        out=repo.commit_recipe_revision(owner_id="user-a",recipe_id="r1",
            request_id="req",base_revision=0,state=sample(),title="Pasta",
            cost_snapshot={"total_cost_jpy":"450"},payload_hash="hash",
            save_version=True)
        self.assertEqual(out,1)
        self.assertEqual(c.rpc_name,"commit_recipe_revision")
        self.assertEqual(c.params["p_expected_revision"],0)
        self.assertEqual(c.params["p_owner_id"],"user-a")
        self.assertTrue(c.params["p_save_version"])

if __name__=="__main__":
    unittest.main()
