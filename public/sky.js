// Blink 102: sky maths. No DOM in this file, so the same code runs in the browser and in Node.
// Written during NASA Space Apps 2026 with AI assistance (Claude); see README "AI use".

export const PIX = 6.15;            // arcsec per pixel
export const UJY = 889.0;           // 1 MJy/sr over one 6.15" pixel, in microjansky
export const MASK = 0b00011100;     // bad pixel | persistence | artifact: left out of stacks and photometry
export const CAUTION = 0b00100011;  // cosmic ray | near saturation | ghost
export const NEAR_SAT = 0b10, OUTLIER = 0b1000000, SOURCE = 0b10000000;
export const J2000 = 51544.5, GAIA_EPOCH = 57388.5, REF_MJD = 61000;
export const WMIN = 0.744, WMAX = 5.002;
export const DET = [[0.744, 1.116], [1.099, 1.651], [1.636, 2.421], [2.423, 3.822], [3.809, 4.420], [4.412, 5.002]];
export const CAT_NAMES = ['cosmic ray', 'near saturation', 'bad pixel', 'persistence', 'artifact (bloom, snowball, streak)',
  'ghost or crosstalk', 'outlier: something changed here', 'known source'];
const RAD = Math.PI / 180;

// ---- positions ----

/** Move a catalogue position {ra, dec, pmra, pmde (mas/yr, pmra includes cos dec), epoch (MJD), plx (mas)} to a date. */
export function propagate(o, mjd, earth) {
  const dt = (mjd - (o.epoch ?? J2000)) / 365.25;
  let dec = o.dec + (o.pmde || 0) * dt / 3.6e6;
  let ra = o.ra + (o.pmra || 0) * dt / 3.6e6 / Math.cos(o.dec * RAD);
  if (earth && o.plx > 0) {       // annual parallax, from Earth's barycentric position in AU
    const [X, Y, Z] = earth, a = ra * RAD, d = dec * RAD;
    ra += o.plx * (X * Math.sin(a) - Y * Math.cos(a)) / Math.cos(d) / 3.6e6;
    dec += o.plx * (X * Math.cos(a) * Math.sin(d) + Y * Math.sin(a) * Math.sin(d) - Z * Math.cos(d)) / 3.6e6;
  }
  return [ra, dec];
}

/** Earth's position (AU, equatorial) from the Astronomical Almanac's low-precision Sun: good to 0.01 AU. */
export function earth(mjd) {
  const n = mjd - 51544.5, g = (357.528 + 0.9856003 * n) * RAD;
  const lam = (280.460 + 0.9856474 * n) * RAD + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const R = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g), eps = (23.439 - 0.0000004 * n) * RAD;
  return [-R * Math.cos(lam), -R * Math.cos(eps) * Math.sin(lam), -R * Math.sin(eps) * Math.sin(lam)];
}

/** Parallax shift [east, north] in arcsec of a star with parallax `plx` (mas) on a date. */
export function parallax(ra, dec, plx, mjd) {
  const [X, Y, Z] = earth(mjd), a = ra * RAD, d = dec * RAD, p = plx / 1000;
  return [p * (X * Math.sin(a) - Y * Math.cos(a)), p * (X * Math.cos(a) * Math.sin(d) + Y * Math.sin(a) * Math.sin(d) - Z * Math.cos(d))];
}

/** Where a catalogue object appears on a date: proper motion plus parallax. */
export const apparent = (o, mjd) => propagate(o, mjd, earth(mjd));

/** Sky -> grid [col, row]. Gnomonic, north up, east at column 0, row 0 at the south edge. */
export function toGrid(ra, dec, c) {
  const da = (ra - c.ra) * RAD, d = dec * RAD, d0 = c.dec * RAD;
  const D = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  const xi = Math.cos(d) * Math.sin(da) / D;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / D;
  const k = 3600 / RAD / PIX, m = (c.size - 1) / 2;
  return [m - xi * k, m + eta * k];
}

export function fromGrid(col, row, c) {
  const m = (c.size - 1) / 2, p = PIX / 3600 * RAD, d0 = c.dec * RAD;
  const xi = (m - col) * p, eta = (row - m) * p, den = Math.cos(d0) - eta * Math.sin(d0);
  return [(c.ra + Math.atan2(xi, den) / RAD + 360) % 360,
    Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den)) / RAD];
}

/** Accepts "269.45 4.69", "17 57 48.5 +04 41 36", "17h57m48.5s +04d41m36s". Returns {ra, dec} in degrees, or null. */
export function parseCoords(text) {
  const tok = text.replace(/−/g, '-').replace(/[hdms°′″'":,]/gi, ' ').trim().split(/\s+/);
  const n = tok.map(Number);
  if (n.some(isNaN)) return null;
  const sign = i => (tok[i].startsWith('-') ? -1 : 1);
  let ra, dec;
  if (n.length === 2) [ra, dec] = n;
  else if (n.length === 6) { ra = (n[0] + n[1] / 60 + n[2] / 3600) * 15; dec = sign(3) * (Math.abs(n[3]) + n[4] / 60 + n[5] / 3600); }
  else if (n.length === 4) { ra = (n[0] + n[1] / 60) * 15; dec = sign(2) * (Math.abs(n[2]) + n[3] / 60); }
  else return null;
  return ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 ? { ra, dec } : null;
}

export function sexa(ra, dec) {
  const f = (v, n) => { const a = Math.abs(v), h = Math.floor(a), m = Math.floor((a - h) * 60), s = ((a - h) * 60 - m) * 60;
    return `${String(h).padStart(2, '0')} ${String(m).padStart(2, '0')} ${s.toFixed(n).padStart(n + 3, '0')}`; };
  return `${f(ra / 15, 2)}  ${dec < 0 ? '−' : '+'}${f(dec, 1)}`;
}

export const mjdDate = mjd => new Date((mjd - 40587) * 86400000);
export const abMag = ujy => 23.9 - 2.5 * Math.log10(ujy);

// ---- data ----

/** Unpack an /api/frames response: uint32 header length, JSON, then float32 image + uint8 flags per exposure. */
export function parseFrames(buf) {
  const n = new DataView(buf).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  const px = head.size * head.size;
  let off = 4 + n;
  const out = [];
  for (const e of head.exposures) {
    if (!e.ok) { out.push(e); continue; }
    e.img = new Float32Array(buf.slice(off, off + px * 4)); off += px * 4;
    e.cat = new Uint8Array(buf.slice(off, off + px)); off += px;
    out.push(e);
  }
  return out;
}

/** Quick look: at most `cap` exposures per (epoch, detector), spread evenly in time. Returns lists of <=16 keys. */
export function planChunks(exposures, cap = 8, skip = new Set()) {
  const groups = new Map();
  for (const e of exposures) {
    const k = e.det * 1000 + e.epoch;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const picked = [];
  for (const k of [...groups.keys()].sort((a, b) => a - b)) {
    const g = groups.get(k), n = Math.min(cap, g.length);
    for (let i = 0; i < n; i++) picked.push(g[Math.floor((i + 0.5) * g.length / n)]);
  }
  const keys = [...new Set(picked.map(e => e.key))].filter(k => !skip.has(k));
  const chunks = [];
  for (let i = 0; i < keys.length; i += 16) chunks.push(keys.slice(i, i + 16));
  return chunks;
}

/**
 * Stack exposures into one frame. Per pixel: drop masked values, then average what lies within 3 sigma of the
 * median (sigma from the interquartile range, so a star's real change with wavelength is not clipped away).
 * Also returns, per pixel, the share of exposures carrying each flag severity (0-255).
 */
export function stack(exps, size) {
  const px = size * size, N = exps.length;
  const img = new Float32Array(px).fill(NaN), n = new Uint16Array(px);
  const left = new Uint8Array(px), caution = new Uint8Array(px), changed = new Uint8Array(px);
  const v = new Float32Array(N);
  for (let p = 0; p < px; p++) {
    let k = 0, nl = 0, nc = 0, nch = 0, seen = 0, all = 0;
    for (let i = 0; i < N; i++) {
      const c = exps[i].cat[p], x = exps[i].img[p];
      if (x !== x) continue;
      seen++; all += x;
      if (c & CAUTION) nc++;
      if (c & OUTLIER) nch++;
      if (c & MASK) { nl++; continue; }
      v[k++] = x;
    }
    if (seen) { left[p] = 255 * nl / seen; caution[p] = 255 * nc / seen; changed[p] = 255 * nch / seen; }
    n[p] = k;
    // every exposure masked here (a saturated core, say): show the flagged values so the picture has no hole;
    // n = 0 and the flags overlay still say these pixels were not trusted
    if (!k) { if (seen) img[p] = all / seen; continue; }
    if (k < 4) { let s = 0; for (let i = 0; i < k; i++) s += v[i]; img[p] = s / k; continue; }
    const s = v.subarray(0, k).sort();
    const med = (s[(k - 1) >> 1] + s[k >> 1]) / 2;
    const sig = Math.max((s[Math.floor(0.75 * (k - 1))] - s[Math.floor(0.25 * (k - 1))]) / 1.349, 1e-6);
    let sum = 0, m = 0;
    for (let i = 0; i < k; i++) if (Math.abs(s[i] - med) <= 3 * sig) { sum += s[i]; m++; }
    img[p] = m ? sum / m : med;
  }
  return { img, n, left, caution, changed };
}

export function median(a) {
  const s = Float64Array.from(a).filter(x => x === x).sort();
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN;
}

/** Robust centre and scatter of an image: median and 1.4826 x MAD. */
export function robust(a) {
  const med = median(a);
  return [med, 1.4826 * median(Array.from(a, x => Math.abs(x - med)))];
}

export function percentile(a, q) {
  const s = Float64Array.from(a).filter(x => x === x).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
}

// ---- measuring a source ----

/** Median of unmasked pixels in a ring, the local sky. */
export function ringSky(e, size, col, row, rin, rout) {
  const v = [], c0 = Math.round(col), r0 = Math.round(row), R = Math.ceil(rout);
  for (let r = r0 - R; r <= r0 + R; r++) for (let c = c0 - R; c <= c0 + R; c++) {
    if (r < 0 || c < 0 || r >= size || c >= size) continue;
    const d = Math.hypot(c - col, r - row), p = r * size + c;
    if (d >= rin && d <= rout && !(e.cat[p] & MASK) && e.img[p] === e.img[p]) v.push(e.img[p]);
  }
  return v.length >= 8 ? median(v) : 0;
}

/**
 * Aperture photometry of one exposure at a grid position.
 * Flux in microjansky; error = sky noise in the aperture plus 3 % of the flux (the SPHEREx handbook's systematic).
 */
export function aperture(e, size, col, row, r = 2.5, rin = 5, rout = 8) {
  const sky = ringSky(e, size, col, row, rin, rout);
  let sum = 0, area = 0, flagged = false, sat = false, missing = false, hole = false;
  const R = Math.ceil(r + 1), c0 = Math.round(col), r0 = Math.round(row), S = 5;
  for (let rr = r0 - R; rr <= r0 + R; rr++) for (let cc = c0 - R; cc <= c0 + R; cc++) {
    let w = 0;       // share of this pixel inside the circle, from 5 x 5 sub-samples
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++)
      if (Math.hypot(cc + (i + 0.5) / S - 0.5 - col, rr + (j + 0.5) / S - 0.5 - row) <= r) w++;
    if (!w) continue;
    w /= S * S;
    if (rr < 0 || cc < 0 || rr >= size || cc >= size) { missing = true; continue; }
    const p = rr * size + cc, x = e.img[p];
    if (x !== x) { hole = true; continue; }       // blank pixel: a saturated core, or the detector's edge
    if (e.cat[p] & MASK && w > 0.2) flagged = true;
    if (e.cat[p] & NEAR_SAT) sat = true;
    sum += w * (x - sky); area += w;
  }
  const flux = sum * UJY, stat = Math.sqrt(area) * e.noise * UJY;
  return { flux, err: Math.hypot(stat, 0.03 * flux), snr: flux / stat, sky, flagged: flagged || hole, sat, hole, ok: !missing && area > 0 };
}

/**
 * Aperture correction per detector, measured on this field's own stars: how much more light a 6-pixel aperture
 * collects than the 2.5-pixel one. `stars` are [col, row] of bright, isolated, unsaturated stars.
 * Returns {det: {f, n}} for detectors with at least 8 clean measurements.
 */
export function apertureCorrection(exps, size, stars) {
  const ratios = {};
  for (const [c, r] of stars) for (const e of exps) {
    const a = aperture(e, size, c, r, 2.5, 8, 11), b = aperture(e, size, c, r, 6, 8, 11);
    if (!a.ok || !b.ok || a.flagged || b.flagged || a.sat || b.sat || a.snr < 40) continue;
    const q = b.flux / a.flux;
    if (q > 0.9 && q < 2) (ratios[e.det] ||= []).push(q);
  }
  const out = {};
  for (const d in ratios) if (ratios[d].length >= 8) out[d] = { f: median(ratios[d]), n: ratios[d].length };
  return out;
}

/** Bright stars with no neighbour above 3 % of their brightness within `clear` pixels, away from the edges. */
export function isolatedStars(img, size, thresh, faint, clear = 11, edge = 12) {
  const all = findPeaks(img, size, faint, 2, 2);
  return findPeaks(img, size, thresh, 3, edge).filter(p => all.every(q => q === p || (q[0] === p[0] && q[1] === p[1]) ||
    Math.hypot(q[0] - p[0], q[1] - p[1]) > clear || q[2] < 0.03 * p[2]));
}

/** Brightness from the unsaturated outer light of a star (ring 4-8 px), for stars too bright for their core. */
export function wingFlux(e, size, col, row, rin = 4, rout = 8) {
  const sky = ringSky(e, size, col, row, 11, 14);
  let sum = 0, n = 0, total = 0;
  const c0 = Math.round(col), r0 = Math.round(row), R = Math.ceil(rout);
  for (let r = r0 - R; r <= r0 + R; r++) for (let c = c0 - R; c <= c0 + R; c++) {
    const d = Math.hypot(c - col, r - row);
    if (d < rin || d > rout) continue;
    total++;
    if (r < 0 || c < 0 || r >= size || c >= size) continue;
    const p = r * size + c;
    if (e.img[p] !== e.img[p] || e.cat[p] & (MASK | NEAR_SAT)) continue;
    sum += e.img[p] - sky; n++;
  }
  return n >= 0.5 * total ? { flux: sum / n * total * UJY, ok: true } : { flux: NaN, ok: false };
}

/** Flux-weighted centre of light near a position, iterated. Returns [col, row, signal-to-noise] or null. */
export function centroid(e, size, col, row, r = 2.5, sky = null) {
  if (sky === null) sky = ringSky(e, size, col, row, 5, 8);
  let cx = col, cy = row, sum = 0, n = 0;
  for (let it = 0; it < 4; it++) {
    let sx = 0, sy = 0; sum = 0; n = 0;
    const c0 = Math.round(cx), r0 = Math.round(cy), R = Math.ceil(r);
    for (let rr = r0 - R; rr <= r0 + R; rr++) for (let cc = c0 - R; cc <= c0 + R; cc++) {
      if (rr < 0 || cc < 0 || rr >= size || cc >= size || Math.hypot(cc - cx, rr - cy) > r) continue;
      const p = rr * size + cc, x = e.img[p] - sky;
      if (x !== x || e.cat[p] & MASK || x <= 0) continue;
      sx += x * cc; sy += x * rr; sum += x; n++;
    }
    if (!(sum > 0) || n < 4) return null;
    cx = sx / sum; cy = sy / sum;
    if (Math.hypot(cx - col, cy - row) > r + 1) return null;      // wandered off to a neighbour
  }
  return [cx, cy, sum / (Math.sqrt(n) * (e.noise || 1))];
}

/**
 * Centre of a star whose core is saturated, from its unsaturated outer light: the flux-weighted centre of a ring,
 * re-centred until it stops moving. Returns [col, row, signal-to-noise] or null.
 */
export function wingCentroid(e, size, col, row, rin = 4, rout = 9) {
  const sky = ringSky(e, size, col, row, 11, 14);
  let cx = col, cy = row, sum = 0, n = 0;
  for (let it = 0; it < 20; it++) {
    let sx = 0, sy = 0, total = 0; sum = 0; n = 0;
    const c0 = Math.round(cx), r0 = Math.round(cy), R = Math.ceil(rout);
    for (let rr = r0 - R; rr <= r0 + R; rr++) for (let cc = c0 - R; cc <= c0 + R; cc++) {
      const d = Math.hypot(cc - cx, rr - cy);
      if (d < rin || d > rout) continue;
      total++;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const p = rr * size + cc, x = e.img[p] - sky;
      if (x !== x || e.cat[p] & (MASK | NEAR_SAT) || x <= 0) continue;
      sx += x * (cc - cx); sy += x * (rr - cy); sum += x; n++;
    }
    if (!(sum > 0) || n < 0.4 * total) return null;
    const dx = 0.5 * sx / sum, dy = 0.5 * sy / sum;   // a hard-edged ring over-reports an offset, so take half steps
    cx += dx; cy += dy;
    if (Math.hypot(cx - col, cy - row) > 4) return null;
    if (Math.hypot(dx, dy) < 0.01) break;
  }
  return [cx, cy, sum / (Math.sqrt(n) * (e.noise || 1))];
}

/** Where a source is in one exposure: its core if usable, else its outer light. Returns [col, row, S/N, usedWings]. */
export function locate(e, size, col, row) {
  const a = centroid(e, size, col, row);
  if (a && a[2] > 10) return [...a, false];
  const w = wingCentroid(e, size, col, row);
  return w ? [...w, true] : a ? [...a, false] : null;
}

/** Straight-line fit y = a + b (t - t0) with 3-sigma clipping. Returns {a, b, eb (error on b), t0, rms, n}. */
export function lineFit(t, y) {
  let keep = t.map(() => true), a = 0, b = 0, eb = Infinity, rms = Infinity, t0 = 0, n = 0;
  for (let it = 0; it < 3; it++) {
    const T = t.filter((_, i) => keep[i]), Y = y.filter((_, i) => keep[i]);
    n = T.length;
    if (n < 3) return null;
    t0 = T.reduce((s, v) => s + v, 0) / n;
    const ym = Y.reduce((s, v) => s + v, 0) / n;
    let stt = 0, sty = 0;
    for (let i = 0; i < n; i++) { stt += (T[i] - t0) ** 2; sty += (T[i] - t0) * (Y[i] - ym); }
    if (!stt) return null;
    b = sty / stt; a = ym;
    const res = T.map((v, i) => Y[i] - a - b * (v - t0));
    rms = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / Math.max(1, n - 2));
    eb = rms / Math.sqrt(stt);
    const cut = 3 * 1.4826 * median(res.map(Math.abs));
    keep = t.map((v, i) => Math.abs(y[i] - a - b * (v - t0)) <= Math.max(cut, 1e-9));
  }
  return { a, b, eb, t0, rms, n };
}

/** Peaks in a stacked frame: local maxima above `thresh`, at least `sep` pixels apart, brightest first. */
export function findPeaks(img, size, thresh, sep = 3, edge = 4) {
  const peaks = [];
  for (let r = edge; r < size - edge; r++) for (let c = edge; c < size - edge; c++) {
    const x = img[r * size + c];
    if (!(x > thresh)) continue;
    let top = true;
    for (let dr = -1; dr <= 1 && top; dr++) for (let dc = -1; dc <= 1; dc++)
      if ((dr || dc) && img[(r + dr) * size + c + dc] > x) { top = false; break; }
    if (top) peaks.push([c, r, x]);
  }
  peaks.sort((a, b) => b[2] - a[2]);
  const out = [];
  for (const p of peaks) if (out.every(q => Math.hypot(p[0] - q[0], p[1] - q[1]) >= sep)) out.push(p);
  return out;
}

/** Wavelength (um) of an exposure at a grid position: it changes across the field. */
export const waveAt = (e, size, col, row) => e.wave + e.dwave_dx * (col - (size - 1) / 2) + e.dwave_dy * (row - (size - 1) / 2);

// ---- deeper: following a mover, searching for faint movers, periods, and what a spectrum says ----

/** An image shifted so that the value at (col + dx, row + dy) lands on (col, row). Bilinear; blank outside. */
export function shiftImage(img, size, dx, dy) {
  const out = new Float32Array(size * size).fill(NaN);
  const ix = Math.floor(dx), iy = Math.floor(dy), fx = dx - ix, fy = dy - iy;
  for (let r = 0; r < size; r++) {
    const r0 = r + iy;
    if (r0 < 0 || r0 + 1 >= size) continue;
    for (let c = 0; c < size; c++) {
      const c0 = c + ix;
      if (c0 < 0 || c0 + 1 >= size) continue;
      const p = r0 * size + c0;
      out[r * size + c] = (1 - fy) * ((1 - fx) * img[p] + fx * img[p + 1]) + fy * ((1 - fx) * img[p + size] + fx * img[p + size + 1]);
    }
  }
  return out;
}

/** An exposure re-centred on a moving object: shifted by (dx, dy) pixels, flags moved to the nearest pixel. */
export function shiftExposure(e, size, dx, dy) {
  const cat = new Uint8Array(size * size), jx = Math.round(dx), jy = Math.round(dy);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const r0 = r + jy, c0 = c + jx;
    cat[r * size + c] = r0 < 0 || c0 < 0 || r0 >= size || c0 >= size ? 0 : e.cat[r0 * size + c0];
  }
  return { ...e, img: shiftImage(e.img, size, dx, dy), cat };
}

/**
 * Lomb-Scargle periodogram for unevenly spaced brightness measurements. Returns the best period (days), its power,
 * and the chance that noise alone would give a peak this high (from shuffling the measurements `shuffles` times).
 */
export function findPeriod(t, y, { pmin = 20, pmax = null, shuffles = 200 } = {}) {
  const n = t.length, span = Math.max(...t) - Math.min(...t);
  pmax ??= span / 1.5;                        // at least one and a half cycles must fit
  if (n < 12 || pmax <= pmin) return null;
  const nf = Math.min(600, Math.ceil(4 * span * (1 / pmin - 1 / pmax))), freqs = Array.from({ length: nf }, (_, i) => 1 / pmax + i * (1 / pmin - 1 / pmax) / (nf - 1));
  const power = yy => {
    const mean = yy.reduce((s, v) => s + v, 0) / n, d = yy.map(v => v - mean), vr = d.reduce((s, v) => s + v * v, 0) / (n - 1);
    let best = 0, bf = freqs[0];
    for (const f of freqs) {
      const w = 2 * Math.PI * f;
      let s2 = 0, c2 = 0;
      for (const x of t) { s2 += Math.sin(2 * w * x); c2 += Math.cos(2 * w * x); }
      const tau = Math.atan2(s2, c2) / (2 * w);
      let cs = 0, cc = 0, ss = 0, sn = 0;
      for (let i = 0; i < n; i++) { const a = w * (t[i] - tau), c = Math.cos(a), s = Math.sin(a); cs += d[i] * c; cc += c * c; sn += d[i] * s; ss += s * s; }
      const p = (cs * cs / cc + sn * sn / ss) / (2 * vr);
      if (p > best) { best = p; bf = f; }
    }
    return [best, bf];
  };
  const [p0, f0] = power(y);
  let higher = 0, seed = 12345;
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;      // repeatable shuffles
  for (let k = 0; k < shuffles; k++) {
    const s = y.slice();
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
    if (power(s)[0] >= p0) higher++;
  }
  const period = 1 / f0;
  return { period, err: period * period / (2 * span), power: p0, chance: (higher + 1) / (shuffles + 1), cycles: span / period };
}

const planck = (um, T) => 1 / (um ** 3 * (Math.exp(14387.77 / (um * T)) - 1));      // B_nu up to a constant; wavelength in um

/**
 * What a spectrum says at a glance. `pts` = [{wave (um), flux, err}] of clean measurements.
 * Fits a blackbody (temperature and scale) and measures how deep the water (1.4 um) and methane (3.3 um) bands are
 * against that smooth curve. A quick look, not a classification.
 */
export function readSpectrum(pts) {
  const p = pts.filter(q => q.flux === q.flux && q.err > 0);
  if (p.length < 20 || median(p.map(q => q.flux / q.err)) < 5) return null;
  let best = null;
  for (let T = 400; T <= 12000; T *= 1.03) {
    let sxy = 0, sxx = 0;
    for (const q of p) { const b = planck(q.wave, T); sxy += b * q.flux; sxx += b * b; }
    const a = sxy / sxx, rms = Math.sqrt(p.reduce((s, q) => s + (q.flux - a * planck(q.wave, T)) ** 2, 0) / p.length);
    if (!best || rms < best.rms) best = { T, a, rms };
  }
  const level = median(p.map(q => Math.abs(q.flux))), model = w => best.a * planck(w, best.T);
  const band = (lo, hi) => { const v = p.filter(q => q.wave >= lo && q.wave <= hi); return v.length >= 4 ? [median(v.map(q => q.flux)), 1.25 * robust(v.map(q => q.flux))[1] / Math.sqrt(v.length), median(v.map(q => q.wave))] : null; };
  const depth = (lo, hi, c1, c2) => {            // how far the band sits below a line drawn between two continuum windows
    const b = band(lo, hi), a = band(...c1), c = band(...c2);
    if (!b || !a || !c) return null;
    const cont = a[0] + (c[0] - a[0]) * (b[2] - a[2]) / (c[2] - a[2]);
    return cont > 0 ? { depth: 1 - b[0] / cont, err: Math.hypot(b[1], a[1], c[1]) / cont } : null;
  };
  // methane at 3.3 um has no clean continuum on its blue side in cool objects, so compare it with the 4 um peak,
  // allowing for the slope a blackbody of the fitted temperature would have between the two
  const ch4 = band(3.2, 3.6), peak = band(3.9, 4.1);
  const methane = ch4 && peak && peak[0] > 0 ? { depth: 1 - (ch4[0] / peak[0]) / (planck(ch4[2], best.T) / planck(peak[2], best.T)), err: Math.hypot(ch4[1], peak[1] * ch4[0] / peak[0]) / peak[0] } : null;
  return { T: best.T, fit: best.rms / level, model, water: depth(1.36, 1.46, [1.24, 1.31], [1.56, 1.68]), methane };
}

// ---- self-check: `node public/sky.js` ----
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('sky.js')) {
  const near = (a, b, tol) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${a} != ${b}`); };
  // Barnard's Star: J2000 position plus 16 years of proper motion must equal Gaia's 2016.0 declination
  const b = propagate({ ra: 269.45207696, dec: 4.69336497, pmra: -801.551, pmde: 10362.394 }, GAIA_EPOCH);
  near(b[1], 4.73942005, 2e-5); near(b[0], 269.44850253, 2e-5);
  const ea = earth(60930); near(ea[0], 0.9846, 0.012); near(ea[1], -0.1790, 0.012); near(ea[2], -0.0775, 0.012);   // astropy's values for that date
  const px = parallax(269.4463, 4.7679, 546.9, 61137); near(px[0], 0.5238, 0.01); near(px[1], 0.0766, 0.01);      // checked against astropy
  const c = { ra: 133.7589, dec: -7.2421, size: 64 };
  const g = toGrid(...fromGrid(10.3, 50.7, c), c); near(g[0], 10.3, 1e-6); near(g[1], 50.7, 1e-6);
  near(toGrid(c.ra, c.dec + PIX / 3600, c)[1], 32.5, 1e-6);          // one pixel north is one row up
  if (!(toGrid(c.ra + 0.001, c.dec, c)[0] < 31.5)) throw new Error('east must be at lower columns');
  near(parseCoords('08 55 10.83 -07 14 42.5').dec, -7.245139, 1e-5);
  near(parseCoords('17h57m48.5s +04d41m36s').ra, 269.452083, 1e-5);
  near(parseCoords('133.79 -7.24').dec, -7.24, 1e-9); near(parseCoords('00 10 00 -00 30 00').dec, -0.5, 1e-9);
  const size = 21, mk = (cx, cy, amp, cr) => {       // a fake star, with an optional cosmic ray
    const img = new Float32Array(size * size), cat = new Uint8Array(size * size);
    for (let r = 0; r < size; r++) for (let q = 0; q < size; q++)
      img[r * size + q] = amp * Math.exp(-((q - cx) ** 2 + (r - cy) ** 2) / 2) + 0.01 * Math.sin(q * 7.3 + r * 3.1);
    if (cr) img[5 * size + 5] = 500;
    return { img, cat, noise: 0.01, wave: 1, dwave_dx: 0, dwave_dy: 0 };
  };
  const exps = [0, 0, 0, 0, 1, 0].map(cr => mk(10.3, 9.6, 10, cr));
  near(stack(exps, size).img[5 * size + 5], 0, 0.05);                 // the cosmic ray is clipped
  const ce = centroid(exps[0], size, 10, 10); near(ce[0], 10.3, 0.1); near(ce[1], 9.6, 0.1);
  near(aperture(exps[0], size, 10.3, 9.6, 4, 7, 9).flux, 10 * 2 * Math.PI * UJY, 0.03 * 10 * 2 * Math.PI * UJY);
  near(lineFit([0, 1, 2, 3, 4], [1, 3, 5, 7, 9]).b, 2, 1e-9);
  const big = 41, sat = { img: new Float32Array(big * big), cat: new Uint8Array(big * big), noise: 0.01 };   // saturated star at (20.6, 19.3)
  for (let r = 0; r < big; r++) for (let q = 0; q < big; q++) {
    const d = Math.hypot(q - 20.6, r - 19.3), p = r * big + q;
    sat.img[p] = d < 2 ? NaN : 1000 / (1 + d * d) ** 1.5; if (d < 3.5) sat.cat[p] = 0b10000;
  }
  if (centroid(sat, big, 20, 20)) throw new Error('a masked core must not give a core centroid');
  const wc = locate(sat, big, 20, 20); near(wc[0], 20.6, 0.1); near(wc[1], 19.3, 0.1); if (!wc[3]) throw new Error('wings');
  if (!aperture(sat, big, 20.6, 19.3).hole) throw new Error('hole');
  const pk = findPeaks(stack(exps, size).img, size, 1); near(pk[0][0], 10, 0); near(pk[0][1], 10, 0);
  const sh = shiftImage(exps[0].img, size, 2, -1); near(sh[9 * size + 8], exps[0].img[8 * size + 10], 1e-6);          // value from (col+2, row-1)
  const tt = Array.from({ length: 80 }, (_, i) => i * 6.3 + (i * 37 % 5)), per = findPeriod(tt, tt.map(x => 1 + 0.3 * Math.sin(2 * Math.PI * x / 97)));
  near(per.period, 97, 3); if (!(per.chance < 0.02)) throw new Error('period significance');
  const bb = Array.from({ length: 280 }, (_, i) => { const w = 0.8 + i * 0.015, f = 1e6 / (w ** 3 * (Math.exp(14387.77 / (w * 3000)) - 1)); return { wave: w, flux: f, err: f / 50 }; });
  const rs = readSpectrum(bb); near(rs.T, 3000, 120); near(rs.methane.depth, 0, 0.05); near(rs.water.depth, 0, 0.05);
  if (planChunks(Array.from({ length: 40 }, (_, i) => ({ key: 'k' + i, det: 1 + i % 2, epoch: 0 })), 8).flat().length !== 16) throw new Error('plan');
  console.log('sky.js self-check passed');
}
