/*
 * Shareable (static website) version of the Unified Territory Planning Dashboard.
 *
 * The original app talks to a small Python server (app/server.py) through /api/* calls.
 * This file answers those same calls inside the browser, so the dashboard can be hosted
 * as plain files (GitHub Pages, Netlify, any web host) with no Python needed:
 *
 *   GET  /api/branches       -> branches.json (list of branches)
 *   GET  /api/bundle         -> bundles/<branch>.json (data pre-built from that branch's input Excel files)
 *   GET  /api/working        -> saved working assignment from this browser's storage (per branch)
 *   POST /api/working        -> save working assignment to this browser's storage (per branch)
 *   POST /api/working/clear  -> remove the saved working assignment (per branch)
 *   POST /api/export         -> build the Excel file in the browser and download it
 *                               (same sheets/columns as app/exporter.py)
 *   POST /api/reload, /api/mapping -> not available (data is fixed in the bundles)
 * Every call except /api/branches carries ?branch=<id>.
 *
 * The dashboard code itself (core.js, map.js, views.js, style.css) is unchanged.
 */
(function () {
  'use strict';
  const realFetch = window.fetch.bind(window);
  const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
  const bundles = {};
  let lastExport = null;

  function reply(obj, status) {
    return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function isoNow(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function stamp(d) {
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  async function getJson(file) {
    const r = await realFetch(file, { cache: 'no-store' });
    if (!r.ok) throw new Error('Could not load ' + file + ' (' + r.status + ')');
    return r.json();
  }
  async function getBundle(branch) {
    if (!/^[a-z0-9_]+$/.test(branch || '')) throw new Error('Unknown branch');
    if (!bundles[branch]) bundles[branch] = await getJson('bundles/' + branch + '.json');
    return bundles[branch];
  }

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const rel = url.replace(/^https?:\/\/[^/]+/, '');
    const path = rel.split('?')[0];
    if (!/^\/api\//.test(path)) return realFetch(input, init);
    const branch = new URLSearchParams(rel.split('?')[1] || '').get('branch');
    const STORE_KEY = 'utd_working_assignment_' + branch;
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    const isPost = !!(init && init.method === 'POST');
    try {
      if (path === '/api/branches') return reply(await getJson('branches.json'));
      if (path === '/api/bundle') return reply(await getBundle(branch));
      if (path === '/api/working' && !isPost) {
        let raw = null;
        try { raw = localStorage.getItem(STORE_KEY); } catch (e) { /* storage blocked */ }
        return reply(raw ? { exists: true, working: JSON.parse(raw) } : { exists: false });
      }
      if (path === '/api/working') {
        body.saved_at = isoNow();
        try { localStorage.setItem(STORE_KEY, JSON.stringify(body)); }
        catch (e) { return reply({ error: 'This browser does not allow saving (private window or storage blocked).' }, 500); }
        return reply({ ok: true, saved_at: body.saved_at, path: 'this browser' });
      }
      if (path === '/api/working/clear') {
        try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
        return reply({ ok: true });
      }
      if (path === '/api/export') {
        const b = await getBundle(branch);
        const res = await exportXlsx(b, body || {});
        return reply({ ok: true, file: res.name, url: '#download-last-export', folder: 'your Downloads folder' });
      }
      if (path === '/api/reload') {
        const b = await getBundle(branch);
        return reply({ ok: b.ok, fingerprint: b.meta.fingerprint });
      }
      if (path === '/api/mapping') {
        return reply({ error: 'Column mapping is not available in the shared web version (the data is pre-built).' }, 400);
      }
      return reply({ error: 'unknown endpoint' }, 404);
    } catch (e) {
      console.error(e);
      return reply({ error: String(e && e.message || e) }, 500);
    }
  };

  // The "download" link in the export result box re-downloads the last export.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href="#download-last-export"]');
    if (!a) return;
    e.preventDefault();
    if (lastExport) saveBlob(lastExport.blob, lastExport.name);
  });

  function saveBlob(blob, name) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  }

  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Could not load the Excel library (internet connection needed).'));
      document.head.appendChild(s);
    });
  }

  /* ======================================================================== Excel export
   * Port of app/exporter.py – same sheets, headers, colours, filters and widths. */
  const HEAD_FILL = '1F3A5F';
  const RAG_FILL = { GREEN: 'C6EFCE', AMBER: 'FFEB9C', RED: 'FFC7CE' };
  const NOT_CLUSTERED = 'NOT ALLOCATED - not clustered';

  function pyStr(v) {
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    return String(v);
  }
  function x(v) {
    if (Array.isArray(v)) return v.map(pyStr).join(', ');
    if (v && typeof v === 'object') return Object.entries(v).map(([k, a]) => `${k}: ${pyStr(a)}`).join('; ');
    return v === undefined ? null : v;
  }
  function num(s) {
    const t = pyStr(s);
    return /^-?\d+$/.test(t) ? parseInt(t, 10) : s;
  }
  function colLetter(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function fill(color) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + color } }; }

  function sheet(wb, title, headers, rows, widths, ragCols) {
    const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2' }] });
    ws.addRow(headers);
    headers.forEach((h, i) => {
      const cell = ws.getCell(1, i + 1);
      cell.fill = fill(HEAD_FILL);
      cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
      cell.alignment = { wrapText: true, vertical: 'top' };
    });
    rows.forEach(r => ws.addRow(r.map(x)));
    const last = rows.length + 1;
    (ragCols || []).filter(h => headers.includes(h)).map(h => headers.indexOf(h) + 1).forEach(ci => {
      for (let rr = 2; rr <= last; rr++) {
        const c = ws.getCell(rr, ci), v = c.value;
        if (typeof v === 'string' && RAG_FILL[v.toUpperCase()]) c.fill = fill(RAG_FILL[v.toUpperCase()]);
      }
    });
    if (rows.length) ws.autoFilter = `A1:${colLetter(headers.length)}${last}`;
    headers.forEach((h, i) => {
      ws.getColumn(i + 1).width = (widths || {})[h] || Math.min(Math.max(String(h).length + 2, 12), 45);
    });
    ws._lastRow = last;
    return ws;
  }

  function origText(c) {
    const comp = (c.cur_comp || []).filter(([e]) => e !== '(no mapping)');
    if (!comp.length) return 'no current mapping';
    if (comp.length === 1) return comp[0][0];
    return `MIXED (${comp.length} executives): ` + comp.map(([e, n]) => `${e} ${n}`).join('; ');
  }
  function changeType(rec, fin) {
    rec = rec || null; fin = fin || null;
    if (rec === fin) return 'Unchanged';
    if (rec && !fin) return 'Unassigned by user';
    if (fin && !rec) return 'Assigned by user';
    return 'Moved';
  }
  const blank = (v) => v === null || v === undefined || v === '';

  async function exportXlsx(bundle, payload) {
    if (!window.ExcelJS) await loadScript(EXCELJS_URL);
    const final = payload.final || {};
    const names = payload.names || {};
    const cands = bundle.candidates;
    const base = cands.find(c => c.key === payload.baseline) || null;
    const baseLabel = base ? base.label : '(none - blank start)';
    const recMap = base ? base.map : {};
    const get = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null);
    const tname = (e) => (e ? (names[e] || e) : null);
    const now = new Date();
    const wb = new window.ExcelJS.Workbook();

    // ---- Sheet 1: Final Seller Assignment
    // seller-level Final executive as computed by the dashboard (cluster + Renewal OS rule + BM seller overrides)
    const sellerFinal = payload.seller_final, sellerSrc = payload.seller_source;
    const useSf = Array.isArray(sellerFinal) && sellerFinal.length === bundle.sellers.length;
    const useSrc = useSf && Array.isArray(sellerSrc) && sellerSrc.length === bundle.sellers.length;
    const srcLabel = { override: 'BM seller override', retained: 'Renewal case - stays with current executive', cluster: 'Follows cluster' };
    let rows = [];
    bundle.sellers.forEach((s, n) => {
      const cid = s.c, orig = get(s, 'cur');
      const feNc = useSf && (cid === null || cid === undefined) ? sellerFinal[n] : null;
      if (feNc) {  // renewal case outside every cluster: stays with its current executive
        rows.push([num(s.g), null, tname(feNc), feNc, s.el, get(s, 'pop'), orig, feNc, feNc,
          feNc !== orig ? 'Yes' : 'No', 'No', 'N/A - not clustered', srcLabel.retained]);
        return;
      }
      if (cid === null || cid === undefined) {
        rows.push([num(s.g), null, NOT_CLUSTERED, NOT_CLUSTERED, s.el, get(s, 'pop'), orig, NOT_CLUSTERED, NOT_CLUSTERED, 'N/A - not clustered', 'N/A - not clustered',
          NOT_CLUSTERED, 'N/A - not clustered']);
        return;
      }
      const cfe = get(final, cid), fe = useSf ? sellerFinal[n] : cfe;
      const src = useSrc ? (srcLabel[sellerSrc[n]] || sellerSrc[n]) : 'Follows cluster';
      // recommended executive by the same rule as the dashboard: a renewal case stays with its current executive
      const re = src === srcLabel.retained ? orig : get(recMap, cid);
      rows.push([num(s.g), num(cid), fe ? tname(fe) : 'UNASSIGNED', fe || 'UNASSIGNED', s.el, get(s, 'pop'), orig,
        re || 'UNASSIGNED', fe || 'UNASSIGNED',
        (fe || null) !== (orig || null) ? 'Yes' : 'No',
        (fe || null) !== (re || null) ? 'Yes' : 'No',
        cfe || 'UNASSIGNED', src]);
    });
    sheet(wb, 'Final Seller Assignment',
      ['GLID', 'Cluster ID', 'Territory', 'Executive', 'Eligibility', 'In RAG Population', 'Original Executive',
        `Recommended Executive (${baseLabel})`, 'Final Executive', 'Mapping Changed (Final vs Original)', 'Changed vs Recommendation',
        'Cluster Final Executive', 'Final Executive Basis'],
      rows);

    // ---- Sheet 2: Final Cluster Assignment
    const params = bundle.rag_params;
    const lastTs = {};
    for (const a of payload.audit || []) if (a.cluster !== null && a.cluster !== undefined) lastTs[String(a.cluster)] = a.ts === undefined ? null : a.ts;
    rows = []; const diffRows = [];
    for (const c of bundle.clusters) {
      const cid = c.id, fe = get(final, cid), re = get(recMap, cid);
      const ot = origText(c), ct = changeType(re, fe);
      const ov = blank(c.ov) ? 'N/A - uncached in source' : c.ov;
      rows.push([num(cid), c.br, fe ? tname(fe) : 'UNASSIGNED', fe || 'UNASSIGNED', ot, get(c, 'plurality'),
        re ? tname(re) : 'UNASSIGNED', fe ? tname(fe) : 'UNASSIGNED', ct,
        ov, c.ovs, c.worst].concat(params.map(p => get(c.rag, p)), [c.n, c.n_el, c.n_inel], cands.map(cd => get(cd.map, cid))));
      diffRows.push([num(cid), ot, re || 'UNASSIGNED', fe || 'UNASSIGNED', ct, ct !== 'Unchanged' ? get(lastTs, cid) : null]);
    }
    sheet(wb, 'Final Cluster Assignment',
      ['Cluster ID', 'Branch', 'Territory', 'Executive', 'Original Territory (current, seller level)', 'Original Plurality Executive (info only)',
        `Recommended Territory (${baseLabel})`, 'Final Territory', 'Change Type',
        'Cluster Overall RAG (stored)', 'Cluster Overall Score (stored)', 'Worst Parameter RAG (stored)'].concat(params.map(p => `${p} (stored)`),
        ['Seller Count', 'Eligible Sellers', 'Ineligible Sellers'], cands.map(cd => `${cd.label} Executive`)),
      rows, null, ['Cluster Overall RAG (stored)', 'Worst Parameter RAG (stored)'].concat(params.map(p => `${p} (stored)`)));

    // ---- Sheet 3: Territory Summary
    const tm = payload.territory_metrics || [];
    const months = ((bundle.territory_rag || {}).window || []).map(w => w.ym);
    const head = ['Executive', 'Territory', 'Total Sellers', 'Renewal Cases', 'Eligible Sellers', 'Cluster Count',
      'Geographic Spread (km) [live]', 'Avg Distance to Territory Centroid (km) [live]', 'Max Distance to Territory Centroid (km) [live]',
      'Upcoming Renewals (eligible) [live]', 'Renewal HHI [live]', 'MDC % [live]', 'Turnover % [live]', 'Vintage % [live]', 'Annual % [live]',
      'Sellers Keeping Current Executive [live]', 'Sellers Changing Executive [live]',
      'Stored Territory RAG applies?', 'Stored Overall RAG', 'Stored Overall Score', 'Stored RAG source',
      'Final Cluster IDs'].concat(months.map(m => `Renewals ${m} [live]`),
      ['MDC [live]', 'TS [live]', 'Turnover > Threshold [live]', 'Vintage Clients [live]', 'Annual [live]', 'MYR [live]',
        'Today: Total Sellers', 'Today: Eligible Sellers', 'Today: Renewal Cases', 'Same Executive', 'New to Executive']);
    const allocKeys = ['mdc', 'ts', 'turnover', 'vintage', 'annual', 'myr', 'old_total', 'old_eligible', 'old_renewal_os',
      'existing', 'newly_mapped'];
    rows = tm.map(t => [t.exec, t.territory, t.total, t.renewal, t.eligible, t.clusters,
      t.geo_spread, t.avg_dist, t.max_dist, t.ren_window, t.hhi,
      t.mdc_pct, t.turnover_pct, t.vintage_pct, t.annual_pct,
      t.retained, t.changes,
      t.stored_status, t.stored_rag, t.stored_score, t.stored_label,
      (t.cluster_ids || []).map(pyStr).join(', ')].concat(months.map(m => get(t.months || {}, m)), allocKeys.map(k => get(t, k))).map(v => v === undefined ? null : v));
    sheet(wb, 'Territory Summary', head, rows, null, ['Stored Overall RAG']);

    // ---- Sheet 4: Unassigned Clusters
    rows = [];
    for (const c of bundle.clusters) {
      if (get(final, c.id)) continue;
      rows.push([num(c.id), c.n, c.n_el, blank(c.ov) ? 'N/A - uncached in source' : c.ov, c.worst, c.br,
        c.clat, c.clon, get(recMap, c.id) || 'UNASSIGNED', origText(c)]);
    }
    sheet(wb, 'Unassigned Clusters', ['Cluster ID', 'Seller Count', 'Eligible Sellers', 'Cluster Overall RAG (stored)', 'Worst Parameter RAG (stored)',
      'Branch', 'Centroid Latitude', 'Centroid Longitude', `Recommended (${baseLabel})`, 'Original (current, seller level)'],
      rows, null, ['Cluster Overall RAG (stored)', 'Worst Parameter RAG (stored)']);

    // ---- Sheet 5: Changes / Audit
    diffRows.sort((a, b) => {
      const ua = a[4] === 'Unchanged' ? 1 : 0, ub = b[4] === 'Unchanged' ? 1 : 0;
      if (ua !== ub) return ua - ub;
      const sa = pyStr(a[0]), sb = pyStr(b[0]);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    sheet(wb, 'Changes - Audit', ['Cluster', 'Original Assignment (current, seller level)', `Recommended Assignment (${baseLabel})`,
      'Final Assignment', 'Change Type', 'Timestamp (last change)'], diffRows);
    const audit = payload.audit || [];
    const g = (a, k) => (a[k] === undefined ? null : a[k]);
    sheet(wb, 'Audit Log', ['Timestamp', 'Action', 'Method', 'Cluster', 'From', 'To', 'Note', 'GLID'],
      audit.map(a => [g(a, 'ts'), g(a, 'action'), g(a, 'method'), (a.cluster !== null && a.cluster !== undefined) ? num(a.cluster) : null,
        g(a, 'from'), g(a, 'to'), g(a, 'note'), (a.glid !== null && a.glid !== undefined) ? num(a.glid) : null]));

    // ---- Sheet 6: Validation
    rows = (bundle.validation || []).map(v => [v.area, v.check, v.status, v.count, v.detail]);
    const ec = payload.engine_check;
    if (ec) rows.push(['Live metrics', 'Live metric engine reproduces stored Territory RAG metrics', g(ec, 'status'), ec.mismatches || 0, g(ec, 'detail')]);
    for (const p of payload.final_validation || []) rows.push(['Final assignment', g(p, 'check'), g(p, 'status'), p.count || 0, g(p, 'detail')]);
    const vws = sheet(wb, 'Validation', ['Area', 'Check', 'Status', 'Affected', 'Detail'], rows, { Detail: 120, Check: 60 });
    for (let r = 2; r <= vws._lastRow; r++) {
      vws.getCell(r, 5).alignment = { wrapText: true, vertical: 'top' };
      const col = { PASS: 'C6EFCE', WARN: 'FFEB9C', FAIL: 'FFC7CE' }[vws.getCell(r, 3).value];
      if (col) vws.getCell(r, 3).fill = fill(col);
    }

    // ---- Run info
    const info = [['Branch', (bundle.branch || {}).name || null], ['Exported at', isoNow(now)], ['Baseline recommendation', baseLabel],
      ['Data fingerprint', bundle.meta.fingerprint], ['Input folder', bundle.meta.input_dir]];
    for (const f of bundle.meta.files) info.push([`Input: ${f.label}`, f.name ? `${f.name} (modified ${f.modified})` : 'not found']);
    info.push(['Note', "Cluster RAG and Territory Recommendation values are stored values from the input files. '[live]' territory metrics are recalculated " +
      'from seller data for the final assignment; stored Territory RAG is shown only where the final territory equals a stored candidate territory.']);
    sheet(wb, 'Run Info', ['Item', 'Value'], info, { Item: 36, Value: 120 });

    const br = String((bundle.branch || {}).name || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const name = `Final_Territory_Assignment_${br ? br + '_' : ''}${stamp(now)}.xlsx`;
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    lastExport = { blob, name };
    saveBlob(blob, name);
    return { name };
  }
})();
