// Measure the five test targets from the cached exposures with the same routines the page uses.
// usage: node scripts/validate.mjs      (NASA Space Apps 2026; written with AI assistance)
import { readFileSync } from 'node:fs';
import * as K from '../public/sky.js';

const only = process.argv.slice(2);           // optional: names to check
const index = JSON.parse(readFileSync('public/cache/index.json')).filter(t => !only.length || only.includes(t.name));
for (const t of index) {
  const dir = `public/cache/${t.slug}/`, man = JSON.parse(readFileSync(dir + 'manifest.json')), size = t.size, c = { ra: t.ra, dec: t.dec, size };
  const epochOf = new Map(man.search.exposures.map(e => [e.key, e.epoch])), exps = [];
  for (const f of man.files) { const b = readFileSync(dir + f); exps.push(...K.parseFrames(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).filter(e => e.ok)); }
  for (const e of exps) e.epoch = epochOf.get(e.key);
  const pos = e => K.toGrid(...K.apparent(t.obj, e.mjd), c), mid = (size - 1) / 2;
  // motion from the centre of light in every exposure
  const tt = [], east = [], north = []; let holes = 0, sat = 0;
  const meas = exps.map(e => { const [col, row] = pos(e), a = K.aperture(e, size, col, row), l = K.locate(e, size, col, row), w = K.wingFlux(e, size, col, row);
    holes += a.hole; sat += a.sat;
    if (l && l[2] > 10) { const px = t.obj.plx > 0 ? K.parallax(t.ra, t.dec, t.obj.plx, e.mjd) : [0, 0];       // take the yearly parallax wobble out
      tt.push((e.mjd - K.REF_MJD) / 365.25); east.push((mid - l[0]) * K.PIX - px[0]); north.push((l[1] - mid) * K.PIX - px[1]); }
    return { e, a, wing: w.ok ? w.flux : NaN, wave: K.waveAt(e, size, col, row) }; });
  const fe = K.lineFit(tt, east), fn = K.lineFit(tt, north), cat = Math.hypot(t.obj.pmra, t.obj.pmde) / 1000;
  const saturated = meas.filter(m => m.a.sat || m.a.hole).length > 0.3 * meas.length;
  console.log(`\n${t.name}: ${exps.length} of ${man.search.n} exposures cached, ${man.search.epochs.length} dates (${man.search.epochs.map(e => e.label).join(', ')})`);
  console.log(`  saturated: ${saturated} (blank core in ${holes}, near saturation in ${sat})`);
  console.log(fe && fn ? `  motion from ${fe.n} single exposures: ${Math.hypot(fe.b, fn.b).toFixed(2)} +- ${Math.hypot(fe.eb, fn.eb).toFixed(2)} "/yr (east ${fe.b.toFixed(2)}, north ${fn.b.toFixed(2)}); catalogue ${cat.toFixed(2)} (east ${(t.obj.pmra / 1000).toFixed(2)}, north ${(t.obj.pmde / 1000).toFixed(2)})`
    : `  too faint to locate in single exposures (${tt.length} located); catalogue motion ${cat.toFixed(2)} "/yr`);
  // detection in per-date stacks, short and long wavelengths, at the predicted position
  for (const [lab, lo, hi] of [['0.75-2.4 um', 0.74, 2.42], ['3.8-5.0 um', 3.8, 5.01]]) {
    const out = man.search.epochs.map(ep => {
      const ex = exps.filter(e => e.epoch === ep.i && e.wave >= lo && e.wave <= hi);
      if (ex.length < 4) return `${ep.label}: -`;
      const st = K.stack(ex, size), [, sig] = K.robust(st.img), mj = K.median(ex.map(e => e.mjd));
      const [col, row] = K.toGrid(...K.propagate(t.obj, mj), c), fake = { img: st.img, cat: new Uint8Array(size * size), noise: sig };
      const a = K.aperture(fake, size, col, row), ce = K.centroid(fake, size, col, row);
      return `${ep.label}: ${a.flux.toFixed(0)} uJy S/N ${(a.flux / (Math.sqrt(19.6) * sig * K.UJY)).toFixed(1)}${ce ? ` offset ${(Math.hypot(ce[0] - col, ce[1] - row) * K.PIX).toFixed(1)}"` : ''} (${ex.length})`;
    });
    console.log(`  stack ${lab}: ${out.slice(0, 6).join(' | ')}${out.length > 6 ? ' ...' : ''}`);
  }
  // brightness over time: each exposure divided by the source's own median spectrum (outer light if saturated)
  const val = saturated ? m => m.wing : m => (m.a.flagged ? NaN : m.a.flux), n = 20, bin = w => Math.min(n - 1, Math.max(0, Math.floor((Math.log(w) - Math.log(K.WMIN)) / (Math.log(K.WMAX) - Math.log(K.WMIN)) * n)));
  const bins = Array.from({ length: n }, () => []); for (const m of meas) if (isFinite(val(m))) bins[bin(m.wave)].push(val(m));
  const med = bins.map(b => (b.length >= 3 ? K.median(b) : NaN));
  const rel = man.search.epochs.map(ep => { const v = meas.filter(m => m.e.epoch === ep.i).map(m => val(m) / med[bin(m.wave)]).filter(x => isFinite(x) && med.length); return v.length >= 3 ? [ep.label, K.median(v), v.length] : null; }).filter(Boolean);
  const r = rel.map(x => x[1]);
  console.log(`  brightness per date (${saturated ? 'outer light' : 'aperture'}), relative to own average: ${rel.map(x => `${x[0]} ${x[1].toFixed(2)}`).join(', ')}`);
  if (r.length > 1) console.log(`  range ${Math.min(...r).toFixed(2)} to ${Math.max(...r).toFixed(2)} = ${(2.5 * Math.log10(Math.max(...r) / Math.min(...r))).toFixed(2)} mag`);
}
