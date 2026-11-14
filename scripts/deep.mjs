// Try the deeper tools on the cached targets: period finding and spectrum readouts.
// usage: node scripts/deep.mjs      (NASA Space Apps 2026; written with AI assistance)
import { readFileSync } from 'node:fs';
import * as K from '../public/sky.js';

const index = JSON.parse(readFileSync('public/cache/index.json'));
for (const t of index) {
  const dir = `public/cache/${t.slug}/`, man = JSON.parse(readFileSync(dir + 'manifest.json')), size = t.size, c = { ra: t.ra, dec: t.dec, size };
  const epochOf = new Map(man.search.exposures.map(e => [e.key, e.epoch])), exps = [];
  for (const f of man.files) { const b = readFileSync(dir + f); exps.push(...K.parseFrames(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).filter(e => e.ok)); }
  for (const e of exps) e.epoch = epochOf.get(e.key);
  console.log(`\n== ${t.name}`);
  // the target's own measurements
  const meas = exps.map(e => { const [col, row] = K.toGrid(...K.apparent(t.obj, e.mjd), c); return { e, a: K.aperture(e, size, col, row), w: K.wingFlux(e, size, col, row), wave: K.waveAt(e, size, col, row) }; }).filter(m => m.a.ok);
  const sat = meas.filter(m => m.a.sat || m.a.hole).length > 0.3 * meas.length;
  const val = sat ? m => (m.w.ok ? m.w.flux : NaN) : m => (m.a.flagged ? NaN : m.a.flux), n = 20, bin = w => Math.min(n - 1, Math.max(0, Math.floor((Math.log(w) - Math.log(K.WMIN)) / (Math.log(K.WMAX) - Math.log(K.WMIN)) * n)));
  const bins = Array.from({ length: n }, () => []); for (const m of meas) if (isFinite(val(m))) bins[bin(m.wave)].push(val(m));
  const med = bins.map(b => (b.length >= 3 ? K.median(b) : NaN));
  const lc = meas.map(m => [m.e.mjd, val(m) / med[bin(m.wave)]]).filter(p => isFinite(p[1]) && p[1] > 0 && p[1] < 5);
  const per = K.findPeriod(lc.map(p => p[0]), lc.map(p => p[1]));
  console.log(per ? `  period: ${per.period.toFixed(0)} +- ${per.err.toFixed(0)} d, power ${per.power.toFixed(1)}, chance ${per.chance.toFixed(3)}, ${per.cycles.toFixed(1)} cycles covered, from ${lc.length} points` : `  period: not enough data (${lc.length} points)`);
  if (!sat) {
    const rs = K.readSpectrum(meas.filter(m => !m.a.flagged).map(m => ({ wave: m.wave, flux: m.a.flux, err: m.a.err })));
    console.log(rs ? `  spectrum: blackbody ${rs.T.toFixed(0)} K (misfit ${(100 * rs.fit).toFixed(0)} %), water ${rs.water ? (100 * rs.water.depth).toFixed(0) + ' +- ' + (100 * rs.water.err).toFixed(0) + ' %' : '-'}, methane ${rs.methane ? (100 * rs.methane.depth).toFixed(0) + ' +- ' + (100 * rs.methane.err).toFixed(0) + ' %' : '-'}` : '  spectrum: too faint to read');
  }
}
