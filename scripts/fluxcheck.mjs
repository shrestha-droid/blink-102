// Compare Blink 102's fluxes with 2MASS: field stars' brightness near 2.16 um against their catalogued Ks magnitude.
// usage: node scripts/fluxcheck.mjs      (NASA Space Apps 2026; written with AI assistance)
import { readFileSync } from 'node:fs';
import * as K from '../public/sky.js';

const KS_ZERO_JY = 666.7;                   // 2MASS Ks zero point (Cohen et al. 2003)
const index = JSON.parse(readFileSync('public/cache/index.json')), all = [];
for (const t of index) {
  const dir = `public/cache/${t.slug}/`, man = JSON.parse(readFileSync(dir + 'manifest.json')), size = t.size, c = { ra: t.ra, dec: t.dec, size }, exps = [];
  for (const f of man.files) { const b = readFileSync(dir + f); exps.push(...K.parseFrames(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).filter(e => e.ok)); }
  const st = K.stack(exps, size), [med, sig] = K.robust(st.img);
  const stars = K.isolatedStars(st.img, size, med + 40 * sig, med + 5 * sig).filter(p => st.caution[p[1] * size + p[0]] < 64 && st.left[p[1] * size + p[0]] < 64).slice(0, 12);
  const cor = K.apertureCorrection(exps, size, stars);
  console.log(`\n${t.name}: ${stars.length} calibration stars; correction by detector: ${[1, 2, 3, 4, 5, 6].map(d => (cor[d] ? `D${d} x${cor[d].f.toFixed(3)} (${cor[d].n})` : `D${d} -`)).join(', ')}`);
  const url = `https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=II/246/out&-c=${t.ra}${t.dec < 0 ? '-' : '%2B'}${Math.abs(t.dec)}&-c.rm=3.2&-out=RAJ2000,DEJ2000,Kmag,Qflg&-out.max=500&-sort=Kmag`;
  const rows = (await (await fetch(url)).text()).split('\n').filter(l => l && !l.startsWith('#')).slice(3).map(l => l.split('\t')).filter(r => r.length >= 3 && isFinite(+r[2]));
  const ks = exps.filter(e => e.wave > 2.05 && e.wave < 2.28);
  for (const r of rows) {
    const kmag = +r[2]; if (kmag < 9.8 || kmag > 14.3) continue;                       // unsaturated, and bright enough to measure well
    const [col, row] = K.toGrid(+r[0], +r[1], c);
    if (col < 10 || row < 10 || col > size - 11 || row > size - 11) continue;
    if (rows.some(q => q !== r && Math.hypot(...K.toGrid(+q[0], +q[1], c).map((v, i) => v - [col, row][i])) < 7 && +q[2] < kmag + 3)) continue;   // isolated in 2MASS
    if (Math.hypot(col - (size - 1) / 2, row - (size - 1) / 2) < 14 && t.name !== 'WISE 0855-0714') continue;                 // keep out of the bright target's glare
    const f = ks.map(e => K.aperture(e, size, col, row)).filter(a => a.ok && !a.flagged && !a.sat).map(a => a.flux);
    if (f.length < 4) continue;
    const k = cor[3]?.f || 1, ours = K.median(f) * k / 1e6, cat = KS_ZERO_JY * 10 ** (-kmag / 2.5);
    if (ours < 0.3 * cat) { console.log(`  Ks ${kmag.toFixed(2)}: nothing at its 2MASS (1999) position now: it has moved`); continue; }
    all.push({ field: t.name, kmag, ratio: ours / cat, raw: ours / k / cat });
    console.log(`  Ks ${kmag.toFixed(2)}: 2MASS ${(cat * 1e3).toFixed(2)} mJy, ours ${(ours * 1e3).toFixed(2)} mJy, ratio ${(ours / cat).toFixed(3)} (uncorrected ${(ours / k / cat).toFixed(3)}), ${f.length} exposures`);
  }
}
const r = all.map(a => a.ratio), raw = all.map(a => a.raw);
if (r.length) console.log(`\n${r.length} stars: median ours/2MASS = ${K.median(r).toFixed(3)} corrected, ${K.median(raw).toFixed(3)} uncorrected; scatter ${(1.4826 * K.median(r.map(x => Math.abs(x - K.median(r))))).toFixed(3)}`);
