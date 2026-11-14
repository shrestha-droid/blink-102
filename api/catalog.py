"""GET /api/catalog?kind=catwise|gaia&ra=&dec=&r=  ->  catalogue cone search through IRSA TAP  (NASA Space Apps 2026; written with AI assistance, see README "AI use")."""
import json, os, sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
import _spx


def run(q):
    ra, dec = _spx.coords(q)
    kind = q.get("kind", "catwise")
    assert kind in _spx.CATALOGS, "kind must be catwise or gaia"
    body = json.dumps(_spx.catalog(kind, ra, dec, float(q.get("r", 5))), separators=(",", ":")).encode()
    return {"Content-Type": "application/json", "Cache-Control": "public, s-maxage=604800"}, body


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        _spx.respond(self, run)
