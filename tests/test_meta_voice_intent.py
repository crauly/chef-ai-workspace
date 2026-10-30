import io
import json
import unittest
from unittest.mock import patch

from chef_ai_workspace.ai_provider import ProposalProviderError
from chef_ai_workspace.meta_responses import MetaResponsesProvider


class Response:
    def __init__(self, payload):
        self.data = io.BytesIO(json.dumps(payload).encode("utf-8"))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self, length):
        return self.data.read(length)


class Opener:
    def __init__(self, payload):
        self.payload = payload
        self.request = None

    def open(self, request, timeout):
        self.request = request
        assert timeout == 18
        return Response(self.payload)


def envelope(output_text):
    return {
        "status": "completed",
        "output": [
            {"type": "reasoning"},
            {"type": "message", "role": "assistant", "status": "completed",
             "content": [{"type": "output_text", "text": output_text}]},
        ],
    }


class TestMetaVoiceIntent(unittest.TestCase):
    def test_natural_browse_intent(self):
        opener = Opener(envelope('{"intent":"browse","target":"アマトリチャーナ"}'))
        with patch("chef_ai_workspace.meta_responses.urllib.request.build_opener", return_value=opener):
            value = MetaResponsesProvider("test-key").classify_intent(
                "こないだ作ったアマトリチャーナちょっと見せてくれる？", "idle")
        self.assertEqual(value, {"intent": "browse", "target": "アマトリチャーナ"})
        payload = json.loads(opener.request.data)
        self.assertEqual(payload["model"], "muse-spark-1.3")
        self.assertIs(payload["store"], False)
        self.assertEqual(payload["max_output_tokens"], 1024)

    def test_reject_unsafe_or_malformed_model_output(self):
        for invalid in [
            '{"intent":"delete","target":""}',
            '{"intent":"edit","target":"","approved":true}',
            '{"intent":"create","target":12}',
            '{"intent":"browse"}',
            "Sure, let me open it.",
        ]:
            with self.subTest(output=invalid):
                opener = Opener(envelope(invalid))
                with patch("chef_ai_workspace.meta_responses.urllib.request.build_opener", return_value=opener):
                    with self.assertRaises(ProposalProviderError):
                        MetaResponsesProvider("test-key").classify_intent("このレシピを表示して")

    def test_invalid_mode_rejected(self):
        with self.assertRaises(ValueError):
            MetaResponsesProvider("test-key").classify_intent("表示", "delete")
