// Precompute the example targets so they open instantly: saves the API's own responses under public/cache/.
// usage: node scripts/precache.mjs [https://deployment]      (NASA Space Apps 2026; written with AI assistance)
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { planChunks, propagate, REF_MJD } from '../public/sky.js';

const API = process.argv[2] || 'https://blink-102.vercel.app';
const SIZE = 64, FULL_DEPTH_LIMIT = 600;
const TARGETS = [["Barnard's Star", "Barnard's star"], ['eps Indi B', 'eps Ind B'], ['WISE 0855-0714', 'WISE J085510.83-071442.5'], ['RW Aur', 'RW Aur'], ['R Dra', 'R Dra']];
const tag = (xml, t) => xml.match(new RegExp(`<${t}>([^<]*)`))?.[1];
const round5 = v => Math.round(v * 1e5) / 1e5;

async function get(url, tries = 4) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 90)}`); return r; }
    catch (e) { if (i === tries - 1) throw e; await new Promise(ok => setTimeout(ok, 2000 * (i + 1))); }
  }
}

const index = [];
for (const [name, query] of TARGETS) {
  const xml = await (await get(`https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV?${encodeURIComponent(query)}`)).text();
  const obj = { name, type: tag(xml, 'otype') || '', ra: +tag(xml, 'jradeg'), dec: +tag(xml, 'jdedeg'), pmra: +tag(xml, 'pmRA') || 0, pmde: +tag(xml, 'pmDE') || 0,
    plx: +(xml.match(/<plx><v>([^<]*)/)?.[1] || 0), epoch: 51544.5, src: 'SIMBAD' };
  const [ra, dec] = propagate(obj, REF_MJD).map(round5), slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
  const search = await (await get(`${API}/api/search?ra=${ra}&dec=${dec}`)).json();
  const quick = planChunks(search.exposures, 8);
  const rest = search.n <= FULL_DEPTH_LIMIT ? planChunks(search.exposures, 1e9, new Set(quick.flat())) : [];
  const chunks = [...quick, ...rest], files = [], dir = `public/cache/${slug}`;
  await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
  let next = 0, bytes = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (next < chunks.length) {
      const i = next++, f = `${String(i).padStart(3, '0')}.bin`;
      const buf = Buffer.from(await (await get(`${API}/api/frames?ra=${ra}&dec=${dec}&size=${SIZE}&keys=${chunks[i].join(',')}`)).arrayBuffer());
      await writeFile(`${dir}/${f}`, buf); files[i] = f; bytes += buf.length;
    }
  }));
  await writeFile(`${dir}/manifest.json`, JSON.stringify({ search, files }));
  index.push({ slug, name, ra, dec, size: SIZE, obj });
  console.log(`${name}: ${ra} ${dec}  ${search.n} exposures, ${search.epochs.length} epochs, ${chunks.flat().length} cached in ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
}
await writeFile('public/cache/index.json', JSON.stringify(index));
