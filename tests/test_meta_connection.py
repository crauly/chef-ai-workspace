import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from chef_ai_workspace.meta_responses import MetaResponsesProvider


class Response:
    def __init__(self, data):
        self.data = io.BytesIO(json.dumps(data).encode())
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return None
    def read(self, size):
        return self.data.read(size)


class Opener:
    def __init__(self, response=None, error=None):
        self.response, self.error = response, error
    def open(self, request, timeout):
        assert timeout == 12
        assert request.full_url == "https://api.meta.ai/v1/models"
        assert request.get_header("Authorization") == "Bearer test-key"
        if self.error:
            raise self.error
        return Response(self.response)


class CheckConnectionTest(unittest.TestCase):
    def check(self, response=None, error=None):
        with patch("chef_ai_workspace.meta_responses.urllib.request.build_opener",
                   return_value=Opener(response, error)):
            return MetaResponsesProvider("test-key").check_connection()

    def test_model_is_available(self):
        self.assertEqual(self.check({"object":"list","data":[{"id":"muse-spark-1.3"}]}),
                         {"status":"ready"})

    def test_model_unavailable(self):
        self.assertEqual(self.check({"object":"list","data":[{"id":"other"}]}),
                         {"status":"model_unavailable"})

    def test_malformed_response(self):
        self.assertEqual(self.check({"data":"invalid"}),{"status":"invalid_response"})

    def test_unauthorized(self):
        error=urllib.error.HTTPError("https://api.meta.ai/v1/models",401,"unauthorized",{},None)
        self.assertEqual(self.check(error=error),{"status":"unauthorized"})

    def test_server_error(self):
        error=urllib.error.HTTPError("https://api.meta.ai/v1/models",500,"oops",{},None)
        self.assertEqual(self.check(error=error),{"status":"provider_error"})
