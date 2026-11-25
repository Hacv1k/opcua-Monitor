// RTOM features (renderer): annotations, trend/anomaly insights, PDF incident report.
// Loaded after app.js; uses its globals (chartData, alarmLog, pinnedSignals, getSignalName, endpointInput).
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function inv(ch, a, b) { return window.opcua.invoke(ch, a, b); }
  function nameOf(id) { try { return getSignalName(id); } catch (e) { return id; } }
  function fmtTime(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return iso; } }
  function num(v) { return typeof v === 'number' && isFinite(v); }

  // ─── Insights (trend + anomaly) ────────────────────────────────────────────
  var insights = [];
  var lastFired = {}; // key -> ms
  var COOLDOWN_MS = 120000;
  var unseen = 0;

  function addInsight(nodeId, kind, text, value, label) {
    var key = nodeId + '|' + kind;
    var now = Date.now();
    if (lastFired[key] && now - lastFired[key] < COOLDOWN_MS) return;
    lastFired[key] = now;
    var item = { time: new Date().toISOString(), nodeId: nodeId, signal: label || nameOf(nodeId), nodeId: nodeId, kind: kind, text: text, value: value };
    insights.unshift(item);
    if (insights.length > 200) insights.pop();
    unseen++;
    updateInsightBadge();
    try { window.dispatchEvent(new CustomEvent('rtom-insight', { detail: item })); } catch (e) {}
  }

  function analyse(nodeId, data) {
    var vals = [];
    for (var i = 0; i < data.length; i++) { if (num(data[i].value)) vals.push(data[i].value); }
    var n = vals.length;
    if (n < 40) return;
    var recentN = 5;
    var base = vals.slice(Math.max(0, n - recentN - 300), n - recentN);
    var m = 0, k;
    for (k = 0; k < base.length; k++) m += base[k];
    m /= base.length;
    var v = 0;
    for (k = 0; k < base.length; k++) v += (base[k] - m) * (base[k] - m);
    var sd = Math.sqrt(v / base.length);
    var recent = 0;
    for (k = n - recentN; k < n; k++) recent += vals[k];
    recent /= recentN;
    var floor = Math.max(sd, Math.abs(m) * 0.02, 1e-6);
    var z = (recent - m) / floor;
    if (Math.abs(z) >= 4 && Math.abs(recent - m) > Math.abs(m) * 0.05) {
      addInsight(nodeId, 'anomaly',
        'Value ' + recent.toFixed(2) + ' is ' + Math.abs(z).toFixed(1) + 'σ ' + (z > 0 ? 'above' : 'below') +
        ' its recent normal (' + m.toFixed(2) + ')', recent);
    }
    // Linear trend over the latest window
    var w = Math.min(n, 120);
    var seg = vals.slice(n - w);
    var sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (k = 0; k < w; k++) { sx += k; sy += seg[k]; sxx += k * k; sxy += k * seg[k]; syy += seg[k] * seg[k]; }
    var den = w * sxx - sx * sx;
    if (den === 0) return;
    var slope = (w * sxy - sx * sy) / den;
    var rnum = w * sxy - sx * sy;
    var rden = Math.sqrt(den * (w * syy - sy * sy));
    var r2 = rden === 0 ? 0 : (rnum / rden) * (rnum / rden);
    var drift = slope * (w - 1);
    var ref = Math.max(Math.abs(seg[0]), Math.abs(m), 1e-6);
    if (r2 > 0.85 && Math.abs(drift) > 0.15 * ref && Math.abs(drift) > 3 * floor) {
      addInsight(nodeId, drift > 0 ? 'rising' : 'falling',
        (drift > 0 ? 'Steadily rising' : 'Steadily falling') + ': ' + (drift > 0 ? '+' : '') + drift.toFixed(2) +
        ' over the last ' + w + ' samples', seg[w - 1]);
    }
  }

  function scan() {
    try {
      if (typeof chartData === 'undefined' || typeof isMonitoring === 'undefined' || !isMonitoring) return;
      chartData.forEach(function (data, nodeId) { analyse(nodeId, data); });
    } catch (e) { /* never break the app */ }
  }
  setInterval(scan, 3000);

  // ─── Header buttons ────────────────────────────────────────────────────────
  var btnNote, btnInsight, btnReport, insightBadge;
  function makeBtn(label, cls) {
    var b = document.createElement('button');
    b.className = 'btn btn-sm ' + cls;
    b.textContent = label;
    return b;
  }
  function updateInsightBadge() {
    if (!insightBadge) return;
    if (unseen > 0) { insightBadge.textContent = unseen > 99 ? '99+' : unseen; insightBadge.classList.remove('hidden'); }
    else insightBadge.classList.add('hidden');
  }
  function setupButtons() {
    var host = document.querySelector('.header-right');
    if (!host) return;
    host.style.flexWrap = 'wrap';
    host.style.justifyContent = 'flex-end';
    var anchor = host.querySelector('.status-badge');
    btnNote = makeBtn('📝 Notes', 'btn-secondary');
    btnReport = makeBtn('📄 Report', 'btn-secondary');
    var wrap = document.createElement('div');
    wrap.className = 'event-btn-wrap';
    btnInsight = makeBtn('🔍 Insights', 'btn-secondary');
    insightBadge = document.createElement('span');
    insightBadge.className = 'event-badge hidden';
    insightBadge.style.background = '#f59e0b';
    wrap.appendChild(btnInsight); wrap.appendChild(insightBadge);
    [btnNote, wrap, btnReport].forEach(function (el) { host.insertBefore(el, anchor); });
    btnNote.addEventListener('click', openNotes);
    btnInsight.addEventListener('click', openInsights);
    btnReport.addEventListener('click', generateReport);
  }

  // ─── Generic modal ─────────────────────────────────────────────────────────
  function modal(title, bodyHtml) {
    var old = document.getElementById('featModal');
    if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'featModal';
    m.className = 'connection-modal';
    m.style.zIndex = 1500;
    m.innerHTML = '<div class="connection-modal-box" style="width:560px;">' +
      '<div class="connection-modal-header"><div class="connection-modal-title">' + title + '</div>' +
      '<button class="zoom-modal-close" id="featClose">✕</button></div>' +
      '<div class="connection-modal-body" id="featBody">' + bodyHtml + '</div></div>';
    document.body.appendChild(m);
    document.getElementById('featClose').addEventListener('click', function () { m.remove(); });
    m.addEventListener('mousedown', function (e) { if (e.target === m) m.remove(); });
    return m;
  }

  // ─── Notes ─────────────────────────────────────────────────────────────────
  function openNotes() {
    var opts = '<option value="">General (no signal)</option>';
    var seen = {};
    pinnedSignals.forEach(function (s) { seen[s.nodeId] = 1; opts += '<option value="' + esc(s.nodeId) + '">' + esc(s.name) + '</option>'; });
    chartData.forEach(function (d, id) { if (!seen[id]) opts += '<option value="' + esc(id) + '">' + esc(nameOf(id)) + '</option>'; });
    var m = modal('📝 Event Notes',
      '<div style="font-size:0.75rem;color:#9ca3af;margin-bottom:0.5rem;">Add a note at the current time (e.g. "restarted the drive"). Notes appear in the PDF report.</div>' +
      '<select id="noteSig" class="input">' + opts + '</select>' +
      '<textarea id="noteText" class="input" rows="3" placeholder="What happened?"></textarea>' +
      '<button id="noteAdd" class="btn btn-primary" style="width:100%;">Add note</button>' +
      '<div id="noteList" style="margin-top:0.75rem;max-height:260px;overflow-y:auto;"></div>');
    function render(list) {
      var el = document.getElementById('noteList');
      if (!el) return;
      if (!list || !list.length) { el.innerHTML = '<div style="color:#6b7280;font-size:0.75rem;">No notes yet</div>'; return; }
      el.innerHTML = list.map(function (a) {
        return '<div style="border-top:1px solid #374151;padding:6px 0;font-size:0.75rem;">' +
          '<div style="color:#9ca3af;">' + esc(fmtTime(a.time)) + (a.signal ? ' · ' + esc(a.signal) : '') +
          ' <button data-id="' + esc(a.id) + '" class="btn btn-danger btn-sm note-del" style="float:right;">Delete</button></div>' +
          '<div>' + esc(a.text) + '</div></div>';
      }).join('');
      el.querySelectorAll('.note-del').forEach(function (b) {
        b.addEventListener('click', function () { inv('ann-delete', b.dataset.id).then(function (r) { render(r.annotations); }); });
      });
    }
    inv('ann-list').then(render);
    document.getElementById('noteAdd').addEventListener('click', function () {
      var t = document.getElementById('noteText').value.trim();
      if (!t) return;
      var sel = document.getElementById('noteSig');
      inv('ann-add', { text: t, nodeId: sel.value || null, signal: sel.value ? sel.options[sel.selectedIndex].text : null })
        .then(function (r) { if (r && r.success) { document.getElementById('noteText').value = ''; render(r.annotations); } });
    });
    return m;
  }

  // ─── Insights panel ────────────────────────────────────────────────────────
  var KIND = { rule: ['🔗 Rule', '#c084fc'], anomaly: ['⚠️ Anomaly', '#f87171'], rising: ['↗ Rising', '#fbbf24'], falling: ['↘ Falling', '#60a5fa'] };
  function openInsights() {
    unseen = 0; updateInsightBadge();
    var body = insights.length ? insights.map(function (i) {
      var k = KIND[i.kind] || [i.kind, '#9ca3af'];
      return '<div style="border-top:1px solid #374151;padding:6px 0;font-size:0.75rem;">' +
        '<span style="color:' + k[1] + ';font-weight:600;">' + k[0] + '</span> · <b>' + esc(i.signal) + '</b>' +
        '<div style="color:#9ca3af;">' + esc(fmtTime(i.time)) + '</div><div>' + esc(i.text) + '</div></div>';
    }).join('') : '<div style="color:#6b7280;font-size:0.8rem;">Nothing unusual detected yet. RTOM learns each signal\'s normal range while monitoring and flags sudden deviations and steady drifts early, before a fixed threshold is hit.</div>';
    var m = modal('🔍 Trend &amp; Anomaly Insights',
      '<div style="max-height:380px;overflow-y:auto;">' + body + '</div>' +
      '<button id="insClear" class="btn btn-secondary" style="margin-top:0.75rem;">Clear</button>');
    document.getElementById('insClear').addEventListener('click', function () { insights = []; lastFired = {}; m.remove(); });
  }

  // ─── PDF report ────────────────────────────────────────────────────────────
  function chartImage(data, tmin, tmax) {
    var vals = data.filter(function (d) { return num(d.value); }).map(function (d) { return d.value; });
    if (vals.length < 2) return '';
    var c = document.createElement('canvas');
    c.width = 1400; c.height = 300;
    var g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (num(tmin)) lo = Math.min(lo, tmin);
    if (num(tmax)) hi = Math.max(hi, tmax);
    if (hi === lo) { hi += 1; lo -= 1; }
    var padL = 70, padR = 20, padT = 20, padB = 30, W = c.width - padL - padR, H = c.height - padT - padB;
    function y(v) { return padT + H - ((v - lo) / (hi - lo)) * H; }
    g.strokeStyle = '#e5e7eb'; g.fillStyle = '#6b7280'; g.font = '22px sans-serif'; g.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var val = lo + (hi - lo) * i / 4, yy = y(val);
      g.beginPath(); g.moveTo(padL, yy); g.lineTo(padL + W, yy); g.stroke();
      g.fillText(val.toFixed(Math.abs(hi - lo) < 10 ? 2 : 0), 4, yy + 7);
    }
    function line(v, color) { g.strokeStyle = color; g.setLineDash([8, 6]); g.beginPath(); g.moveTo(padL, y(v)); g.lineTo(padL + W, y(v)); g.stroke(); g.setLineDash([]); }
    g.lineWidth = 2;
    if (num(tmax)) line(tmax, '#dc2626');
    if (num(tmin)) line(tmin, '#2563eb');
    g.strokeStyle = '#1d4ed8'; g.lineWidth = 3; g.beginPath();
    vals.forEach(function (v, idx) {
      var x = padL + (idx / (vals.length - 1)) * W;
      if (idx === 0) g.moveTo(x, y(v)); else g.lineTo(x, y(v));
    });
    g.stroke();
    g.fillStyle = '#6b7280';
    g.fillText(String(data[0].time || ''), padL, c.height - 6);
    var lastT = String(data[data.length - 1].time || '');
    g.fillText(lastT, padL + W - g.measureText(lastT).width, c.height - 6);
    return c.toDataURL('image/png');
  }

  async function generateReport() {
    var orig = btnReport.textContent;
    btnReport.textContent = '⏳ Building...'; btnReport.disabled = true;
    try {
      var run = null;
      try { run = await inv('run-get-status'); } catch (e) {}
      var started = run && run.monitoringStartedAt, elapsed = started ? Date.now() - started : null;
      function dur(ms) {
        if (ms == null) return 'n/a';
        var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60);
        return h + 'h ' + mi + 'm ' + (s % 60) + 's';
      }
      var notes = []; try { notes = await inv('ann-list'); } catch (e) {}
      var events = [];
      try { if (window.eventCapture) { var cr = await window.eventCapture.getCaptures(); events = (cr && cr.captures) || (Array.isArray(cr) ? cr : []); } } catch (e) {}

      var ids = pinnedSignals.length ? pinnedSignals.map(function (s) { return s.nodeId; }) : Array.from(chartData.keys()).slice(0, 12);
      var sigHtml = ids.map(function (id) {
        var d = chartData.get(id) || [];
        var vs = d.filter(function (p) { return num(p.value); }).map(function (p) { return p.value; });
        var th = (typeof signalThresholds !== 'undefined' && signalThresholds.get(id)) || {};
        var tmin = num(th.min) ? th.min : (typeof globalMinThreshold !== 'undefined' ? globalMinThreshold : null);
        var tmax = num(th.max) ? th.max : (typeof globalMaxThreshold !== 'undefined' ? globalMaxThreshold : null);
        var stat = vs.length ? ('min ' + Math.min.apply(null, vs).toFixed(2) + ' · max ' + Math.max.apply(null, vs).toFixed(2) +
          ' · avg ' + (vs.reduce(function (a, b) { return a + b; }, 0) / vs.length).toFixed(2) + ' · last ' + vs[vs.length - 1].toFixed(2)) : 'no numeric data';
        var img = chartImage(d, tmin, tmax);
        return '<div class="sig"><h3>' + esc(nameOf(id)) + '</h3><div class="stat">' + esc(stat) + '</div>' +
          (img ? '<img src="' + img + '">' : '') + '</div>';
      }).join('') || '<p>No signal data captured yet.</p>';

      var alarmHtml = alarmLog.length ? '<table><tr><th>Time</th><th>Signal</th><th>Value</th><th>Type</th><th>Threshold</th><th>Ack</th></tr>' +
        alarmLog.slice(0, 100).map(function (a) {
          return '<tr><td>' + esc(a.time) + '</td><td>' + esc(a.signalName) + '</td><td>' + esc(a.value) + '</td><td>' + esc(a.type) +
            '</td><td>' + esc(a.threshold) + '</td><td>' + (a.acknowledged ? 'yes' : 'no') + '</td></tr>';
        }).join('') + '</table>' : '<p>No alarms.</p>';

      var insHtml = insights.length ? '<table><tr><th>Time</th><th>Signal</th><th>Finding</th></tr>' +
        insights.slice(0, 100).map(function (i) {
          return '<tr><td>' + esc(fmtTime(i.time)) + '</td><td>' + esc(i.signal) + '</td><td>' + esc(i.text) + '</td></tr>';
        }).join('') + '</table>' : '<p>No trends or anomalies flagged.</p>';

      var evHtml = events.length ? '<table><tr><th>Event</th><th>Time</th><th>Signal</th><th>Findings</th></tr>' +
        events.slice(0, 50).map(function (e) {
          var tag = (e.matchedPatterns || []).map(function (p) { return p.label || p.name || p; }).join('; ');
          return '<tr><td>#' + esc(e.id) + '</td><td>' + esc(fmtTime(e.startedAtISO || '')) +
            '</td><td>' + esc(e.triggerSignalName || '') + ' ' + esc((e.triggerType || '').toUpperCase()) + ' at ' + esc(e.triggerValue) + ' (limit ' + esc(e.threshold) + ')</td><td>' + esc(tag) + '</td></tr>';
        }).join('') + '</table>' : '<p>No Black Box captures.</p>';

      var noteHtml = notes.length ? '<table><tr><th>Time</th><th>Signal</th><th>Note</th></tr>' +
        notes.slice(0, 100).map(function (a) {
          return '<tr><td>' + esc(fmtTime(a.time)) + '</td><td>' + esc(a.signal || '-') + '</td><td>' + esc(a.text) + '</td></tr>';
        }).join('') + '</table>' : '<p>No notes.</p>';

      var html = '<!doctype html><html><head><meta charset="utf-8"><title>RTOM Incident Report</title><style>' +
        'body{font-family:Segoe UI,Arial,sans-serif;color:#111827;margin:0;font-size:11px}' +
        'h1{font-size:20px;margin:0}h2{font-size:14px;border-bottom:2px solid #1d4ed8;padding-bottom:3px;margin:18px 0 8px;color:#1d4ed8}' +
        'h3{font-size:12px;margin:0 0 2px}.meta{color:#4b5563;margin:4px 0 0}.stat{color:#4b5563;margin-bottom:4px}' +
        'table{width:100%;border-collapse:collapse}th,td{border:1px solid #d1d5db;padding:3px 5px;text-align:left;vertical-align:top}th{background:#f3f4f6}' +
        '.sig{margin-bottom:10px;page-break-inside:avoid}.sig img{width:100%}.foot{margin-top:20px;color:#9ca3af;font-size:9px}' +
        '</style></head><body>' +
        '<h1>RTOM — Incident Report</h1>' +
        '<div class="meta">Generated: ' + esc(new Date().toLocaleString()) + ' · Server: ' + esc(endpointInput ? endpointInput.value : '') + '</div>' +
        '<div class="meta">Monitoring run time: ' + esc(dur(elapsed)) + (started ? ' (since ' + esc(new Date(started).toLocaleString()) + ')' : '') + '</div>' +
        '<h2>Signals</h2>' + sigHtml +
        '<h2>Alarms</h2>' + alarmHtml +
        '<h2>Trend &amp; Anomaly Findings</h2>' + insHtml +
        '<h2>Black Box Events</h2>' + evHtml +
        '<h2>Engineer Notes</h2>' + noteHtml +
        '<div class="foot">Generated by RTOM — Realtime OPC Monitor</div></body></html>';

      var stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
      var res = await inv('report-save-pdf', html, 'RTOM_Incident_Report_' + stamp + '.pdf');
      if (res && res.success) alert('Report saved:\n' + res.path);
      else if (res && !res.canceled) alert('Report failed: ' + (res.error || 'unknown error'));
    } catch (e) {
      alert('Report failed: ' + e.message);
    } finally {
      btnReport.textContent = orig; btnReport.disabled = false;
    }
  }

  setupButtons();
  window.RTOMFeatures = { addInsight: addInsight, getInsights: function () { return insights; }, openNotes: openNotes };
})();
