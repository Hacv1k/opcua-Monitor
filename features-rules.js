// RTOM cross-signal rules (renderer): user-defined, runtime, works with any OPC UA server.
// A rule fires when ALL its conditions are true at the same time.
(function () {
  'use strict';
  var rules = [];
  var OPS = [
    ['>', 'is above'], ['<', 'is below'],
    ['rising', 'is trending up'], ['falling', 'is trending down'], ['anomaly', 'is anomalous']
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nameOf(id) { try { return getSignalName(id); } catch (e) { return id; } }
  function save() { return window.opcua.invoke('feat-set-config', { crossRules: rules }); }

  function lastValue(nodeId) {
    var d = chartData.get(nodeId);
    if (!d || !d.length) return null;
    var v = d[d.length - 1].value;
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }
  function recentInsight(nodeId, kind, windowSec) {
    var list = (window.RTOMFeatures && window.RTOMFeatures.getInsights()) || [];
    var cutoff = Date.now() - windowSec * 1000;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it.nodeId === nodeId && it.kind === kind && new Date(it.time).getTime() >= cutoff) return true;
    }
    return false;
  }
  function condTrue(c, windowSec) {
    if (c.op === '>' || c.op === '<') {
      var v = lastValue(c.nodeId);
      if (v === null) return false;
      return c.op === '>' ? v > c.value : v < c.value;
    }
    return recentInsight(c.nodeId, c.op, windowSec);
  }
  function describe(r) {
    return r.conds.map(function (c) {
      var op = OPS.filter(function (o) { return o[0] === c.op; })[0];
      return (c.name || nameOf(c.nodeId)) + ' ' + (op ? op[1] : c.op) + ((c.op === '>' || c.op === '<') ? ' ' + c.value : '');
    }).join('  AND  ');
  }

  var wasTrue = {};
  function evaluate() {
    try {
      if (typeof isMonitoring === 'undefined' || !isMonitoring) return;
      rules.forEach(function (r) {
        if (r.enabled === false || !r.conds || !r.conds.length) return;
        var ok = r.conds.every(function (c) { return condTrue(c, r.windowSec || 60); });
        if (ok && !wasTrue[r.id]) {
          if (window.RTOMFeatures) {
            window.RTOMFeatures.addInsight('rule:' + r.id, 'rule', r.name + ' — ' + describe(r), null, r.name);
          }
        }
        wasTrue[r.id] = ok;
      });
    } catch (e) { /* never break the app */ }
  }
  setInterval(evaluate, 2000);

  function modal(title, body) {
    var old = document.getElementById('featModal');
    if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'featModal'; m.className = 'connection-modal'; m.style.zIndex = 1500;
    m.innerHTML = '<div class="connection-modal-box" style="width:640px;"><div class="connection-modal-header"><div class="connection-modal-title">' +
      title + '</div><button class="zoom-modal-close" id="featClose">✕</button></div><div class="connection-modal-body">' + body + '</div></div>';
    document.body.appendChild(m);
    document.getElementById('featClose').addEventListener('click', function () { m.remove(); });
    m.addEventListener('mousedown', function (e) { if (e.target === m) m.remove(); });
    return m;
  }

  function signalOptions() {
    var seen = {}, html = '';
    pinnedSignals.forEach(function (s) { seen[s.nodeId] = 1; html += '<option value="' + esc(s.nodeId) + '">' + esc(s.name) + '</option>'; });
    chartData.forEach(function (d, id) { if (!seen[id]) html += '<option value="' + esc(id) + '">' + esc(nameOf(id)) + '</option>'; });
    return html || '<option value="">(start monitoring first)</option>';
  }
  function condRow(i, sigOpts) {
    return '<div class="cond-row" style="display:flex;gap:4px;margin-bottom:4px;">' +
      '<select class="input c-sig" style="flex:2;margin:0;">' + (i > 0 ? '<option value="">— none —</option>' : '') + sigOpts + '</select>' +
      '<select class="input c-op" style="flex:1.4;margin:0;">' + OPS.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') + '</select>' +
      '<input class="input c-val" type="number" step="any" placeholder="value" style="flex:0.8;margin:0;"></div>';
  }

  function openRules() {
    var sigOpts = signalOptions();
    var m = modal('🔗 Cross-Signal Rules',
      '<div style="font-size:0.75rem;color:#9ca3af;margin-bottom:0.5rem;">Fire a finding when several signals misbehave <b>together</b> (any OPC UA server, set at runtime). All conditions must be true at the same time.</div>' +
      '<div id="ruleList" style="max-height:200px;overflow-y:auto;margin-bottom:0.75rem;"></div>' +
      '<div class="sidebar-title">New rule</div>' +
      '<input id="ruleName" class="input" placeholder="Rule name, e.g. Connection storm">' +
      condRow(0, sigOpts) + condRow(1, sigOpts) + condRow(2, sigOpts) +
      '<div style="font-size:0.7rem;color:#9ca3af;margin:4px 0;">Trend / anomaly conditions count if detected within the last <input id="ruleWin" type="number" value="60" min="10" style="width:60px;" class="input" > seconds</div>' +
      '<button id="ruleAdd" class="btn btn-primary" style="width:100%;">Add rule</button>');

    function render() {
      var el = document.getElementById('ruleList');
      if (!el) return;
      if (!rules.length) { el.innerHTML = '<div style="color:#6b7280;font-size:0.75rem;">No rules yet</div>'; return; }
      el.innerHTML = rules.map(function (r) {
        return '<div style="border-top:1px solid #374151;padding:5px 0;font-size:0.75rem;"><b>' + esc(r.name) + '</b>' +
          '<button class="btn btn-danger btn-sm r-del" data-id="' + esc(r.id) + '" style="float:right;">Delete</button>' +
          '<div style="color:#9ca3af;">' + esc(describe(r)) + '</div></div>';
      }).join('');
      el.querySelectorAll('.r-del').forEach(function (b) {
        b.addEventListener('click', function () {
          rules = rules.filter(function (r) { return r.id !== b.dataset.id; });
          save(); render();
        });
      });
    }
    render();

    document.getElementById('ruleAdd').addEventListener('click', function () {
      var conds = [];
      m.querySelectorAll('.cond-row').forEach(function (row) {
        var sel = row.querySelector('.c-sig');
        if (!sel.value) return;
        var op = row.querySelector('.c-op').value;
        var val = parseFloat(row.querySelector('.c-val').value);
        if ((op === '>' || op === '<') && !isFinite(val)) return;
        conds.push({ nodeId: sel.value, name: sel.options[sel.selectedIndex].text, op: op, value: isFinite(val) ? val : null });
      });
      if (conds.length < 2) { alert('A cross-signal rule needs at least 2 complete conditions.'); return; }
      var name = document.getElementById('ruleName').value.trim() || 'Rule ' + (rules.length + 1);
      rules.push({ id: 'r' + Date.now(), name: name, enabled: true, windowSec: parseInt(document.getElementById('ruleWin').value, 10) || 60, conds: conds });
      save(); render();
      document.getElementById('ruleName').value = '';
    });
  }

  function setup() {
    var host = document.querySelector('.header-right');
    if (!host) return;
    var b = document.createElement('button');
    b.className = 'btn btn-sm btn-secondary';
    b.textContent = '🔗 Rules';
    host.insertBefore(b, host.querySelector('.status-badge'));
    b.addEventListener('click', openRules);
  }
  setup();
  window.opcua.invoke('feat-get-config').then(function (c) { if (c && Array.isArray(c.crossRules)) rules = c.crossRules; }).catch(function () {});
})();
