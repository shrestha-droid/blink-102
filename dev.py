"""Local server: static files from public/ plus the same /api functions Vercel runs.

usage: python dev.py [port]      (NASA Space Apps 2026; written with AI assistance)
"""
import importlib, os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "api"))
import _spx


class Dev(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=os.path.join(ROOT, "public"), **k)

    def do_GET(self):
        name = self.path.split("?")[0].removeprefix("/api/")
        if self.path.startswith("/api/") and name in ("search", "frames", "catalog"):
            return _spx.respond(self, importlib.import_module(name).run)
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"http://localhost:{port}")
    ThreadingHTTPServer(("", port), Dev).serve_forever()
