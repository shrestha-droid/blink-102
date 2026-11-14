// Blink 102: catalogue lookups. Each returns objects {name, ra, dec, pmra, pmde, plx, epoch, mag, src, type}.
// Written during NASA Space Apps 2026 with AI assistance (Claude); see README "AI use".
// The CfA mirrors of the CDS services allow browser (CORS) access; Gaia falls back to IRSA through our proxy.
import { J2000, GAIA_EPOCH } from './sky.js';

const CFA = 'https://vizier.cfa.harvard.edu/viz-bin';
const SIMBAD = 'https://simbad.cfa.harvard.edu/simbad/sim-tap/sync';
const API = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? new URLSearchParams(location.search).get('api') || '' : '';   // dev only
const num = v => (v === '' || v == null || isNaN(+v) ? null : +v);

async function get(url, ms = 25000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url, location.href).host} answered ${r.status}`);
  return r.text();
}

/** Name -> J2000 position and proper motion, through the Sesame resolver (SIMBAD, then NED, then VizieR). */
export async function resolveName(name) {
  const xml = new DOMParser().parseFromString(await get(`${CFA}/nph-sesame/-oxp/SNV?${encodeURIComponent(name)}`), 'text/xml');
  const r = [...xml.getElementsByTagName('Resolver')].find(x => x.getElementsByTagName('jradeg').length);
  if (!r) return null;
  const tag = t => r.getElementsByTagName(t)[0]?.textContent.trim();
  const plx = r.getElementsByTagName('plx')[0]?.getElementsByTagName('v')[0]?.textContent;
  return { name: (tag('oname') || name).replace(/^(NAME|V\*|\*)\s+/, ''), type: tag('otype') || '', ra: +tag('jradeg'), dec: +tag('jdedeg'),
    pmra: num(tag('pmRA')) || 0, pmde: num(tag('pmDE')) || 0, plx: num(plx) || 0, epoch: J2000, src: 'SIMBAD' };
}

/** Split one CSV line, honouring double quotes. */
function csvLine(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Named objects near a position. SIMBAD positions are J2000, so the search is padded for fast movers. */
export async function simbad(ra, dec, rDeg) {
  const q = `SELECT TOP 300 main_id,otype,ra,dec,pmra,pmdec,plx_value,sp_type FROM basic WHERE ra IS NOT NULL AND ` +
    `1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra.toFixed(5)},${dec.toFixed(5)},${rDeg.toFixed(4)}))`;
  const lines = (await get(`${SIMBAD}?request=doQuery&lang=adql&format=csv&query=${encodeURIComponent(q)}`)).trim().split('\n').slice(1);
  return lines.map(csvLine).map(c => ({ name: c[0].replace(/^(NAME|V\*|\*)\s+/, '').replace(/\s+/g, ' '), type: c[1], ra: +c[2], dec: +c[3],
    pmra: num(c[4]) || 0, pmde: num(c[5]) || 0, plx: num(c[6]) || 0, sp: c[7] || '', epoch: J2000, src: 'SIMBAD' }));
}

/** Gaia DR3 stars (ESA). Positions are at epoch 2016.0. */
export async function gaia(ra, dec, rArcmin) {
  try {
    const c = `${ra.toFixed(5)}${dec < 0 ? '-' : '%2B'}${Math.abs(dec).toFixed(5)}`;
    const text = await get(`${CFA}/asu-tsv?-source=I/355/gaiadr3&-c=${c}&-c.rm=${rArcmin.toFixed(2)}` +
      `&-out=DR3Name,RA_ICRS,DE_ICRS,pmRA,pmDE,Plx,Gmag,RPmag&-out.max=3000&-sort=Gmag`, 20000);
    const rows = text.split('\n').filter(l => l && !l.startsWith('#')).slice(3).map(l => l.split('\t'));
    if (!rows.length && !text.includes('RA_ICRS')) throw new Error('empty VizieR reply');
    return rows.filter(c => c.length >= 7).map(c => ({ name: c[0].trim(), ra: +c[1], dec: +c[2], pmra: num(c[3]) || 0, pmde: num(c[4]) || 0,
      plx: num(c[5]) || 0, mag: num(c[6]), epoch: GAIA_EPOCH, src: 'Gaia DR3' }));
  } catch {
    return proxy('gaia', ra, dec, rArcmin, GAIA_EPOCH, 'Gaia DR3');
  }
}

/** CatWISE 2020 (NASA WISE): the catalogue with proper motions for cold brown dwarfs that Gaia cannot see. */
export const catwise = (ra, dec, rArcmin) => proxy('catwise', ra, dec, rArcmin, null, 'CatWISE');

async function proxy(kind, ra, dec, rArcmin, epoch, src) {
  const rows = JSON.parse(await get(`${API}/api/catalog?kind=${kind}&ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&r=${rArcmin.toFixed(2)}`, 60000));
  return rows.map(o => ({ name: o.name, ra: o.ra, dec: o.dec, pmra: o.pmra || 0, pmde: o.pmdec || 0, plx: o.plx || 0,
    mag: kind === 'catwise' ? o.m2 : o.m1, epoch: epoch ?? o.epoch, src }));
}
