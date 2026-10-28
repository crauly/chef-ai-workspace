import io
import json
from unittest.mock import patch

import pytest

from chef_ai_workspace.ai_provider import ProposalProviderError
from chef_ai_workspace.meta_responses import MetaResponsesProvider


class Response:
    def __init__(self, payload):
        self.data = io.BytesIO(json.dumps(payload).encode("utf-8"))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

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


def envelope(text):
    return {
        "status": "completed",
        "output": [
            {"type": "reasoning"},
            {"type": "message", "role": "assistant", "status": "completed",
             "content": [{"type": "output_text", "text": text}]},
        ],
    }


def test_muse_intent_classifies_natural_browse_without_lexical_regex():
    opener = Opener(envelope('{"intent":"browse","target":"アマトリチャーナ"}'))
    with patch("chef_ai_workspace.meta_responses.urllib.request.build_opener", return_value=opener):
        value = MetaResponsesProvider("test-key").classify_intent(
            "こないだ作ったアマトリチャーナちょっと見せてくれる？", "idle")
    assert value == {"intent": "browse", "target": "アマトリチャーナ"}
    payload = json.loads(opener.request.data)
    assert payload["model"] == "muse-spark-1.3"
    assert payload["store"] is False
    assert payload["max_output_tokens"] == 120
    assert "こないだ" in payload["input"]


@pytest.mark.parametrize("invalid", [
    '{"intent":"delete","target":""}',
    '{"intent":"edit","target":"","approved":true}',
    '{"intent":"create","target":12}',
    '{"intent":"browse"}',
    "Sure, let me open it.",
])
def test_invalid_intent_cannot_trigger_navigation(invalid):
    opener = Opener(envelope(invalid))
    with patch("chef_ai_workspace.meta_responses.urllib.request.build_opener", return_value=opener):
        with pytest.raises(ProposalProviderError):
            MetaResponsesProvider("test-key").classify_intent("このレシピを表示して")


def test_invalid_mode_rejected_without_provider_call():
    with pytest.raises(ValueError):
        MetaResponsesProvider("test-key").classify_intent("表示", "delete")
