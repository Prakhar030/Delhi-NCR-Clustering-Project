/* ============================================================================
   core.js - state, indexes, live-metric engine, assignment actions
   Stored values (Cluster RAG, Territory Recommendation, Territory RAG) are never
   changed. The user's work lives only in S.final (cluster -> executive).
   ========================================================================== */
'use strict';

const S = {
  B: null,              // bundle from server
  base: null,           // baseline candidate key (Recommended), or null
  final: {},            // cid -> exec | null      (Final / user-modified)
  sellerOv: {},         // seller key (GLID) -> exec  (BM seller-level Final executive override; cluster ID never changes)
  finalIdx: null,       // cache: exec -> [seller index] in the Final assignment
  names: {},            // exec -> territory name
  audit: [],            // event log
  undo: [],             // stack of {label, changes:[{cid,from,to}]}
  sel: new Set(),       // selected clusters (map / lists)
  activeExec: null,
  mode: 'inspect',      // inspect | quick | select | draw
  lastImpact: null,     // [{exec, before, after}]
  dirty: false,
  metricsCache: {},     // exec -> metrics for final assignment
  engineCheck: null,
  listeners: [],
};

const C = {};           // cid -> cluster
let SELLERS = [];
let EXECS = [];         // assignable executives (from recommendation)
let EXEC_SET = new Set();
let COLOR_INDEX = {};
let CUR_IDX = {};       // original (current) exec -> [seller index], all mapped sellers
let SKEY_IDX = {};      // seller key -> seller index

/* ------------------------------------------------------------------ utils */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (v) => (v === null || v === undefined) ? '' : String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nowTs = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const idSort = (a, b) => { const x = Number(a), y = Number(b);
  if (!isNaN(x) && !isNaN(y)) return x - y; return String(a).localeCompare(String(b)); };
function fmt(v, kind) {
  if (v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v))) return '<span class="muted">—</span>';
  if (kind === 'pct') return (v * 100).toFixed(1) + '%';
  if (kind === 'km') return Number(v).toFixed(2);
  if (kind === 'hhi') return Number(v).toFixed(3);
  if (kind === 'int') return Math.round(v).toLocaleString('en-IN');
  if (kind === 'score') return Number(v).toFixed(1);
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-IN') : (Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(1));
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return esc(v);
}
function ragBadge(v, extra) {
  if (v === null || v === undefined || v === '') return `<span class="rag rag-na">${extra || 'N/A'}</span>`;
  const u = String(v).toUpperCase();
  const cls = u === 'GREEN' ? 'rag-g' : u === 'AMBER' ? 'rag-a' : u === 'RED' ? 'rag-r' : 'rag-na';
  return `<span class="rag ${cls}">${esc(v)}</span>`;
}
const OV_NA = 'N/A – uncached in source';
function overallBadge(c) { return ragBadge(c.ov, OV_NA); }
function toast(msg, kind = 'info', ms = 3500) {
  const t = document.createElement('div'); t.className = `toast toast-${kind}`; t.innerHTML = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), ms);
}
/* branch chosen on the start screen; every data call carries it (?branch=<id>) */
const BRANCH = new URLSearchParams(location.search).get('branch') || null;
async function api(path, body) {
  if (BRANCH && path !== '/api/branches') path += (path.includes('?') ? '&' : '?') + 'branch=' + encodeURIComponent(BRANCH);
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

/* ------------------------------------------------------------------ colours (generated, never hard-coded to names) */
function buildColors() {
  COLOR_INDEX = {};
  const all = [...EXECS];
  (S.B.current_executives || []).forEach(e => { if (!EXEC_SET.has(e)) all.push(e); });
  all.forEach((e, i) => { COLOR_INDEX[e] = i; });
}
function execColor(e) {
  if (!e) return '#9aa0a6';
  const i = COLOR_INDEX[e];
  if (i === undefined) return '#6b7280';
  const hue = (i * 137.508 + 12) % 360;
  const light = [42, 55, 34, 48][i % 4];
  const sat = EXEC_SET.has(e) ? 72 : 25;
  return `hsl(${hue.toFixed(1)},${sat}%,${light}%)`;
}
const swatch = (e) => `<span class="sw" style="background:${execColor(e)}"></span>`;
const execLabel = (e) => e ? `${swatch(e)}${esc(e)}` : '<span class="muted">Unassigned</span>';
const tName = (e) => e ? (S.names[e] || e) : null;

/* ------------------------------------------------------------------ bundle indexes */
function indexBundle(B) {
  S.B = B;
  SELLERS = B.sellers;
  for (const k of Object.keys(C)) delete C[k];
  B.clusters.forEach(c => { C[c.id] = c; });
  EXECS = B.executives.slice();
  EXEC_SET = new Set(EXECS);
  CUR_IDX = {}; SKEY_IDX = {};
  SELLERS.forEach(s => { if (s.cur) (CUR_IDX[s.cur] = CUR_IDX[s.cur] || []).push(s.i); SKEY_IDX[sKey(s)] = s.i; });
  buildColors();
}
const CIDS = () => S.B.clusters.map(c => c.id);
const cand = (key) => S.B.candidates.find(c => c.key === key) || null;
const recOf = (cid) => { const c = cand(S.base); return c ? (c.map[cid] || null) : null; };
const candLabel = (key) => { const c = cand(key); return c ? c.label : 'None (blank start)'; };
function clustersOf(exec, map) {
  const out = [];
  for (const cid in map) if (map[cid] === exec) out.push(cid);
  return out.sort(idSort);
}
const finalClusters = (e) => clustersOf(e, S.final);
const recClusters = (e) => { const c = cand(S.base); return c ? clustersOf(e, c.map) : []; };
function origText(c) {
  const comp = (c.cur_comp || []).filter(x => x[0] !== '(no mapping)');
  if (!comp.length) return 'no current mapping';
  if (comp.length === 1) return comp[0][0];
  return `MIXED (${comp.length})`;
}
function origTitle(c) {
  return (c.cur_comp || []).map(([e, n]) => `${e}: ${n}`).join('\n');
}

/* ------------------------------------------------------------------ seller-level Final executive (single source of truth)
   Final executive of a seller, in order of precedence:
     1. BM seller-level override (clustered sellers only) - the seller keeps its Cluster ID
     2. Renewal case (Business Eligibility Status is not 'Eligible': renewal due / outstanding) stays with
        the current executive, if that executive is in the assignable pool - clustered or not
     3. otherwise a clustered seller follows its cluster's Final executive
   Eligible sellers that are not clustered are never allocated. The Recommended assignment uses the same
   rule with the recommendation's cluster map (recExecOf). */
const sKey = (s) => s.g !== null && s.g !== undefined ? s.g : '#' + s.i;
const isRenewalOS = (s) => s.el !== 'Eligible';
const keepsOriginal = (s) => isRenewalOS(s) && !!s.cur && EXEC_SET.has(s.cur);
const hasOverride = (s) => Object.prototype.hasOwnProperty.call(S.sellerOv, sKey(s));
function defaultFinalExec(s) {
  if (keepsOriginal(s)) return s.cur;
  return s.c === null ? null : (S.final[s.c] || null);
}
function finalExecOf(s) {
  if (s.c !== null && hasOverride(s)) return S.sellerOv[sKey(s)];
  return defaultFinalExec(s);
}
function finalSource(s) {
  if (s.c !== null && hasOverride(s)) return 'override';
  if (keepsOriginal(s)) return 'retained';
  return s.c === null ? null : 'cluster';
}
const SOURCE_LABEL = { override: 'BM seller override', retained: 'Renewal case – stays with current executive', cluster: 'Follows cluster' };
function recExecOf(s) {
  if (keepsOriginal(s)) return s.cur;
  return s.c === null ? null : recOf(s.c);
}
const recSellers = (e) => SELLERS.filter(s => recExecOf(s) === e).map(s => s.i);
const recMetrics = (e) => { const cl = recClusters(e); const m = metricsForSellers(recSellers(e), e, cl.length); m.cluster_ids = cl; return m; };
const currentAllMetrics = (e) => metricsForSellers(CUR_IDX[e] || [], e, null);   // every seller mapped to e today
function finalIndex() {
  if (!S.finalIdx) {
    const by = {}; SELLERS.forEach(s => { const e = finalExecOf(s); if (e) (by[e] = by[e] || []).push(s.i); });
    S.finalIdx = by;
  }
  return S.finalIdx;
}
const finalSellers = (e) => finalIndex()[e] || [];
const overrideCount = () => Object.keys(S.sellerOv).length;

/* Old allocation -> new allocation for one executive.
   newIdx: sellers in the executive's new allocation; ownerOf(cid): executive owning that cluster in the same basis;
   isExc(s): explicit BM exception. Pass newIdx = null for a basis without a new allocation. */
function allocationFor(e, newIdx, ownerOf, isExc) {
  const old = CUR_IDX[e] || [];
  const a = { oldTotal: old.length, oldEligible: 0, oldRenewalOS: 0, exception: null, newTotal: null, existing: null, newlyMapped: null, within: null, outside: null };
  old.forEach(i => { if (isRenewalOS(SELLERS[i])) a.oldRenewalOS++; else a.oldEligible++; });
  if (!newIdx) return a;
  a.exception = 0; a.newTotal = newIdx.length; a.existing = 0; a.newlyMapped = 0; a.within = 0; a.outside = 0;
  for (const i of newIdx) {
    const s = SELLERS[i];
    if (s.cur === e) a.existing++; else a.newlyMapped++;
    if (s.c !== null && ownerOf(s.c) === e) a.within++; else a.outside++;
    if (isExc && isExc(s)) a.exception++;
  }
  return a;
}
const finalAllocation = (e) => allocationFor(e, finalSellers(e), (cid) => S.final[cid] || null, hasOverride);

/* ------------------------------------------------------------------ stored Territory RAG access */
function trCol(field) { return S.B.territory_rag.metric_cols[field] || null; }
function trIdx(colname) { return colname ? S.B.territory_rag.columns.indexOf(colname) : -1; }
function storedRow(key, exec) {
  return S.B.territory_rag.rows.find(r => r.cand === key && r.exec === exec) || null;
}
function storedVal(row, field) {
  if (!row) return null;
  const i = trIdx(trCol(field));
  return i < 0 ? null : row.vals[i];
}
function storedByCol(row, colname) {
  if (!row) return null; const i = trIdx(colname); return i < 0 ? null : row.vals[i];
}
function storedParamRagCols() {
  const ov = trCol('overall_rag');
  return S.B.territory_rag.columns.filter(c => /RAG$/i.test(c) && c !== ov);
}

/* ------------------------------------------------------------------ live metric engine
   Definitions mirror the Territory Recommendation 'Configuration' sheet (population =
   eligible sellers in RAG population; geo = haversine to mean lat/lon of that population;
   renewal HHI over the stored window months). Verified against stored values at load. */
const inPop = (s) => (s.pop === null || s.pop === undefined) ? (s.c !== null && s.el === 'Eligible') : s.pop === true;
function hav(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const p1 = lat1 * rad, p2 = lat2 * rad, dp = p2 - p1, dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function metricsForSellers(idxs, exec, nClusters) {
  const m = { clusters: nClusters, total: idxs.length, eligible: 0, ineligible: 0, months: {} };
  const win = S.B.territory_rag.window || [];
  const winSet = new Set(win.map(w => w.ym));
  let la = 0, lo = 0, np = 0, mdc = 0, ts = 0, an = 0, my = 0, to = 0, toN = 0, vi = 0, viN = 0, inW = 0, retained = 0, changes = 0;
  const pop = [];
  let renewal = 0;
  for (const i of idxs) {
    const s = SELLERS[i];
    if (exec !== undefined) { if ((s.cur || null) === (exec || null)) retained++; else changes++; }
    if (isRenewalOS(s)) renewal++;
    if (!inPop(s)) continue;
    pop.push(s);
    if (s.cv) { la += s.la; lo += s.lo; np++; }
    if (s.mdc === 'MDC') mdc++; else if (s.mdc === 'TS') ts++;
    if (s.ann === 'ANNUAL') an++; else if (s.ann === 'MYR') my++;
    if (s.to !== null && s.to !== undefined) { toN++; if (s.to) to++; }
    if (s.vi !== null && s.vi !== undefined) { viN++; if (s.vi) vi++; }
    if (s.ym && winSet.has(s.ym)) { inW++; m.months[s.ym] = (m.months[s.ym] || 0) + 1; }
  }
  m.eligible = pop.length; m.ineligible = m.total - m.eligible;
  m.renewal = renewal; m.elig_all = m.total - renewal;   // sales view: Total sellers = Renewal cases + Eligible sellers
  m.retained = exec !== undefined ? retained : null; m.changes = exec !== undefined ? changes : null;
  m.mdc = mdc; m.ts = ts; m.annual = an; m.myr = my; m.turnover = to; m.vintage = vi;
  m.mdc_pct = (mdc + ts) ? mdc / (mdc + ts) : null;
  m.annual_pct = (an + my) ? an / (an + my) : null;
  m.turnover_pct = toN ? to / toN : null;
  m.vintage_pct = viN ? vi / viN : null;
  m.ren_window = win.length ? inW : null;
  if (win.length && inW) { let h = 0; for (const ym in m.months) h += (m.months[ym] / inW) ** 2; m.hhi = h; } else m.hhi = null;
  if (np) {
    const cla = la / np, clo = lo / np; let sum = 0, sq = 0, mx = 0; const d = [];
    for (const s of pop) if (s.cv) { const x = hav(s.la, s.lo, cla, clo); d.push(x); sum += x; if (x > mx) mx = x; }
    const mean = sum / d.length; for (const x of d) sq += (x - mean) ** 2;
    m.geo_spread = Math.sqrt(sq / d.length); m.avg_dist = mean; m.max_dist = mx; m.clat = cla; m.clon = clo;
  } else { m.geo_spread = m.avg_dist = m.max_dist = null; }
  if (!S.B.seller_fields.includes('mdc_ts')) m.mdc_pct = null;
  if (!S.B.seller_fields.includes('annual_myr')) m.annual_pct = null;
  if (!S.B.seller_fields.includes('turnover_flag')) m.turnover_pct = null;
  if (!S.B.seller_fields.includes('vintage_flag')) m.vintage_pct = null;
  return m;
}
function metricsForClusters(cids, exec) {
  const idxs = []; cids.forEach(cid => { (C[cid]?.sellers || []).forEach(i => idxs.push(i)); });
  const m = metricsForSellers(idxs, exec, cids.length); m.cluster_ids = cids.slice(); return m;
}
function finalMetrics(exec) {
  // same metric engine, fed with the executive's Final sellers (cluster members + seller-level rules/overrides)
  if (!S.metricsCache[exec]) {
    const cl = finalClusters(exec);
    const m = metricsForSellers(finalSellers(exec), exec, cl.length); m.cluster_ids = cl;
    S.metricsCache[exec] = m;
  }
  return S.metricsCache[exec];
}
const currentMetrics = (() => { let cache = null; return (exec) => {
  if (!cache) { cache = {}; const by = {};
    SELLERS.forEach(s => { if (s.c !== null && s.cur) (by[s.cur] = by[s.cur] || []).push(s.i); });
    for (const e in by) cache[e] = metricsForSellers(by[e], e, null);
  } return cache[exec] || metricsForSellers([], exec, null); }; })();

/* metric rows for comparison tables: [storedField, liveKey, label, kind] */
const METRICS = [
  ['m_clusters', 'clusters', 'Clusters', 'int'],
  [null, 'total', 'Total sellers', 'int'],
  [null, 'renewal', 'Renewal cases', 'int'],
  [null, 'elig_all', 'Eligible sellers', 'int'],
  ['m_geo_spread', 'geo_spread', 'Geographic spread (km)', 'km'],
  ['m_avg_dist', 'avg_dist', 'Avg distance to territory centroid (km)', 'km'],
  ['m_max_dist', 'max_dist', 'Max distance to territory centroid (km)', 'km'],
  ['m_ren_window', 'ren_window', 'Renewals in window', 'int'],
  ['m_hhi', 'hhi', 'Renewal HHI (lower = more even)', 'hhi'],
  ['m_mdc_pct', 'mdc_pct', 'MDC % (of MDC+TS)', 'pct'],
  ['m_turnover_pct', 'turnover_pct', 'Turnover above threshold %', 'pct'],
  ['m_vintage_pct', 'vintage_pct', 'Vintage clients %', 'pct'],
  ['m_annual_pct', 'annual_pct', 'Annual % (of Annual+MYR)', 'pct'],
  [null, 'retained', 'Sellers keeping current executive', 'int'],
  [null, 'changes', 'Mapping changes vs original', 'int'],
];
const CHECK_FIELDS = [['m_total', 'total'], ['m_eligible', 'eligible'], ['m_geo_spread', 'geo_spread'], ['m_avg_dist', 'avg_dist'],
  ['m_max_dist', 'max_dist'], ['m_ren_window', 'ren_window'], ['m_hhi', 'hhi'], ['m_mdc', 'mdc'], ['m_ts', 'ts'], ['m_mdc_pct', 'mdc_pct'],
  ['m_turnover', 'turnover'], ['m_turnover_pct', 'turnover_pct'], ['m_vintage', 'vintage'], ['m_vintage_pct', 'vintage_pct'],
  ['m_annual', 'annual'], ['m_myr', 'myr'], ['m_annual_pct', 'annual_pct']];

function runEngineCheck() {
  const rows = S.B.territory_rag.rows;
  if (!rows.length) { S.engineCheck = { status: 'WARN', mismatches: 0, detail: 'No stored territory rows to verify against' }; return; }
  let compared = 0, mism = 0; const samples = [];
  for (const r of rows) {
    let m;
    if (r.cand === '__current__') m = currentMetrics(r.exec);
    else { const c = cand(r.cand); if (!c) continue; m = metricsForClusters(clustersOf(r.exec, c.map), r.exec); }
    for (const [f, k] of CHECK_FIELDS) {
      const sv = storedVal(r, f); if (sv === null || sv === undefined || typeof sv !== 'number') continue;
      const lv = m[k]; compared++;
      if (lv === null || lv === undefined || Math.abs(lv - sv) > 1e-6 * Math.max(1, Math.abs(sv))) {
        mism++; if (samples.length < 30) samples.push({ Row: r.label, Executive: r.exec, Metric: trCol(f), Stored: sv, Live: lv });
      }
    }
    for (const w of S.B.territory_rag.window) {
      const sv = storedByCol(r, w.col); if (typeof sv !== 'number') continue; compared++;
      if ((m.months[w.ym] || 0) !== sv) { mism++; if (samples.length < 30) samples.push({ Row: r.label, Executive: r.exec, Metric: w.col, Stored: sv, Live: m.months[w.ym] || 0 }); }
    }
  }
  S.engineCheck = {
    status: mism ? 'WARN' : 'PASS', mismatches: mism, compared, samples,
    detail: mism ? `${mism} of ${compared} stored territory values could not be reproduced by the live engine - treat live values as indicative`
      : `All ${compared.toLocaleString()} stored territory metric values (every candidate + current territory) are reproduced exactly by the live engine`,
  };
}

/* RAG population of the final territory is exactly the RAG population of its clusters
   (false when a seller-level override moved an eligible seller in or out) */
function popIntact(exec) {
  const own = new Set(finalClusters(exec));
  for (const i of finalSellers(exec)) { const s = SELLERS[i]; if (inPop(s) && !own.has(s.c)) return false; }
  for (const cid of own) for (const i of (C[cid]?.sellers || [])) { const s = SELLERS[i]; if (inPop(s) && finalExecOf(s) !== exec) return false; }
  return true;
}
/* stored RAG applies only if the final cluster set equals a stored candidate's set (and its RAG population is unchanged) */
function storedApplicable(exec) {
  const f = finalClusters(exec).join(',');
  if (!f) return null;
  if (!popIntact(exec)) return null;
  const order = [S.base, ...S.B.candidates.map(c => c.key).filter(k => k !== S.base)].filter(Boolean);
  for (const k of order) {
    const c = cand(k);
    if (clustersOf(exec, c.map).join(',') === f) { const row = storedRow(k, exec); if (row) return { key: k, row }; }
  }
  return null;
}

/* ------------------------------------------------------------------ actions (rules enforced here) */
function onChange(fn) { S.listeners.push(fn); }
function emit(info) { S.listeners.forEach(fn => { try { fn(info); } catch (e) { console.error(e); } }); }

function applyChanges(changes, method, label, opts = {}) {
  // Rules: a cluster has exactly one final owner (map), only existing clusters, only assignable executives,
  // sellers always follow their cluster; unmapped clusters are never auto-assigned (only explicit user changes).
  const eff = [];
  for (const ch of changes) {
    if (!(ch.cid in C)) continue;
    if (ch.to !== null && !EXEC_SET.has(ch.to)) { toast(`'${esc(ch.to)}' is not an assignable executive`, 'err'); continue; }
    const from = S.final[ch.cid] || null;
    if (from === (ch.to || null)) continue;
    eff.push({ cid: ch.cid, from, to: ch.to || null });
  }
  // seller-level Final executive overrides: opts.sellers = [{i, to}] (to = null removes the override)
  const effS = [];
  for (const ch of (opts.sellers || [])) {
    const s = SELLERS[ch.i]; if (!s || s.c === null) continue;
    if (ch.to !== null && ch.to !== undefined && !EXEC_SET.has(ch.to)) { toast(`'${esc(ch.to)}' is not an assignable executive`, 'err'); continue; }
    const from = hasOverride(s) ? S.sellerOv[sKey(s)] : null, to = ch.to || null;
    if (from === to) continue;
    effS.push({ i: ch.i, from, to });
  }
  if (!eff.length && !effS.length) { if (!opts.silent) toast('No change', 'info', 1500); return false; }
  const affected = new Set(); eff.forEach(c => { if (c.from) affected.add(c.from); if (c.to) affected.add(c.to); });
  const sBefore = effS.map(x => finalExecOf(SELLERS[x.i]));
  sBefore.forEach(e => { if (e) affected.add(e); });
  const before = {}; affected.forEach(e => { before[e] = finalMetrics(e); });
  const ts = nowTs();
  for (const c of eff) {
    S.final[c.cid] = c.to;
    S.audit.push({ ts, action: opts.undo ? 'undo' : (c.to ? (c.from ? 'move' : 'assign') : 'unassign'), method, cluster: c.cid, from: c.from, to: c.to, note: label || '' });
  }
  effS.forEach(x => { const k = sKey(SELLERS[x.i]); if (x.to) S.sellerOv[k] = x.to; else delete S.sellerOv[k]; });
  S.metricsCache = {}; S.finalIdx = null;
  effS.forEach((x, n) => {
    const s = SELLERS[x.i], after = finalExecOf(s); if (after) affected.add(after);
    S.audit.push({ ts, action: opts.undo ? 'undo' : (x.to ? 'seller-override' : 'seller-override-removed'), method, cluster: null, glid: s.g,
      from: sBefore[n], to: after, note: `Seller ${s.g} (cluster ${s.c}): final executive ${sBefore[n] || 'Unassigned'} → ${after || 'Unassigned'}` +
        (x.to ? ' (seller-level override)' : ` (override removed; ${SOURCE_LABEL[finalSource(s)].toLowerCase()})`) + (label ? ' · ' + label : '') });
  });
  if (!opts.undo) S.undo.push({ label: label || method, changes: eff, sellers: effS });
  S.lastImpact = [...affected].sort().map(e => ({ exec: e, before: before[e] || null, after: finalMetrics(e) }));
  S.dirty = true;
  emit({ changed: eff.map(c => c.cid), affected: [...affected], sellers: effS.map(x => x.i) });
  if (!opts.silent) {
    const parts = []; if (eff.length) parts.push(`${eff.length} cluster${eff.length > 1 ? 's' : ''}`); if (effS.length) parts.push(`${effS.length} seller${effS.length > 1 ? 's' : ''}`);
    toast(`${esc(label || method)}: ${parts.join(' + ')} changed`, 'ok', 2200);
  }
  return true;
}
function undoLast() {
  const u = S.undo.pop(); if (!u) { toast('Nothing to undo'); return; }
  applyChanges(u.changes.map(c => ({ cid: c.cid, to: c.from })).reverse(), 'undo', 'Undo: ' + u.label,
    { undo: true, sellers: (u.sellers || []).map(x => ({ i: x.i, to: x.from })) });
}
/* Seller Explorer: set a seller's Final executive (exec = null or its default -> remove the override) */
function setSellerFinal(i, exec) {
  const s = SELLERS[i]; if (!s || s.c === null) return false;
  const to = (!exec || exec === defaultFinalExec(s)) ? null : exec;
  return applyChanges([], 'seller-explorer', to ? `Seller ${s.g} final executive → ${to}` : `Seller ${s.g} override removed`, { sellers: [{ i, to }] });
}
const allOverridesCleared = () => Object.keys(S.sellerOv).map(k => ({ i: SKEY_IDX[k], to: null })).filter(x => x.i !== undefined);
function assignClusters(cids, exec, method, label) { return applyChanges(cids.map(cid => ({ cid, to: exec })), method, label); }
function replaceTerritory(exec, cids, method) {
  const keep = new Set(cids);
  const ch = cids.map(cid => ({ cid, to: exec }));
  finalClusters(exec).forEach(cid => { if (!keep.has(cid)) ch.push({ cid, to: null }); });
  return applyChanges(ch, method, `Replace territory of ${exec}`);
}
function resetToRecommendation(scopeExec) {
  if (scopeExec) {
    // exec's territory becomes exactly its recommended clusters; clusters it held that are not recommended to it become unassigned
    const rec = recClusters(scopeExec), keep = new Set(rec);
    const ch = rec.map(cid => ({ cid, to: scopeExec }));
    finalClusters(scopeExec).forEach(cid => { if (!keep.has(cid)) ch.push({ cid, to: null }); });
    return applyChanges(ch, 'reset', `Reset ${scopeExec} to recommendation (${candLabel(S.base)})`);
  }
  return applyChanges(CIDS().map(cid => ({ cid, to: recOf(cid) })), 'reset', `Reset to recommendation (${candLabel(S.base)})`, { sellers: allOverridesCleared() });
}
function startBlank() { return applyChanges(CIDS().map(cid => ({ cid, to: null })), 'blank', 'Start blank (all clusters unassigned)'); }

function initFinalFromBaseline() {
  S.final = {}; const c = cand(S.base);
  CIDS().forEach(cid => { S.final[cid] = c ? (c.map[cid] || null) : null; });
  S.sellerOv = {}; S.finalIdx = null;
  S.metricsCache = {}; S.undo = []; S.lastImpact = null;
}

function changeType(cid) {
  const r = recOf(cid), f = S.final[cid] || null;
  if (r === f) return 'Unchanged';
  if (r && !f) return 'Unassigned by user';
  if (f && !r) return 'Assigned by user';
  return 'Moved';
}

function finalValidation() {
  const out = [];
  const un = CIDS().filter(cid => !S.final[cid]);
  const bad = CIDS().filter(cid => S.final[cid] && !EXEC_SET.has(S.final[cid]));
  const empty = EXECS.filter(e => !finalClusters(e).length);
  const notClEl = SELLERS.filter(s => s.c === null && !isRenewalOS(s)).length;
  out.push({ check: 'Each cluster has at most one territory (no split clusters)', status: 'PASS', count: 0, detail: 'Enforced: the final assignment is one executive per cluster; eligible sellers follow their cluster, renewal cases stay with their current executive' });
  out.push({ check: 'Final executives are in the executive pool', status: bad.length ? 'FAIL' : 'PASS', count: bad.length, detail: bad.length ? bad.join(', ') : 'All assigned executives come from the Territory Recommendation' });
  out.push({ check: 'Unassigned clusters', status: un.length ? 'WARN' : 'PASS', count: un.length, detail: un.length ? `${un.length} clusters (${un.reduce((a, c) => a + C[c].n, 0)} sellers) have no final territory: ${un.slice(0, 40).join(', ')}${un.length > 40 ? ' …' : ''}` : 'Every cluster is assigned' });
  out.push({ check: 'Executives without any cluster', status: empty.length ? 'WARN' : 'PASS', count: empty.length, detail: empty.length ? empty.join(', ') : 'Every executive has a territory' });
  out.push({ check: 'Eligible sellers not clustered (cannot be assigned)', status: notClEl ? 'INFO' : 'PASS', count: notClEl, detail: `${notClEl} eligible sellers have no Cluster ID (outside the branch radius or no location); exported as NOT ALLOCATED` });
  const kept = SELLERS.filter(s => finalSource(s) === 'retained').length;
  const osOut = SELLERS.filter(s => isRenewalOS(s) && !keepsOriginal(s) && !(s.c !== null && hasOverride(s)));
  const osOutEx = [...new Set(osOut.map(s => s.cur || '(no current executive)'))];
  out.push({ check: 'Renewal cases kept with their current executive', status: 'INFO', count: kept, detail: `${kept} renewal cases (renewal due / outstanding) stay with their current executive, including ${SELLERS.filter(s => s.c === null && finalSource(s) === 'retained').length} that are not in any cluster` });
  out.push({ check: 'Renewal cases whose current executive is not in the executive pool', status: osOut.length ? 'WARN' : 'PASS', count: osOut.length,
    detail: osOut.length ? `${osOut.length} renewal cases cannot stay with their current executive (not in this branch's executive pool), so they follow their cluster (or are NOT ALLOCATED if not clustered): ${osOutEx.join(', ')}` : 'None' });
  out.push({ check: 'Seller-level Final executive overrides', status: overrideCount() ? 'INFO' : 'PASS', count: overrideCount(), detail: `${overrideCount()} sellers have a BM seller-level override (their Cluster ID is unchanged)` });
  // reconciliation of the allocation view
  const unrec = []; let sumNew = 0;
  EXECS.forEach(e => { const a = finalAllocation(e); sumNew += a.newTotal;
    if (a.oldTotal !== a.oldEligible + a.oldRenewalOS || a.newTotal !== a.existing + a.newlyMapped || a.newTotal !== a.within + a.outside || a.newTotal !== finalMetrics(e).total) unrec.push(e); });
  const allocated = SELLERS.filter(s => finalExecOf(s)).length;
  if (sumNew !== allocated) unrec.push(`sum of New Total ${sumNew} ≠ allocated sellers ${allocated}`);
  out.push({ check: 'Allocation reconciles (Old = Eligible + Renewal cases; New = Existing + Newly Mapped = Within + Outside)', status: unrec.length ? 'FAIL' : 'PASS', count: unrec.length,
    detail: unrec.length ? unrec.join(', ') : `All ${EXECS.length} executives reconcile; ${allocated} sellers have a Final executive` });
  return out;
}

function workingPayload() {
  return { fingerprint: S.B.meta.fingerprint, baseline: S.base, final: S.final, seller_overrides: S.sellerOv, names: S.names, audit: S.audit,
           files: S.B.meta.files.map(f => ({ logical: f.logical, name: f.name, modified: f.modified })) };
}
function sellerFinalPayload() {
  return { seller_final: SELLERS.map(s => finalExecOf(s)), seller_source: SELLERS.map(s => finalSource(s)) };
}
function territoryMetricsPayload() {
  return EXECS.map(e => {
    const m = finalMetrics(e); const sa = storedApplicable(e); const a = finalAllocation(e);
    return { exec: e, territory: tName(e), clusters: m.clusters, total: m.total, eligible: m.eligible, ineligible: m.ineligible, renewal: m.renewal,
      mdc: m.mdc, ts: m.ts, turnover: m.turnover, vintage: m.vintage, annual: m.annual, myr: m.myr,
      old_total: a.oldTotal, old_eligible: a.oldEligible, old_renewal_os: a.oldRenewalOS, exception: a.exception, new_total: a.newTotal,
      existing: a.existing, newly_mapped: a.newlyMapped, within: a.within, outside: a.outside,
      geo_spread: m.geo_spread, avg_dist: m.avg_dist, max_dist: m.max_dist, ren_window: m.ren_window, hhi: m.hhi,
      mdc_pct: m.mdc_pct, turnover_pct: m.turnover_pct, vintage_pct: m.vintage_pct, annual_pct: m.annual_pct,
      retained: m.retained, changes: m.changes, months: m.months, cluster_ids: m.cluster_ids,
      stored_status: sa ? 'Yes - final territory equals stored candidate territory' : (m.clusters ? 'No - territory modified; stored RAG not applicable' : 'No clusters'),
      stored_rag: sa ? storedVal(sa.row, 'overall_rag') : null, stored_score: sa ? storedVal(sa.row, 'overall_score') : null,
      stored_label: sa ? sa.row.label : null };
  });
}
