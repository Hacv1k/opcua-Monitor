// RTOM multi-server monitoring (renderer): every server is a named, collapsible block in the left panel.
// Main server = the normal Connect dialog (now with a name). Extra servers are added with "+ Add server".
// Ticking a signal in any server tree adds it to the pinned graphs, tagged "[ServerName]".
(function () {
  'use strict';
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function inv(ch) { var a = Array.prototype.slice.call(arguments, 1); return window.opcua.invoke.apply(null, [ch].concat(a)); }
  function interval() { return (typeof currentSamplingInterval === 'number') ? currentSamplingInterval : 1000; }

  var servers = [];
  var expanded = {};
  var host = null;
  var primaryName = 'Main';
  var primaryCollapsed = false;
  window.RTOM_PRIMARY_NAME = primaryName;

  // ─── Primary server: name + collapsible header ─────────────────────────────
  var treeEl = document.getElementById('nodeTree');
  var primarySec = treeEl ? treeEl.parentElement : null;
  var titleEl = primarySec ? primarySec.querySelector('.sidebar-title') : null;

  function paintPrimaryTitle() {
    if (!titleEl) return;
    titleEl.textContent = (primaryCollapsed ? '▸ ' : '▾ ') + primaryName;
    titleEl.title = 'Click to minimise / expand this server';
  }
  function paintConnectionBar() {
    var t = document.getElementById('connectionBarText');
    if (!t) return;
    var txt = t.textContent || '';
    if (txt.indexOf('Not connected') === 0) return;
    if (txt.indexOf(primaryName + ' — ') !== 0) t.textContent = primaryName + ' — ' + txt;
  }
  if (titleEl && primarySec) {
    titleEl.style.cursor = 'pointer';
    titleEl.style.userSelect = 'none';
    titleEl.addEventListener('click', function () {
      primaryCollapsed = !primaryCollapsed;
      treeEl.style.display = primaryCollapsed ? 'none' : '';
      primarySec.style.flex = primaryCollapsed ? '0 0 auto' : '1';
      paintPrimaryTitle();
    });
  }
  var nameInput = document.getElementById('serverName');
  if (nameInput) {
    nameInput.addEventListener('change', function () {
      primaryName = (nameInput.value || 'Main').trim().slice(0, 20) || 'Main';
      nameInput.value = primaryName;
      window.RTOM_PRIMARY_NAME = primaryName;
      inv('feat-set-config', { primaryName: primaryName });
      paintPrimaryTitle(); paintConnectionBar();
    });
  }
  var barText = document.getElementById('connectionBarText');
  if (barText) new MutationObserver(paintConnectionBar).observe(barText, { childList: true, characterData: true, subtree: true });
  inv('feat-get-config').then(function (c) {
    if (c && c.primaryName) primaryName = c.primaryName;
    window.RTOM_PRIMARY_NAME = primaryName;
    if (nameInput) nameInput.value = primaryName;
    paintPrimaryTitle(); paintConnectionBar();
  }).catch(function () { paintPrimaryTitle(); });
  paintPrimaryTitle();

  // ─── Extra servers: sidebar panels ─────────────────────────────────────────
  function ensureHost() {
    if (host || !primarySec) return;
    host = document.createElement('div');
    host.id = 'serverPanels';
    host.style.cssText = 'flex:0 1 auto;max-height:55%;overflow-y:auto;border-top:1px solid #374151;background:#1b2432;';
    primarySec.parentElement.insertBefore(host, primarySec.nextSibling);
  }

  async function refresh() {
    try { servers = await inv('srv-list'); } catch (e) { servers = []; }
    renderPanels();
  }

  function pinPrefix(s) { return '#' + s.name + '#'; }

  async function tick(s, node, checked, msgEl) {
    var pid = pinPrefix(s) + node.nodeId;
    var label = '[' + s.name + '] ' + node.displayName;
    if (checked) {
      var r = await inv('srv-add-signals', s.id, [{ nodeId: node.nodeId, name: node.displayName }], interval());
      if (!r.success) { msgEl.textContent = r.message; return false; }
      var sig = r.signals[0];
      if (!pinnedSignals.some(function (p) { return p.nodeId === pid; })) {
        pinnedSignals.push({ nodeId: pid, name: sig.name, value: sig.value });
        if (isMonitoring) createPinnedChart({ nodeId: pid, name: sig.name, value: sig.value }, pinnedSignals.length - 1);
        syncPinnedToMainProcess(); updatePinnedCount(); updatePinButtons();
      }
      msgEl.style.color = '#6ee7b7';
      msgEl.textContent = isMonitoring ? 'Added ' + label : 'Pinned ' + label + ' — graphs when you press Start';
    } else {
      if (pinnedSignals.some(function (p) { return p.nodeId === pid; })) togglePin(pid, label, null);
      inv('srv-remove-signal', pid);
      msgEl.style.color = '#9ca3af';
      msgEl.textContent = 'Removed ' + label;
    }
    return true;
  }

  async function loadChildren(s, nodeId, container, level, msgEl) {
    container.innerHTML = '<div style="color:#6b7280;margin-left:' + (level * 12) + 'px;font-size:0.75rem;">Loading...</div>';
    var r = await inv('srv-browse', s.id, nodeId);
    container.innerHTML = '';
    if (!r.success) { container.innerHTML = '<div style="color:#fca5a5;font-size:0.75rem;">' + esc(r.message) + '</div>'; return; }
    r.nodes.forEach(function (n) {
      var row = document.createElement('div');
      row.style.cssText = 'margin-left:' + (level * 12) + 'px;padding:2px 4px;font-size:0.78rem;';
      if (n.nodeClass === 2) {
        var lab = document.createElement('label');
        lab.style.cursor = 'pointer';
        var cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = pinnedSignals.some(function (p) { return p.nodeId === pinPrefix(s) + n.nodeId; });
        cb.addEventListener('change', async function () { var ok = await tick(s, n, cb.checked, msgEl); if (!ok) cb.checked = !cb.checked; });
        lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + n.displayName));
        row.appendChild(lab); container.appendChild(row);
      } else {
        var head = document.createElement('div');
        head.style.cursor = 'pointer'; head.textContent = '▸ ' + n.displayName;
        var kids = document.createElement('div'); kids.style.display = 'none';
        head.addEventListener('click', function () {
          if (kids.style.display === 'none') {
            kids.style.display = 'block'; head.textContent = '▾ ' + n.displayName;
            if (!kids.dataset.loaded) { kids.dataset.loaded = '1'; loadChildren(s, n.nodeId, kids, level + 1, msgEl); }
          } else { kids.style.display = 'none'; head.textContent = '▸ ' + n.displayName; }
        });
        row.appendChild(head); container.appendChild(row); container.appendChild(kids);
      }
    });
    if (!r.nodes.length) container.innerHTML = '<div style="color:#6b7280;margin-left:' + (level * 12) + 'px;font-size:0.75rem;">(empty)</div>';
  }

  function renderPanels() {
    ensureHost();
    if (!host) return;
    host.innerHTML = '';
    servers.forEach(function (s) {
      var box = document.createElement('div');
      box.style.borderBottom = '1px solid #374151';
      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:pointer;user-select:none;';
      head.innerHTML = '<span style="width:10px;">' + (expanded[s.id] ? '▾' : '▸') + '</span>' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + (s.connected ? '#22c55e' : '#6b7280') + ';flex-shrink:0;"></span>' +
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.75rem;font-weight:700;" title="' + esc(s.endpoint) + '">' + esc(s.name) + '</span>';
      var btnC = document.createElement('button');
      btnC.className = 'btn btn-sm ' + (s.connected ? 'btn-secondary' : 'btn-success');
      btnC.textContent = s.connected ? 'Disconnect' : 'Connect';
      var btnX = document.createElement('button');
      btnX.className = 'btn btn-sm btn-danger'; btnX.textContent = '✕'; btnX.title = 'Remove server';
      head.appendChild(btnC); head.appendChild(btnX);
      box.appendChild(head);

      var body = document.createElement('div');
      body.style.cssText = 'padding:2px 8px 8px;display:' + (expanded[s.id] ? 'block' : 'none') + ';';
      var msg = document.createElement('div');
      msg.style.cssText = 'font-size:0.68rem;color:#9ca3af;margin:2px 0 4px;';
      var tree = document.createElement('div');
      body.appendChild(msg); body.appendChild(tree);
      box.appendChild(body);

      if (expanded[s.id] && s.connected) loadChildren(s, 'i=85', tree, 0, msg);
      else if (expanded[s.id]) msg.textContent = 'Not connected — click Connect.';

      head.addEventListener('click', function (e) {
        if (e.target === btnC || e.target === btnX) return;
        expanded[s.id] = !expanded[s.id];
        renderPanels();
      });
      btnC.addEventListener('click', async function (e) {
        e.stopPropagation();
        if (s.connected) { await inv('srv-disconnect', s.id); }
        else {
          btnC.textContent = '...';
          var r = await inv('srv-connect', s.id);
          if (!r.success) { alert('Could not connect to ' + s.name + ':\n' + r.message); }
          else expanded[s.id] = true;
        }
        refresh();
      });
      btnX.addEventListener('click', async function (e) {
        e.stopPropagation();
        if (!confirm('Remove server "' + s.name + '"?')) return;
        await inv('srv-remove', s.id);
        pinnedSignals.filter(function (p) { return p.nodeId.indexOf(pinPrefix(s)) === 0; }).forEach(function (p) { togglePin(p.nodeId, p.name, null); });
        refresh();
      });
      host.appendChild(box);
    });
    var add = document.createElement('div');
    add.style.cssText = 'padding:8px 10px;';
    add.innerHTML = '<button class="btn btn-sm btn-secondary" style="width:100%;">+ Add server</button>';
    add.firstChild.addEventListener('click', openAddModal);
    host.appendChild(add);
  }

  // ─── Add-server dialog ─────────────────────────────────────────────────────
  function openAddModal() {
    var old = document.getElementById('featModal');
    if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'featModal'; m.className = 'connection-modal'; m.style.zIndex = 1500;
    m.innerHTML = '<div class="connection-modal-box" style="width:420px;"><div class="connection-modal-header"><div class="connection-modal-title">🖥 Add OPC UA Server</div>' +
      '<button class="zoom-modal-close" id="featClose">✕</button></div><div class="connection-modal-body">' +
      '<input id="srvName" class="input" placeholder="Name, e.g. PLC2 (letters/numbers)">' +
      '<input id="srvEp" class="input" placeholder="opc.tcp://host:4840">' +
      '<input id="srvUser" class="input" placeholder="Username (optional)">' +
      '<input id="srvPass" class="input" type="password" placeholder="Password (optional)">' +
      '<button id="srvAdd" class="btn btn-primary" style="width:100%;">Add &amp; connect</button>' +
      '<div id="srvMsg" style="font-size:0.75rem;color:#fca5a5;margin-top:6px;"></div></div></div>';
    document.body.appendChild(m);
    document.getElementById('featClose').addEventListener('click', function () { m.remove(); });
    document.getElementById('srvAdd').addEventListener('click', async function () {
      var msg = document.getElementById('srvMsg');
      msg.textContent = 'Saving...';
      var r = await inv('srv-save', { name: document.getElementById('srvName').value, endpoint: document.getElementById('srvEp').value,
        user: document.getElementById('srvUser').value, pass: document.getElementById('srvPass').value });
      if (!r.success) { msg.textContent = r.message; return; }
      msg.textContent = 'Connecting...';
      var c = await inv('srv-connect', r.server.id);
      expanded[r.server.id] = !!c.success;
      m.remove();
      await refresh();
      if (!c.success) alert('Server saved, but the connection failed:\n' + c.message + '\nFix the address and press Connect.');
    });
  }

  // ─── Keep extra servers in step with the main Start / Stop buttons ─────────
  if (typeof monitorBtn !== 'undefined' && monitorBtn) {
    monitorBtn.addEventListener('click', function () {
      setTimeout(function () { inv('srv-resume', interval()).catch(function () {}); }, 500);
    });
  }
  if (typeof stopMonitorBtn !== 'undefined' && stopMonitorBtn) {
    stopMonitorBtn.addEventListener('click', function () { inv('srv-stop-all').catch(function () {}); });
  }

  // Header shortcut
  var hdr = document.querySelector('.header-right');
  if (hdr) {
    var b = document.createElement('button');
    b.className = 'btn btn-sm btn-secondary';
    b.textContent = '➕ Server';
    hdr.insertBefore(b, hdr.querySelector('.status-badge'));
    b.addEventListener('click', openAddModal);
  }

  refresh();
})();
