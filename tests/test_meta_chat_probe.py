import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from chef_ai_workspace.meta_responses import MetaResponsesProvider


class MockResponse:
    def __init__(self, data):
        self.data=io.BytesIO(json.dumps(data).encode("utf-8"))
    def __enter__(self): return self
    def __exit__(self,*args): return None
    def read(self,n): return self.data.read(n)


class Opener:
    def __init__(self,result=None,error=None):
        self.result=result;self.error=error
    def open(self,request,timeout):
        assert request.full_url=="https://api.meta.ai/v1/chat/completions"
        assert request.get_header("Authorization")=="Bearer test-key"
        assert timeout==22
        payload=json.loads(request.data)
        assert payload["model"]=="muse-spark-1.3"
        assert payload["messages"]==[{"role":"user","content":"Reply with one word: ready"}]
        if self.error: raise self.error
        return MockResponse(self.result)


class ChatProbeTest(unittest.TestCase):
    def call(self,result=None,error=None):
        with patch("chef_ai_workspace.meta_responses.urllib.request.build_opener",
                   return_value=Opener(result,error)):
            return MetaResponsesProvider("test-key").check_chat_completions()

    def test_success(self):
        self.assertEqual(self.call({"choices":[{"message":{"role":"assistant","content":"ready"}}]}),
                         {"status":"inference_ready"})

    def test_bad_response(self):
        self.assertEqual(self.call({"choices":[]}),{"status":"invalid_response"})

    def test_model_not_found(self):
        error=urllib.error.HTTPError("https://api.meta.ai/v1/chat/completions",404,"not found",{},
               io.BytesIO(b'{"error":{"code":"model_not_found","message":"sensitive"}}'))
        self.assertEqual(self.call(error=error),{"status":"model_unavailable","reason":"model_not_found"})
