"""Meta Search Grounding response seam (Responses API web_search only).

Mirrors web/price-web-search.ts: only an observed ``web_search_call``
output item plus at least one ``url_citation`` annotation counts as a
real search. Tool-request-only, citation-free, or unparsable answers are
"not searched" and never become prices. Candidate validation reuses
:mod:`chef_ai_workspace.external_reference` (the SSOT); this module only
detects search evidence and extracts the model's JSON payload.
No Tavily/Brave/Exa/Google path exists.
"""

import json

RESPONSES_ENDPOINT = "https://api.meta.ai/v1/responses"
GROUNDED_SEARCH_MODEL = "muse-spark-1.3"


def build_price_search_input(material_name, request, locale="ja"):
    material = (material_name or "").strip()
    if not material:
        raise ValueError("material name required")
    lang = "en" if locale == "en" else "ja"
    req = (request or "").strip()
    if lang == "en":
        return (f'Reference price research for "{material}". '
                f'Chef request in their own words: "{req}". '
                "Search the web for current retail offers of this "
                "ingredient, then return JSON only.")
    return (f"「{material}」の参考価格調査。料理人の依頼（原文）:「{req}」。 "
            "Webで現在の販売価格を検索し、JSONのみで返すこと。")


def _extract_json(text):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        pass
    for opener, _closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        if start < 0:
            continue
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
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
            elif ch in "{[":
                depth += 1
            elif ch in "}]":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except (ValueError, TypeError):
                        break
    return None


def parse_responses_output(raw):
    """Return {searched, citations, texts, payload}.

    searched is True only when a web_search_call item ran AND at least
    one url_citation annotation is present. payload is the model's JSON
    (or None); citations are [{url, title}].
    """
    out = {"searched": False, "citations": [], "texts": [], "payload": None}
    if not isinstance(raw, dict):
        return out
    output = raw.get("output")
    if not isinstance(output, list):
        return out
    saw_call = False
    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "web_search_call":
            saw_call = True
            continue
        if item.get("type") != "message" or item.get("role") != "assistant":
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") != "output_text" or not isinstance(part.get("text"), str):
                continue
            out["texts"].append(part["text"])
            for ann in part.get("annotations") or []:
                if not isinstance(ann, dict):
                    continue
                if ann.get("type") != "url_citation":
                    continue
                url = ann.get("url")
                if not isinstance(url, str) or not url.strip():
                    continue
                title = ann.get("title")
                title = title.strip() if isinstance(title, str) and title.strip() else url.strip()
                if all(c["url"] != url.strip() for c in out["citations"]):
                    out["citations"].append(
                        {"url": url.strip()[:500], "title": title[:200]})
    out["searched"] = saw_call and len(out["citations"]) > 0
    joined = "\n".join(out["texts"])
    if joined.strip():
        out["payload"] = _extract_json(joined)
    return out
