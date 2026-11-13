// Visitor behaviour from the AR looks of one session (or all of them), for the live map's
// Analysis window. analyzeLooks() works the numbers out; renderAnalysis() draws them.
// Looks are rows of the "looks" table: target_name, mode, start_unix_ms, end_unix_ms, and for
// newer looks distance_avg_m / _min_m / _max_m, view_angle_h_deg / _v_deg and path.

const GLANCE_S = 2, ENGAGED_S = 10, STRAIGHT_DEG = 10;
const median = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtS = (s) => !Number.isFinite(s) ? '–' : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.floor(s / 3600)} h ${Math.round(s % 3600 / 60)} min`;
const fmtM = (m) => Number.isFinite(m) ? `${m.toFixed(1)} m` : '–';
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;

export function analyzeLooks(rows, opts = {}) {
  const looks = rows.map(r => ({
    name: r.target_name || 'image', mode: r.mode === 'ai' ? 'ai' : 'generic', session: r.session_id || '',
    start: +r.start_unix_ms, end: +r.end_unix_ms,
    dist: r.distance_avg_m != null ? +r.distance_avg_m : null, min: r.distance_min_m != null ? +r.distance_min_m : null,
    h: r.view_angle_h_deg != null ? +r.view_angle_h_deg : null, v: r.view_angle_v_deg != null ? +r.view_angle_v_deg : null,
    path: Array.isArray(r.path) ? r.path : null,
  })).filter(l => l.end > l.start).sort((a, b) => a.start - b.start);
  looks.forEach(l => { l.secs = (l.end - l.start) / 1000; });
  if (!looks.length) return { empty: true };

  const sessions = new Set(looks.map(l => l.session));
  const first = looks[0].start, last = Math.max(...looks.map(l => l.end));
  const total = looks.reduce((t, l) => t + l.secs, 0);
  // per painting
  const by = new Map();
  looks.forEach((l, i) => {
    if (!by.has(l.name)) by.set(l.name, { name: l.name, looks: [], firstAt: l.start, order: by.size });
    by.get(l.name).looks.push({ ...l, idx: i });
  });
  const paintings = [...by.values()].map(p => {
    const secs = p.looks.reduce((t, l) => t + l.secs, 0), d = p.looks.filter(l => l.dist != null);
    const hs = p.looks.filter(l => l.h != null).map(l => l.h);
    // a visit back: looked at again after looking at something else in the same session
    let revisits = 0;
    for (let k = 1; k < p.looks.length; k++) {
      const a = p.looks[k - 1], b = p.looks[k];
      if (a.session === b.session && looks.slice(a.idx + 1, b.idx).some(x => x.name !== p.name && x.session === a.session)) revisits++;
    }
    return {
      name: p.name, order: p.order, count: p.looks.length, secs, avg: secs / p.looks.length,
      dist: d.length ? d.reduce((t, l) => t + l.dist * l.secs, 0) / d.reduce((t, l) => t + l.secs, 0) : NaN,
      closest: d.length ? Math.min(...d.map(l => l.min != null ? l.min : l.dist)) : NaN,
      side: median(hs), sessions: new Set(p.looks.map(l => l.session)).size, revisits,
      ai: p.looks.filter(l => l.mode === 'ai').reduce((t, l) => t + l.secs, 0),
      looks: p.looks,
    };
  });
  // gaps between looks (time spent between paintings), within a session
  const gaps = [];
  for (let i = 1; i < looks.length; i++) if (looks[i].session === looks[i - 1].session) gaps.push(Math.max(0, (looks[i].start - looks[i - 1].end) / 1000));
  const measured = looks.filter(l => l.dist != null), angled = looks.filter(l => l.h != null);
  // stepped closer: the distance at the end of the look is 20 cm or more below the start
  const withPath = looks.filter(l => l.path && l.path.length >= 4);
  const closer = withPath.filter(l => {
    const q = Math.max(1, Math.floor(l.path.length / 4));
    const a = median(l.path.slice(0, q).map(p => p.d)), b = median(l.path.slice(-q).map(p => p.d));
    return a - b >= 0.2;
  }).length;
  const longest = looks.reduce((m, l) => l.secs > m.secs ? l : m, looks[0]);
  return {
    single: sessions.size === 1, sessions: sessions.size, first, last,
    span: (last - first) / 1000, total, count: looks.length,
    glances: looks.filter(l => l.secs < GLANCE_S).length, engaged: looks.filter(l => l.secs >= ENGAGED_S).length,
    aiSecs: looks.filter(l => l.mode === 'ai').reduce((t, l) => t + l.secs, 0),
    gap: median(gaps), longest,
    medianDist: median(measured.map(l => l.dist)), closest: measured.length ? Math.min(...measured.map(l => l.min != null ? l.min : l.dist)) : NaN,
    measured: measured.length,
    left: angled.filter(l => l.h <= -STRAIGHT_DEG).length, right: angled.filter(l => l.h >= STRAIGHT_DEG).length,
    straight: angled.filter(l => Math.abs(l.h) < STRAIGHT_DEG).length, angled: angled.length,
    withPath: withPath.length, closer,
    paintings, looks,
    walked: opts.walked ?? null, totalPaintings: opts.totalPaintings ?? null,
  };
}

/* ---------- drawing ---------- */
const MODE = { generic: { label: 'Generic', color: 'var(--an-generic)' }, ai: { label: 'AI assisted', color: 'var(--an-ai)' } };
const STYLE = `
.an { --an-generic: #2a78d6; --an-ai: #eb6834; display: flex; flex-direction: column; gap: 18px; color: var(--text); }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .an { --an-generic: #3987e5; --an-ai: #d95926; } }
:root[data-theme="dark"] .an { --an-generic: #3987e5; --an-ai: #d95926; }
.an h3 { margin: 0 0 8px; font-size: 15px; }
.an .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.an .tile { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; min-width: 0; }
.an .tile b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; margin-top: 2px; }
.an .tile span { color: var(--muted); font-size: 12px; }
.an .tile small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
.an .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
@media (max-width: 900px) { .an .grid2 { grid-template-columns: 1fr; } }
.an .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 12px; min-width: 0; }
.an .notes { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
.an .legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.an .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
.an svg { display: block; width: 100%; height: auto; }
.an svg text { fill: var(--muted); font-size: 11px; font-family: inherit; }
.an svg .lbl { fill: var(--text); }
.an .scroll { overflow-x: auto; }
.an table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
.an th { text-align: left; color: var(--muted); font-weight: 600; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.an td { padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.an td.num, .an th.num { text-align: right; }
.an .empty { color: var(--muted); padding: 20px 0; }
`;
const legend = () => `<div class="legend"><span><i style="background:${MODE.generic.color}"></i>Generic</span><span><i style="background:${MODE.ai.color}"></i>AI assisted</span></div>`;
const side = (h) => !Number.isFinite(h) ? '–' : Math.abs(h) < STRAIGHT_DEG ? 'straight on' : `${Math.round(Math.abs(h))}° ${h < 0 ? 'left' : 'right'}`;

function tiles(a) {
  const t = (label, value, note) => `<div class="tile"><span>${label}</span><b>${value}</b>${note ? `<small>${note}</small>` : ''}</div>`;
  return `<div class="tiles">` +
    (a.single ? t('Visit length', fmtS(a.span), 'first look to last') : t('Visits (sessions)', a.sessions, 'with at least one look')) +
    t('Paintings looked at', a.paintings.length + (a.totalPaintings ? ` of ${a.totalPaintings}` : ''), `${a.count} looks`) +
    t('Time looking', fmtS(a.total), a.single && a.span ? `${pct(a.total, a.span)}% of the visit` : `average look ${fmtS(a.total / a.count)}`) +
    t('Quick glances', a.glances, `under ${GLANCE_S} s · ${pct(a.glances, a.count)}% of looks`) +
    t('Engaged looks', a.engaged, `${ENGAGED_S} s or longer`) +
    t('Typical distance', fmtM(a.medianDist), a.measured ? `closest ${fmtM(a.closest)} · ${a.measured} measured` : 'no distances saved') +
    t('AI assisted', `${pct(a.aiSecs, a.total)}%`, 'of the looking time') +
    (a.single ? t('Walked (Pozyx)', a.walked != null ? fmtM(a.walked) : '–', a.walked != null ? 'from the recording' : 'no recording') : '') +
    `</div>`;
}

function notes(a) {
  const n = [];
  n.push(`Longest look: <b>${esc(a.longest.name)}</b>, ${fmtS(a.longest.secs)}.`);
  const top = [...a.paintings].sort((x, y) => y.secs - x.secs).slice(0, 3);
  n.push(`Most time: ${top.map(p => `<b>${esc(p.name)}</b> (${fmtS(p.secs)})`).join(', ')}.`);
  const rev = a.paintings.filter(p => p.revisits > 0);
  n.push(rev.length ? `Came back to ${rev.length} painting${rev.length === 1 ? '' : 's'}: ${rev.map(p => esc(p.name)).join(', ')}.` : 'Did not come back to a painting after moving on.');
  if (Number.isFinite(a.gap)) n.push(`Typically ${fmtS(a.gap)} between one look and the next.`);
  if (a.angled) n.push(`Looked from the left ${pct(a.left, a.angled)}%, straight on ${pct(a.straight, a.angled)}%, from the right ${pct(a.right, a.angled)}% of the looks (${a.angled} with an angle).`);
  if (a.withPath) n.push(`Stepped at least 20 cm closer during ${a.closer} of ${a.withPath} looks with recorded movement.`);
  if (!a.measured) n.push('No distances yet: give the paintings a size in the AR editor (Painting sizes) to measure them in new looks.');
  return `<ul class="notes">${n.map(x => `<li>${x}</li>`).join('')}</ul>`;
}

// One row per painting (in the order first looked at), one bar per look, coloured by mode
function timeline(a) {
  const rows = [...a.paintings].sort((x, y) => x.order - y.order), W = 900, L = 150, R = 12, rowH = 22, top = 8, H = top + rows.length * rowH + 26;
  const span = Math.max(1, (a.last - a.first) / 1000), x = (t) => L + (t - a.first) / 1000 / span * (W - L - R);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Timeline of looks per painting">`;
  // recessive grid: minute ticks (or 10 s for short visits)
  const step = span > 1800 ? 300 : span > 600 ? 120 : span > 120 ? 60 : 10;
  for (let t = 0; t <= span; t += step) {
    const gx = L + t / span * (W - L - R);
    s += `<line x1="${gx}" y1="${top}" x2="${gx}" y2="${H - 22}" stroke="var(--grid)" stroke-width="1"/><text x="${gx}" y="${H - 6}" text-anchor="middle">${t < 60 ? `${t} s` : step >= 60 ? `${Math.round(t / 60)} min` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`}</text>`;
  }
  rows.forEach((p, i) => {
    const y = top + i * rowH;
    s += `<text class="lbl" x="${L - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(p.name.length > 20 ? p.name.slice(0, 19) + '…' : p.name)}</text>`;
    for (const l of p.looks) {
      const x0 = x(l.start), w = Math.max(3, x(l.end) - x0);
      s += `<rect x="${x0.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 8}" rx="3" fill="${MODE[l.mode].color}" stroke="var(--panel)" stroke-width="1"><title>${esc(p.name)} · ${MODE[l.mode].label} · ${fmtS(l.secs)}${l.dist != null ? ` · ${fmtM(l.dist)}` : ''}</title></rect>`;
    }
  });
  return s + '</svg>';
}

// Total looking time per painting, longest first, value at the bar's end
function bars(a) {
  const rows = [...a.paintings].sort((x, y) => y.secs - x.secs), W = 520, L = 150, R = 70, rowH = 22, H = rows.length * rowH + 8;
  const max = Math.max(...rows.map(p => p.secs)), x = (v) => (v / max) * (W - L - R);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Time spent at each painting">`;
  rows.forEach((p, i) => {
    const y = 4 + i * rowH, wa = x(p.secs - p.ai), wb = x(p.ai);
    s += `<text class="lbl" x="${L - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(p.name.length > 20 ? p.name.slice(0, 19) + '…' : p.name)}</text>`;
    s += `<g><title>${esc(p.name)} · ${fmtS(p.secs)} in ${p.count} look${p.count === 1 ? '' : 's'}${p.ai ? ` (AI assisted ${fmtS(p.ai)})` : ''}</title>`;
    if (wa > 0) s += `<rect x="${L}" y="${y + 4}" width="${Math.max(2, wa).toFixed(1)}" height="${rowH - 8}" rx="3" fill="${MODE.generic.color}"/>`;
    if (wb > 0) s += `<rect x="${(L + wa + (wa > 0 ? 2 : 0)).toFixed(1)}" y="${y + 4}" width="${Math.max(2, wb - (wa > 0 ? 2 : 0)).toFixed(1)}" height="${rowH - 8}" rx="3" fill="${MODE.ai.color}"/>`;
    s += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent"/></g>`;
    s += `<text x="${(L + wa + wb + 6).toFixed(1)}" y="${y + rowH / 2 + 4}">${fmtS(p.secs)}</text>`;
  });
  return s + '</svg>';
}

// Where the phone was, seen from above: the painting at the top, every measured look a dot at its
// distance and left/right angle (the same for every painting), rings every metre
function standPlot(a) {
  const looks = a.looks.filter(l => l.dist != null && l.h != null);
  if (!looks.length) return '<div class="empty">No looks with a distance and angle yet.</div>';
  const W = 520, H = 330, cx = W / 2, cy = 34, maxD = Math.max(2, Math.ceil(Math.max(...looks.map(l => l.dist)))), k = (H - cy - 30) / maxD;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Where visitors stood in front of the paintings, seen from above">`;
  for (let m = 1; m <= maxD; m++) {
    s += `<path d="M${cx - m * k} ${cy} A${m * k} ${m * k} 0 0 0 ${cx + m * k} ${cy}" fill="none" stroke="var(--grid)" stroke-width="1"/>`;
    s += `<text x="${cx - m * k + 4}" y="${cy + 14}">${m} m</text>`;   // at the wall end of each ring, away from the dots
  }
  s += `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${H - 22}" stroke="var(--grid-strong)" stroke-dasharray="4 5"/>`;
  s += `<rect x="${cx - 40}" y="${cy - 14}" width="80" height="8" rx="2" fill="var(--grid-strong)"/><text class="lbl" x="${cx}" y="${cy - 20}" text-anchor="middle">painting</text>`;
  s += `<text x="16" y="${H - 6}">← from the left</text><text x="${W - 16}" y="${H - 6}" text-anchor="end">from the right →</text>`;
  for (const l of looks) {
    const r = l.h * Math.PI / 180, px = cx + Math.sin(r) * l.dist * k, py = cy + Math.cos(r) * l.dist * k;
    s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5" fill="${MODE[l.mode].color}" stroke="var(--panel)" stroke-width="2"><title>${esc(l.name)} · ${fmtM(l.dist)} · ${side(l.h)} · ${fmtS(l.secs)}</title></circle>`;
  }
  return s + '</svg>';
}

function table(a) {
  const rows = [...a.paintings].sort((x, y) => y.secs - x.secs);
  return `<div class="scroll"><table><tr><th>Painting</th><th class="num">Looks</th><th class="num">Total</th><th class="num">Average</th>` +
    `<th class="num">Distance</th><th class="num">Closest</th><th>Side</th>${a.single ? '' : '<th class="num">Visits</th>'}<th class="num">Came back</th><th class="num">AI assisted</th></tr>` +
    rows.map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.count}</td><td class="num">${fmtS(p.secs)}</td><td class="num">${fmtS(p.avg)}</td>` +
      `<td class="num">${fmtM(p.dist)}</td><td class="num">${fmtM(p.closest)}</td><td>${side(p.side)}</td>${a.single ? '' : `<td class="num">${p.sessions}</td>`}` +
      `<td class="num">${p.revisits || '–'}</td><td class="num">${p.ai ? pct(p.ai, p.secs) + '%' : '–'}</td></tr>`).join('') + '</table></div>';
}

export function renderAnalysis(el, a) {
  if (a.empty) { el.innerHTML = `<style>${STYLE}</style><div class="an"><div class="empty">No AR looks in this session yet.</div></div>`; return; }
  el.innerHTML = `<style>${STYLE}</style><div class="an">` + tiles(a) +
    `<div class="card"><h3>What stood out</h3>${notes(a)}</div>` +
    (a.single ? `<div class="card"><h3>Timeline: which painting, when</h3>${legend()}<div class="scroll">${timeline(a)}</div></div>` : '') +
    `<div class="grid2"><div class="card"><h3>Time at each painting</h3>${legend()}${bars(a)}</div>` +
    `<div class="card"><h3>Where visitors stood (seen from above)</h3>${legend()}${standPlot(a)}</div></div>` +
    `<div class="card"><h3>Paintings</h3>${table(a)}</div></div>`;
}

// The paintings table as CSV (one row per painting)
export function analysisCsv(a) {
  if (a.empty) return '';
  const q = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const n = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '';
  const head = ['painting', 'looks', 'total_s', 'average_s', 'distance_m', 'closest_m', 'side_deg', 'visits', 'came_back', 'ai_assisted_s'];
  return [head.join(','), ...[...a.paintings].sort((x, y) => y.secs - x.secs).map(p =>
    [q(p.name), p.count, n(p.secs), n(p.avg), n(p.dist, 2), n(p.closest, 2), n(p.side, 0), p.sessions, p.revisits, n(p.ai)].join(','))].join('\n');
}
