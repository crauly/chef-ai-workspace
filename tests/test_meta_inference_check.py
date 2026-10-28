import io
import json
import unittest
import urllib.error
from unittest.mock import patch
from chef_ai_workspace.meta_responses import MetaResponsesProvider


class Response:
    def __init__(self, data):
        self.stream=io.BytesIO(json.dumps(data).encode())
    def __enter__(self): return self
    def __exit__(self,*args): return None
    def read(self,n): return self.stream.read(n)


class Opener:
    def __init__(self, data=None, error=None):
        self.data=data
        self.error=error
    def open(self, req, timeout):
        assert req.full_url=="https://api.meta.ai/v1/responses"
        assert req.get_header("Authorization")=="Bearer test-key"
        assert timeout==22
        payload=json.loads(req.data)
        assert payload["model"]=="muse-spark-1.3"
        assert payload["store"] is False
        if self.error: raise self.error
        return Response(self.data)


def envelope(message, status="completed"):
    return {"status":status,"output":[{"type":"reasoning"},{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":message}]}]}


class TestMuseInferenceDiagnostic(unittest.TestCase):
    def probe(self,data=None,error=None):
        with patch("chef_ai_workspace.meta_responses.urllib.request.build_opener",return_value=Opener(data,error)):
            return MetaResponsesProvider("test-key").check_inference()["status"]

    def test_success(self):
        self.assertEqual(self.probe(envelope('{"intent":"browse","target":""}')),"inference_ready")

    def test_incomplete(self):
        self.assertEqual(self.probe(envelope('{"intent":"browse","target":""}',"incomplete")),"incomplete_response")

    def test_wrong_text(self):
        self.assertEqual(self.probe(envelope('Hello!')),"invalid_response")

    def test_wrong_structured_output(self):
        self.assertEqual(self.probe(envelope('{"intent":"edit","target":""}')),"unexpected_model_output")

    def test_provider_errors_are_sanitized(self):
        for code,expected in [(400,"request_rejected"),(401,"unauthorized"),(403,"forbidden"),(404,"model_unavailable"),(429,"rate_limited"),(500,"provider_error")]:
            with self.subTest(code=code):
                err=urllib.error.HTTPError("https://api.meta.ai/v1/responses",code,"secret raw error",{},None)
                self.assertEqual(self.probe(error=err),expected)

    def test_provider_404_exposes_only_safe_reason(self):
        payload = b'{"error":{"type":"invalid_request_error","code":"model_not_found","message":"private account data"}}'
        err = urllib.error.HTTPError("https://api.meta.ai/v1/responses",404,"not found",{},io.BytesIO(payload))
        with patch("chef_ai_workspace.meta_responses.urllib.request.build_opener",
                   return_value=Opener(error=err)):
            result = MetaResponsesProvider("test-key").check_inference()
        self.assertEqual(result, {"status":"model_unavailable","reason":"model_not_found"})
        self.assertNotIn("private",str(result))
