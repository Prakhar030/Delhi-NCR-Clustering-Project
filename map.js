/* ============================================================================
   map.js - Leaflet map, layers, cluster/seller styling, draw-to-select
   Cluster outline = convex hull of the cluster's own sellers (display only);
   cluster geometry, IDs and membership are never changed.
   ========================================================================== */
'use strict';

const M = {
  map: null, CL: {}, CM: {}, SM: [], labels: null,
  gHull: null, gCent: null, gEl: null, gInel: null, gUncl: null, gRecOut: null, gFinOut: null, gDraw: null,
  opt: { clusterColor: 'final', sellerColor: 'elig', hull: true, cent: true, el: false, inel: false, uncl: false,
         recOut: false, finOut: false, labels: false, focus: true },
  draw: { pts: [], line: null, poly: null, mode: 'add' },
  flashLayer: null,
};
const RAGC = { GREEN: '#2e9d52', AMBER: '#e8a317', RED: '#d64541' };
const ragColor = (v) => RAGC[String(v || '').toUpperCase()] || '#9aa0a6';

function initMap() {
  const map = L.map('map', { zoomControl: true, doubleClickZoom: true, preferCanvas: false });
  M.map = map;
  const carto = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    { maxZoom: 20, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
  const gray = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 16, attribution: 'Tiles &copy; Esri' });
  osm.addTo(map);
  L.control.layers({ 'OpenStreetMap': osm, 'Light grey (Esri)': gray, 'Light (CARTO)': carto }, null, { position: 'bottomleft' }).addTo(map);
  L.control.scale({ position: 'bottomright' }).addTo(map);
  map.createPane('hulls').style.zIndex = 410;
  map.createPane('sellers').style.zIndex = 420;
  map.createPane('outlines').style.zIndex = 430;
  map.createPane('cents').style.zIndex = 440;
  map.createPane('drawp').style.zIndex = 450;
  const canvas = L.canvas({ padding: 0.5, pane: 'sellers' });

  M.gHull = L.layerGroup(); M.gCent = L.layerGroup(); M.gEl = L.layerGroup(); M.gInel = L.layerGroup(); M.gUncl = L.layerGroup();
  M.gRecOut = L.layerGroup(); M.gFinOut = L.layerGroup(); M.gDraw = L.layerGroup().addTo(map); M.labels = L.layerGroup();

  const bounds = [];
  for (const c of S.B.clusters) {
    const hull = c.hull || [];
    let lyr;
    if (hull.length >= 3) lyr = L.polygon(hull, { pane: 'hulls', weight: 1 });
    else if (c.clat !== null) lyr = L.circle([c.clat, c.clon], { radius: 25, pane: 'hulls', weight: 1 });
    if (lyr) {
      lyr.bindTooltip(() => clusterTooltip(c.id), { sticky: true, direction: 'top', opacity: 0.95 });
      lyr.on('click', (e) => onClusterClick(c.id, e));
      M.CL[c.id] = lyr; M.gHull.addLayer(lyr);
    }
    if (c.clat !== null && c.clon !== null) {
      const cm = L.circleMarker([c.clat, c.clon], { pane: 'cents', radius: 6, weight: 1.5 });
      cm.bindTooltip(() => clusterTooltip(c.id), { direction: 'top', opacity: 0.95 });
      cm.on('click', (e) => onClusterClick(c.id, e));
      M.CM[c.id] = cm; M.gCent.addLayer(cm); bounds.push([c.clat, c.clon]);
      M.labels.addLayer(L.marker([c.clat, c.clon], { pane: 'cents', interactive: false,
        icon: L.divIcon({ className: 'clabel', html: esc(c.id), iconSize: [30, 14], iconAnchor: [15, -6] }) }));
    }
  }
  SELLERS.forEach((s) => {
    if (!s.cv) return;
    const mk = L.circleMarker([s.la, s.lo], { renderer: canvas, radius: 3, weight: 0.6 });
    mk.on('click', (e) => onSellerClick(s.i, e));
    M.SM[s.i] = mk;
    (s.c === null ? M.gUncl : (s.el === 'Eligible' ? M.gEl : M.gInel)).addLayer(mk);
  });
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] }); else map.setView([28.6, 77.2], 11);

  map.on('click', (e) => { if (S.mode === 'draw') drawAdd(e.latlng); });
  map.on('dblclick', (e) => { if (S.mode === 'draw') { L.DomEvent.stop(e); drawFinish(); } });
  applyLayerVisibility();
  restyleAll();
  wireMapPanel();
  onChange(onFinalChanged);
}

/* ------------------------------------------------------------------ styles */
function clusterFill(cid) {
  const c = C[cid], mode = M.opt.clusterColor;
  if (mode === 'final') return S.final[cid] ? execColor(S.final[cid]) : '#9aa0a6';
  if (mode === 'rec') return recOf(cid) ? execColor(recOf(cid)) : '#9aa0a6';
  if (mode === 'rag:overall') return ragColor(c.ov);
  if (mode === 'rag:worst') return ragColor(c.worst);
  if (mode.startsWith('rag:p:')) return ragColor(c.rag[mode.slice(6)]);
  return '#1f78b4';
}
function clusterStyle(cid) {
  const fill = clusterFill(cid);
  const f = S.final[cid] || null;
  const st = { color: fill, fillColor: fill, weight: 1, fillOpacity: 0.32, opacity: 0.9, dashArray: null };
  if (M.opt.clusterColor === 'final' && !f) { st.dashArray = '3 3'; st.fillOpacity = 0.18; st.color = '#6b7280'; }
  if (M.opt.focus && S.activeExec) {
    if (f === S.activeExec) { st.weight = 2.5; st.fillOpacity = 0.5; st.color = '#111827'; }
    else st.fillOpacity = Math.min(st.fillOpacity, 0.14);
  }
  if (S.sel.has(cid)) { st.color = '#000'; st.weight = 3; st.dashArray = '5 3'; st.fillOpacity = 0.55; }
  return st;
}
function centStyle(cid) {
  const s = clusterStyle(cid);
  return { color: S.sel.has(cid) ? '#000' : (s.weight > 1 ? '#111827' : '#ffffff'), weight: S.sel.has(cid) ? 3 : (s.weight > 1 ? 2 : 1.2),
           fillColor: s.fillColor, fillOpacity: Math.max(0.75, s.fillOpacity), radius: S.sel.has(cid) ? 8 : 6 };
}
function restyleCluster(cid) {
  if (M.CL[cid]) M.CL[cid].setStyle(clusterStyle(cid));
  if (M.CM[cid]) { const st = centStyle(cid); M.CM[cid].setStyle(st); M.CM[cid].setRadius(st.radius); }
}
function sellerColor(s) {
  const m = M.opt.sellerColor;
  if (m === 'elig') return s.el === 'Eligible' ? '#1f78b4' : '#8c8c8c';
  if (m === 'cur') return s.cur ? execColor(s.cur) : '#bbb';
  if (s.c === null) return '#bbb';
  if (m === 'rec') return execColor(recOf(s.c));
  if (m === 'final') return execColor(finalExecOf(s));
  return '#1f78b4';
}
function restyleSeller(i) {
  const mk = M.SM[i]; if (!mk) return; const s = SELLERS[i]; const col = sellerColor(s);
  mk.setStyle({ color: s.c === null ? '#000' : col, fillColor: col, fillOpacity: 0.9, weight: s.c === null ? 1 : 0.5 });
}
function restyleAll() {
  S.B.clusters.forEach(c => restyleCluster(c.id));
  SELLERS.forEach(s => restyleSeller(s.i));
  if (M.opt.recOut) drawOutlines('rec'); if (M.opt.finOut) drawOutlines('final');
  renderLegend();
}
function applyLayerVisibility() {
  const set = (g, on) => { if (on) { if (!M.map.hasLayer(g)) g.addTo(M.map); } else if (M.map.hasLayer(g)) M.map.removeLayer(g); };
  set(M.gHull, M.opt.hull); set(M.gCent, M.opt.cent); set(M.gEl, M.opt.el); set(M.gInel, M.opt.inel); set(M.gUncl, M.opt.uncl);
  set(M.gRecOut, M.opt.recOut); set(M.gFinOut, M.opt.finOut); set(M.labels, M.opt.labels);
}

/* ------------------------------------------------------------------ territory outlines (dashed hull of member sellers, display only) */
function hullOf(points) {
  const pts = [...new Map(points.map(p => [p[0] + ',' + p[1], p])).values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of pts.slice().reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function drawOutlines(kind) {
  const g = kind === 'rec' ? M.gRecOut : M.gFinOut; g.clearLayers();
  const map = kind === 'rec' ? (cand(S.base)?.map || {}) : S.final;
  const by = {};
  for (const cid in map) { const e = map[cid]; if (!e) continue; (by[e] = by[e] || []).push(cid); }
  for (const e in by) {
    const pts = []; by[e].forEach(cid => (C[cid].sellers || []).forEach(i => { const s = SELLERS[i]; if (s.cv) pts.push([s.la, s.lo]); }));
    const h = hullOf(pts); if (h.length < 3) continue;
    g.addLayer(L.polygon(h, { pane: 'outlines', color: execColor(e), weight: kind === 'rec' ? 2 : 3, dashArray: kind === 'rec' ? '8 6' : null,
      fill: false, interactive: false }).bindTooltip(`${kind === 'rec' ? 'Recommended' : 'Final'}: ${esc(tName(e))}`));
  }
}

/* ------------------------------------------------------------------ tooltips / popups */
function clusterTooltip(cid) {
  const c = C[cid], f = S.final[cid] || null, r = recOf(cid);
  return `<div class="tt"><b>Cluster ${esc(cid)}</b> · ${c.n_el} eligible sellers${c.n_inel ? ` · ${c.n_inel} renewal cases` : ''}<br>
    Recommended: ${esc(r || 'Unassigned')}<br>Final: <b>${esc(f || 'Unassigned')}</b>${r !== f ? ' <span class="chg">changed</span>' : ''}<br>
    ${f ? `${esc(f)} total sellers: <b>${finalSellers(f).length}</b><br>` : ''}
    Today: ${esc(origText(c))}</div>`;
}
function onSellerClick(i, e) {
  if (S.mode === 'draw') { drawAdd(e.latlng); return; }
  const s = SELLERS[i];
  const html = `<div class="pop"><b>GLID ${esc(s.g)}</b><br>Cluster: ${s.c === null ? '<i>not clustered</i>' : `<a href="#" onclick="inspectCluster('${esc(s.c)}');return false;">${esc(s.c)}</a>`}<br>
    Eligibility: ${esc(s.el)}<br>Renewal: ${esc(s.rd || '—')} ${s.st ? '(' + esc(s.st) + ')' : ''}<br>
    Current exec: ${esc(s.cur || '—')}<br>Recommended: ${esc(recExecOf(s) || (s.c === null ? 'NOT ALLOCATED' : 'Unassigned'))}<br>
    Final: <b>${esc(finalExecOf(s) || (s.c === null ? 'NOT ALLOCATED' : 'Unassigned'))}</b>${keepsOriginal(s) ? ' <span class="muted">(renewal case – stays)</span>' : ''}</div>`;
  L.popup().setLatLng(e.latlng).setContent(html).openOn(M.map);
}
function onClusterClick(cid, e) {
  if (e) L.DomEvent.stopPropagation(e);
  if (S.mode === 'draw') { drawAdd(e.latlng); return; }
  if (S.mode === 'quick') {
    if (!S.activeExec) { toast('Select an executive first (side panel)', 'warn'); return; }
    const f = S.final[cid] || null;
    if (f === S.activeExec) applyChanges([{ cid, to: null }], 'map-click', `Removed cluster ${cid} from ${S.activeExec}`);
    else applyChanges([{ cid, to: S.activeExec }], 'map-click', f ? `Moved cluster ${cid} from ${f} to ${S.activeExec}` : `Added cluster ${cid} to ${S.activeExec}`);
    return;
  }
  if (S.mode === 'select') { toggleSel(cid); return; }
  inspectCluster(cid);
}

/* ------------------------------------------------------------------ selection */
function toggleSel(cid) { if (S.sel.has(cid)) S.sel.delete(cid); else S.sel.add(cid); restyleCluster(cid); renderSelection(); }
function setSel(cids, add) {
  const prev = [...S.sel]; if (!add) S.sel.clear(); cids.forEach(c => S.sel.add(c));
  new Set([...prev, ...cids]).forEach(restyleCluster); renderSelection();
}
function clearSel() { const prev = [...S.sel]; S.sel.clear(); prev.forEach(restyleCluster); renderSelection(); }

/* ------------------------------------------------------------------ draw polygon -> select clusters whose centroid is inside */
function setMode(mode) {
  if (S.mode === 'draw' && mode !== 'draw') drawCancel(true);
  S.mode = mode;
  $$('.modebtn').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('#drawbar').style.display = mode === 'draw' ? 'flex' : 'none';
  M.map.getContainer().classList.toggle('drawing', mode === 'draw');
  if (mode === 'draw') { M.map.doubleClickZoom.disable(); drawReset(); toast('Click on the map to add polygon points; double-click or “Finish” to close.', 'info', 4500); }
  else M.map.doubleClickZoom.enable();
  const hint = { inspect: 'Click a cluster to see it.', quick: 'Click a cluster to give it to / take it from the chosen executive.',
    select: 'Click clusters to select them.', draw: 'Click points, double-click to finish.' };
  $('#modehint').textContent = hint[mode] || '';
}
function drawReset() { M.draw.pts = []; if (M.draw.line) { M.gDraw.removeLayer(M.draw.line); M.draw.line = null; } }
function drawAdd(ll) {
  M.draw.pts.push([ll.lat, ll.lng]);
  if (M.draw.line) M.gDraw.removeLayer(M.draw.line);
  const pts = M.draw.pts.length > 2 ? [...M.draw.pts, M.draw.pts[0]] : M.draw.pts;
  M.draw.line = L.polyline(pts, { pane: 'drawp', color: '#111827', weight: 2, dashArray: '6 4' }).addTo(M.gDraw);
  $('#drawcount').textContent = `${M.draw.pts.length} point${M.draw.pts.length === 1 ? '' : 's'}`;
}
function drawUndoPoint() { M.draw.pts.pop(); const p = M.draw.pts.slice(); drawReset(); p.forEach(x => drawAdd({ lat: x[0], lng: x[1] })); }
function drawCancel(silent) { drawReset(); if (!silent) setMode('select'); }
function pointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function drawFinish() {
  const pts = M.draw.pts.slice();
  if (pts.length < 3) { toast('A polygon needs at least 3 points', 'warn'); return; }
  if (M.draw.poly) M.gDraw.removeLayer(M.draw.poly);
  drawReset();
  M.draw.poly = L.polygon(pts, { pane: 'drawp', color: '#111827', weight: 2, dashArray: '6 4', fillOpacity: 0.05, interactive: false }).addTo(M.gDraw);
  const inside = S.B.clusters.filter(c => c.clat !== null && pointInPoly(c.clat, c.clon, pts)).map(c => c.id);
  const add = $('#drawAddChk').checked;
  setSel(inside, add);
  S.mode = 'draw'; setMode('select');
  toast(`Polygon selects ${inside.length} cluster(s) (centroid inside). Review the selection, click clusters to add/remove, then apply.`, 'ok', 6000);
  showSideSection('selection');
}
function clearDrawn() { if (M.draw.poly) { M.gDraw.removeLayer(M.draw.poly); M.draw.poly = null; } }

/* ------------------------------------------------------------------ navigation helpers */
function zoomToClusters(cids) {
  const b = []; cids.forEach(cid => { const c = C[cid]; if (!c) return;
    (c.hull && c.hull.length ? c.hull : (c.clat !== null ? [[c.clat, c.clon]] : [])).forEach(p => b.push(p)); });
  if (b.length) M.map.fitBounds(b, { padding: [40, 40], maxZoom: 17 });
}
function flashCluster(cid) {
  const c = C[cid]; if (!c || c.clat === null) return;
  if (M.flashLayer) M.map.removeLayer(M.flashLayer);
  M.flashLayer = L.circleMarker([c.clat, c.clon], { radius: 22, color: '#ef4444', weight: 3, fill: false, pane: 'drawp', interactive: false }).addTo(M.map);
  setTimeout(() => { if (M.flashLayer) { M.map.removeLayer(M.flashLayer); M.flashLayer = null; } }, 2500);
}
function mapSearch(q) {
  q = String(q || '').trim(); if (!q) return;
  if (C[q]) { showTab('map'); zoomToClusters([q]); flashCluster(q); inspectCluster(q); return; }
  const s = SELLERS.find(x => x.g === q);
  if (s) { showTab('map'); if (s.cv) { M.map.setView([s.la, s.lo], 17); onSellerClick(s.i, { latlng: L.latLng(s.la, s.lo) }); } else toast('Seller has no valid coordinates', 'warn'); return; }
  toast(`No cluster or GLID “${esc(q)}”`, 'warn');
}

/* ------------------------------------------------------------------ react to final assignment changes (only affected objects) */
function onFinalChanged(info) {
  info.changed.forEach(restyleCluster);
  if (M.opt.sellerColor === 'final') { info.changed.forEach(cid => (C[cid].sellers || []).forEach(restyleSeller)); (info.sellers || []).forEach(restyleSeller); }
  if (M.opt.finOut) drawOutlines('final');
  renderLegend();
}

/* ------------------------------------------------------------------ map layer panel */
function wireMapPanel() {
  const ccSel = $('#optClusterColor');
  ccSel.innerHTML = `<option value="final">Final territory</option><option value="rec">Recommended territory</option>
    <option value="rag:overall">Cluster RAG – Overall (stored)</option><option value="rag:worst">Cluster RAG – Worst parameter (stored)</option>
    ${S.B.rag_params.map(p => `<option value="rag:p:${esc(p)}">Cluster RAG – ${esc(p)}</option>`).join('')}<option value="none">Single colour</option>`;
  ccSel.value = M.opt.clusterColor;
  ccSel.onchange = () => { M.opt.clusterColor = ccSel.value; S.B.clusters.forEach(c => restyleCluster(c.id)); renderLegend(); };
  const scSel = $('#optSellerColor'); scSel.value = M.opt.sellerColor;
  scSel.onchange = () => { M.opt.sellerColor = scSel.value; SELLERS.forEach(s => restyleSeller(s.i)); renderLegend(); };
  $$('#mapopts input[type=checkbox][data-opt]').forEach(cb => {
    cb.checked = !!M.opt[cb.dataset.opt];
    cb.onchange = () => {
      M.opt[cb.dataset.opt] = cb.checked;
      if (cb.dataset.opt === 'recOut' && cb.checked) drawOutlines('rec');
      if (cb.dataset.opt === 'finOut' && cb.checked) drawOutlines('final');
      if (cb.dataset.opt === 'focus') S.B.clusters.forEach(c => restyleCluster(c.id));
      applyLayerVisibility();
    };
  });
  const syncToggle = () => { const col = $('#mapopts').classList.contains('collapsed'); $('#mapoptsToggle').textContent = col ? '▸' : '▾'; $('#mapoptsToggle').title = col ? 'Show map layers' : 'Hide map layers'; };
  $('#mapopts .po-head').onclick = () => { $('#mapopts').classList.toggle('collapsed'); syncToggle(); };
  syncToggle();
  $('#mapSearch').onkeydown = (e) => { if (e.key === 'Enter') mapSearch(e.target.value); };
  $('#mapSearchBtn').onclick = () => mapSearch($('#mapSearch').value);
}
function renderLegend() {
  const el = $('#legend'); if (!el) return;
  const mode = M.opt.clusterColor;
  let html = '';
  if (mode === 'final' || mode === 'rec') {
    const map = mode === 'final' ? S.final : (cand(S.base)?.map || {});
    const cnt = {}; let un = 0; for (const cid in map) { if (map[cid]) cnt[map[cid]] = (cnt[map[cid]] || 0) + 1; else un++; }
    CIDS().forEach(cid => { if (!(cid in map)) un++; });
    html = `<div class="lg-h">${mode === 'final' ? 'Final' : 'Recommended'} territories</div>` +
      EXECS.map(e => `<div class="lg-i${S.activeExec === e ? ' on' : ''}" onclick="setActiveExec('${esc(e).replace(/'/g, "\\'")}')">${swatch(e)}${esc(tName(e))} <span class="muted">${cnt[e] || 0}</span></div>`).join('') +
      `<div class="lg-i">${swatch(null)}Unassigned <span class="muted">${un}</span></div>`;
  } else if (mode.startsWith('rag')) {
    html = `<div class="lg-h">Cluster RAG (stored)</div>` + ['GREEN', 'AMBER', 'RED'].map(r => `<div class="lg-i"><span class="sw" style="background:${RAGC[r]}"></span>${r}</div>`).join('') +
      `<div class="lg-i"><span class="sw" style="background:#9aa0a6"></span>${mode === 'rag:overall' ? OV_NA : 'N/A'}</div>`;
  }
  const sm = M.opt.sellerColor;
  html += `<div class="lg-h">Sellers</div>` + (sm === 'elig'
    ? `<div class="lg-i"><span class="dot" style="background:#1f78b4"></span>Eligible</div><div class="lg-i"><span class="dot" style="background:#8c8c8c"></span>Not eligible</div>`
    : `<div class="lg-i muted">coloured by ${sm === 'cur' ? 'current' : sm === 'rec' ? 'recommended' : 'final'} executive</div>`) +
    `<div class="lg-i"><span class="dot" style="background:#fff;border:1.5px solid #000"></span>Not clustered (black ring)</div>`;
  el.innerHTML = html;
}
