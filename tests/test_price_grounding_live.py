"""Opt-in live acceptance for Meta Search Grounding (Responses web_search).

Never runs in CI. Requires MODEL_API_KEY in the backend environment and
CHEF_LIVE_GROUNDING=1. Read-only: one low-context grounded query, no DB,
no persistence, no secret output. Cost is a single search query
(token charge plus the documented per-query grounding charge).
"""
import json
import os
import unittest
import urllib.request


@unittest.skipUnless(os.environ.get("CHEF_LIVE_GROUNDING") == "1",
                     "Opt-in live Search Grounding acceptance")
class LiveGroundingTests(unittest.TestCase):
    ENDPOINT = "https://api.meta.ai/v1/responses"

    def post(self, payload: dict) -> dict:
        req = urllib.request.Request(
            self.ENDPOINT, data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={"Authorization": "Bearer " + os.environ["MODEL_API_KEY"],
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as response:
            return json.loads(response.read(131072))

    def test_web_search_call_with_url_citation(self):
        raw = self.post({
            "model": "muse-spark-1.3",
            "instructions": (
                "Search the web for the current retail price of pork belly "
                "(500g pack) in Japan. First line: ONLY JSON {\"candidates\": "
                "[{\"name\":..., \"amount\": decimal string, \"currency\":..., "
                "\"package_quantity\": decimal string, \"package_unit\":..., "
                "\"seller\":..., \"source\":..., \"url\":...}]} with ONLY "
                "offers actually seen. After the JSON, add one bullet per "
                "candidate: '- <seller>: <source page title> <full page URL>'. "
                "Never invent prices; when unsure return {\"candidates\":[]}."),
            "input": "豚バラ肉 500g retail price Japan",
            "tools": [{"type": "web_search", "search_context_size": "low"}],
            "tool_choice": "auto",
            "store": False,
            "max_output_tokens": 4096,
            "reasoning": {"effort": "low"},
        })
        self.assertEqual(raw.get("status"), "completed")
        output = raw.get("output")
        self.assertIsInstance(output, list)
        calls = [i for i in output if isinstance(i, dict)
                 and i.get("type") == "web_search_call"]
        # The tool must actually run: specifying it is not success.
        self.assertGreater(len(calls), 0, "no web_search_call observed")
        citations = []
        texts = []
        for item in output:
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            for part in item.get("content") or []:
                if not isinstance(part, dict):
                    continue
                if isinstance(part.get("text"), str):
                    texts.append(part["text"])
                for ann in (part.get("annotations") or []):
                    if isinstance(ann, dict) and ann.get("type") == "url_citation":
                        citations.append(ann)
        self.assertGreater(len(citations), 0, "no url_citation observed")
        urls = [c.get("url") for c in citations if c.get("url")]
        self.assertTrue(urls)
        joined = "\n".join(texts)
        start = joined.find("{")
        self.assertGreaterEqual(start, 0, "no JSON payload in answer")
        payload = None
        depth, in_str, esc = 0, False, False
        for i in range(start, len(joined)):
            ch = joined[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    payload = json.loads(joined[start:i + 1])
                    break
        self.assertIsInstance(payload, dict, "no balanced JSON payload")
        candidates = payload.get("candidates")
        self.assertIsInstance(candidates, list)
        self.assertGreater(len(candidates), 0, "no priced candidates returned")
        first = candidates[0]
        for field in ("name", "amount", "currency", "package_quantity",
                      "package_unit", "seller", "source", "url"):
            self.assertTrue(first.get(field), "missing " + field)
        domains = sorted({u.split("/")[2] for u in urls if "://" in u})
        print("\nLIVE-GROUNDING calls=%d citations=%d domains=%s"
              % (len(calls), len(urls), domains[:5]))


if __name__ == "__main__":
    unittest.main()
