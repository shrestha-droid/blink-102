// Blink 102: the instrument. Loads exposures, stacks them per date, blinks, and measures what you click.
// Written during NASA Space Apps 2026 with AI assistance (Claude); see README "AI use".
import * as K from './sky.js';
import { scatter } from './charts.js';
import * as Cat from './catalogs.js';

const $ = s => document.querySelector(s);
const probe = document.body.appendChild(Object.assign(document.createElement('i'), { hidden: true }));
const css = v => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };      // resolved for the current theme
const API = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? new URLSearchParams(location.search).get('api') || '' : '';   // dev only
const PRESETS = ["Barnard's Star", 'eps Indi B', 'WISE 0855-0714', 'RW Aur', 'R Dra'];
const PRESET_QUERY = { "Barnard's Star": "Barnard's star", 'eps Indi B': 'eps Ind B', 'WISE 0855-0714': 'WISE J085510.83-071442.5' };
const MOLECULES = [{ x0: 1.33, x1: 1.5, label: 'H₂O' }, { x0: 1.75, x1: 2.05, label: 'H₂O' }, { x0: 3.2, x1: 3.65, label: 'CH₄' },
  { x0: 4.18, x1: 4.35, label: 'CO₂' }, { x0: 4.55, x1: 4.8, label: 'CO' }];
const LN = Math.log, L0 = LN(K.WMIN), L1 = LN(K.WMAX);
const params = new URLSearchParams(location.search);

const S = {                      // everything the page shows is derived from this
  gen: 0, target: null, size: 64, c: null, search: null, byKey: new Map(), exps: [], failed: 0, total: 0, cached: null,
  wmin: K.WMIN, wmax: K.WMAX, frames: [], frame: 0, playing: !matchMedia('(prefers-reduced-motion: reduce)').matches, fps: 2,
  diff: false, rgb: false, flags: false, cats: true, snap: true, bright: 0, zoom: 1, vx: 32, vy: 32,
  lim: null, sel: null, meas: [], peek: null, catalog: [], movers: [], tab: 'lc', log: false, mol: false, sweep: null,
};
let cacheIndex = null, dirty = false, timer = null;

// ---------- small helpers ----------
const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);
const epochColor = i => {          // time runs from pale to saturated blue
  const u = i / Math.max(1, (S.search?.epochs.length || 1) - 1), a = rgb(css('--t0')), b = rgb(css('--t1'));
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * u)).join(',')})`;
};
const detColor = d => css(`--d${d}`);
const fmtDate = mjd => K.mjdDate(mjd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthYear = mjd => K.mjdDate(mjd).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const totalPm = o => Math.hypot(o.pmra || 0, o.pmde || 0) / 1000;      // arcsec per year
const round5 = v => Math.round(v * 1e5) / 1e5;
function notice(html, err = false) { const n = $('#notice'); n.hidden = !html; n.className = 'notice' + (err ? ' err' : ''); n.innerHTML = html || ''; }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- choosing a target ----------
async function go(text, { keepView = false } = {}) {
  text = text.trim();
  if (!text) return;
  notice('');
  const co = K.parseCoords(text);
  let t;
  try {
    if (co) t = { name: null, obj: null, ra: round5(co.ra), dec: round5(co.dec), typed: true };
    else {
      const hit = cacheIndex?.find(c => c.name.toLowerCase() === text.toLowerCase());
      const obj = hit?.obj || await Cat.resolveName(PRESET_QUERY[text] || text);
      if (!obj) return notice(`No object called “${esc(text)}” was found. Try coordinates, for example <code>269.4463 4.7679</code>.`, true);
      const [ra, dec] = K.propagate(obj, K.REF_MJD);
      t = { name: hit?.name || PRESETS.find(p => p.toLowerCase() === text.toLowerCase()) || obj.name, obj, ra: round5(ra), dec: round5(dec) };
      const moved = Math.hypot((ra - obj.ra) * Math.cos(dec * Math.PI / 180), dec - obj.dec) * 60;
      if (moved > 0.2) notice(`${esc(t.name)} has moved ${moved.toFixed(1)}′ since 2000 (${totalPm(obj).toFixed(1)}″ per year). Showing where it is now.`);
    }
  } catch (e) {
    return notice(`The name lookup did not answer (${esc(e.message)}). Coordinates still work.`, true);
  }
  loadTarget(t, keepView);
}

async function loadTarget(t, keepView) {
  const gen = ++S.gen;
  Object.assign(S, { target: t, c: { ra: t.ra, dec: t.dec, size: S.size }, search: null, byKey: new Map(), exps: [], failed: 0, total: 0,
    frames: [], frame: keepView ? S.frame : 0, sel: null, meas: [], peek: null, catalog: [], movers: [], lim: null, zoom: 1, vx: S.size / 2, vy: S.size / 2, cached: null });
  $('#q').value = t.name || `${t.ra} ${t.dec}`;
  $('#load').textContent = 'Finding exposures…';
  $('#b-more').hidden = true; $('#field').replaceChildren(); $('#field-note').textContent = '';
  renderAll(); showSource(); syncUrl();
  const hit = cacheIndex?.find(c => c.ra === t.ra && c.dec === t.dec && c.size === S.size);
  let search, chunks;
  try {
    if (hit) {
      const man = await (await fetch(`cache/${hit.slug}/manifest.json`)).json();
      search = man.search; chunks = man.files.map(f => ({ url: `cache/${hit.slug}/${f}` })); S.cached = hit.slug;
    } else {
      const r = await fetch(`${API}/api/search?ra=${t.ra}&dec=${t.dec}`);
      search = await r.json();
      if (!r.ok) throw new Error(search.error || r.status);
      chunks = K.planChunks(search.exposures, 8).map(keys => ({ keys }));
    }
  } catch (e) {
    if (gen === S.gen) { $('#load').textContent = ''; notice(`The SPHEREx image search failed (${esc(e.message)}). Try again in a moment.`, true); }
    return;
  }
  if (gen !== S.gen) return;
  S.search = search;
  for (const e of search.exposures) S.byKey.set(e.key, e);
  if (!search.n) { $('#load').textContent = ''; return notice('SPHEREx has no released images at this position yet. New data arrives weekly.'); }
  buildPlates();
  loadCatalogues(gen);
  await fetchChunks(chunks, gen);
  if (gen !== S.gen) return;
  const rest = search.n - S.exps.length - S.failed;
  $('#b-more').hidden = rest <= 0;
  $('#b-more').textContent = `Load every exposure (${search.n})`;
  if (params.get('sel') && !S.sel) { const [ra, dec] = params.get('sel').split(',').map(Number); selectSky(ra, dec); }
}

async function fetchChunks(chunks, gen) {
  S.total += chunks.reduce((n, c) => n + (c.keys?.length || 16), 0);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length && gen === S.gen) {
      const ch = chunks[next++];
      const url = ch.url || `${API}/api/frames?ra=${S.c.ra}&dec=${S.c.dec}&size=${S.size}&keys=${ch.keys.join(',')}`;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(r.status);
        const list = K.parseFrames(await r.arrayBuffer());
        if (gen !== S.gen) return;
        for (const e of list) {
          if (!e.ok) { S.failed++; continue; }
          e.epoch = S.byKey.get(e.key)?.epoch ?? 0;
          S.exps.push(e);
        }
      } catch { S.failed += ch.keys?.length || 0; }
      $('#load').textContent = `${S.exps.length} of ${S.search.n} exposures`;
      invalidate();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));     // browsers allow about six requests per host
  if (gen === S.gen) { $('#load').textContent = ''; invalidate(); }
}

async function loadCatalogues(gen) {
  const half = S.size * K.PIX / 3600 / 2, t = S.target;
  const add = list => { if (gen === S.gen) { S.catalog.push(...list); invalidate(false); buildField(); if (S.sel) showSource(); } };
  if (t.obj) add([{ ...t.obj, name: t.name, target: true }]);
  Cat.gaia(t.ra, t.dec, half * 60 * 1.5).then(add).catch(() => {});
  // SIMBAD positions are J2000, so pad the search by 6' to catch fast movers that have since arrived here
  Cat.simbad(t.ra, t.dec, half * 1.5 + 0.1).then(list => {
    if (gen !== S.gen) return;
    const sep = (a, b) => Math.hypot((a.ra - b.ra) * Math.cos(a.dec * Math.PI / 180), a.dec - b.dec) * 3600;
    list = list.filter(o => o.type !== 'Pl' && !(t.obj && sep(o, t.obj) < 5));      // drop planets and the target's own duplicate
    add(list);
    if (t.typed) {
      const fast = list.filter(o => totalPm(o) > 0.5).map(o => ({ o, now: K.propagate(o, K.REF_MJD) }))
        .filter(x => Math.hypot((x.now[0] - t.ra) * Math.cos(t.dec * Math.PI / 180), x.now[1] - t.dec) < half * 2.2)
        .sort((a, b) => totalPm(b.o) - totalPm(a.o))[0];
      if (fast) {
        const [c, r] = K.toGrid(...fast.now, S.c), off = Math.hypot(c - (S.size - 1) / 2, r - (S.size - 1) / 2) * K.PIX / 60;
        if (off > 0.3) {
          notice(`${esc(fast.o.name)} moves ${totalPm(fast.o).toFixed(1)}″ per year and is now ${off.toFixed(1)}′ from the position you entered. <button type="button" id="recentre">Centre on it</button>`);
          $('#recentre').onclick = () => go(fast.o.name);
        }
      }
    }
  }).catch(() => {});
  Cat.catwise(t.ra, t.dec, half * 60 * 1.5).then(add).catch(() => {});
}

// ---------- frames: one stacked picture per date ----------
const inBand = e => e.wave >= S.wmin && e.wave <= S.wmax;
function invalidate(restack = true) {
  if (restack) dirty = true;
  if (!timer) timer = setTimeout(() => { timer = null; if (dirty) { dirty = false; computeFrames(); if (S.sel) measure(); } renderAll(); }, 60);
}

function computeFrames() {
  if (!S.search) return;
  const size = S.size, thirds = [0, 1, 2].map(i => Math.exp(LN(S.wmin) + (LN(S.wmax) - LN(S.wmin)) * i / 3)).concat(S.wmax);
  S.frames = S.search.epochs.map(ep => {
    const ex = S.exps.filter(e => e.epoch === ep.i && inBand(e));
    if (!ex.length) return null;
    const f = K.stack(ex, size);
    f.count = ex.length; f.mjd = K.median(ex.map(e => e.mjd)); f.epoch = ep;
    if (S.rgb) f.rgb = [2, 1, 0].map(k => { const sub = ex.filter(e => e.wave >= thirds[k] && e.wave <= thirds[k + 1]); return sub.length ? K.stack(sub, size).img : null; });
    return f;
  });
  const live = S.frames.filter(Boolean);
  if (!live.length) { S.lim = null; return; }
  if (S.diff) for (const f of live) {           // each date minus the average of the others
    const others = live.filter(g => g !== f);
    f.diff = new Float32Array(size * size);
    for (let p = 0; p < size * size; p++) { let s = 0, n = 0; for (const g of others) if (g.img[p] === g.img[p]) { s += g.img[p]; n++; } f.diff[p] = n ? f.img[p] - s / n : NaN; }
  }
  const lims = imgs => { const big = imgs.flatMap(a => Array.from(a)), [med, sig] = K.robust(big); return { lo: med - 2 * sig, sig: sig || 1e-6, hi: K.percentile(big, 0.995) }; };
  S.lim = lims(live.map(f => f.img));           // one set of limits for every date, so brightness changes are real
  if (S.diff) S.lim.dsig = K.robust(live.flatMap(f => Array.from(f.diff)))[1] || 1e-6;
  if (S.rgb) S.lim.rgb = [0, 1, 2].map(k => { const im = live.map(f => f.rgb[k]).filter(Boolean); return im.length ? lims(im) : null; });
}

const stretcher = lim => { const soft = 3 * lim.sig, hi = lim.lo + (lim.hi - lim.lo) * 10 ** -S.bright, d = Math.asinh(Math.max(hi - lim.lo, soft) / soft);
  return v => (v !== v ? NaN : Math.min(1, Math.max(0, Math.asinh((v - lim.lo) / soft) / d))); };

/** Paint a frame (or one exposure) into a size x size canvas. Row 0 is south, so rows are flipped. */
function paint(cv, src) {
  const size = S.size, plate = document.querySelector('meta[name="color-scheme"]').content === 'light';
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d'), id = ctx.createImageData(size, size), d = id.data;
  if (!src || !S.lim) { ctx.clearRect(0, 0, size, size); return; }
  const st = stretcher(S.lim), nanv = plate ? 235 : 22;
  const st3 = src.rgb && S.rgb ? S.lim.rgb.map(l => l && stretcher(l)) : null;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const p = r * size + c, o = ((size - 1 - r) * size + c) * 4;
    let R, G, B;
    if (src.diff && S.diff) { const t = 0.5 + src.diff[p] / (16 * S.lim.dsig * 10 ** -S.bright); R = G = B = t !== t ? NaN : Math.min(1, Math.max(0, t)); }
    else if (st3) [R, G, B] = st3.map((f, k) => (f && src.rgb[k] ? f(src.rgb[k][p]) : 0));
    else R = G = B = st(src.img[p]);
    if (R !== R) { d[o] = d[o + 1] = d[o + 2] = nanv; d[o + 3] = 255; continue; }
    if (plate) { R = 1 - R; G = 1 - G; B = 1 - B; }
    d[o] = 255 * R; d[o + 1] = 255 * G; d[o + 2] = 255 * B; d[o + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

// ---------- drawing ----------
const off = document.createElement('canvas');
function view() { const sw = S.size / S.zoom; return { sw, sx: Math.min(S.size - sw, Math.max(0, S.vx - sw / 2)), sy: Math.min(S.size - sw, Math.max(0, S.vy - sw / 2)) }; }
function toScreen(col, row, W) { const v = view(); return [(col + 0.5 - v.sx) * W / v.sw, (S.size - 1 - row + 0.5 - v.sy) * W / v.sw]; }
function toGridXY(x, y, W) { const v = view(); return [v.sx + x * v.sw / W - 0.5, S.size - 1 - (v.sy + y * v.sw / W - 0.5)]; }

function current() {             // what the eyepiece shows: a hovered single exposure, or the current date's stack
  if (S.peek) return { src: S.peek, mjd: S.peek.mjd, one: true };
  const f = S.frames[S.frame];
  return f ? { src: f, mjd: f.mjd } : { src: null, mjd: S.search?.epochs[S.frame] ? (S.search.epochs[S.frame].mjd0 + S.search.epochs[S.frame].mjd1) / 2 : K.REF_MJD };
}

function renderAll() { renderEye(); renderPlates(); renderStrip(); if (!$('#film').hidden) renderFilm(); }

function renderEye(target = $('#img'), over = $('#ovl')) {
  const cur = current(), W = Math.round(target.clientWidth * devicePixelRatio) || 640;
  paint(off, cur.src);
  target.width = target.height = W;
  const ctx = target.getContext('2d'), v = view();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, v.sx, v.sy, v.sw, v.sw, 0, 0, W, W);
  drawOverlay(over, W, cur);
  const t = S.target, ep = S.search?.epochs[S.frame];
  $('#hud-target').innerHTML = t ? `<b>${esc(t.name || 'Position')}</b>\n${K.sexa(t.ra, t.dec)}\n${t.ra.toFixed(5)} ${t.dec >= 0 ? '+' : ''}${t.dec.toFixed(5)}` : '';
  $('#hud-epoch').innerHTML = !ep ? '' : cur.one ? `<b>${fmtDate(cur.mjd)}</b>\none exposure · D${cur.src.det}\n${cur.src.wave.toFixed(3)} µm`
    : `<b>${fmtDate(cur.mjd)}</b>\n${cur.src ? `${cur.src.count} exposures stacked` : 'no exposures in this colour range'}\ndate ${S.frame + 1} of ${S.search.epochs.length}`;
  $('#hud-wave').textContent = `${S.wmin.toFixed(2)}–${S.wmax.toFixed(2)} µm${S.diff ? '\ndifference' : S.rgb ? '\ncolour: short=blue long=red' : ''}`;
  $('#hud-scale').textContent = `${(S.size * K.PIX / 60 / S.zoom).toFixed(1)}′ across · north up, east left`;
}

/** Stroke the current path in the selection colour over a contrasting under-stroke, so it shows on any pixel. */
function halo(g, dpr, dash = []) {
  g.setLineDash([]); g.strokeStyle = css('--bg'); g.lineWidth = 3.4 * dpr; g.stroke();
  g.setLineDash(dash); g.strokeStyle = css('--sel'); g.lineWidth = 1.4 * dpr; g.stroke();
  g.setLineDash([]); g.lineWidth = 1.2 * dpr;
}

function drawOverlay(cv, W, cur) {
  cv.width = cv.height = W;
  const g = cv.getContext('2d'), dpr = W / (cv.clientWidth || W), cell = W / view().sw, size = S.size;
  g.lineWidth = 1.2 * dpr;
  const f = S.frames[S.frame];
  if (S.flags && f && !cur.one) {              // three severities, not eight colours
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      const p = r * size + c;
      if (f.left[p] < 64 && f.caution[p] < 64 && f.changed[p] < 64) continue;
      const [x, y] = toScreen(c, r, W), x0 = x - cell / 2, y0 = y - cell / 2;
      if (x0 > W || y0 > W || x0 + cell < 0 || y0 + cell < 0) continue;
      if (f.left[p] >= 64) { g.strokeStyle = css('--left'); g.globalAlpha = 0.35 + 0.65 * f.left[p] / 255; g.beginPath(); g.moveTo(x0, y0 + cell); g.lineTo(x0 + cell, y0); g.stroke(); }
      else if (f.caution[p] >= 64) { g.strokeStyle = css('--caution'); g.globalAlpha = 0.3 + 0.6 * f.caution[p] / 255; g.strokeRect(x0 + 1, y0 + 1, cell - 2, cell - 2); }
      if (f.changed[p] >= 64) { g.fillStyle = css('--found'); g.globalAlpha = 0.9; g.beginPath(); g.arc(x, y, Math.max(1.5 * dpr, cell / 7), 0, 7); g.fill(); }
    }
    g.globalAlpha = 1;
  }
  const earth = S.search?.epochs[S.frame]?.earth, inView = (x, y) => x > -20 && y > -20 && x < W + 20 && y < W + 20;
  if (S.cats) {
    g.font = `${11 * dpr}px "IBM Plex Mono", monospace`;
    for (const o of S.catalog) {               // known objects, drawn where they should be on this date
      const [c, r] = K.toGrid(...K.propagate(o, cur.mjd, earth), S.c), [x, y] = toScreen(c, r, W);
      if (!inView(x, y)) continue;
      if (o.target) {                           // the named target: a dashed crosshair with a gap
        g.beginPath();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.moveTo(x + dx * 9 * dpr, y + dy * 9 * dpr); g.lineTo(x + dx * 22 * dpr, y + dy * 22 * dpr); }
        halo(g, dpr, [4 * dpr, 3 * dpr]);
        continue;
      }
      const named = o.src === 'SIMBAD';
      if (o.src === 'CatWISE' && S.zoom < 3 && !(totalPm(o) > 0.3 && totalPm(o) * 1000 > 5 * o.epm)) continue;   // CatWISE earns its place for real movers Gaia cannot see
      if (o.src === 'Gaia DR3' && S.zoom < 2 && !(o.mag <= 16.5)) continue;          // faint ones appear when zoomed in
      g.strokeStyle = g.fillStyle = css('--known'); g.globalAlpha = named ? 0.95 : 0.55;
      g.beginPath();
      if (o.src === 'CatWISE') g.rect(x - 4 * dpr, y - 4 * dpr, 8 * dpr, 8 * dpr); else g.arc(x, y, (named ? 7 : 4.5) * dpr, 0, 7);
      g.stroke();
      if (named && (totalPm(o) > 0.2 || S.zoom >= 2)) g.fillText(o.name, x + 10 * dpr, y - 8 * dpr);
    }
    g.globalAlpha = 1;
  }
  for (const m of S.movers) {                  // found by the scan
    const dt = (cur.mjd - m.mjd0) / 365.25, [x, y] = toScreen(m.col - m.pe * dt / K.PIX, m.row + m.pn * dt / K.PIX, W);
    g.strokeStyle = m.known ? css('--known') : css('--found'); g.lineWidth = 2 * dpr; g.beginPath(); g.arc(x, y, 9 * dpr, 0, 7); g.stroke(); g.lineWidth = 1.2 * dpr;
  }
  if (S.sel) {
    const [c, r] = selGrid(cur.mjd), [x, y] = toScreen(c, r, W);
    g.beginPath(); g.arc(x, y, 2.5 * cell, 0, 7); halo(g, dpr);
    g.strokeStyle = css('--sel');
    if (cur.one) { g.globalAlpha = 0.45; g.setLineDash([3 * dpr, 3 * dpr]); for (const rr of [5, 8]) { g.beginPath(); g.arc(x, y, rr * cell, 0, 7); g.stroke(); } g.setLineDash([]); g.globalAlpha = 1; }
  }
}

// ---------- plate rack ----------
function buildPlates() {
  const box = $('#plates'); box.replaceChildren();
  S.search.epochs.forEach((ep, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'plate'; b.role = 'option'; b.style.setProperty('--pc', epochColor(i));
    b.innerHTML = `<canvas></canvas><span>${esc(ep.label)}</span><small>${ep.n}</small>`;
    b.title = `${fmtDate(ep.mjd0)} to ${fmtDate(ep.mjd1)}: ${ep.n} exposures released`;
    b.onclick = () => { S.frame = i; setPlaying(false); renderAll(); syncUrl(); };
    b.onmouseenter = () => { if (S.playing) return; S.hoverFrame = S.frame; S.frame = i; renderEye(); };
    b.onmouseleave = () => { if (S.hoverFrame != null && !S.playing) { S.frame = S.hoverFrame; renderEye(); } S.hoverFrame = null; };
    box.append(b);
  });
}
function renderPlates() {
  [...$('#plates').children].forEach((b, i) => {
    const f = S.frames[i];
    b.setAttribute('aria-selected', i === S.frame);
    b.classList.toggle('empty', !f);
    paint(b.firstChild, f);
    b.lastChild.textContent = f ? `${f.count} stacked` : '—';
  });
}

// ---------- filter strip ----------
const wx = w => (LN(w) - L0) / (L1 - L0);                 // wavelength -> 0..1 along the strip (log scale)
const xw = x => Math.exp(L0 + Math.min(1, Math.max(0, x)) * (L1 - L0));
function buildStrip() {
  K.DET.forEach(([a, b], i) => {
    const s = document.createElement('button');
    s.type = 'button'; s.className = 'seg'; s.style.cssText = `left:${wx(a) * 100}%;width:${(wx(b) - wx(a)) * 100}%;background:var(--d${i + 1})`;
    s.innerHTML = `D${i + 1}<small>${a.toFixed(2)}–${b.toFixed(2)}</small>`;
    s.title = `Detector ${i + 1}: ${a.toFixed(2)} to ${b.toFixed(2)} µm`;
    s.onclick = () => setWindow(a, b);
    $('#segs').append(s);
  });
  const strip = $('#strip'), win = $('#win');
  let drag = null;
  const at = ev => (ev.clientX - strip.getBoundingClientRect().left) / strip.clientWidth;
  win.onpointerdown = ev => {
    stopSweep(); ev.preventDefault(); win.setPointerCapture(ev.pointerId);
    drag = { which: ev.target.id === 'h0' ? 0 : ev.target.id === 'h1' ? 1 : 2, x0: at(ev), a: wx(S.wmin), b: wx(S.wmax) };
  };
  win.onpointermove = ev => {
    if (!drag) return;
    const d = at(ev) - drag.x0, min = 0.012;
    if (drag.which === 0) setWindow(xw(Math.min(drag.a + d, drag.b - min)), S.wmax, false);
    else if (drag.which === 1) setWindow(S.wmin, xw(Math.max(drag.b + d, drag.a + min)), false);
    else { const w = drag.b - drag.a, a = Math.min(1 - w, Math.max(0, drag.a + d)); setWindow(xw(a), xw(a + w), false); }
  };
  win.onpointerup = win.onpointercancel = () => { drag = null; syncUrl(); };
  for (const [id, which] of [['h0', 0], ['h1', 1]]) $('#' + id).onkeydown = ev => {
    const step = ev.key === 'ArrowLeft' ? -0.01 : ev.key === 'ArrowRight' ? 0.01 : 0;
    if (!step) return;
    ev.preventDefault(); ev.stopPropagation();
    which ? setWindow(S.wmin, xw(Math.max(wx(S.wmax) + step, wx(S.wmin) + 0.012))) : setWindow(xw(Math.min(wx(S.wmin) + step, wx(S.wmax) - 0.012)), S.wmax);
  };
}
function setWindow(a, b, sync = true) {
  S.wmin = Math.max(K.WMIN, Math.min(a, b)); S.wmax = Math.min(K.WMAX, Math.max(a, b));
  dirty = true; computeFrames(); dirty = false;
  if (S.sel) { S.fit = fitMotion(); drawTimeChart(); }
  renderAll();
  if (sync) syncUrl();
}
function renderStrip() {
  const win = $('#win'), cv = $('#strip-ticks');
  win.style.left = `${wx(S.wmin) * 100}%`; win.style.width = `${(wx(S.wmax) - wx(S.wmin)) * 100}%`;
  $('#h0').setAttribute('aria-valuetext', `${S.wmin.toFixed(2)} micrometres`); $('#h1').setAttribute('aria-valuetext', `${S.wmax.toFixed(2)} micrometres`);
  cv.width = cv.clientWidth * devicePixelRatio; cv.height = 12 * devicePixelRatio;
  const g = cv.getContext('2d');
  g.fillStyle = css('--bg'); g.globalAlpha = 0.75;
  for (const e of S.exps) g.fillRect(Math.round(wx(e.wave) * cv.width), 0, Math.max(1, devicePixelRatio), cv.height);   // where data exists
}
function stopSweep() { if (S.sweep) { cancelAnimationFrame(S.sweep); S.sweep = null; $('#b-sweep').setAttribute('aria-pressed', false); } }
function sweep() {                 // slide a narrow window from 0.75 to 5.0 um
  if (S.sweep) return stopSweep();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $('#b-sweep').setAttribute('aria-pressed', true);
  const w = 0.14, t0 = performance.now(), dur = 9000;
  let last = 0;
  const step = now => {
    const u = (now - t0) / dur;
    if (u >= 1) { setWindow(xw(1 - w), K.WMAX); return stopSweep(); }
    if (now - last > 70) { last = now; setWindow(xw(u * (1 - w)), xw(u * (1 - w) + w), false); }
    S.sweep = requestAnimationFrame(step);
  };
  S.sweep = requestAnimationFrame(step);
}

// ---------- filmstrip: every exposure of the current date ----------
function renderFilm() {
  const box = $('#film'), list = S.exps.filter(e => e.epoch === S.frame && inBand(e)).sort((a, b) => a.wave - b.wave);
  box.replaceChildren(...list.slice(0, 160).map(e => {
    const f = document.createElement('figure'), cv = document.createElement('canvas');
    paint(cv, e);
    f.append(cv, `${e.wave.toFixed(2)} µm`);
    f.title = `${fmtDate(e.mjd)} · detector ${e.det} · ${e.wave.toFixed(3)} µm`;
    f.onmouseenter = () => { S.peek = e; renderEye(); };
    f.onmouseleave = () => { S.peek = null; renderEye(); };
    return f;
  }));
  if (!list.length) box.textContent = 'No exposures of this date in the chosen colour range.';
}

// ---------- selecting and measuring a source ----------
function selGrid(mjd) {            // where the selected source is on a date, following its motion
  const s = S.sel, dt = (mjd - s.mjd0) / 365.25;
  return K.toGrid(s.ra + s.pmra * dt / 3.6e6 / Math.cos(s.dec * Math.PI / 180), s.dec + s.pmde * dt / 3.6e6, S.c);
}

function selectGrid(col, row) {
  const f = S.frames[S.frame];
  if (!f) return;
  if (S.snap) {
    let best = -Infinity, bc = col, br = row;
    for (let r = Math.round(row) - 2; r <= Math.round(row) + 2; r++) for (let c = Math.round(col) - 2; c <= Math.round(col) + 2; c++) {
      if (r < 0 || c < 0 || r >= S.size || c >= S.size) continue;
      const v = f.img[r * S.size + c];
      if (v > best) { best = v; bc = c; br = r; }
    }
    const ce = K.centroid({ img: f.img, cat: new Uint8Array(S.size * S.size), noise: S.lim.sig }, S.size, bc, br);
    [col, row] = ce ? ce : [bc, br];
  }
  const [ra, dec] = K.fromGrid(col, row, S.c);
  selectSky(ra, dec, f.mjd);
}

function selectSky(ra, dec, mjd = S.frames[S.frame]?.mjd || K.REF_MJD, forced = null) {
  // a catalogue object within 1.5 px on this date lends its name and its proper motion
  const [col, row] = K.toGrid(ra, dec, S.c), earth = S.search?.epochs[S.frame]?.earth;
  let match = forced, md = 1.5;
  if (!match) for (const o of S.catalog) {
    const [c, r] = K.toGrid(...K.propagate(o, mjd, earth), S.c), d = Math.hypot(c - col, r - row) - (o.target ? 0.6 : o.src === 'SIMBAD' ? 0.3 : 0);
    if (d < md) { md = d; match = o; }
  }
  S.sel = { ra, dec, mjd0: mjd, pmra: match?.pmra || 0, pmde: match?.pmde || 0, match, measuredPm: false };
  measure(); syncUrl(); renderEye();
}

function measure() {
  const size = S.size, s = S.sel;
  const run = () => S.exps.map(e => {
    const [col, row] = selGrid(e.mjd);
    const a = K.aperture(e, size, col, row), cen = a.ok ? K.locate(e, size, col, row) : null, w = K.wingFlux(e, size, col, row);
    return { e, col, row, wave: K.waveAt(e, size, col, row), ...a, cen, wing: w.ok ? w.flux : NaN };
  }).filter(m => m.ok);
  S.meas = run();
  S.fit = fitMotion();
  // a source with no catalogue motion that clearly moves: follow the measured motion and measure again
  if (!s.match?.pmra && !s.measuredPm && S.fit && S.fit.total > 0.25 && S.fit.total > 6 * S.fit.err) {
    s.pmra += S.fit.pe * 1000; s.pmde += S.fit.pn * 1000; s.measuredPm = true;
    S.meas = run(); S.fit = fitMotion();
  }
  s.saturated = S.meas.filter(m => m.sat || m.hole).length > 0.3 * S.meas.length;
  showSource();
}

/** Proper motion from the centre of light in every exposure where the source is clearly detected. */
function fitMotion() {
  const s = S.sel, mid = (S.size - 1) / 2;
  let pts = S.meas.filter(m => m.cen && m.cen[2] > 10 && m.wave >= S.wmin && m.wave <= S.wmax), stacked = false;     // the line fit clips the odd bad one
  if (pts.length < 8) {          // too faint in single exposures: use its centre of light in each date's stack instead
    pts = S.frames.filter(Boolean).map(f => {
      const fake = { img: f.img, cat: new Uint8Array(S.size * S.size), noise: S.lim.sig, mjd: f.mjd, epoch: f.epoch.i };
      const cen = K.centroid(fake, S.size, ...selGrid(f.mjd));
      return cen && cen[2] > 4 ? { e: fake, cen } : null;
    }).filter(Boolean);
    stacked = true;
    if (pts.length < 3) return null;
  }
  const t = pts.map(m => (m.e.mjd - s.mjd0) / 365.25);
  // offsets on the sky in arcsec, measured from the grid centre: east is toward lower columns
  const east = pts.map(m => (mid - m.cen[0]) * K.PIX), north = pts.map(m => (m.cen[1] - mid) * K.PIX);
  const fe = K.lineFit(t, east), fn = K.lineFit(t, north);
  if (!fe || !fn) return null;
  return { pts, t, east, north, fe, fn, stacked, pe: fe.b, pn: fn.b, total: Math.hypot(fe.b, fn.b), err: Math.hypot(fe.eb, fn.eb), pa: (Math.atan2(fe.b, fn.b) * 180 / Math.PI + 360) % 360 };
}

function showSource() {
  const s = S.sel;
  $('#src').hidden = !s; $('#src-empty').hidden = !!s;
  if (!s) return;
  const good = S.meas.filter(m => !m.flagged), name = s.match?.name;
  $('#src-name').innerHTML = `<b>${esc(name || 'Unnamed source')}</b>${K.sexa(s.ra, s.dec)}`;
  const badges = [];
  if (s.match) badges.push(['known', `in ${s.match.src}${s.match.type ? ` (${s.match.type})` : ''}`]);
  const [sc, sr] = K.toGrid(s.ra, s.dec, S.c), gaia = S.catalog.filter(o => o.src === 'Gaia DR3');      // checked now, not at click time: Gaia may load later
  if (gaia.length && !gaia.some(o => { const [c, r] = K.toGrid(...K.propagate(o, s.mjd0), S.c); return Math.hypot(c - sc, r - sr) < 1.5; })) badges.push(['found', 'not in Gaia']);
  const holes = S.meas.filter(m => m.hole).length;
  if (s.saturated) badges.push(['warn', holes ? `saturated: core blank in ${holes} of ${S.meas.length} exposures` : 'saturated: brightness unreliable']);
  else if (S.meas.length - good.length) badges.push(['', `${S.meas.length - good.length} of ${S.meas.length} exposures flagged`]);
  if (s.measuredPm) badges.push(['found', 'following its measured motion']);
  $('#src-badges').innerHTML = badges.map(([c, t]) => `<span class="badge ${c}">${esc(t)}</span>`).join('');
  drawSpectrum(); drawTimeChart();
}

/** The source's own typical brightness at each wavelength: medians in log-spaced bins (fewer, wider bins when faint). */
function medianSpectrum(val) {
  const ok = S.meas.filter(m => isFinite(val(m)));
  const n = K.median(ok.map(m => Math.abs(val(m)) / m.err)) > 8 ? 60 : 20;
  const bin = w => Math.min(n - 1, Math.max(0, Math.floor(wx(w) * n)));       // wavelengths just outside the nominal range go in the end bins
  const bins = Array.from({ length: n }, () => []);
  for (const m of ok) bins[bin(m.wave)].push(val(m));
  const med = bins.map(b => (b.length >= 3 ? K.median(b) : NaN));
  return { med, n, at: w => med[bin(w)] };
}

/** A y-range that a few wild points cannot stretch: the 2nd to 98th percentile, padded, always including zero. */
function calmRange(v) {
  const lo = K.percentile(v, 0.02), hi = K.percentile(v, 0.98), pad = 0.3 * (hi - lo || Math.abs(hi) || 1);
  return [Math.min(0, lo - pad), hi + pad];
}

function drawSpectrum() {
  const sat = S.sel.saturated, usable = S.meas.filter(m => !m.hole);         // a blank core gives no flux at all
  const spec = medianSpectrum(m => (m.hole || (!sat && m.flagged) ? NaN : m.flux));
  const big = Math.max(...spec.med.filter(isFinite), 0) > 20000, u = big ? 1000 : 1, unit = big ? 'mJy' : 'µJy', dp = big ? 1 : 0;
  const line = spec.med.map((v, i) => [xw((i + 0.5) / spec.n), v / u]).filter(p => isFinite(p[1]));
  const good = usable.filter(m => !m.flagged);
  scatter($('#ch-spec'), {
    points: usable.map(m => ({ x: m.wave, y: m.flux / u, e: m.err / u, color: epochColor(m.e.epoch), hollow: m.flagged || m.sat, data: m,
      tip: `${m.wave.toFixed(3)} µm · ${fmtDate(m.e.mjd)}\n${(m.flux / u).toFixed(dp)} ± ${(m.err / u).toFixed(dp)} ${unit}${m.flux > 0 ? ` (AB ${K.abMag(m.flux).toFixed(2)})` : ''}${m.flagged ? '\nflagged pixel in aperture' : m.sat ? '\nnear saturation' : ''}` })),
    lines: [{ pts: line, color: css('--sel'), width: 1.5 }],
    bands: K.DET.map(([x0, x1], i) => ({ x0, x1, color: detColor(i + 1) })),
    marks: S.mol ? MOLECULES : [], xdom: [0.7, 5.1], xticks: [1, 2, 3, 4, 5], ylog: S.log,
    ydom: calmRange((good.length >= 5 ? good : usable).map(m => m.flux / u)),
    xlabel: 'wavelength (µm)', ylabel: `flux density (${unit})`,
    summary: `Spectrum: ${S.meas.length} measurements from ${K.WMIN} to ${K.WMAX} micrometres.`,
    onHover: p => { S.peek = p ? p.data.e : null; renderEye(); },
  });
  const peak = line.reduce((a, b) => (b[1] > a[1] ? b : a), [0, -Infinity]);
  $('#spec-sum').textContent = !line.length ? 'No usable measurements here: the core is blank (saturated) in every exposure. Brightness over time below uses its outer light.' :
    `${usable.length} measurements, one per exposure. Typical peak ${peak[1].toFixed(dp)} ${unit} (AB ${K.abMag(peak[1] * u).toFixed(1)}) near ${peak[0].toFixed(2)} µm. ` +
    (sat ? `Too bright for SPHEREx: ${S.meas.length - usable.length} exposures have a blank core and are not shown, and the rest (hollow) are near saturation, so treat this as a rough lower limit. `
      : 'Aperture fluxes (radius 15″), no aperture correction: expect about 10 % low. ') + 'Hover a point to see the exposure it came from.';
  const rows = ['wavelength_um,flux_uJy,err_uJy,mjd,detector,flagged,near_saturation,file'].concat(S.meas.map(m =>
    [m.wave.toFixed(4), m.flux.toFixed(2), m.err.toFixed(2), m.e.mjd, m.e.det, +m.flagged, +m.sat, m.e.key.split('/').pop()].join(',')));
  $('#c-csv').href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
}

function drawTimeChart() {
  const s = S.sel;
  if (!s) return;
  const xfmt = v => monthYear(v);
  if (S.tab === 'pm') {
    const f = S.fit;
    if (!f) { scatter($('#ch-time'), { points: [], empty: 'Too faint to track in single exposures' }); $('#time-sum').textContent = ''; return; }
    const mj = f.pts.map(m => m.e.mjd), t2m = t => s.mjd0 + t * 365.25, ends = [Math.min(...f.t), Math.max(...f.t)];
    const pt = (y, i, hollow, lab) => ({ x: mj[i], y, color: epochColor(f.pts[i].e.epoch), hollow, tip: `${fmtDate(mj[i])}\n${lab} ${y >= 0 ? '+' : ''}${y.toFixed(2)}″` });
    scatter($('#ch-time'), {
      points: f.north.map((y, i) => pt(y - f.fn.a, i, false, 'north')).concat(f.east.map((y, i) => pt(y - f.fe.a, i, true, 'east'))),
      lines: [{ pts: ends.map(t => [t2m(t), f.fn.b * (t - f.fn.t0)]), color: css('--sel'), label: 'north' },
        { pts: ends.map(t => [t2m(t), f.fe.b * (t - f.fe.t0)]), color: css('--sel'), dash: '4 3', label: 'east' }],
      xlabel: 'date', ylabel: 'shift (arcsec)', xfmt, summary: `Position over time: moving ${f.total.toFixed(2)} arcseconds per year.`,
    });
    const cat = s.match && totalPm(s.match) > 0 ? ` Catalogue (${s.match.src}): ${totalPm(s.match).toFixed(2)}″/yr toward ${((Math.atan2(s.match.pmra, s.match.pmde) * 180 / Math.PI + 360) % 360).toFixed(0)}°.` : '';
    const sig = f.total / f.err, cpm = s.match ? totalPm(s.match) : 0;
    const clash = cpm > 0.5 && Math.hypot(f.pe - s.match.pmra / 1000, f.pn - s.match.pmde / 1000) > Math.max(5 * f.err, 0.3 * cpm);
    $('#time-sum').textContent = `Measured from ${f.pts.length} ${f.stacked ? 'stacked dates (too faint in single exposures)' : 'exposures'} at ${S.wmin.toFixed(2)}–${S.wmax.toFixed(2)} µm: ` +
      `${f.total.toFixed(2)} ± ${f.err.toFixed(2)}″ per year toward ${f.pa.toFixed(0)}° (north = 0°, east = 90°).${sig < 4 ? ' That is not a significant motion.' : ''}${cat}` +
      (clash ? ' These do not agree: at these wavelengths the light here may come from a background star. Try another colour window.' : '') +
      (s.saturated ? ' Located from the star’s outer light, which is less precise.' : '') + ' Filled = north, hollow = east.';
    return;
  }
  // brightness over time: each point divided by the source's own typical brightness at that wavelength,
  // so all colours in the window count toward one curve. Saturated stars use their unsaturated outer light.
  const val = s.saturated ? m => m.wing : m => (m.flagged ? NaN : m.flux), spec = medianSpectrum(val);
  const pts = S.meas.filter(m => !m.flagged && m.wave >= S.wmin && m.wave <= S.wmax).map(m => ({ m, rel: val(m) / spec.at(m.wave) })).filter(p => isFinite(p.rel) && spec.at(p.m.wave) > 0);
  const means = S.search.epochs.map(ep => { const v = pts.filter(p => p.m.e.epoch === ep.i); return v.length >= 3 ? [K.median(v.map(p => p.m.e.mjd)), K.median(v.map(p => p.rel))] : null; }).filter(Boolean);
  scatter($('#ch-time'), {
    points: pts.map(p => ({ x: p.m.e.mjd, y: p.rel, color: epochColor(p.m.e.epoch), tip: `${fmtDate(p.m.e.mjd)} · ${p.m.wave.toFixed(2)} µm\n${p.rel.toFixed(2)} × its average` })),
    lines: [{ pts: means, color: css('--sel'), width: 1.5 }], xlabel: 'date', ylabel: 'brightness ÷ own average', xfmt,
    ydom: pts.length ? calmRange(pts.map(p => p.rel).concat(2)) : undefined,
    summary: `Brightness over time from ${pts.length} measurements.`,
  });
  const lo = Math.min(...means.map(p => p[1])), hi = Math.max(...means.map(p => p[1]));
  $('#time-sum').textContent = !means.length ? 'Not enough clean measurements in this colour range.' :
    `Per-date medians range from ${lo.toFixed(2)} to ${hi.toFixed(2)} × the average` + (means.length > 1 ? ` (${(2.5 * Math.log10(hi / lo)).toFixed(2)} mag).` : '.') +
    (s.saturated ? ' Measured from the star’s unsaturated outer light (ring 25–49″), because its core is saturated.' : '') + ' Each point is divided by this source’s own spectrum, so every colour in the window counts.';
}

// ---------- the field list and the motion scan ----------
function buildField() {
  const half = (S.size - 1) / 2;
  const items = S.catalog.filter(o => o.src === 'SIMBAD' || o.target).map(o => ({ o, g: K.toGrid(...K.propagate(o, K.REF_MJD), S.c) }))
    .filter(x => Math.abs(x.g[0] - half) < half && Math.abs(x.g[1] - half) < half).sort((a, b) => totalPm(b.o) - totalPm(a.o)).slice(0, 40);
  const li = (cls, name, meta, on) => { const e = document.createElement('li'); e.innerHTML = `<span class="dot ${cls}"></span><span>${esc(name)}</span><span class="m">${esc(meta)}</span>`; e.onclick = on; return e; };
  $('#field').replaceChildren(
    ...S.movers.map(m => li(m.known ? '' : 'found', m.known ? m.known.name : 'Uncatalogued mover', `measured ${m.total.toFixed(2)} ± ${m.err.toFixed(2)}″/yr${m.known ? ` · catalogue ${totalPm(m.known).toFixed(2)}` : ''}`, () => { const [ra, dec] = K.fromGrid(m.col, m.row, S.c); selectSky(ra, dec, m.mjd0); })),
    ...items.map(({ o }) => li('', o.name, `${o.type || ''}${totalPm(o) > 0.05 ? ` · ${totalPm(o).toFixed(2)}″/yr` : ''}`, () => { const [ra, dec] = K.propagate(o, S.frames[S.frame]?.mjd || K.REF_MJD); selectSky(ra, dec, undefined, o); })));
  if (!S.movers.length) $('#field-note').textContent = items.length ? 'Named objects in view, fastest first. Click one to measure it.' : '';
}

async function scan() {             // measure the motion of every bright dot; list the ones that move
  const gen = S.gen, size = S.size, btn = $('#b-scan');
  if (S.exps.length < 20) return;
  btn.disabled = true; S.movers = [];
  const all = K.stack(S.exps, size), [med, sig] = K.robust(all.img);
  const peaks = K.findPeaks(all.img, size, med + 15 * sig, 3, 5).slice(0, 150), mid = (size - 1) / 2, mjd0 = K.median(S.exps.map(e => e.mjd));
  for (let i = 0; i < peaks.length; i++) {
    if (i % 8 === 0) { $('#field-note').textContent = `Scanning ${i + 1} of ${peaks.length} sources…`; await new Promise(requestAnimationFrame); if (gen !== S.gen) return; }
    const [pc, pr] = peaks[i];
    const track = (pe, pn, c0, r0) => {         // centre of light in every exposure, starting from where a mover would be
      const t = [], east = [], north = [];
      for (const e of S.exps) {
        const dt = (e.mjd - mjd0) / 365.25, c = K.locate(e, size, c0 - pe * dt / K.PIX, r0 + pn * dt / K.PIX);
        if (c && c[2] > 10) { t.push(dt); east.push((mid - c[0]) * K.PIX); north.push((c[1] - mid) * K.PIX); }
      }
      return [K.lineFit(t, east), K.lineFit(t, north)];
    };
    let [fe, fn] = track(0, 0, pc, pr);
    if (!fe || !fn || fe.n < 15) continue;
    if (Math.hypot(fe.b, fn.b) < 0.3 || Math.hypot(fe.b, fn.b) < 6 * Math.hypot(fe.eb, fn.eb)) continue;
    const again = track(fe.b, fn.b, mid - fe.a / K.PIX, mid + fn.a / K.PIX);      // follow the first estimate and measure again
    if (again[0] && again[1]) [fe, fn] = again;
    const total = Math.hypot(fe.b, fn.b), err = Math.hypot(fe.eb, fn.eb);
    if (total < 0.3 || total < 6 * err) continue;
    const col = mid - fe.a / K.PIX, row = mid + fn.a / K.PIX;
    const known = S.catalog.filter(o => o.src !== 'CatWISE').map(o => ({ o, d: Math.hypot(...K.toGrid(...K.propagate(o, mjd0), S.c).map((v, k) => v - [col, row][k])) })).filter(x => x.d < 1.8).sort((a, b) => a.d - b.d)[0]?.o;
    S.movers.push({ col, row, pe: fe.b, pn: fn.b, total, err, mjd0, known });
  }
  S.movers.sort((a, b) => b.total - a.total);
  btn.disabled = false;
  const fresh = S.movers.filter(m => !m.known).length;
  $('#field-note').textContent = `${peaks.length} sources measured. ${S.movers.length} move${S.movers.length === 1 ? 's' : ''} faster than 0.3″ per year` +
    (S.movers.length ? `; ${fresh} ${fresh === 1 ? 'is' : 'are'} not in Gaia or SIMBAD.` : '.') + (S.movers.length ? ' A star beside a bright mover can be dragged along by its glow: compare with the catalogue value, and check with the flags overlay.' : '');
  buildField(); renderEye();
}

// ---------- play ----------
let playTimer = null;
function setPlaying(on) {
  S.playing = on; $('#play').textContent = on ? 'Pause' : 'Play'; $('#play').setAttribute('aria-pressed', on);
  clearInterval(playTimer);
  if (on) playTimer = setInterval(() => step(1, true), 1000 / S.fps);          // a hard cut: a fade would hide small motions
}
function step(d, auto = false) {
  const n = S.search?.epochs.length || 0;
  if (!n) return;
  if (!auto) setPlaying(false);
  for (let k = 0; k < n; k++) { S.frame = (S.frame + d + n) % n; if (S.frames[S.frame] || !S.frames.some(Boolean)) break; }
  renderEye(); renderPlates();
  if (!$('#film').hidden && !auto) renderFilm();
}

// ---------- sharing ----------
function syncUrl() {
  const t = S.target, p = new URLSearchParams();
  if (!t) return;
  if (t.name) p.set('target', t.name); else { p.set('ra', t.ra); p.set('dec', t.dec); }
  if (S.size !== 64) p.set('fov', S.size);
  if (S.wmin > K.WMIN + 1e-3 || S.wmax < K.WMAX - 1e-3) { p.set('wmin', S.wmin.toFixed(3)); p.set('wmax', S.wmax.toFixed(3)); }
  if (!S.playing) p.set('epoch', S.frame + 1);
  if (S.diff) p.set('mode', 'difference'); else if (S.rgb) p.set('mode', 'colour');
  if (S.sel) p.set('sel', `${S.sel.ra.toFixed(5)},${S.sel.dec.toFixed(5)}`);
  if (params.has('embed')) p.set('embed', 1);
  if (API) p.set('api', API);
  history.replaceState(null, '', `?${p}`);
}

function compose() {               // the eyepiece with its labels, as one canvas, for PNG and video export
  const W = 720, ov = document.createElement('canvas'), out = document.createElement('canvas');
  const draw = () => {
    const cur = current(); paint(off, cur.src);
    out.width = out.height = W;
    const g = out.getContext('2d'), v = view();
    g.imageSmoothingEnabled = false; g.drawImage(off, v.sx, v.sy, v.sw, v.sw, 0, 0, W, W);
    drawOverlay(ov, W, cur); g.drawImage(ov, 0, 0);
    const plate = document.querySelector('meta[name="color-scheme"]').content === 'light';
    g.font = '500 15px "IBM Plex Mono", monospace'; g.fillStyle = plate ? '#1B1A17' : '#ECE8E1'; g.shadowColor = plate ? '#F7F4EC' : '#000'; g.shadowBlur = 4;
    g.fillText(`${S.target.name || `${S.target.ra} ${S.target.dec}`}`, 12, 24);
    g.fillText(`${fmtDate(cur.mjd)}  ·  ${S.wmin.toFixed(2)}–${S.wmax.toFixed(2)} µm`, 12, 46);
    g.fillText('NASA SPHEREx · Blink 102', 12, W - 12); g.shadowBlur = 0;
  };
  return { out, draw };
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
const slug = () => (S.target?.name || 'sky').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
function savePng() { const c = compose(); c.draw(); c.out.toBlob(b => download(b, `blink102-${slug()}.png`)); }
function saveVideo() {
  const type = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => window.MediaRecorder?.isTypeSupported(t));
  if (!type) return notice('This browser cannot record video. Save PNG frames instead.', true);
  const c = compose(), n = S.search.epochs.length, was = S.playing, btn = $('#t-vid');
  setPlaying(false); btn.disabled = true; btn.textContent = 'Recording…';
  c.draw();
  const rec = new MediaRecorder(c.out.captureStream(30), { mimeType: type, videoBitsPerSecond: 6e6 }), parts = [];
  rec.ondataavailable = e => parts.push(e.data);
  rec.onstop = () => { download(new Blob(parts, { type }), `blink102-${slug()}.${type.includes('mp4') ? 'mp4' : 'webm'}`); btn.disabled = false; btn.textContent = 'Save video'; setPlaying(was); };
  rec.start();
  let k = 0;
  const tick = setInterval(() => { if (k >= n * 4) { clearInterval(tick); return rec.stop(); } step(1, true); c.draw(); k++; }, 1000 / S.fps);
}

// ---------- wider sky (Aladin Lite), loaded only when opened ----------
let aladin = null;
async function wider() {
  const t = S.target, note = $('#wide-note');
  try {
    if (!window.A) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js'; s.onload = ok; s.onerror = no; document.head.append(s); setTimeout(no, 15000); });
    await window.A.init;
    const fov = S.size * K.PIX / 3600;
    if (!aladin) aladin = window.A.aladin('#aladin', { survey: 'P/allWISE/color', cooFrame: 'ICRSd', showLayersControl: true, showCooGridControl: false, showFullscreenControl: false });
    aladin.gotoRaDec(t.ra, t.dec); aladin.setFoV(fov * 4);
    const box = window.A.graphicOverlay({ color: '#ffffff', lineWidth: 2 });
    aladin.removeLayers?.(); aladin.addOverlay(box);
    const h = fov / 2, cd = Math.cos(t.dec * Math.PI / 180);
    box.add(window.A.polygon([[t.ra - h / cd, t.dec - h], [t.ra + h / cd, t.dec - h], [t.ra + h / cd, t.dec + h], [t.ra - h / cd, t.dec + h]]));
    aladin.addCatalog(window.A.catalogFromVizieR('I/355/gaiadr3', `${t.ra} ${t.dec}`, fov, { onClick: 'showTable', color: '#6EE7B7', name: 'Gaia DR3' }));
    aladin.addCatalog(window.A.catalogFromVizieR('II/328/allwise', `${t.ra} ${t.dec}`, fov, { onClick: 'showTable', color: '#F5BE4A', name: 'AllWISE' }));
    note.textContent = 'AllWISE (NASA WISE) colour image from the Aladin sky atlas, with Gaia DR3 and AllWISE catalogue points. The white square is the field shown above. Use the layers button to switch to 2MASS or DSS.';
  } catch {
    note.textContent = 'The Aladin sky atlas (CDS, Strasbourg) did not load. Everything else on this page works without it.';
  }
}

// ---------- wiring ----------
function toggle(id, key, after) {
  const b = $(id);
  b.onclick = () => { S[key] = !S[key]; b.setAttribute('aria-pressed', S[key]); after?.(); };
  return () => b.click();
}
const keys = {};
function init() {
  if (params.has('embed')) document.body.classList.add('embed');
  buildStrip();
  for (const name of PRESETS) { const b = document.createElement('button'); b.type = 'button'; b.textContent = name; b.onclick = () => go(name); $('#presets').append(b); }
  $('#search').onsubmit = ev => { ev.preventDefault(); go($('#q').value); };
  const restack = () => { computeFrames(); renderAll(); syncUrl(); };
  keys.d = toggle('#t-diff', 'diff', () => { if (S.diff && S.rgb) { S.rgb = false; $('#t-rgb').setAttribute('aria-pressed', false); } restack(); });
  keys.c = toggle('#t-rgb', 'rgb', () => { if (S.rgb && S.diff) { S.diff = false; $('#t-diff').setAttribute('aria-pressed', false); } restack(); });
  keys.f = toggle('#t-flags', 'flags', renderEye);
  keys.g = toggle('#t-cat', 'cats', renderEye);
  toggle('#t-snap', 'snap');
  keys.s = sweep; $('#b-sweep').onclick = sweep;
  keys['0'] = () => { stopSweep(); setWindow(K.WMIN, K.WMAX); }; $('#b-all').onclick = keys['0'];
  K.DET.forEach(([a, b], i) => { keys[i + 1] = () => { stopSweep(); setWindow(a, b); }; });
  keys['['] = () => { const a = wx(S.wmin), b = wx(S.wmax), m = (a + b) / 2, h = Math.max(0.03, (b - a) / 2 * 0.8); setWindow(xw(m - h), xw(m + h)); };
  keys[']'] = () => { const a = wx(S.wmin), b = wx(S.wmax), m = (a + b) / 2, h = (b - a) / 2 * 1.25; setWindow(xw(m - h), xw(m + h)); };
  const zoom = (f, x = 0.5, y = 0.5) => { const v = view(), gx = v.sx + x * v.sw, gy = v.sy + y * v.sw; S.zoom = Math.min(12, Math.max(1, S.zoom * f)); const sw = S.size / S.zoom; S.vx = gx - (x - 0.5) * sw; S.vy = gy - (y - 0.5) * sw; renderEye(); };
  keys['+'] = keys['='] = () => zoom(1.5); keys['-'] = () => zoom(1 / 1.5);
  $('#t-zin').onclick = keys['+']; $('#t-zout').onclick = keys['-'];
  keys.i = () => { const m = document.querySelector('meta[name="color-scheme"]'), plate = m.content !== 'light'; m.content = plate ? 'light' : 'dark';
    try { plate ? localStorage.setItem('blink-theme', 'light') : localStorage.removeItem('blink-theme'); } catch {}
    $('#b-theme').setAttribute('aria-pressed', plate); buildPlatesColors(); renderAll(); if (S.sel) showSource(); };
  $('#b-theme').onclick = keys.i; $('#b-theme').setAttribute('aria-pressed', document.querySelector('meta[name="color-scheme"]').content === 'light');
  keys[' '] = () => setPlaying(!S.playing); $('#play').onclick = keys[' '];
  keys.arrowleft = () => step(-1); keys.arrowright = () => step(1);
  keys['?'] = () => $('#help').showModal();
  if (!('command' in HTMLButtonElement.prototype)) $('#b-help').onclick = keys['?'];     // browsers without invoker commands
  addEventListener('keydown', ev => {
    if (ev.target.matches('input, select, textarea') || ev.metaKey || ev.ctrlKey || ev.altKey || $('#help').open) return;
    const k = keys[ev.key.toLowerCase()];
    if (k) { ev.preventDefault(); k(); }
  });
  $('#fps').oninput = ev => { S.fps = +ev.target.value; if (S.playing) setPlaying(true); };
  $('#t-bright').oninput = ev => { S.bright = +ev.target.value; renderAll(); };
  $('#t-fov').onchange = ev => { S.size = +ev.target.value; if (S.target) loadTarget(S.target); };
  $('#t-png').onclick = savePng; $('#t-vid').onclick = saveVideo;
  $('#b-link').onclick = async () => { syncUrl(); try { await navigator.clipboard.writeText(location.href); $('#b-link').textContent = 'Copied'; } catch { $('#b-link').textContent = 'Copy from address bar'; } setTimeout(() => ($('#b-link').textContent = 'Copy link'), 1600); };
  $('#b-more').onclick = async () => { $('#b-more').hidden = true; const have = new Set(S.exps.map(e => e.key)); await fetchChunks(K.planChunks(S.search.exposures, 1e9, have).map(keys => ({ keys })), S.gen); };
  $('#b-scan').onclick = scan;
  const drawer = (btn, box, open) => { $(btn).onclick = () => { const on = $(box).hidden; $(box).hidden = !on; $(btn).setAttribute('aria-expanded', on); if (on) open(); }; };
  drawer('#b-film', '#film', renderFilm); drawer('#b-wide', '#wide', wider);
  $('#c-log').onclick = () => { S.log = !S.log; $('#c-log').setAttribute('aria-pressed', S.log); drawSpectrum(); };
  $('#c-mol').onclick = () => { S.mol = !S.mol; $('#c-mol').setAttribute('aria-pressed', S.mol); drawSpectrum(); };
  for (const [id, tab] of [['#s-lc', 'lc'], ['#s-pm', 'pm']]) $(id).onclick = () => { S.tab = tab; $('#s-lc').setAttribute('aria-selected', tab === 'lc'); $('#s-pm').setAttribute('aria-selected', tab === 'pm'); drawTimeChart(); };

  // the eyepiece: click to select, wheel to zoom, drag to pan
  const eye = $('#eye');
  let down = null;
  eye.onpointerdown = ev => { down = { x: ev.clientX, y: ev.clientY, vx: S.vx, vy: S.vy, moved: false }; eye.setPointerCapture(ev.pointerId); };
  eye.onpointermove = ev => {
    if (!down) return;
    const dx = ev.clientX - down.x, dy = ev.clientY - down.y;
    if (Math.hypot(dx, dy) > 4) down.moved = true;
    if (down.moved && S.zoom > 1) { const k = view().sw / eye.clientWidth; S.vx = down.vx - dx * k; S.vy = down.vy - dy * k; renderEye(); }
  };
  eye.onpointerup = ev => {
    if (down && !down.moved) { const r = eye.getBoundingClientRect(), [c, row] = toGridXY(ev.clientX - r.left, ev.clientY - r.top, r.width); setPlaying(false); selectGrid(c, row); }
    down = null;
  };
  eye.addEventListener('wheel', ev => { ev.preventDefault(); const r = eye.getBoundingClientRect(); zoom(ev.deltaY < 0 ? 1.2 : 1 / 1.2, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height); }, { passive: false });
  new ResizeObserver(() => renderAll()).observe(eye);

  try { if (!localStorage.getItem('blink-coach') && !params.has('embed')) $('#coach').hidden = false; } catch {}
  $('#coach-ok').onclick = () => { $('#coach').hidden = true; try { localStorage.setItem('blink-coach', '1'); } catch {} };
}
function buildPlatesColors() { [...$('#plates').children].forEach((b, i) => b.style.setProperty('--pc', epochColor(i))); }

async function start() {
  init();
  try { cacheIndex = await (await fetch('cache/index.json')).json(); } catch { cacheIndex = []; }
  if (params.get('fov')) { S.size = Math.min(160, Math.max(24, +params.get('fov') || 64)); $('#t-fov').value = S.size; }
  if (params.get('wmin')) { S.wmin = Math.max(K.WMIN, +params.get('wmin')); S.wmax = Math.min(K.WMAX, +params.get('wmax') || K.WMAX); }
  if (params.get('mode') === 'difference') { S.diff = true; $('#t-diff').setAttribute('aria-pressed', true); }
  if (params.get('mode') === 'colour') { S.rgb = true; $('#t-rgb').setAttribute('aria-pressed', true); }
  if (params.get('epoch')) { S.frame = Math.max(0, +params.get('epoch') - 1); S.playing = false; }
  setPlaying(S.playing);
  const q = params.get('target') || (params.get('ra') ? `${params.get('ra')} ${params.get('dec')}` : PRESETS[0]);     // it never opens empty
  go(q, { keepView: params.has('epoch') });
}
start();
