"""Self-checks against live data. usage: python scripts/check.py [search|frames|all]

(NASA Space Apps 2026; written with AI assistance.)
"""
import json, os, struct, sys, time
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
import _spx

BARNARD = (269.44630, 4.76788)    # Barnard's Star at MJD 61000: J2000 position + 25.888 yr of proper motion


def unpack(body):
    n = struct.unpack("<I", body[:4])[0]
    head = json.loads(body[4:4 + n]); size = head["size"]; off = 4 + n; out = []
    for e in head["exposures"]:
        if e["ok"]:
            img = np.frombuffer(body, "<f4", size * size, off).reshape(size, size); off += size * size * 4
            cat = np.frombuffer(body, np.uint8, size * size, off).reshape(size, size); off += size * size
            out.append((e, img, cat))
    assert off == len(body), "payload length mismatch"
    return head, out


def check_search():
    assert _spx.split_epochs([0, 1, 25, 100, 101]) == [(0, 25), (100, 101)]
    assert len(_spx.split_epochs(list(range(0, 100, 2)))) == 4          # a 98-day run is cut into 4 pieces
    t = time.time(); s = _spx.search(*BARNARD)
    print(f"search: {s['n']} exposures, {len(s['epochs'])} epochs, {time.time() - t:.1f}s", [(e['label'], e['n']) for e in s["epochs"]])
    assert s["n"] >= 340 and len(s["epochs"]) == 3
    return s


def check_frames(s):
    keys = [e["key"] for e in s["exposures"] if e["det"] == 6][:3] + [e["key"] for e in s["exposures"] if e["det"] == 3][:1]
    t = time.time(); head, exps = unpack(_spx.frames(*BARNARD, 64, keys))
    print(f"frames: {len(exps)}/{len(keys)} ok, {time.time() - t:.1f}s")
    for e, img, cat in exps:
        r, c = np.unravel_index(np.nanargmax(img), img.shape)
        sky = np.isfinite(img) & (cat & _spx.MASK == 0) & (cat & _spx.SOURCE == 0)
        print(f"  D{e['det']} mjd {e['mjd']:.2f} wave {e['wave']:.3f} um  peak at row {r} col {c} = {img[r, c]:.1f} MJy/sr  "
              f"noise {e['noise']:.4f}  sky median {np.median(img[sky]):+.4f}  source-flagged {np.mean(cat & 128 > 0):.2f}  "
              f"near-sat at peak {bool(cat[r, c] & 2)}")
        lo, hi = {3: (1.6, 2.45), 6: (4.4, 5.01)}[e["det"]]
        assert lo < e["wave"] < hi, "wavelength outside the detector's band"
        assert abs(np.median(img[sky])) < 3 * e["noise"], "sky not subtracted"
        assert 0.5 < np.mean(cat & 128 > 0) <= 1.0
        # Barnard's Star moves 10.4"/yr north = 1.7 px/yr; it must sit within ~2 px of the grid centre
        assert abs(r - 31.5) < 3.5 and abs(c - 31.5) < 3.5, "star is not where its proper motion puts it"
    assert len(exps) == len(keys)


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    s = check_search()
    if what != "search":
        check_frames(s)
    print("all checks passed")
