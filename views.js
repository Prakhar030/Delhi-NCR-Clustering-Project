/* ============================================================================
   views.js - tabs, side panel, explorers, dashboard, validation, export, boot
   ========================================================================== */
'use strict';

const STALE = new Set();
let CURRENT_TAB = null, MAP_READY = false;

/* ------------------------------------------------------------------ generic table */
function table(el, cols, rows, opts = {}) {
  const st = el._t || (el._t = { k: opts.sortKey || null, dir: opts.sortDir || 1, page: 0 });
  if (opts.resetPage) st.page = 0;
  const pageSize = opts.pageSize || 0;
  let data = rows.slice();
  if (st.k) {
    const c = cols.find(x => x.k === st.k);
    if (c) {
      const sv = c.s || ((r) => r[c.k]);
      data.sort((a, b) => { let x = sv(a), y = sv(b);
        if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * st.dir;
        const nx = Number(x), ny = Number(y); if (!isNaN(nx) && !isNaN(ny) && String(x).trim() !== '' && String(y).trim() !== '') return (nx - ny) * st.dir;
        return String(x).localeCompare(String(y)) * st.dir; });
    }
  }
  const pages = pageSize ? Math.max(1, Math.ceil(data.length / pageSize)) : 1;
  if (st.page >= pages) st.page = pages - 1;
  const shown = pageSize ? data.slice(st.page * pageSize, (st.page + 1) * pageSize) : data;
  const head = cols.map(c => `<th data-k="${esc(c.k)}" class="${c.n ? 'n' : ''}" title="${esc(c.t || '')}">${c.l}${st.k === c.k ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
  const body = shown.map((r, i) => `<tr class="${opts.onRow ? 'click' : ''}" data-i="${i}">` + cols.map(c => {
    const v = c.f ? c.f(r) : fmt(r[c.k], c.kind); return `<td class="${c.n ? 'n' : ''}">${v}</td>`; }).join('') + '</tr>').join('');
  const grp = opts.groups ? `<tr class="grp">${opts.groups.map(g => `<th colspan="${g.span}">${g.l}</th>`).join('')}</tr>` : '';
  el.innerHTML = `<div class="tblwrap" style="${opts.maxH ? 'max-height:' + opts.maxH : ''}"><table class="t"><thead>${grp}<tr>${head}</tr></thead><tbody>${body ||
    `<tr><td colspan="${cols.length}" class="muted">No rows</td></tr>`}</tbody></table></div>` +
    (pageSize && pages > 1 ? `<div class="pager"><button class="mini" data-p="-1">‹ Prev</button> Page ${st.page + 1} / ${pages} · ${data.length.toLocaleString()} rows <button class="mini" data-p="1">Next ›</button></div>`
      : `<div class="note">${data.length.toLocaleString()} rows</div>`);
  $$('th[data-k]', el).forEach(th => th.onclick = () => { const k = th.dataset.k; if (st.k === k) st.dir *= -1; else { st.k = k; st.dir = 1; } table(el, cols, rows, opts); });
  $$('.pager button', el).forEach(b => b.onclick = () => { st.page += Number(b.dataset.p); table(el, cols, rows, opts); });
  if (opts.onRow) $$('tbody tr.click', el).forEach(tr => tr.onclick = (e) => { if (e.target.closest('button,select,a,input')) return; opts.onRow(shown[Number(tr.dataset.i)]); });
  if (opts.after) opts.after(el, shown);
}
function options(list, sel, withAll = '— all —') {
  return (withAll ? `<option value="">${withAll}</option>` : '') + list.map(v => { const val = Array.isArray(v) ? v[0] : v, lab = Array.isArray(v) ? v[1] : v;
    return `<option value="${esc(val)}"${String(sel) === String(val) ? ' selected' : ''}>${esc(lab)}</option>`; }).join('');
}
const execOptions = (sel, none = '— choose executive —') => options(EXECS.map(e => [e, tName(e) !== e ? `${e} (${tName(e)})` : e]), sel, none);
let MODAL_REFRESH = null;   // re-renders the open card after an assignment change
function openModal(html, refresh) { $('#modal-body').innerHTML = html; $('#modal').style.display = 'flex'; MODAL_REFRESH = refresh || null; }
function closeModal() { $('#modal').style.display = 'none'; MODAL_REFRESH = null; }

/* seller-level Final executive dropdown (Seller Explorer, seller card, cluster card seller list, map popup) */
function sellerFinalSelect(s) {
  if (s.c === null) return '<span class="muted">NOT ALLOCATED</span>';
  const cur = finalExecOf(s), def = defaultFinalExec(s), ov = hasOverride(s);
  const why = keepsOriginal(s) ? 'Renewal OS – kept with original' : 'follows cluster';
  const title = ov ? `BM seller-level override. Without it: ${def || 'Unassigned'} (${why})` : `${SOURCE_LABEL[finalSource(s)]}. Choose an executive to override for this seller only.`;
  return `${swatch(cur)}<select class="sov" data-i="${s.i}" title="${esc(title)}">
    <option value="__default"${ov ? '' : ' selected'}>${ov ? '↺ ' : ''}${esc(def || 'Unassigned')} (${esc(why)})</option>
    ${EXECS.map(e => `<option value="${esc(e)}"${ov && cur === e ? ' selected' : ''}>${esc(e)}</option>`).join('')}
  </select>${ov ? ' <span class="tag">override</span>' : ''}`;
}
document.addEventListener('change', (ev) => {
  const t = ev.target; if (!t.classList || !t.classList.contains('sov')) return;
  setSellerFinal(Number(t.dataset.i), t.value === '__default' ? null : t.value);
});
/* "45 MDC, 42 TS" - one format for count pairs everywhere */
function fmtPair(a, b, la, lb) {
  if (a === null || a === undefined || b === null || b === undefined) return '<span class="muted">—</span>';
  return `${Math.round(a).toLocaleString('en-IN')} ${la}, ${Math.round(b).toLocaleString('en-IN')} ${lb}`;
}
const branchName = (b) => b ? String(b).replace(/[\s_-]+\d{1,2}(st|nd|rd|th)?[\s_-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?([\s_-]+\d{2,4})?\s*$/i, '').trim() : b;
const TURNOVER_LABEL = () => S.B.turnover_threshold ? `Turnover > ₹${esc(S.B.turnover_threshold)}` : 'Turnover above threshold';
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/* ------------------------------------------------------------------ tabs */
const RENDER = { data: renderData, dash: renderDash, terr: renderTerr, changes: renderChanges, map: () => {} };
function showTab(name) {
  if (!S.B.ok && name !== 'data') { toast('Complete the column mapping first', 'warn'); name = 'data'; }
  CURRENT_TAB = name;
  $$('nav#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + name));
  if (name === 'map') {
    if (!MAP_READY) { initMap(); MAP_READY = true; renderSide(); }
    setTimeout(() => M.map.invalidateSize(), 50);
  } else if (STALE.has(name) || !$('#tab-' + name).innerHTML) { STALE.delete(name); RENDER[name](); }
}
$$('nav#tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

/* ------------------------------------------------------------------ header */
function updateHeader() {
  const ch = CIDS().filter(cid => changeType(cid) !== 'Unchanged').length + overrideCount();
  $('#chgCount').textContent = ch || '';
  $('#dirtyFlag').style.display = S.dirty ? 'inline' : 'none';
  $('#btnUndo').disabled = !S.undo.length;
}
function setupBaseline() {
  const sel = $('#baseSel');
  sel.innerHTML = S.B.candidates.map(c => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('') + '<option value="">None – blank start</option>';
  sel.value = S.base || '';
  if (S.B.candidates.length <= 1) {  // single recommendation configured: show it as a fixed label, no choice needed
    $('#baseWrap').style.display = 'none';
    const fx = $('#baseFixed'); fx.style.display = 'inline';
    fx.textContent = S.B.candidates.length ? `Recommendation: ${S.B.candidates[0].label}` : 'No recommendation loaded';
  }
  sel.onchange = () => {
    const nk = sel.value || null;
    const reset = confirm(`Recommended baseline → ${candLabel(nk)}.\n\nOK = also reset the Final assignment to this baseline (your edits are logged and can be undone).\nCancel = keep the current Final assignment and only change what it is compared against.`);
    S.base = nk;
    S.audit.push({ ts: nowTs(), action: 'baseline', method: 'header', cluster: null, from: null, to: nk, note: `Baseline set to ${candLabel(nk)}` });
    if (reset) { if (nk) resetToRecommendation(); else startBlank(); }
    else { S.dirty = true; emit({ changed: CIDS(), affected: EXECS }); }
    if (MAP_READY) restyleAll();
  };
}

/* ------------------------------------------------------------------ change listener */
onChange((info) => {
  updateHeader();
  ['dash', 'terr', 'changes'].forEach(t => STALE.add(t));
  if (CURRENT_TAB && CURRENT_TAB !== 'map' && CURRENT_TAB !== 'data') {
    STALE.delete(CURRENT_TAB);
    RENDER[CURRENT_TAB]();
  }
  if (MAP_READY) { renderSideExec(); renderSelection(); renderImpact(); if (INSPECTED) renderInspect(INSPECTED); }
  if (MODAL_REFRESH && $('#modal').style.display !== 'none') MODAL_REFRESH();
  void info;
});

/* ============================================================================ SIDE PANEL (map tab) */
let INSPECTED = null;
function setSidePanel(open) {
  $('#tab-map').classList.toggle('side-min', !open);
  if (MAP_READY) setTimeout(() => M.map.invalidateSize(), 30);
}
const sidePanelOpen = () => !$('#tab-map').classList.contains('side-min');
function renderSide() {
  $('#sideShow').onclick = () => setSidePanel(true);
  $('#side').innerHTML = `
    <div class="side-top"><button class="mini" id="sideHide" title="Minimise this panel; the map uses the freed space">Minimise panel ▸</button></div>
    <div class="side-sec" id="sec-exec"></div>
    <div class="side-sec" id="sec-tools">
      <h3>Edit territory</h3>
      <div class="modes">
        <button class="modebtn" data-mode="inspect" title="Click clusters to view details">Inspect</button>
        <button class="modebtn" data-mode="quick" title="Click a cluster to add/remove it for the selected executive">Quick add/remove</button>
        <button class="modebtn" data-mode="select" title="Click clusters to build a selection">Select</button>
        <button class="modebtn" data-mode="draw" title="Draw a polygon; clusters whose centroid is inside are selected">Draw polygon</button>
      </div>
      <div class="note" id="modehint"></div>
      <div class="row"><input id="addCid" placeholder="Cluster ID" style="width:90px"><button class="mini" id="btnAddCid">Add to executive</button>
        <button class="mini" id="btnSelCid">Add to selection</button><button class="mini" id="btnClearPoly">Clear polygon</button></div>
    </div>
    <div class="side-sec" id="sec-sel"></div>
    <div class="side-sec" id="sec-impact"></div>
    <div class="side-sec" id="sec-insp"></div>`;
  $$('.modebtn').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('#btnAddCid').onclick = () => { const v = $('#addCid').value.trim(); if (!C[v]) return toast(`Cluster “${esc(v)}” not found`, 'warn');
    if (!S.activeExec) return toast('Select an executive first', 'warn'); assignClusters([v], S.activeExec, 'manual-id', `Added cluster ${v} to ${S.activeExec}`); flashCluster(v); };
  $('#btnSelCid').onclick = () => { const v = $('#addCid').value.trim(); if (!C[v]) return toast(`Cluster “${esc(v)}” not found`, 'warn'); setSel([v], true); zoomToClusters([v]); flashCluster(v); };
  $('#btnClearPoly').onclick = clearDrawn;
  $('#sideHide').onclick = () => setSidePanel(false);
  setMode(S.mode === 'draw' ? 'select' : S.mode);
  renderSideExec(); renderSelection(); renderImpact(); renderInspect(null);
}
function showSideSection(id) { const el = $('#sec-' + (id === 'selection' ? 'sel' : id)); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

function setActiveExec(e) {
  S.activeExec = e || null;
  if (MAP_READY) { S.B.clusters.forEach(c => restyleCluster(c.id)); renderLegend(); renderSideExec(); renderSelection(); renderImpact(); if (INSPECTED) renderInspect(INSPECTED); }
}
/* Executive seller counts (sales view): Total sellers = Renewal cases + Eligible sellers.
   Current = everyone mapped to the executive today; Recommended / Final = their own renewal cases (they always stay)
   + the eligible sellers in the clusters given to them. */
const SIDE_ROWS = [['total', 'Total sellers', 'tot'], ['renewal', 'Renewal cases', 'sub'], ['elig_all', 'Eligible sellers', 'sub']];
const editedBadge = '<span class="rag rag-na" title="You changed this territory, so the stored RAG no longer applies">edited</span>';
function renderSideExec() {
  const el = $('#sec-exec'); if (!el) return;
  const e = S.activeExec;
  let html = `<h3>Executive</h3><div class="row"><select id="execSel" style="flex:1">${execOptions(e)}</select></div>`;
  if (e) {
    const f = finalMetrics(e), rm = recMetrics(e), cm = currentAllMetrics(e);
    const curRow = storedRow('__current__', e), recRow = S.base ? storedRow(S.base, e) : null, sa = storedApplicable(e);
    html += `<table class="t cmp exec-tbl"><thead><tr><th>${swatch(e)}</th><th class="n">Current</th><th class="n">Recommended</th><th class="n">Final</th></tr></thead><tbody>
      ${SIDE_ROWS.map(([k, lab, cls]) => `<tr class="${cls}"><td>${lab}</td><td class="n">${fmt(cm[k], 'int')}</td><td class="n">${fmt(rm[k], 'int')}</td><td class="n"><b>${fmt(f[k], 'int')}</b></td></tr>`).join('')}
      <tr><td>Overall RAG</td><td>${ragBadge(storedVal(curRow, 'overall_rag'), '—')}</td><td>${ragBadge(storedVal(recRow, 'overall_rag'), '—')}</td>
        <td>${sa ? ragBadge(storedVal(sa.row, 'overall_rag')) : (f.clusters ? editedBadge : '—')}</td></tr>
      </tbody></table>
      <div class="row"><button class="mini" id="btnZoomExec">Zoom to territory</button>
      <button class="mini" id="btnResetExec">Reset to recommendation</button><button class="mini danger" id="btnClearExec">Clear territory</button></div>
      <details><summary>Clusters in final territory (${f.clusters})</summary><div class="chips" id="finalChips">${chipsFor(e)}</div></details>
      <details><summary>Territory name</summary><div class="row"><input id="terrName" value="${esc(tName(e))}" style="flex:1"></div></details>`;
  } else html += `<div class="note">Choose an executive to see and edit their territory.</div>`;
  el.innerHTML = html;
  $('#execSel').onchange = (ev) => setActiveExec(ev.target.value);
  if (!e) return;
  $('#terrName').onchange = (ev) => { const v = ev.target.value.trim(); const old = tName(e); S.names[e] = v || e;
    S.audit.push({ ts: nowTs(), action: 'rename', method: 'side-panel', cluster: null, from: old, to: S.names[e], note: `Territory name for ${e}` }); S.dirty = true; updateHeader(); renderLegend(); };
  $('#btnZoomExec').onclick = () => zoomToClusters(finalClusters(e).length ? finalClusters(e) : recClusters(e));
  $('#btnResetExec').onclick = () => { if (!S.base) return toast('No recommendation baseline selected', 'warn'); resetToRecommendation(e); };
  $('#btnClearExec').onclick = () => { const cl = finalClusters(e); if (!cl.length) return; if (confirm(`Unassign all ${cl.length} clusters of ${e}? They become Unassigned (not given to anyone else).`)) applyChanges(cl.map(cid => ({ cid, to: null })), 'clear-territory', `Cleared territory of ${e}`); };
  $$('#finalChips .chip').forEach(ch => {
    ch.onclick = (ev) => { const cid = ch.dataset.cid; if (ev.target.classList.contains('x')) { applyChanges([{ cid, to: null }], 'chip-remove', `Removed cluster ${cid} from ${e}`); return; }
      zoomToClusters([cid]); flashCluster(cid); inspectCluster(cid); };
  });
}
function chipsFor(e) {
  const fin = finalClusters(e), rec = new Set(recClusters(e)), finS = new Set(fin);
  const chips = fin.map(cid => `<span class="chip${rec.has(cid) ? '' : ' new'}" data-cid="${esc(cid)}" title="${rec.has(cid) ? 'In recommendation' : 'Added vs recommendation'} · ${C[cid].n} sellers"><b>${esc(cid)}</b><span class="muted">${C[cid].n}</span><button class="x" title="Remove from territory">✕</button></span>`);
  const gone = [...rec].filter(cid => !finS.has(cid)).map(cid => `<span class="chip gone" data-cid="${esc(cid)}" title="Recommended but not in final (now: ${esc(S.final[cid] || 'Unassigned')})"><b>${esc(cid)}</b></span>`);
  return chips.join('') + gone.join('') || '<span class="muted">No clusters</span>';
}

function renderSelection() {
  const el = $('#sec-sel'); if (!el) return;
  const sel = [...S.sel].sort(idSort);
  if (!sel.length) { el.innerHTML = ''; return; }
  const e = S.activeExec;
  const tot = sel.reduce((a, c) => a + C[c].n, 0), el_ = sel.reduce((a, c) => a + C[c].n_el, 0);
  const others = sel.filter(c => S.final[c] && S.final[c] !== e);
  el.innerHTML = `<h3>Selection <span class="muted">${sel.length} clusters · ${tot} sellers · ${el_} eligible</span></h3>
    <div class="tblwrap" style="max-height:220px"><table class="t"><thead><tr><th>Cluster</th><th class="n">Sellers</th><th class="n">Elig.</th><th>Worst RAG</th><th>Recommended</th><th>Final</th><th></th></tr></thead><tbody>
    ${sel.map(cid => { const c = C[cid]; return `<tr><td><a href="#" data-insp="${esc(cid)}">${esc(cid)}</a></td><td class="n">${c.n}</td><td class="n">${c.n_el}</td><td>${ragBadge(c.worst, '—')}</td>
      <td>${execLabel(recOf(cid))}</td><td>${execLabel(S.final[cid])}</td><td><button class="mini" data-unsel="${esc(cid)}" title="Remove from selection">✕</button></td></tr>`; }).join('')}
    </tbody></table></div>
    ${others.length && e ? `<div class="warnbox">${others.length} selected cluster(s) currently belong to other executives and will be <b>moved</b> to ${esc(e)}: ${others.map(c => `${esc(c)} (${esc(S.final[c])})`).join(', ')}</div>` : ''}
    <div class="row">
      <button class="mini primary" id="selAdd" ${e ? '' : 'disabled'}>Add to ${esc(e || 'executive')}</button>
      <button class="mini" id="selReplace" ${e ? '' : 'disabled'} title="Selected clusters become exactly this executive's territory; clusters no longer included become Unassigned">Replace ${esc(e || '')} territory</button>
    </div>
    <div class="row"><select id="selMoveTo">${execOptions(null, '— move to —')}</select><button class="mini" id="selMove">Move</button>
      <button class="mini" id="selUnassign">Unassign</button><button class="mini" id="selClear">Clear selection</button></div>`;
  $$('[data-unsel]', el).forEach(b => b.onclick = () => toggleSel(b.dataset.unsel));
  $$('[data-insp]', el).forEach(a => a.onclick = (ev) => { ev.preventDefault(); zoomToClusters([a.dataset.insp]); flashCluster(a.dataset.insp); inspectCluster(a.dataset.insp); });
  const done = () => { clearSel(); clearDrawn(); };
  $('#selAdd').onclick = () => { if (assignClusters(sel, e, 'selection', `Added ${sel.length} selected cluster(s) to ${e}`)) done(); };
  $('#selReplace').onclick = () => { if (confirm(`Make these ${sel.length} clusters the entire territory of ${e}? ${finalClusters(e).filter(c => !S.sel.has(c)).length} of its current clusters would become Unassigned.`)) { if (replaceTerritory(e, sel, 'selection-replace')) done(); } };
  $('#selMove').onclick = () => { const t = $('#selMoveTo').value; if (!t) return toast('Choose the executive to move to', 'warn'); if (assignClusters(sel, t, 'selection-move', `Moved ${sel.length} cluster(s) to ${t}`)) done(); };
  $('#selUnassign').onclick = () => { if (applyChanges(sel.map(cid => ({ cid, to: null })), 'selection-unassign', `Unassigned ${sel.length} cluster(s)`)) done(); };
  $('#selClear').onclick = done;
}

/* Territory impact rows: [storedField(s), liveKey(s), label, kind]. Recommended = stored value where present, else the
   live engine on the recommended sellers; Final = live engine on the Final sellers. Seller counts are always live
   (same rule for Recommended and Final). IMPACT_MORE is shown collapsed. */
const IMPACT_METRICS = [
  [null, 'total', 'Total sellers', 'int'],
  [null, 'renewal', 'Renewal cases', 'int'],
  [null, 'elig_all', 'Eligible sellers', 'int'],
  ['m_avg_dist', 'avg_dist', 'Avg distance to territory centre (km)', 'km'],
  ['m_ren_window', 'ren_window', 'Upcoming renewals (eligible sellers)', 'int'],
  [['m_mdc', 'm_ts'], ['mdc', 'ts'], 'MDC / TS', ['MDC', 'TS']],
  ['m_turnover', 'turnover', null, 'sellers'],
  ['m_vintage', 'vintage', 'Vintage clients', 'sellers'],
  [['m_annual', 'm_myr'], ['annual', 'myr'], 'Annual / MYR', ['Annual', 'MYR']],
];
const IMPACT_MORE = [
  ['m_clusters', 'clusters', 'Clusters', 'int'],
  ['m_geo_spread', 'geo_spread', 'Geographic spread (km)', 'km'],
  ['m_max_dist', 'max_dist', 'Max distance to territory centre (km)', 'km'],
  ['m_hhi', 'hhi', 'Renewal HHI (lower = more even)', 'hhi'],
  [null, 'retained', 'Sellers keeping their current executive', 'int'],
  [null, 'changes', 'Sellers changing executive', 'int'],
];
function signed(d, kind) {
  if (d === null || d === undefined || isNaN(d)) return '<span class="muted">—</span>';
  if (Math.abs(d) < 1e-9) return '<span class="muted">0</span>';
  const v = kind === 'km' ? d.toFixed(2) : kind === 'hhi' ? d.toFixed(3) : kind === 'score' ? d.toFixed(1) : Math.round(d).toLocaleString('en-IN');
  return (d > 0 ? '+' : '') + v;
}
function impactRowsHtml(recGet, fin, rows = IMPACT_METRICS) {
  const num = (v) => typeof v === 'number' && !isNaN(v);
  return rows.map(([sf, lk, lab, kind]) => {
    const label = lab || `Turnover above threshold${S.B.turnover_threshold ? ' (₹' + esc(S.B.turnover_threshold) + ')' : ''}`;
    if (Array.isArray(kind)) {
      const r = [recGet(lk[0], sf[0]), recGet(lk[1], sf[1])], f = [fin[lk[0]], fin[lk[1]]];
      const ch = [r, f].flat().every(num) ? ((Math.abs(f[0] - r[0]) < 1e-9 && Math.abs(f[1] - r[1]) < 1e-9) ? '<span class="muted">0</span>'
        : `${signed(f[0] - r[0])} ${kind[0]}, ${signed(f[1] - r[1])} ${kind[1]}`) : '<span class="muted">—</span>';
      return `<tr><td>${label}</td><td class="n">${fmtPair(r[0], r[1], kind[0], kind[1])}</td><td class="n"><b>${fmtPair(f[0], f[1], kind[0], kind[1])}</b></td><td class="n">${ch}</td></tr>`;
    }
    const r = recGet(lk, sf), f = fin[lk];
    const show = (v) => kind === 'sellers' ? (num(v) ? `${Math.round(v).toLocaleString('en-IN')} sellers` : fmt(v)) : fmt(v, kind);
    return `<tr><td>${label}</td><td class="n">${show(r)}</td><td class="n"><b>${show(f)}</b></td><td class="n">${num(r) && num(f) ? signed(f - r, kind) : '<span class="muted">—</span>'}</td></tr>`;
  }).join('');
}
function renderImpact() {
  const el = $('#sec-impact'); if (!el) return;
  const e = S.activeExec;
  let html = `<h3>Territory impact</h3>`;
  if (e) {
    const f = finalMetrics(e), recRow = S.base ? storedRow(S.base, e) : null, rm = recMetrics(e);
    const sa = storedApplicable(e);
    const recGet = (lk, sf) => { const v = sf ? storedVal(recRow, sf) : null; return (v !== null && v !== undefined) ? v : rm[lk]; };
    const rRag = storedVal(recRow, 'overall_rag'), fRag = sa ? storedVal(sa.row, 'overall_rag') : null;
    const rSc = storedVal(recRow, 'overall_score'), fSc = sa ? storedVal(sa.row, 'overall_score') : null;
    const head = `<thead><tr><th></th><th class="n">Recommended</th><th class="n">Final</th><th class="n">Change</th></tr></thead>`;
    html += `<table class="t cmp">${head}<tbody>
      ${impactRowsHtml(recGet, f)}
      <tr><td>Overall RAG</td><td class="n">${ragBadge(rRag, '—')}</td>
        <td class="n">${sa ? ragBadge(fRag) : (f.clusters ? editedBadge : '—')}</td>
        <td class="n">${sa && rRag && fRag && String(rRag) !== String(fRag) ? `<span class="chg">${esc(rRag)} → ${esc(fRag)}</span>` : '<span class="muted">—</span>'}</td></tr>
      </tbody></table>
      <details><summary>More details</summary><table class="t cmp">${head}<tbody>
      ${impactRowsHtml(recGet, f, IMPACT_MORE)}
      <tr><td>Overall score</td><td class="n">${fmt(rSc, 'score')}</td><td class="n">${sa ? fmt(fSc, 'score') : '<span class="muted">—</span>'}</td>
        <td class="n">${sa && typeof rSc === 'number' && typeof fSc === 'number' ? signed(fSc - rSc, 'score') : '<span class="muted">—</span>'}</td></tr>
      </tbody></table></details>
      ${renewalBars(f, rm)}`;
  } else html += `<div class="note">Choose an executive to see Recommended vs Final.</div>`;
  el.innerHTML = html;
}
function renewalBars(f, rm) {
  const win = S.B.territory_rag.window || []; if (!win.length) return '';
  const mx = Math.max(1, ...win.map(w => Math.max(f.months[w.ym] || 0, rm.months[w.ym] || 0)));
  return `<details><summary>Upcoming renewals by month (eligible sellers)</summary><table class="t"><thead><tr><th>Month</th><th class="n">Rec.</th><th class="n">Final</th><th>Final</th></tr></thead><tbody>` +
    win.map(w => `<tr><td>${esc(w.col)}</td><td class="n">${rm.months[w.ym] || 0}</td><td class="n">${f.months[w.ym] || 0}</td><td><div class="bar" style="min-width:100px"><span style="width:${(100 * (f.months[w.ym] || 0) / mx).toFixed(0)}%;background:#6d8fc9"></span></div></td></tr>`).join('') + '</tbody></table></details>';
}

function inspectCluster(cid) {
  INSPECTED = cid;
  if (CURRENT_TAB !== 'map') { openClusterCard(cid); return; }
  if (!sidePanelOpen()) setSidePanel(true);  // the cluster card lives in the side panel
  renderInspect(cid); flashCluster(cid); showSideSection('insp');
}
function renderInspect(cid) {
  const el = $('#sec-insp'); if (!el) return;
  if (!cid || !C[cid]) { el.innerHTML = ''; return; }
  const c = C[cid], f = S.final[cid] || null, e = S.activeExec;
  const m = metricsForClusters([cid]);  // same engine / population (eligible sellers) as Cluster RAG
  const geoP = S.B.rag_params.find(p => /^geo/i.test(p));
  el.innerHTML = `<h3>Cluster ${esc(cid)}</h3>
    <div class="kv">
      <div>Eligible sellers</div><div>${c.n_el}</div>
      <div>Renewal cases <span class="muted">(stay with their current executive)</span></div><div>${c.n_inel}</div>
      <div>Geographic Spread</div><div>${geoP ? ragBadge(c.rag[geoP], '—') : '—'}</div>
      <div>Vintage Clients</div><div>${fmt(m.vintage, 'int')}</div>
      <div title="Renewals in the renewal window (${esc((S.B.territory_rag.window[0] || {}).col || '')} – ${esc((S.B.territory_rag.window.slice(-1)[0] || {}).col || '')})">Renewals</div><div>${fmt(m.ren_window, 'int')}</div>
      <div>MDC</div><div>${fmt(m.mdc, 'int')}</div>
      <div>TS</div><div>${fmt(m.ts, 'int')}</div>
      <div>Annual</div><div>${fmt(m.annual, 'int')}</div>
      <div>MYR</div><div>${fmt(m.myr, 'int')}</div>
      <div><b>Final</b></div><div><b>${execLabel(f)}</b></div>
    </div>
    <div class="row">
      ${e && f !== e ? `<button class="mini primary" id="inspAdd">${f ? 'Move' : 'Add'} to ${esc(e)}</button>` : ''}
      ${f ? `<button class="mini" id="inspRem">Unassign from ${esc(f)}</button>` : ''}
      <button class="mini" id="inspSel">${S.sel.has(cid) ? 'Remove from selection' : 'Add to selection'}</button>
      <button class="mini" id="inspZoom">Zoom</button>
    </div>
    <div class="row"><select id="inspMoveTo">${execOptions(null, '— move to executive —')}</select><button class="mini" id="inspMove">Move</button></div>`;
  if ($('#inspAdd')) $('#inspAdd').onclick = () => assignClusters([cid], e, 'inspect', f ? `Moved cluster ${cid} from ${f} to ${e}` : `Added cluster ${cid} to ${e}`);
  if ($('#inspRem')) $('#inspRem').onclick = () => applyChanges([{ cid, to: null }], 'inspect', `Unassigned cluster ${cid} from ${f}`);
  $('#inspMove').onclick = () => { const t = $('#inspMoveTo').value; if (!t) return toast('Choose the executive to move to', 'warn');
    assignClusters([cid], t, 'inspect', f ? `Moved cluster ${cid} from ${f} to ${t}` : `Added cluster ${cid} to ${t}`); };
  $('#inspSel').onclick = () => { toggleSel(cid); renderInspect(cid); };
  $('#inspZoom').onclick = () => zoomToClusters([cid]);
}

/* ============================================================================ cards */
/* Cluster links in tables open the cluster on the map (the detail cards and explorers were removed). */
function openClusterCard(cid) { if (!C[cid]) return; closeModal(); showTab('map'); zoomToClusters([cid]); flashCluster(cid); inspectCluster(cid); }

/* ============================================================================ TERRITORY EXPLORER */
let TBASIS = 'final';
function terrRows(basis) {
  return EXECS.map(e => {
    let m, row = null, cl, a;
    if (basis === 'final') { m = finalMetrics(e); const sa = storedApplicable(e); row = sa ? sa.row : null; cl = finalClusters(e); a = finalAllocation(e); }
    else { const mp = cand(basis).map; cl = clustersOf(e, mp); m = recMetrics(e); row = storedRow(basis, e); a = allocationFor(e, recSellers(e), (cid) => mp[cid] || null, null); }
    return { exec: e, terr: tName(e), m, row, cl, basis, a };
  });
}
function renderTerr() {
  const el = $('#tab-terr');
  const basisOpts = [['final', 'Final (your assignment)'], ...S.B.candidates.map(c => [c.key, 'Recommended'])];
  el.innerHTML = `<div class="card"><h3>Territory Explorer</h3><div class="filters"><label>Show<select id="tbasis">${options(basisOpts, TBASIS, null)}</select></label>
    <span class="note"><b>Renewal cases</b> always stay with their current executive; <b>eligible sellers</b> move with their cluster.</span></div><div id="tTable"></div></div>`;
  $('#tbasis').onchange = () => { TBASIS = $('#tbasis').value; renderTerr(); };
  const sv = (r, f, k) => { const v = storedVal(r.row, f); return (r.basis !== 'final' && v !== null && v !== undefined) ? v : r.m[k]; };
  const ac = (k, l, t) => ({ k: 'a:' + k, l, t, n: true, s: (r) => r.a[k], f: (r) => fmt(r.a[k], 'int') });
  const mc = (k, l, t) => ({ k: 'm:' + k, l, t, n: true, s: (r) => r.m[k], f: (r) => fmt(r.m[k], 'int') });
  const cols = [
    { k: 'exec', l: 'Executive', f: (r) => execLabel(r.exec) }, { k: 'terr', l: 'Territory' },
    ac('oldTotal', 'Total sellers', 'Sellers mapped to this executive today'),
    ac('oldRenewalOS', 'Renewal cases', 'Of these, renewal due / outstanding - they stay with this executive'),
    ac('oldEligible', 'Eligible sellers', 'Of these, eligible sellers'),
    mc('total', 'Total sellers', 'Renewal cases + eligible sellers after the change'),
    mc('renewal', 'Renewal cases', 'Renewal cases (stay with their current executive)'),
    mc('elig_all', 'Eligible sellers', "Eligible sellers in this executive's clusters"),
    ac('existing', 'Same executive', 'Sellers who already belong to this executive today'),
    ac('newlyMapped', 'New to this executive', 'Sellers who belong to someone else (or no one) today'),
    { k: 'cl', l: 'Clusters', n: true, s: (r) => r.cl.length, f: (r) => r.cl.length },
    { k: 'geo', l: 'Geographic spread (km)', n: true, s: (r) => sv(r, 'm_geo_spread', 'geo_spread'), f: (r) => fmt(sv(r, 'm_geo_spread', 'geo_spread'), 'km') },
    { k: 'avgd', l: 'Avg distance (km)', n: true, s: (r) => sv(r, 'm_avg_dist', 'avg_dist'), f: (r) => fmt(sv(r, 'm_avg_dist', 'avg_dist'), 'km') },
    { k: 'mdc', l: 'MDC / TS', n: true, s: (r) => sv(r, 'm_mdc', 'mdc'), f: (r) => fmtPair(sv(r, 'm_mdc', 'mdc'), sv(r, 'm_ts', 'ts'), 'MDC', 'TS') },
    { k: 'to', l: TURNOVER_LABEL(), n: true, t: 'Eligible sellers above the turnover threshold', s: (r) => sv(r, 'm_turnover', 'turnover'), f: (r) => fmt(sv(r, 'm_turnover', 'turnover'), 'int') },
    { k: 'vi', l: 'Vintage Clients', n: true, s: (r) => sv(r, 'm_vintage', 'vintage'), f: (r) => fmt(sv(r, 'm_vintage', 'vintage'), 'int') },
    { k: 'an', l: 'Annual / MYR', n: true, s: (r) => sv(r, 'm_annual', 'annual'), f: (r) => fmtPair(sv(r, 'm_annual', 'annual'), sv(r, 'm_myr', 'myr'), 'Annual', 'MYR') },
  ];
  table($('#tTable'), cols, terrRows(TBASIS), { onRow: (r) => openTerritoryCard(r.exec),
    groups: [{ l: '', span: 2 }, { l: 'Today', span: 3 }, { l: TBASIS === 'final' ? 'Final' : 'Recommended', span: 5 }, { l: 'Territory summary', span: 7 }] });
}
function openTerritoryCard(e) {
  const f = finalMetrics(e);
  const cols = [{ label: 'Current', row: storedRow('__current__', e), m: currentAllMetrics(e) }];
  if (S.base) cols.push({ label: 'Recommended', row: storedRow(S.base, e), m: recMetrics(e) });
  const sa = storedApplicable(e);
  const rowsHtml = METRICS.map(([sf, lk, lab, kind]) => `<tr><td>${lab}</td>${cols.map(c => { const v = sf ? storedVal(c.row, sf) : null; return `<td class="n">${fmt(v !== null && v !== undefined ? v : c.m[lk], kind)}</td>`; }).join('')}<td class="n"><b>${fmt(f[lk], kind)}</b></td></tr>`).join('');
  const ragRows = [trCol('overall_rag'), ...storedParamRagCols()].filter(Boolean).map(p => `<tr><td>${esc(p)}</td>${cols.map(c => `<td>${ragBadge(storedByCol(c.row, p), '—')}</td>`).join('')}<td>${sa ? ragBadge(storedByCol(sa.row, p), '—') : (f.clusters ? editedBadge : '—')}</td></tr>`).join('');
  openModal(`<h3>${swatch(e)}${esc(e)}${tName(e) !== e ? ` <span class="muted" style="font-weight:400">· ${esc(tName(e))}</span>` : ''}</h3>
    <div class="row"><button class="mini primary" onclick="closeModal();showTab('map');setActiveExec(${JSON.stringify(e).replace(/"/g, '&quot;')});zoomToClusters(finalClusters(${JSON.stringify(e).replace(/"/g, '&quot;')}))">Edit on map</button></div>
    <table class="t cmp"><thead><tr><th></th>${cols.map(c => `<th class="n">${esc(c.label)}</th>`).join('')}<th class="n">Final</th></tr></thead><tbody>${rowsHtml}${ragRows}</tbody></table>
    <h4>Final clusters (${f.clusters})</h4><div class="chips">${finalClusters(e).map(cid => `<span class="chip" onclick="openClusterCard('${esc(cid)}')"><b>${esc(cid)}</b></span>`).join('') || '<span class="muted">none</span>'}</div>`);
}

/* ============================================================================ EXECUTIVE DASHBOARD */
function distBar(counts, total) {
  const seg = (k, col) => counts[k] ? `<span style="width:${(100 * counts[k] / total).toFixed(2)}%;background:${col}" title="${k}: ${counts[k]}"></span>` : '';
  return `<div class="bar">${seg('GREEN', 'var(--g)')}${seg('AMBER', 'var(--a)')}${seg('RED', 'var(--r)')}${seg('N/A', 'var(--na)')}</div>`;
}
function countRag(vals) { const c = { GREEN: 0, AMBER: 0, RED: 0, 'N/A': 0 }; vals.forEach(v => { const u = String(v || '').toUpperCase(); if (u in c) c[u]++; else c['N/A']++; }); return c; }
const ragTxt = (c) => `<span class="muted">G ${c.GREEN} · A ${c.AMBER} · R ${c.RED}${c['N/A'] ? ' · N/A ' + c['N/A'] : ''}</span>`;
function renderDash() {
  const el = $('#tab-dash');
  const nS = SELLERS.length, clustered = SELLERS.filter(s => s.c !== null).length;
  const elig = SELLERS.filter(s => s.el === 'Eligible').length;
  const un = CIDS().filter(cid => !S.final[cid]); const unS = un.reduce((a, c) => a + C[c].n, 0);
  const terrs = EXECS.filter(e => finalClusters(e).length).length;
  const kp = (k, v, cls = '') => `<div class="kpi ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`;
  const clDist = [['Overall RAG (stored)', S.B.clusters.map(c => c.ov)], ['Worst parameter RAG', S.B.clusters.map(c => c.worst)], ...S.B.rag_params.map(p => [p, S.B.clusters.map(c => c.rag[p])])];
  const trDist = [...S.B.candidates.map(c => [c.label, S.B.territory_rag.rows.filter(r => r.cand === c.key).map(r => storedVal(r, 'overall_rag'))])];
  if (S.B.territory_rag.rows.some(r => r.cand === '__current__')) trDist.push([S.B.territory_rag.current_label || 'Current', S.B.territory_rag.rows.filter(r => r.cand === '__current__').map(r => storedVal(r, 'overall_rag'))]);
  const finStored = EXECS.map(e => { const sa = storedApplicable(e); return sa ? storedVal(sa.row, 'overall_rag') : null; });
  el.innerHTML = `
    <div class="kpis">${kp('Total sellers', nS.toLocaleString())}${kp('Clustered sellers', clustered.toLocaleString())}${kp('Eligible sellers', elig.toLocaleString())}
      ${kp('Ineligible sellers', (nS - elig).toLocaleString())}${kp('Not clustered (cannot be assigned)', (nS - clustered).toLocaleString(), nS - clustered ? 'warn' : '')}
      ${kp('Total clusters', S.B.clusters.length)}${kp('Territories (final, with clusters)', terrs)}${kp('Executives in pool', EXECS.length)}
      ${kp('Unassigned clusters (final)', un.length, un.length ? 'warn' : '')}${kp('Sellers in unassigned clusters', unS, unS ? 'warn' : '')}
      ${kp('Clusters changed vs recommendation', CIDS().filter(c => changeType(c) !== 'Unchanged').length)}</div>
    <div class="two">
      <div class="card"><h3>Cluster RAG distribution <span class="tag stored">stored</span></h3>
        ${clDist.map(([l, v]) => { const c = countRag(v); return `<div class="distrow"><div>${esc(l)}</div>${distBar(c, v.length)}${ragTxt(c)}</div>`; }).join('')}
        ${S.B.clusters.every(c => !c.ov) ? `<div class="note">Overall RAG: ${OV_NA} for all clusters – the Overall column in the Cluster RAG workbook is a formula with no cached value. Not recalculated.</div>` : ''}</div>
      <div class="card"><h3>Territory RAG distribution <span class="tag stored">stored</span></h3>
        ${trDist.map(([l, v]) => { const c = countRag(v); return `<div class="distrow"><div>${esc(l)}</div>${distBar(c, v.length)}${ragTxt(c)}</div>`; }).join('')}
        ${(() => { const c = countRag(finStored); return `<div class="distrow"><div><b>Final</b> (stored RAG where unchanged)</div>${distBar(c, finStored.length)}<span class="muted">G ${c.GREEN} · A ${c.AMBER} · R ${c.RED} · modified/none ${c['N/A']}</span></div>`; })()}
      </div>
    </div>
    <div class="card"><h3>Territory overview <span class="muted" style="font-weight:400">– click a row to drill down</span></h3><div id="dashT"></div></div>`;
  const pc = storedParamRagCols();
  const pick = (re) => pc.find(p => re.test(p));
  const geoC = pick(/^geo/i), renC = pick(/^renew/i), scC = pick(/^seller count/i);
  const rows = EXECS.map(e => { const m = finalMetrics(e), sa = storedApplicable(e), rr = S.base ? storedRow(S.base, e) : null; return { e, m, sa, rr }; });
  table($('#dashT'), [
    { k: 'e', l: 'Executive', f: (r) => execLabel(r.e) }, { k: 't', l: 'Territory', s: (r) => tName(r.e), f: (r) => esc(tName(r.e)) },
    { k: 'n', l: 'Sellers (final)', n: true, s: (r) => r.m.total, f: (r) => fmt(r.m.total, 'int') },{ k: 'el', l: 'Eligible', n: true, s: (r) => r.m.eligible, f: (r) => fmt(r.m.eligible, 'int') },
    { k: 'cl', l: 'Clusters', n: true, s: (r) => r.m.clusters, f: (r) => r.m.clusters },
    { k: 'st', l: 'Final vs recommendation', s: (r) => r.sa ? 0 : 1, f: (r) => r.sa ? (r.sa.key === S.base ? '<span class="muted">= recommendation</span>' : `= candidate ${esc(r.sa.key)}`) : (r.m.clusters ? '<span class="chg">modified</span>' : '<span class="chg">no clusters</span>') },
    { k: 'ov', l: `Overall RAG (stored)`, s: (r) => r.sa ? storedVal(r.sa.row, 'overall_rag') : null, f: (r) => r.sa ? ragBadge(storedVal(r.sa.row, 'overall_rag')) : `<span class="muted" title="Recommended: ${esc(storedVal(r.rr, 'overall_rag') || '—')}">rec: </span>${ragBadge(storedVal(r.rr, 'overall_rag'), '—')}` },
    ...(geoC ? [{ k: 'geo', l: 'Geographic', f: (r) => ragBadge(storedByCol(r.sa ? r.sa.row : r.rr, geoC), '—') }] : []),
    ...(renC ? [{ k: 'ren', l: 'Renewals', f: (r) => ragBadge(storedByCol(r.sa ? r.sa.row : r.rr, renC), '—') }] : []),
    ...(scC ? [{ k: 'sc', l: 'Seller Count', f: (r) => ragBadge(storedByCol(r.sa ? r.sa.row : r.rr, scC), '—') }] : []),
    { k: 'g', l: 'Geo spread km (live)', n: true, s: (r) => r.m.geo_spread, f: (r) => fmt(r.m.geo_spread, 'km') },
    { k: 'h', l: 'HHI (live)', n: true, s: (r) => r.m.hhi, f: (r) => fmt(r.m.hhi, 'hhi') },
  ], rows, { onRow: (r) => openTerritoryCard(r.e) });
}

/* ============================================================================ CHANGES & EXPORT */
function renderChanges() {
  const el = $('#tab-changes');
  const fv = finalValidation();
  const diff = S.B.clusters.map(c => ({ c, t: changeType(c.id) })).filter(x => x.t !== 'Unchanged');
  el.innerHTML = `<div class="card"><h3>Finalise</h3>
    <div class="row"><button class="primary" id="chSave">Save</button><button class="primary" id="chExport">Export Excel</button>
      <button id="chReset" ${S.base ? '' : 'disabled'}>Reset to recommendation</button><button id="chBlank">Start blank (unassign all)</button>
      <button class="danger" id="chClear">Clear all changes…</button></div>
    <div id="exportResult"></div></div>
    <div class="card"><h3>Changes vs recommendation – ${diff.length} clusters</h3><div id="chT"></div></div>
    <details class="card"><summary><b>Checks before export</b></summary><table class="t"><tbody>${fv.map(v => `<tr><td><span class="st st-${v.status}">${v.status}</span></td><td>${esc(v.check)}</td><td>${esc(v.detail)}</td></tr>`).join('')}</tbody></table></details>
    <details class="card"><summary><b>Audit log – ${S.audit.length} events</b></summary><div id="auT"></div></details>`;
  $('#chSave').onclick = saveWorking; $('#chExport').onclick = doExport;
  $('#chReset').onclick = () => { if (confirm(`Discard your modifications and restore ${candLabel(S.base)}? (logged; can be undone)`)) resetToRecommendation(); };
  $('#chBlank').onclick = () => { if (confirm('Unassign every cluster so you can build territories from scratch? (logged; can be undone)')) startBlank(); };
  $('#chClear').onclick = clearAll;
  table($('#chT'), [
    { k: 'id', l: 'Cluster', s: (x) => Number(x.c.id), f: (x) => `<b>${esc(x.c.id)}</b>` },
    { k: 'r', l: 'Recommended', s: (x) => recOf(x.c.id), f: (x) => execLabel(recOf(x.c.id)) },
    { k: 'f', l: 'Final', s: (x) => S.final[x.c.id], f: (x) => execLabel(S.final[x.c.id]) },
    { k: 't', l: 'Change type', s: (x) => x.t, f: (x) => `<span class="chg">${x.t}</span>` },
    { k: 'n', l: 'Sellers', n: true, s: (x) => x.c.n, f: (x) => x.c.n },
  ], diff, { onRow: (x) => openClusterCard(x.c.id), pageSize: 200 });
  table($('#auT'), [{ k: 'ts', l: 'Time' }, { k: 'action', l: 'Action' }, { k: 'method', l: 'Method' }, { k: 'cluster', l: 'Cluster' }, { k: 'glid', l: 'GLID' },
    { k: 'from', l: 'From', f: (a) => a.action === 'rename' ? esc(a.from) : execLabel(a.from) }, { k: 'to', l: 'To', f: (a) => ['rename', 'baseline'].includes(a.action) ? esc(a.to ?? '') : execLabel(a.to) }, { k: 'note', l: 'Note' }],
    S.audit.slice().reverse(), { pageSize: 200 });
}
async function saveWorking() {
  try { const r = await api('/api/working', workingPayload()); S.dirty = false; updateHeader(); toast(`Saved (${esc(r.saved_at)})`, 'ok'); }
  catch (e) { toast('Save failed: ' + esc(e.message), 'err', 6000); }
}
async function doExport() {
  const fv = finalValidation();
  const un = CIDS().filter(c => !S.final[c]).length;
  if (un && !confirm(`${un} cluster(s) are still unassigned. Export anyway? (They will be listed on the “Unassigned Clusters” sheet.)`)) return;
  try {
    const body = { ...workingPayload(), ...sellerFinalPayload(), territory_metrics: territoryMetricsPayload(), engine_check: S.engineCheck ? { status: S.engineCheck.status, mismatches: S.engineCheck.mismatches, detail: S.engineCheck.detail } : null, final_validation: fv };
    const r = await api('/api/export', body);
    await api('/api/working', workingPayload()); S.dirty = false; updateHeader();
    const box = $('#exportResult');
    if (box) box.innerHTML = `<div class="okbox">Exported <b>${esc(r.file)}</b> to ${esc(r.folder)} · <a href="${esc(r.url)}">download</a></div>`;
    toast(`Exported ${esc(r.file)}`, 'ok', 5000);
    window.location.href = r.url;
  } catch (e) { toast('Export failed: ' + esc(e.message), 'err', 8000); }
}
async function clearAll() {
  if (!confirm('Clear ALL changes?\n\nThis discards the whole working assignment, the undo history and the audit log, removes the saved working copy (moved to outputs/working_history), and restores the recommendation baseline. Input files are not touched.')) return;
  try { await api('/api/working/clear', {}); } catch (e) { toast('Could not clear saved copy: ' + esc(e.message), 'err'); }
  initFinalFromBaseline(); S.audit = [{ ts: nowTs(), action: 'clear-all', method: 'changes-tab', cluster: null, from: null, to: null, note: 'All changes cleared; baseline ' + candLabel(S.base) }];
  S.names = {}; S.dirty = false; emit({ changed: CIDS(), affected: EXECS }); if (MAP_READY) restyleAll(); toast('All changes cleared', 'ok');
}

/* ============================================================================ DATA & VALIDATION */
function renderData() {
  const el = $('#tab-data'), B = S.B;
  const files = B.meta.files.map(f => `<tr><td>${esc(f.label)}</td><td>${f.name ? esc(f.name) : '<span class="st st-FAIL">not found</span>'}</td><td>${esc(f.modified || '')}</td><td>${f.all_matches.length > 1 ? `<span class="st st-WARN">${f.all_matches.length} matches</span> ${esc(f.all_matches.join(', '))}` : ''}</td></tr>`).join('');
  const det = B.detection.map((d, ti) => {
    const sheetSel = (d.all_sheets || []).length ? `<select data-sheet="${ti}">${options(d.all_sheets, d.sheet || '', '— choose sheet —')}</select>` : '';
    const sheetSt = d.sheet_status || '';
    const stCls = /ambiguous|not found|no sheet/.test(sheetSt) ? (d.required ? 'FAIL' : 'WARN') : (/differs/.test(sheetSt) ? 'INFO' : 'PASS');
    return `<details ${d.blocking ? 'open' : ''}><summary>${esc(d.label)} <span class="muted">(${esc(d.input)})</span> – sheet: ${esc(d.sheet || '—')} <span class="st st-${d.blocking ? 'FAIL' : stCls}">${d.blocking ? 'needs mapping' : esc(sheetSt)}</span></summary>
      <div class="row">Sheet: ${sheetSel} <span class="muted">${esc(sheetSt)}</span></div>
      <table class="t"><thead><tr><th>Logical field</th><th>Required</th><th>Detected column</th><th>Status</th><th>Map to</th></tr></thead><tbody>
      ${(d.fields || []).map(f => { const bad = ['ambiguous', 'user mapping not found in file'].includes(f.status) || (f.status === 'missing' && f.required);
        const cls = bad ? 'FAIL' : f.status === 'missing' ? 'WARN' : 'PASS';
        return `<tr><td>${esc(f.label)}</td><td>${f.required ? 'yes' : ''}</td><td>${esc(f.column || '')}${f.candidates.length > 1 ? `<div class="note">candidates: ${esc(f.candidates.join(' | '))}</div>` : ''}</td>
          <td><span class="st st-${cls}">${f.status === 'detected' ? '✓ detected' : esc(f.status)}</span></td>
          <td><select data-t="${ti}" data-f="${esc(f.field)}" data-auto="${esc(f.status === 'detected' ? f.column : '')}">${options([['', '(auto)'], ...(f.required ? [] : [['__none__', '(not available)']]), ...d.columns.map(c => [c, c])], (f.status === 'mapped by user' ? f.column : (f.status === 'not used (user choice)' ? '__none__' : '')), null)}</select></td></tr>`; }).join('')}
      </tbody></table></details>`;
  }).join('');
  const vRows = B.validation.map((v, i) => `<tr><td><span class="st st-${v.status}">${v.status}</span></td><td>${esc(v.area)}</td><td>${esc(v.check)}</td><td class="n">${v.count ? v.count.toLocaleString() : ''}</td><td>${esc(v.detail)}${v.samples && v.samples.length ? ` <a href="#" data-samp="${i}">view ${v.samples.length}${v.count > v.samples.length ? ' of ' + v.count : ''}</a>` : ''}</td></tr>`).join('');
  const summ = B.ok ? `<div class="okbox">✓ ${SELLERS.length.toLocaleString()} sellers loaded · ✓ ${B.clusters.length} clusters · ✓ ${EXECS.length} executives in recommendation pool · ✓ ${B.candidates.length} candidate solution(s) ·
      ${SELLERS.filter(s => s.c === null).length} sellers not clustered · ${B.current_executives.length} current executives</div>` : `<div class="errbox"><b>${esc(B.message || 'Mapping required')}</b></div>`;
  const ec = S.engineCheck;
  el.innerHTML = `<div class="card"><h3>Input files <span class="muted" style="font-weight:400">– read-only; folder ${esc(B.meta.input_dir)}</span></h3>
      <table class="t"><thead><tr><th>Logical input</th><th>File used</th><th>Modified</th><th></th></tr></thead><tbody>${files}</tbody></table>
      <div class="row"><button id="btnReload">Reload input files</button><span class="note">Replace the Excel files in the input folder (or edit config/inputs.json), then reload. Nothing is hard-coded to the current data.</span></div></div>
    ${summ}
    <div class="card"><h3>Detected input fields</h3><div class="note">Columns are matched by name (case/punctuation-insensitive) against config/schema.json. Ambiguous or missing required fields must be mapped here – nothing is guessed silently.</div>
      ${det}<div class="row"><button class="primary" id="btnSaveMap">Save mapping &amp; reload</button><button id="btnClearMap">Clear all manual mappings</button></div></div>
    ${ec ? `<div class="card"><h3>Live metric engine check</h3><div><span class="st st-${ec.status}">${ec.status}</span> ${esc(ec.detail)}</div>
      ${ec.samples && ec.samples.length ? `<div id="ecT"></div>` : ''}<div class="note">The dashboard recalculates raw territory metrics (counts, geographic spread, renewal HHI, MDC %, Turnover %, Vintage %, Annual %) when you edit territories. This check recomputes every stored territory in the recommendation file and compares. Territory RAG itself is never recalculated.</div></div>` : ''}
    <div class="card"><h3>Data validation</h3><table class="t"><thead><tr><th>Status</th><th>Area</th><th>Check</th><th class="n">Affected</th><th>Detail</th></tr></thead><tbody>${vRows}</tbody></table></div>`;
  $('#btnReload').onclick = async () => { await api('/api/reload', {}); location.reload(); };
  $('#btnSaveMap').onclick = saveMapping;
  $('#btnClearMap').onclick = async () => { if (!confirm('Remove all manual column mappings?')) return; await api('/api/mapping', { overrides: {} }); location.reload(); };
  $$('[data-samp]').forEach(a => a.onclick = (e) => { e.preventDefault(); const v = B.validation[Number(a.dataset.samp)];
    openModal(`<h3>${esc(v.check)}</h3><div class="note">${esc(v.detail)}</div><div id="sampT"></div>`);
    const cols = (v.columns && v.columns.length ? v.columns : Object.keys(v.samples[0] || {})).map(k => ({ k, l: esc(k) }));
    table($('#sampT'), cols, v.samples, { pageSize: 100 }); });
  if (ec && ec.samples && ec.samples.length) table($('#ecT'), ['Row', 'Executive', 'Metric', 'Stored', 'Live'].map(k => ({ k, l: k })), ec.samples);
}
async function saveMapping() {
  const B = S.B, ov = {};
  $$('#tab-data select[data-t]').forEach(s => {
    const d = B.detection[Number(s.dataset.t)], f = s.dataset.f, v = s.value;
    if (!v) return;
    (ov[d.table] = ov[d.table] || { fields: {} }).fields[f] = v;
  });
  $$('#tab-data select[data-sheet]').forEach(s => {
    const d = B.detection[Number(s.dataset.sheet)];
    if (s.value && (s.value !== d.sheet || d.sheet_status === 'mapped by user')) (ov[d.table] = ov[d.table] || { fields: {} }).sheet = s.value;
  });
  try { await api('/api/mapping', { overrides: ov }); toast('Mapping saved – reloading', 'ok'); setTimeout(() => location.reload(), 600); }
  catch (e) { toast('Could not save mapping: ' + esc(e.message), 'err'); }
}

/* ============================================================================ BOOT */
/* Start screen: choose a branch. The choice is carried in the address (?branch=<id>) so a refresh keeps it. */
async function showPicker() {
  document.body.classList.add('picking');
  $('#picker').style.display = 'flex';
  try {
    const { branches } = await api('/api/branches');
    $('#pickerList').innerHTML = branches.map(b => `<button class="picker-btn" data-b="${esc(b.id)}">${esc(b.name)}</button>`).join('');
    $$('#pickerList .picker-btn').forEach(btn => btn.onclick = () => { location.search = '?branch=' + encodeURIComponent(btn.dataset.b); });
  } catch (e) { $('#pickerList').innerHTML = `<div class="errbox">Could not load the branch list: ${esc(e.message)}</div>`; }
}
async function boot() {
  if (!BRANCH) { showPicker(); return; }
  $('#btnBranch').onclick = () => { location.search = ''; };   // the unsaved-changes warning (beforeunload) still applies
  let B;
  try { B = await api('/api/bundle'); } catch (e) { document.body.innerHTML = `<div class="errbox" style="margin:20px">Could not load data: ${esc(e.message)} <a href="./">Choose another branch</a></div>`; return; }
  if (!B.ok) {
    S.B = B; $('#subtitle').textContent = 'Input mapping required';
    $$('nav#tabs button').forEach(b => { if (b.dataset.tab !== 'data') b.disabled = true; });
    ['#baseSel', '#btnSave', '#btnExport', '#btnUndo'].forEach(s => $(s).disabled = true);
    SELLERS = []; EXECS = []; showTab('data'); return;
  }
  indexBundle(B);
  runEngineCheck();
  $('#brandTitle').textContent = `Territory Planning – ${B.branch.name}`;
  document.title = `Territory Planning – ${B.branch.name}`;
  $('#subtitle').textContent = `${SELLERS.length.toLocaleString('en-IN')} sellers · ${B.clusters.length} clusters · ${EXECS.length} executives`;
  S.base = B.candidates.length ? B.candidates[0].key : null;
  initFinalFromBaseline();
  S.audit.push({ ts: nowTs(), action: 'session-start', method: 'load', cluster: null, from: null, to: S.base, note: `Loaded; baseline ${candLabel(S.base)}` });

  try {
    const w = await api('/api/working');
    if (w.exists) {
      const W = w.working, same = W.fingerprint === B.meta.fingerprint;
      const msg = `A saved working assignment exists (saved ${W.saved_at}, baseline ${W.baseline || 'none'}).` + (same ? '' : '\n\n⚠ It was saved with DIFFERENT input files. Clusters that no longer exist will be reported and skipped; new clusters start unassigned.') + '\n\nRestore it?';
      if (confirm(msg)) restoreWorking(W);
    }
  } catch (e) { console.warn(e); }

  setupBaseline();
  $('#btnUndo').onclick = undoLast; $('#btnSave').onclick = saveWorking; $('#btnExport').onclick = () => { showTab('changes'); doExport(); };
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  updateHeader();
  const hasFail = B.validation.some(v => v.status === 'FAIL');
  const want = location.hash.slice(1);
  showTab(RENDER[want] ? want : 'map');  // Data & Validation / Dashboard tabs are hidden; still reachable via #data / #dash
  if (hasFail) toast('Some data checks failed – they are listed on the “Validation” sheet of the Excel export', 'warn', 6000);
}
function restoreWorking(W) {
  const skipped = [], newC = [], badExec = [];
  if (W.baseline && cand(W.baseline)) S.base = W.baseline; else if (W.baseline === null) S.base = null;
  const fin = {};
  CIDS().forEach(cid => {
    if (!(cid in (W.final || {}))) { fin[cid] = null; newC.push(cid); return; }
    const e = W.final[cid];
    if (e && !EXEC_SET.has(e)) { fin[cid] = null; badExec.push(`${cid} (${e})`); } else fin[cid] = e || null;
  });
  Object.keys(W.final || {}).forEach(cid => { if (!(cid in C)) skipped.push(cid); });
  // seller-level overrides: kept only for clustered sellers that still exist and executives still in the pool
  const ov = {}, badOv = [];
  Object.entries(W.seller_overrides || {}).forEach(([k, e]) => {
    const i = SKEY_IDX[k];
    if (i === undefined || SELLERS[i].c === null || !EXEC_SET.has(e)) badOv.push(`${k} (${e})`); else ov[k] = e;
  });
  S.final = fin; S.sellerOv = ov; S.finalIdx = null; S.names = W.names || {}; S.audit = (W.audit || []).concat([{ ts: nowTs(), action: 'restore', method: 'load', cluster: null, from: null, to: null,
    note: `Restored working assignment saved ${W.saved_at}` + (skipped.length ? `; skipped missing clusters ${skipped.join(', ')}` : '') + (newC.length ? `; new clusters left unassigned ${newC.join(', ')}` : '') + (badExec.length ? `; executives no longer in pool -> unassigned: ${badExec.join(', ')}` : '') +
      (badOv.length ? `; seller overrides dropped (seller missing / not clustered / executive not in pool): ${badOv.join(', ')}` : '') }]);
  S.metricsCache = {}; S.dirty = false;
  if (badOv.length) toast(`${badOv.length} saved seller override(s) could not be restored. See audit log.`, 'warn', 9000);
  if (skipped.length || newC.length || badExec.length) toast(`Restored with exceptions: ${skipped.length} saved clusters missing, ${newC.length} new clusters unassigned, ${badExec.length} executives not in pool. See audit log.`, 'warn', 9000);
  else toast('Working assignment restored', 'ok');
}
boot();
