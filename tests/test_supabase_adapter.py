import unittest
from types import SimpleNamespace
from chef_ai_workspace.supabase_adapter import SupabasePersistence, decode_recipe

class Query:
    def __init__(self, result): self.result=result; self.filters=[]
    def select(self, fields): return self
    def eq(self,key,value): self.filters.append((key,value)); return self
    def single(self): return self
    def limit(self,n): return self
    def execute(self): return SimpleNamespace(data=self.result)

class Client:
    def __init__(self): self.tables={}; self.calls=[]
    def table(self,name):
        self.calls.append(name)
        return Query(self.tables.get(name))
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
