import io
import json
import unittest
from unittest.mock import patch
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.ai_provider import ChatCompletionsProvider, ProposalProviderError
from chef_ai_workspace.api import app
from chef_ai_workspace.models import Recipe, TrackedValue

class FakeHTTPResponse:
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self,n): return json.dumps({"choices":[{"message":{"content":'{"operations":[{"op":"set_title","value":"New"}]}'}}]}).encode()

class ProviderTests(unittest.TestCase):
    def test_real_api_transport_contract(self):
        p=ChatCompletionsProvider("https://api.openai.com/v1/chat/completions","secret","gpt-4o-mini")
        with patch("urllib.request.urlopen",return_value=FakeHTTPResponse()) as fn:
            ops=p.propose("Rename",{"revision":0})
            self.assertEqual(ops[0]["op"],"set_title")
            req=fn.call_args.args[0]
            self.assertEqual(req.get_header("Authorization"),"Bearer secret")
            self.assertIn(b"Rename",req.data)
            self.assertIn("decimal JSON strings", json.loads(req.data)["messages"][0]["content"])
    def test_missing_key_or_non_https_rejected(self):
        for u,k in (("http://example.com","secret"),("https://example.com","")):
            with self.assertRaises(ValueError):ChatCompletionsProvider(u,k,"test")
    def test_propose_is_nonmutating_and_requires_demo_access(self):
        class Repo:
            def load_owned_recipe(self,owner,rid):
                return Recipe(rid,TrackedValue("Before","confirmed","user"))
        class Provider:
            def propose(self,instruction,recipe_context):
                return [{"op":"set_title","value":"After"}]
        app.state.demo_owner_id=str(uuid4())
        app.state.demo_access_token="test-long-secret"
        app.state.repository_factory=lambda:Repo()
        app.state.ai_provider=Provider()
        client=TestClient(app)
        try:
            rid=str(uuid4())
            body={"instruction":"Rename"}
            self.assertEqual(client.post(f"/demo/recipes/{rid}/propose",json=body).status_code,403)
            self.assertEqual(client.post(f"/demo/recipes/{rid}/propose",json={"instruction":"   "},headers={"X-Demo-Access":"test-long-secret"}).status_code,422)
            r=client.post(f"/demo/recipes/{rid}/propose",json=body,
              headers={"X-Demo-Access":"test-long-secret"})
            self.assertEqual(r.status_code,200,r.text)
            self.assertTrue(r.json()["requires_confirmation"])
            self.assertEqual(r.json()["operations"][0]["value"],"After")
        finally:
            client.close()
            for name in ("demo_owner_id","demo_access_token","repository_factory","ai_provider"):
                delattr(app.state,name)
if __name__=="__main__": unittest.main()
