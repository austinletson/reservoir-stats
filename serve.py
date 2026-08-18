#!/usr/bin/env python3
"""Serve site/ for local development, with caching turned off.

`python3 -m http.server` sends only Last-Modified, so browsers reuse cached ES modules
without revalidating. Editing one module then reloading gets you a mix of old and new
files, which fails in ways that look like application bugs rather than stale caches:
a stale main.js against a fresh index.html blanked every chart on the page and left a
tab inert, because the old code addressed an element the new markup no longer had.

Not used in production. GitHub Pages sets its own cache headers.
"""

import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

PORT = 8765


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    root = Path(__file__).parent / "site"
    if not (root / "data" / "summary.json").exists():
        print("site/data/summary.json is missing. Run: python3 reservoir_stats.py", file=sys.stderr)
        raise SystemExit(1)
    handler = partial(NoCacheHandler, directory=str(root))
    print(f"http://127.0.0.1:{PORT}/  (Ctrl-C to stop)")
    HTTPServer(("127.0.0.1", PORT), handler).serve_forever()
