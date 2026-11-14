"""GET /api/frames?ra=&dec=&size=&keys=a,b,...  ->  aligned cutouts for up to 16 exposures (binary)  (NASA Space Apps 2026; written with AI assistance, see README "AI use")."""
import json, os, sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
import _spx


def run(q):
    ra, dec = _spx.coords(q)
    size = int(q.get("size", 64))
    keys = [k for k in q["keys"].split(",") if k]
    assert 24 <= size <= 160, "size must be 24-160"
    assert 1 <= len(keys) <= 16, "1 to 16 keys per call"
    assert all(_spx.KEY_RE.match(k) and ".." not in k for k in keys), "keys must be SPHEREx level-2 file paths"
    body = _spx.frames(ra, dec, size, keys)
    # a released file never changes, so the result can be cached for good
    return {"Content-Type": "application/octet-stream", "Cache-Control": "public, s-maxage=31536000, immutable"}, body


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        _spx.respond(self, run)
