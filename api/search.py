"""GET /api/search?ra=&dec=  ->  every SPHEREx exposure covering a position, grouped into epochs  (NASA Space Apps 2026; written with AI assistance, see README "AI use")."""
import json, os, sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
import _spx


def run(q):
    ra, dec = _spx.coords(q)
    body = json.dumps(_spx.search(ra, dec), separators=(",", ":")).encode()
    # new exposures are released weekly, so a few hours of CDN caching is safe
    return {"Content-Type": "application/json", "Cache-Control": "public, s-maxage=21600"}, body


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        _spx.respond(self, run)
