import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.models import Recipe, TrackedValue
from chef_ai_workspace.correction_hints import SupabaseCorrectionHints

class Query:
    def __init__(self): self.filters=[];self.rows=[]
    def select(self,*a):return self
    def eq(self,k,v): self.filters.append((k,v));return self
    def order(self,*a,**kw):return self
    def limit(self,*a):return self
    def execute(self):return type("Response",(),{"data":self.rows})()
class Client:
    def __init__(self):self.q=Query()
    def table(self,n):assert n=="correction_preferences";return self.q

class HarnessTests(unittest.TestCase):
    def test_owner_context_filter_and_missing_phrase(self):
        c=Client();c.q.rows=[{"heard_phrase":"澱粉","preferred_phrase":"片栗粉"}]
        hints=SupabaseCorrectionHints(c)
        self.assertEqual(hints.relevant("chef","recipe1","澱粉15g"),
                         [{"heard":"澱粉","candidate":"片栗粉"}])
        self.assertEqual(c.q.filters,[("owner_id","chef"),("context","recipe:recipe1"),("confirmed",True)])
        self.assertEqual(hints.relevant("chef","recipe1","小麦粉15g"),[])
    def test_hints_reach_provider_without_automatic_write(self):
        owner=str(uuid4());rid=str(uuid4());calls=[]
        class Repo:
            def load_owned_recipe(self,o,r):
                self_owner=owner
                assert o==self_owner
                return Recipe(r,TrackedValue("Pasta","confirmed","user"))
        class Hints:
            def relevant(self,*args):return [{"heard":"澱粉","candidate":"片栗粉"}]
            def record(self,*args):calls.append(args)
        class Provider:
            def propose(self,text,ctx):
                assert text=="澱粉15g"
                assert ctx["correction_suggestions"][0]["candidate"]=="片栗粉"
                return []
        app.state.demo_owner_id=owner
        app.state.demo_access_token="test-secret"
        app.state.repository_factory=lambda:Repo()
        app.state.correction_hints=Hints()
        app.state.ai_provider=Provider()
        with TestClient(app) as client:
            try:
                h={"X-Demo-Access":"test-secret"}
                response=client.post(f"/demo/recipes/{rid}/propose",json={"instruction":"澱粉15g"},headers=h)
                self.assertEqual(response.status_code,200,response.text)
                self.assertFalse(calls)
                denied=client.post(f"/demo/recipes/{rid}/corrections",json={"heard":"澱粉","preferred":"片栗粉"})
                self.assertEqual(denied.status_code,403)
                response=client.post(f"/demo/recipes/{rid}/corrections",json={"heard":"澱粉","preferred":"片栗粉"},headers=h)
                self.assertEqual(response.status_code,201,response.text)
                self.assertEqual(calls,[(owner,rid,"澱粉","片栗粉")])
            finally:
                for key in ("demo_owner_id","demo_access_token","repository_factory","correction_hints","ai_provider"):
                    delattr(app.state,key)
if __name__=="__main__":unittest.main()
