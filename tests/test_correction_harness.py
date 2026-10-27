import unittest
from uuid import uuid4
from fastapi.testclient import TestClient
from chef_ai_workspace.api import app
from chef_ai_workspace.models import Recipe, TrackedValue
from chef_ai_workspace.correction_hints import SupabaseCorrectionHints

class Query:
    def __init__(self): self.rows=[];self.args=None
    def execute(self):return type("Response",(),{"data":self.rows})()
class Client:
    def __init__(self):self.q=Query()
    def rpc(self,name,args):
        assert name=="find_relevant_corrections"
        self.q.args=args
        return self.q


