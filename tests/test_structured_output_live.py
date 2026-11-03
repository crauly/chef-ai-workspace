"""Opt-in live acceptance for Structured Output (Phase C).

Never runs in CI. Requires MODEL_API_KEY in the backend environment and
CHEF_LIVE_STRUCTURED=1. Read-only: one tiny classification call, no DB,
no persistence, no secret output.
"""
import json
import os
import unittest
import urllib.request


VOICE_RECIPE_SCHEMA_PY = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "materials": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "quantity": {"type": "string"},
                "unit": {"type": "string"},
                "price_jpy": {"type": "string"},
                "price_quantity": {"type": "string"},
                "price_unit": {"type": "string"},
                "supplier": {"type": "string"}},
            "required": ["name", "quantity", "unit", "price_jpy",
                         "price_quantity", "price_unit", "supplier"],
            "additionalProperties": False}},
        "unit_proposals": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string"},
                "dimension": {"type": "string", "enum": [
                    "mass", "volume", "count", "other"]}},
            "required": ["symbol", "dimension"],
            "additionalProperties": False}},
        "selling_price_jpy": {"type": "string"},
        "notes": {"type": "array", "items": {"type": "string"}},
        "interpretations": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "source": {"type": "string"},
                "suggestion": {"type": "string"},
                "reason": {"type": "string"}},
            "required": ["source", "suggestion", "reason"],
            "additionalProperties": False}},
        "price_research": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "material_name": {"type": "string"},
                "request": {"type": "string"},
                "material_index": {"type": ["integer", "null"],
                                   "minimum": 0}},
            "required": ["material_name", "request", "material_index"],
            "additionalProperties": False}},
        "name_corrections": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "material_name": {"type": "string"},
                "heard": {"type": "string"},
                "candidates": {"type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "reason": {"type": "string"}},
                    "required": ["name", "reason"],
                    "additionalProperties": False}}},
            "required": ["material_name", "heard", "candidates"],
            "additionalProperties": False}}},
    "required": ["title", "materials", "unit_proposals", "selling_price_jpy",
                 "notes", "interpretations", "price_research",
                 "name_corrections"],
    "additionalProperties": False}


@unittest.skipUnless(os.environ.get("CHEF_LIVE_STRUCTURED") == "1",
                     "Opt-in live Structured Output acceptance")
class LiveStructuredOutputTests(unittest.TestCase):
    ENDPOINT = "https://api.meta.ai/v1/chat/completions"

    def post(self, payload: dict) -> dict:
        req = urllib.request.Request(
            self.ENDPOINT, data=json.dumps(payload).encode("utf-8"), method="POST",
            headers={"Authorization": "Bearer " + os.environ["MODEL_API_KEY"],
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.loads(response.read(8192))

    def test_chat_json_schema_accepted_for_intent(self):
        raw = self.post({
            "model": "muse-spark-1.3", "reasoning_effort": "low",
            "max_completion_tokens": 2048,
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "chef_intent", "strict": True, "schema": {
                    "type": "object",
                    "properties": {
                        "intent": {"type": "string",
                                   "enum": ["create", "browse", "edit", "clarify"]},
                        "target": {"type": "string"}},
                    "required": ["intent", "target"],
                    "additionalProperties": False}}},
            "messages": [
                {"role": "system",
                 "content": "Return ONLY a JSON object with exactly intent and target."},
                {"role": "user",
                 "content": json.dumps({"utterance": "内容を確認",
                                        "current_mode": "idle"})}]})
        content = raw["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        self.assertEqual(set(parsed), {"intent", "target"})
        self.assertIn(parsed["intent"], ("create", "browse", "edit", "clarify"))
        self.assertIsInstance(parsed["target"], str)

    def test_voice_recipe_schema_accepted_with_nested_structure(self):
        """VOICE_RECIPE_SCHEMA itself against Muse Spark 1.3. Read-only."""
        schema = VOICE_RECIPE_SCHEMA_PY

        raw = self.post({
            "model": "muse-spark-1.3", "reasoning_effort": "low",
            "max_completion_tokens": 8192,
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "chef_voice_recipe", "strict": True, "schema": schema}},
            "messages": [
                {"role": "developer", "content":
                 "Read the chronological spoken turns as one conversation and "
                 "return a proposed UNSAVED recipe as JSON only. " "Allowed units: g, kg, ml, L. " "Prices are JPY decimal strings. "
                 "A package price is not the quantity consumed."},
                {"role": "user", "content": json.dumps({
                    "spoken_turns": [
                        "pasta 100 grams, 500 gram pack costs 350 yen",
                        "selling price 1800 yen"]})} ]})
        choice = raw["choices"][0]
        self.assertEqual(choice.get("finish_reason"), "stop")
        parsed = json.loads(choice["message"]["content"])
        # Structural assertions mirror the key-set gate of
        # web/app/api/voice-recipe parse(); parse() itself runs in the
        # fixture spec, not in this live probe.
        self.assertEqual(set(parsed),
                         {"title", "materials", "selling_price_jpy",
                          "notes", "interpretations", "price_research",
                          "name_corrections"})
        self.assertIsInstance(parsed["title"], str)
        self.assertIsInstance(parsed["notes"], list)
        self.assertTrue(all(isinstance(n, str) for n in parsed["notes"]))
        self.assertIsInstance(parsed["materials"], list)
        self.assertGreater(len(parsed["materials"]), 0)
        for material in parsed["materials"]:
            self.assertEqual(set(material),
                             {"name", "quantity", "unit", "price_jpy",
                              "price_quantity", "price_unit", "supplier"})
            self.assertTrue(all(isinstance(v, str)
                                for v in material.values()))
        for item in parsed["interpretations"]:
            self.assertEqual(set(item), {"source", "suggestion", "reason"})
        # Controlled input carries explicit values: package-vs-use preserved,
        # so the app-side value checks yield no missing entries.
        first = parsed["materials"][0]
        self.assertEqual(first["quantity"], "100")
        self.assertEqual(first["price_quantity"], "500")
        self.assertIn(first["unit"], ("g", "kg", "ml", "L"))
        self.assertIn(first["price_unit"], ("g", "kg", "ml", "L"))
