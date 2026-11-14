// Blink 102: one small SVG scatter chart, used for the spectrum, the brightness history and the motion track.
// Written during NASA Space Apps 2026 with AI assistance (Claude); see README "AI use".

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
};

function ticks(lo, hi, n = 5) {
  const span = hi - lo, step0 = 10 ** Math.floor(Math.log10(span / n));
  const step = [1, 2, 5, 10].map(m => m * step0).find(s => span / s <= n + 1);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

const logTicks = (lo, hi) => {
  const out = [];
  for (let d = Math.floor(Math.log10(lo)); d <= Math.ceil(Math.log10(hi)); d++)
    for (const m of [1, 2, 5]) { const v = m * 10 ** d; if (v >= lo && v <= hi) out.push(v); }
  return out;
};

const fmt = v => (Math.abs(v) >= 10000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(0).replace('e+', 'e') : String(+v.toPrecision(4)));

/**
 * Draw into an <svg>. opts:
 *   points [{x, y, e, color, hollow, tip, data}]   lines [{pts: [[x, y]], color, width, dash}]
 *   bands [{x0, x1, color, label}]  marks [{x0, x1, label}]  xdom, ydom, ylog, xlabel, ylabel, xfmt, summary
 *   onHover(point | null)
 */
export function scatter(svg, o) {
  const W = svg.clientWidth || 420, H = svg.clientHeight || 220;
  const m = { l: 52, r: 10, t: o.marks?.length ? 20 : 8, b: 34 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', o.summary || '');
  svg.replaceChildren();
  const pts = o.points.filter(p => isFinite(p.x) && isFinite(p.y) && (!o.ylog || p.y > 0) && (!o.ydom || o.ylog || (p.y >= o.ydom[0] && p.y <= o.ydom[1])));
  if (!pts.length) {
    svg.append(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'ch-empty' }, o.empty || 'No measurements'));
    return;
  }
  const ext = (f, pad) => { const v = pts.map(f), a = Math.min(...v), b = Math.max(...v), d = (b - a || Math.abs(a) || 1) * pad; return [a - d, b + d]; };
  const xd = o.xdom || ext(p => p.x, 0.04);
  let yd = o.ydom || ext(p => p.y, 0.08);
  if (o.ylog) { const v = pts.map(p => p.y); yd = [Math.min(...v) / 1.4, Math.max(...v) * 1.4]; }
  else if (o.yzero && yd[0] > 0) yd[0] = 0;
  let area = null;
  const X = x => m.l + (x - xd[0]) / (xd[1] - xd[0]) * (W - m.l - m.r);
  const Y = o.ylog ? y => H - m.b - (Math.log(y) - Math.log(yd[0])) / (Math.log(yd[1]) - Math.log(yd[0])) * (H - m.t - m.b)
    : y => H - m.b - (y - yd[0]) / (yd[1] - yd[0]) * (H - m.t - m.b);

  if (o.area && o.area.pts.length > 1) {
    const id = `ramp${Math.random().toString(36).slice(2, 8)}`, gr = el('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: X(xd[0]), x2: X(xd[1]), y1: 0, y2: 0 });
    for (const [x, c] of o.area.stops) gr.append(el('stop', { offset: ((x - xd[0]) / (xd[1] - xd[0])).toFixed(4), 'stop-color': c }));
    const fade = el('linearGradient', { id: id + 'f', x1: 0, x2: 0, y1: 0, y2: 1 });
    fade.append(el('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 1 }), el('stop', { offset: 1, 'stop-color': '#fff', 'stop-opacity': 0.15 }));
    const mask = el('mask', { id: id + 'm' }); mask.append(el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${id}f)` }));
    svg.append(gr, fade, mask);
    const base = o.ylog ? H - m.b : Y(Math.max(yd[0], 0)), ps = o.area.pts.filter(q => isFinite(q[1]) && (!o.ylog || q[1] > 0));
    if (ps.length > 1) {
      const d = `M${X(ps[0][0]).toFixed(1)} ${base}` + ps.map(q => `L${X(q[0]).toFixed(1)} ${Math.min(base, Y(q[1])).toFixed(1)}`).join('') + `L${X(ps[ps.length - 1][0]).toFixed(1)} ${base}Z`;
      area = el('path', { d, fill: `url(#${id})`, mask: `url(#${id}m)`, opacity: o.area.opacity ?? 0.45 });
    }
  }
  for (const b of o.bands || []) {
    const x0 = Math.max(X(b.x0), m.l), x1 = Math.min(X(b.x1), W - m.r);
    if (x1 > x0) svg.append(el('rect', { x: x0, y: m.t, width: x1 - x0, height: H - m.t - m.b, fill: b.color, opacity: 0.09 }));
  }
  for (const v of (o.ylog ? logTicks(yd[0], yd[1]) : ticks(yd[0], yd[1], 4))) {
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'ch-grid' }));
    svg.append(el('text', { x: m.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'ch-tick' }, fmt(v)));
  }
  for (const v of o.xticks || ticks(xd[0], xd[1], 6)) {
    svg.append(el('line', { x1: X(v), x2: X(v), y1: H - m.b, y2: H - m.b + 4, class: 'ch-axis' }));
    svg.append(el('text', { x: X(v), y: H - m.b + 15, 'text-anchor': 'middle', class: 'ch-tick' }, o.xfmt ? o.xfmt(v) : fmt(v)));
  }
  svg.append(el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'ch-axis' }));
  if (!o.ylog && yd[0] < 0 && yd[1] > 0) svg.append(el('line', { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), class: 'ch-zero' }));
  svg.append(el('text', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle', class: 'ch-label' }, o.xlabel || ''));
  svg.append(el('text', { x: 11, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', class: 'ch-label', transform: `rotate(-90 11 ${(m.t + H - m.b) / 2})` }, o.ylabel || ''));
  for (const k of o.marks || []) {        // molecule brackets along the top
    const x0 = X(k.x0), x1 = X(k.x1);
    svg.append(el('path', { d: `M${x0} ${m.t - 2}v-4H${x1}v4`, class: 'ch-mark' }));
    svg.append(el('text', { x: (x0 + x1) / 2, y: m.t - 9, 'text-anchor': 'middle', class: 'ch-tick' }, k.label));
  }
  const g = el('g'), lines = el('g');
  if (area) g.append(area);
  if (o.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const id = `wipe${Math.random().toString(36).slice(2, 8)}`, cp = el('clipPath', { id }), r = el('rect', { x: 0, y: 0, width: 0, height: H });
    r.append(el('animate', { attributeName: 'width', from: 0, to: W, dur: '1.1s', fill: 'freeze', calcMode: 'spline', keyTimes: '0;1', keySplines: '.25 .7 .2 1' }));
    cp.append(r); svg.append(cp);
    g.setAttribute('clip-path', `url(#${id})`); lines.setAttribute('clip-path', `url(#${id})`);
  }
  for (const p of pts) {
    if (p.e > 0 && !o.ylog) g.append(el('line', { x1: X(p.x), x2: X(p.x), y1: Y(p.y - p.e), y2: Y(p.y + p.e), stroke: p.color, 'stroke-width': 1, opacity: 0.45 }));
    g.append(el('circle', { cx: X(p.x), cy: Y(p.y), r: p.hollow ? 2.6 : 3, fill: p.hollow ? 'none' : p.color, stroke: p.color, 'stroke-width': p.hollow ? 1 : 0, opacity: p.hollow ? 0.6 : 0.95 }));
  }
  svg.append(g, lines);
  for (const l of o.lines || []) {
    const d = l.pts.filter(q => isFinite(q[1]) && (!o.ylog || q[1] > 0)).map((q, i) => `${i ? 'L' : 'M'}${X(q[0]).toFixed(1)} ${Y(q[1]).toFixed(1)}`).join('');
    if (d) lines.append(el('path', { d, fill: 'none', stroke: l.color || 'currentColor', 'stroke-width': l.width || 1.5, 'stroke-dasharray': l.dash || '', 'stroke-linejoin': 'round' }));
    if (l.label && l.pts.length) {
      const q = l.pts[l.pts.length - 1];
      lines.append(el('text', { x: Math.min(X(q[0]) + 4, W - m.r - 2), y: Y(q[1]) - 5, 'text-anchor': 'end', class: 'ch-tick' }, l.label));
    }
  }
  // hover: nearest point within 24 px, a ring on it and a tooltip
  const ring = el('circle', { r: 6, class: 'ch-ring', visibility: 'hidden' });
  svg.append(ring);
  const tip = svg.parentElement.querySelector('.ch-tip');
  svg.onmousemove = ev => {
    const r = svg.getBoundingClientRect(), mx = (ev.clientX - r.left) * W / r.width, my = (ev.clientY - r.top) * H / r.height;
    let best = null, bd = 24;
    for (const p of pts) { const d = Math.hypot(X(p.x) - mx, Y(p.y) - my); if (d < bd) { bd = d; best = p; } }
    ring.setAttribute('visibility', best ? 'visible' : 'hidden');
    if (best) { ring.setAttribute('cx', X(best.x)); ring.setAttribute('cy', Y(best.y)); }
    if (tip) {
      tip.hidden = !best;
      if (best) { tip.textContent = best.tip; tip.style.left = `${Math.min(X(best.x) / W * r.width + 10, r.width - 190)}px`; tip.style.top = `${Math.max(Y(best.y) / H * r.height - 44, 0)}px`; }
    }
    o.onHover?.(best);
  };
  svg.onmouseleave = () => { ring.setAttribute('visibility', 'hidden'); if (tip) tip.hidden = true; o.onHover?.(null); };
}
