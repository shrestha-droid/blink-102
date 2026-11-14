"""Blink 102: shared SPHEREx reading code.

Written during NASA Space Apps 2026 with AI assistance (Claude); see README "AI use".

Reads only the bytes it needs from SPHEREx spectral images on NASA/IRSA's public
AWS bucket, and puts every exposure on one north-up grid so frames can be blinked.
"""
import csv, io, json, math, re, struct, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from astropy.io import fits
from astropy.io.fits.hdu.compressed._codecs import Rice1
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates

S3 = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
SIA = "https://irsa.ipac.caltech.edu/SIA"
TAP = "https://irsa.ipac.caltech.edu/TAP/sync"
COLLECTIONS = ["spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep"]
KEY_RE = re.compile(r"^(dr1|qr3)/level2/[A-Za-z0-9_./-]+\.fits$")
PIX = 6.15            # arcsec per pixel, native and output
NPIX = 2040           # detector width and height
ROW = NPIX * 4        # bytes per IMAGE row

# FLAGS bits (SPHEREx Explanatory Supplement v2.0, Table 16) folded into 8 categories.
CATS = [
    ("cosmic ray", [0]),
    ("near saturation", [1]),
    ("bad pixel", [2, 6, 9, 10, 11, 14, 15]),
    ("persistence", [17]),
    ("artifact", [25, 26, 27, 28, 29]),
    ("ghost", [7, 20, 22, 23, 24]),
    ("outlier", [19]),
    ("known source", [21]),
]
CAT_MASKS = [sum(1 << b for b in bits) for _, bits in CATS]
MASK = 0b00011100     # categories left out of stacks and photometry (official photometry mask)
SOURCE = 0b10000000


# ---------- network ----------

def http_get(url, headers=None, timeout=60, tries=3, want=None):
    """GET with retries. `want` asserts the status (206 for ranges: a 200 means the whole file)."""
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=timeout) as r:
                if want and r.status != want:
                    raise IOError(f"expected HTTP {want}, got {r.status}")
                return r.read()
        except Exception as e:  # network hiccups are common; the caller decides what a final failure means
            last = e
            time.sleep(0.4 * (i + 1))
    raise last


def s3_range(key, spec):
    """One contiguous byte range of a file in the SPHEREx bucket. S3 has no multi-range."""
    assert KEY_RE.match(key) and ".." not in key, "bad key"
    return http_get(S3 + key, {"Range": "bytes=" + spec}, want=206)


# ---------- FITS pieces ----------

def parse_header(raw, start=0):
    """(Header, padded length in bytes) of the FITS header starting at raw[start]."""
    n = start
    while raw[n:n + 8] != b"END     ":
        n += 80
        if n + 80 > len(raw):
            raise ValueError("header truncated")
    return fits.Header.fromstring(raw[start:n + 80].decode("ascii", "replace")), (n + 80 - start + 2879) // 2880 * 2880


def wave_table(tail):
    """Parse the WCS-WAVE lookup table from the end of the file.

    Returns (X, Y, V): 1-based control pixels and V[iy, ix, 0|1] = wavelength | bandwidth (um).
    """
    at = tail.rfind(b"XTENSION= 'BINTABLE'")
    hdr, hlen = parse_header(tail, at)
    nx, ny = int(hdr["TFORM1"][:-1]), int(hdr["TFORM2"][:-1])
    d = tail[at + hlen:]
    X = np.frombuffer(d, ">i4", nx, 0).astype(float)
    Y = np.frombuffer(d, ">i4", ny, nx * 4).astype(float)
    V = np.frombuffer(d, ">f4", 2 * nx * ny, (nx + ny) * 4).reshape(ny, nx, 2).astype(float)
    return X, Y, V


def wave_at(tab, x, y):
    """Bilinear wavelength and bandwidth (um) at 0-based detector pixels x, y (arrays)."""
    X, Y, V = tab
    fx = np.interp(np.asarray(x) + 1, X, np.arange(len(X)))
    fy = np.interp(np.asarray(y) + 1, Y, np.arange(len(Y)))
    return [map_coordinates(V[..., k], [fy, fx], order=1, mode="nearest") for k in (0, 1)]


def grid_sky(ra, dec, size):
    """RA, Dec (deg) of every pixel of the output grid: gnomonic, north up, east at column 0."""
    c = (size - 1) / 2
    p = math.radians(PIX / 3600)
    row, col = np.mgrid[0:size, 0:size]
    xi, eta = (c - col) * p, (row - c) * p
    d0 = math.radians(dec)
    den = math.cos(d0) - eta * math.sin(d0)
    a = ra + np.degrees(np.arctan2(xi, den))
    d = np.degrees(np.arctan2(math.sin(d0) + eta * math.cos(d0), np.hypot(xi, den)))
    return a % 360, d


def fit_background(img, cat):
    """Robust plane (or constant) through sky pixels. Returns (plane, centre value, noise)."""
    size = img.shape[0]
    ok = np.isfinite(img) & (cat & MASK == 0)
    sky = ok & (cat & SOURCE == 0)
    if sky.sum() < 50:
        sky = ok
    if sky.sum() < 10:
        return np.zeros_like(img), 0.0, float("nan")
    row, col = np.mgrid[0:size, 0:size]
    c = (size - 1) / 2
    use_plane = sky.sum() >= 200     # too few pixels: a slope would be noise, so fit a constant
    coef = np.array([np.median(img[sky]), 0.0, 0.0])
    for _ in range(4):
        res = img - (coef[0] + coef[1] * (col - c) + coef[2] * (row - c))
        r = res[sky]
        sig = 1.4826 * np.median(np.abs(r - np.median(r))) or 1e-9
        keep = sky & (np.abs(res - np.median(r)) < 3 * sig)
        if keep.sum() < 10:
            break
        if use_plane:
            A = np.stack([np.ones(keep.sum()), (col - c)[keep], (row - c)[keep]], 1)
            coef = np.linalg.lstsq(A, img[keep], rcond=None)[0]
        else:
            coef = np.array([np.median(img[keep]), 0.0, 0.0])
    plane = coef[0] + coef[1] * (col - c) + coef[2] * (row - c)
    r = (img - plane)[sky]
    return plane, float(coef[0]), float(1.4826 * np.median(np.abs(r - np.median(r))))


# ---------- one exposure ----------

FLAGS_GUESS = 2880 + 23040 + NPIX * ROW     # where FLAGS starts if the IMAGE header has its usual size


def fetch_meta(key):
    """Stage 1 (network): image header, FLAGS header + row table, wavelength table."""
    with ThreadPoolExecutor(3) as ex:
        a = ex.submit(s3_range, key, "0-28799")
        b = ex.submit(s3_range, key, f"{FLAGS_GUESS}-{FLAGS_GUESS + 17280 + NPIX * 8 - 1}")
        c = ex.submit(s3_range, key, "-8640")
        return a.result(), b.result(), c.result()


def plan(key, meta, sky):
    """Stage 2 (CPU): where the target is on this detector and which rows to read."""
    a, b, tail = meta
    _, plen = parse_header(a, 0)
    try:
        hdr, hlen = parse_header(a, plen)
    except ValueError:          # unusually long header: read more
        a = s3_range(key, "0-86399")
        hdr, hlen = parse_header(a, plen)
    data0 = plen + hlen
    foff = data0 + NPIX * ROW
    if foff != FLAGS_GUESS or not b.startswith(b"XTENSION= 'BINTABLE'"):
        b = s3_range(key, f"{foff}-{foff + 40319}")
    fh, fhlen = parse_header(b, 0)
    assert fh.get("EXTNAME", "").strip() == "FLAGS" and fh["ZCMPTYPE"].strip() == "RICE_1" and fh["ZTILE1"] == NPIX
    desc = np.frombuffer(b, ">i4", NPIX * 2, fhlen).reshape(NPIX, 2)
    heap0 = foff + fhlen + NPIX * 8

    w = WCS(hdr)
    xs, ys = w.all_world2pix(sky[0], sky[1], 0, quiet=True)
    inside = np.isfinite(xs) & np.isfinite(ys) & (xs > -0.5) & (xs < NPIX - 0.5) & (ys > -0.5) & (ys < NPIX - 0.5)
    c = sky[0].shape[0] // 2
    if inside.mean() < 0.05 or not inside[c, c]:
        return {"key": key, "ok": False, "why": "target is off this image"}
    y0, y1 = max(0, int(ys[inside].min()) - 1), min(NPIX - 1, int(ys[inside].max()) + 2)
    x0, x1 = max(0, int(xs[inside].min()) - 1), min(NPIX - 1, int(xs[inside].max()) + 2)
    return {"key": key, "ok": True, "hdr": hdr, "xs": xs, "ys": ys, "box": (x0, x1, y0, y1),
            "img_range": f"{data0 + y0 * ROW}-{data0 + (y1 + 1) * ROW - 1}",
            "flag_range": f"{heap0 + desc[y0, 1]}-{heap0 + desc[y1, 1] + desc[y1, 0] - 1}",
            "desc": desc, "tab": wave_table(tail)}


def fetch_pixels(p):
    """Stage 3 (network): the rows of IMAGE and of the compressed FLAGS heap."""
    with ThreadPoolExecutor(2) as ex:
        i = ex.submit(s3_range, p["key"], p["img_range"])
        f = ex.submit(s3_range, p["key"], p["flag_range"])
        return i.result(), f.result()


RICE = Rice1(blocksize=32, bytepix=4, tilesize=NPIX)


def build(p, pix, size):
    """Stage 4 (CPU): decode, resample onto the common grid, subtract sky. Returns (meta, image, cats)."""
    x0, x1, y0, y1 = p["box"]
    img = np.frombuffer(pix[0], ">f4").reshape(y1 - y0 + 1, NPIX)[:, x0:x1 + 1].astype(np.float32)
    desc, blob = p["desc"], np.frombuffer(pix[1], np.uint8)
    fl = np.empty((y1 - y0 + 1, x1 - x0 + 1), np.int64)
    for r in range(y0, y1 + 1):
        o = desc[r, 1] - desc[y0, 1]
        fl[r - y0] = np.asarray(RICE.decode(blob[o:o + desc[r, 0]]))[:NPIX][x0:x1 + 1]

    coords = [p["ys"] - y0, p["xs"] - x0]
    out = map_coordinates(img, coords, order=1, cval=np.nan).astype(np.float32)
    cat = np.zeros((size, size), np.uint8)
    for i, m in enumerate(CAT_MASKS):       # a pixel is flagged if any input pixel that fed it was
        plane = ((fl & m) != 0).astype(np.float32)
        cat |= ((map_coordinates(plane, coords, order=1, cval=0.0) > 0.01).astype(np.uint8) << i)

    bgplane, bg, noise = fit_background(out, cat)
    out = (out - bgplane).astype("<f4")

    c = (size - 1) / 2
    wave, band = wave_at(p["tab"], np.clip(p["xs"], 0, NPIX - 1), np.clip(p["ys"], 0, NPIX - 1))
    row, col = np.mgrid[0:size, 0:size]
    A = np.stack([np.ones(size * size), (col - c).ravel(), (row - c).ravel()], 1)
    w0, gx, gy = np.linalg.lstsq(A, wave.ravel(), rcond=None)[0]
    ci = size // 2
    h = p["hdr"]
    meta = {"key": p["key"], "ok": True, "det": int(h["DETECTOR"]), "mjd": round(float(h["MJD-AVG"]), 6),
            "wave": round(float(w0), 5), "dwave_dx": round(float(gx), 7), "dwave_dy": round(float(gy), 7),
            "band": round(float(band[ci, ci]), 5), "bg": round(bg, 5), "noise": round(noise, 6),
            "fwhm": round(float(h.get("PSF_FWHM", 0)), 2), "finast": int(h.get("FINAST", 0)),
            "x": round(float(p["xs"][ci, ci]), 2), "y": round(float(p["ys"][ci, ci]), 2)}
    return meta, out, cat


def frames(ra, dec, size, keys):
    """Aligned cutouts for up to 16 exposures, packed as: uint32 header length, JSON, then pixels."""
    sky = grid_sky(ra, dec, size)
    with ThreadPoolExecutor(16) as ex:
        metas = list(ex.map(lambda k: _try(fetch_meta, k), keys))
    plans = []
    for k, m in zip(keys, metas):
        plans.append(_try(plan, k, m, sky) if not isinstance(m, Exception) else m)
    with ThreadPoolExecutor(16) as ex:
        pixels = list(ex.map(lambda p: _try(fetch_pixels, p) if isinstance(p, dict) and p["ok"] else None, plans))
    head, blobs = [], []
    for k, p, px in zip(keys, plans, pixels):
        if isinstance(p, Exception) or isinstance(px, Exception):
            head.append({"key": k, "ok": False, "why": str(p if isinstance(p, Exception) else px)[:120]})
        elif not p["ok"]:
            head.append(p)
        else:
            r = _try(build, p, px, size)
            if isinstance(r, Exception):
                head.append({"key": k, "ok": False, "why": str(r)[:120]})
            else:
                head.append(r[0]); blobs += [r[1].tobytes(), r[2].tobytes()]
    j = json.dumps({"size": size, "scale_arcsec": PIX, "exposures": head}).encode()
    return struct.pack("<I", len(j)) + j + b"".join(blobs)


def _try(f, *a):
    try:
        return f(*a)
    except Exception as e:
        return e


# ---------- search ----------

def sia(collection, ra, dec):
    q = urllib.parse.urlencode({"COLLECTION": collection, "POS": f"circle {ra} {dec} 0.0003", "RESPONSEFORMAT": "CSV"})
    text = http_get(f"{SIA}?{q}", timeout=120).decode("utf-8", "replace")
    # the cloud_access column holds unquoted JSON, so only columns before it are trustworthy
    return [r for r in csv.DictReader(io.StringIO(text)) if (r.get("access_url") or "").endswith(".fits")]


def month_label(mjd):
    t = time.gmtime((mjd - 40587) * 86400)
    return time.strftime("%b %Y", t)


def search(ra, dec):
    """Every released SPHEREx exposure covering a position, grouped into epochs."""
    with ThreadPoolExecutor(4) as ex:
        results = list(ex.map(lambda c: _try(sia, c, ra, dec), COLLECTIONS))
    if all(isinstance(r, Exception) for r in results):
        raise IOError(f"IRSA image search failed: {results[0]}")
    seen, exps = {}, []
    for rows in results:
        if isinstance(rows, Exception):
            continue
        for r in rows:
            key = r["access_url"].split("/ibe/data/spherex/")[-1]
            det = int(r["energy_bandpassname"][-1])
            ident = (r["obs_id"], det)
            if not KEY_RE.match(key) or (ident in seen and not key.startswith("dr1")):
                continue
            seen[ident] = {"key": key, "det": det, "mjd": round((float(r["t_min"]) + float(r["t_max"])) / 2, 5)}
    exps = sorted(seen.values(), key=lambda e: e["mjd"])
    epochs = split_epochs([e["mjd"] for e in exps])
    for e in exps:
        e["epoch"] = next(i for i, (a, b) in enumerate(epochs) if a <= e["mjd"] <= b)
    out = []
    for i, (a, b) in enumerate(epochs):
        n = sum(1 for e in exps if e["epoch"] == i)
        out.append({"i": i, "label": month_label((a + b) / 2), "mjd0": a, "mjd1": b, "n": n, "earth": earth_xyz((a + b) / 2)})
    return {"ra": ra, "dec": dec, "n": len(exps), "epochs": out, "exposures": exps}


def split_epochs(mjds, gap=30, longest=60, piece=30):
    """New epoch after a gap of `gap` days (a sky pass lasts up to ~7 weeks); long runs are cut into equal pieces of about `piece` days."""
    if not mjds:
        return []
    runs, start, prev = [], mjds[0], mjds[0]
    for m in mjds[1:]:
        if m - prev > gap:
            runs.append((start, prev)); start = m
        prev = m
    runs.append((start, prev))
    out = []
    for a, b in runs:
        n = math.ceil((b - a) / piece) if b - a > longest else 1
        edges = [a + (b - a) * i / n for i in range(n + 1)]
        for i in range(n):
            lo = edges[i] if i == 0 else min(m for m in mjds if m > edges[i])
            hi = max(m for m in mjds if m <= edges[i + 1])
            if hi >= lo:
                out.append((lo, hi))
    return out


def earth_xyz(mjd):
    """Earth's barycentric position (AU, ICRS), for parallax in predicted positions."""
    from astropy.coordinates import get_body_barycentric
    from astropy.time import Time
    p = get_body_barycentric("earth", Time(mjd, format="mjd"), ephemeris="builtin")
    return [round(float(v), 5) for v in (p.x.value, p.y.value, p.z.value)]


# ---------- catalogues through IRSA TAP (no CORS there, so we proxy) ----------

CATALOGS = {
    "catwise": ("catwise_2020", "source_name AS name, ra, dec, pmra*1000 AS pmra, pmdec*1000 AS pmdec, sigpmra*1000 AS epmra, sigpmdec*1000 AS epmdec, w1mpro_pm AS m1, w2mpro_pm AS m2, meanobsmjd AS epoch"),
    "gaia": ("gaia_dr3_source", "designation AS name, ra, dec, pmra, pmdec, parallax AS plx, phot_g_mean_mag AS m1, phot_rp_mean_mag AS m2"),
}


def catalog(kind, ra, dec, r_arcmin):
    table, cols = CATALOGS[kind]
    q = (f"SELECT {cols} FROM {table} WHERE 1=CONTAINS(POINT('ICRS',ra,dec),"
         f"CIRCLE('ICRS',{ra:.6f},{dec:.6f},{min(r_arcmin, 12) / 60:.5f}))")
    text = http_get(f"{TAP}?{urllib.parse.urlencode({'QUERY': q, 'FORMAT': 'csv'})}", timeout=90).decode()
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        rows.append({k: (v if k == "name" else (float(v) if v not in ("", "null") else None)) for k, v in r.items()})
    return rows


# ---------- HTTP glue shared by the three endpoints ----------

def respond(handler, fn):
    """Run fn(query dict) -> (headers, bytes) and write an HTTP response; errors become clean JSON."""
    q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query).items()}
    try:
        status, (headers, body) = 200, fn(q)
    except (KeyError, ValueError, AssertionError) as e:
        status, headers, body = 400, {"Content-Type": "application/json"}, json.dumps({"error": f"bad request: {e}"}).encode()
    except Exception as e:
        status, headers, body = 502, {"Content-Type": "application/json"}, json.dumps({"error": str(e)[:300]}).encode()
    handler.send_response(status)
    for k, v in {"Access-Control-Allow-Origin": "*", "Content-Length": str(len(body)), **headers}.items():
        handler.send_header(k, v)
    handler.end_headers()
    handler.wfile.write(body)


def coords(q):
    ra, dec = float(q["ra"]), float(q["dec"])
    assert 0 <= ra < 360 and -90 <= dec <= 90, "ra must be 0-360 and dec -90 to 90"
    return ra, dec
