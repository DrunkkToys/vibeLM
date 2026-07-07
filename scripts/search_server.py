#!/usr/bin/env python3
"""Local search proxy — Bing RSS, returns JSON for vibeLM plugin.
Run: python3 scripts/search_server.py
Endpoint: http://localhost:8394/search?q=...&format=json
No API keys. No DuckDuckGo. No SearXNG. Just Bing RSS + XML."""

import http.server
import json
import re
import xml.etree.ElementTree as ET
import urllib.parse
import urllib.request
import ssl

PORT = 8394

def bing_search(query, max_results=5):
    url = f"https://www.bing.com/search?format=rss&q={urllib.parse.quote(query)}&count={max_results}"
    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=10, context=ctx)
        xml_data = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        return {"results": [], "error": str(e)}

    try:
        root = ET.fromstring(xml_data)
        results = []
        for item in root.findall(".//item"):
            title = item.findtext("title", "").strip()
            link = item.findtext("link", "").strip()
            desc = item.findtext("description", "").strip()
            if title and link:
                results.append({"title": title, "url": link, "snippet": desc[:300]})
            if len(results) >= max_results:
                break
        return {"results": results}
    except Exception as e:
        return {"results": [], "error": f"parse error: {e}"}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/search":
            query = params.get("q", [""])[0]
            if not query:
                self.send_json({"results": [], "error": "missing q parameter"})
                return
            data = bing_search(query)
            self.send_json(data)
        else:
            self.send_json({"error": "not found", "usage": "GET /search?q=...&format=json"})

    def send_json(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    print(f"Search proxy running on http://localhost:{PORT}/search?q=...")
    server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()
