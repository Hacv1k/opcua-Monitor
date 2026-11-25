// RTOM alert delivery (renderer): settings dialog + hooks that forward alarms/insights to email and phone push.
(function () {
  'use strict';
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function inv(ch, a) { return window.opcua.invoke(ch, a); }
  function endpoint() { try { return endpointInput.value; } catch (e) { return ''; } }

  // ── Hook: threshold alarms ──
  var origAdd = window.addAlarm;
  if (typeof origAdd === 'function') {
    window.addAlarm = function () {
      var r = origAdd.apply(this, arguments);
      try {
        var a = alarmLog[0];
        if (a) {
          inv('alert-send', {
            kind: 'alarm', key: 'alarm|' + a.nodeId + '|' + a.type, priority: 4,
            subject: 'RTOM ALARM: ' + a.signalName + ' ' + (a.type === 'high' ? 'HIGH' : 'LOW'),
            body: 'Signal: ' + a.signalName + '\nValue: ' + a.value + '\nLimit: ' + a.threshold + ' (' + a.type + ')\nTime: ' + a.fullTime + '\nServer: ' + endpoint()
          }).catch(function () {});
        }
      } catch (e) {}
      return r;
    };
  }

  // ── Hook: trend / anomaly / cross-signal findings ──
  window.addEventListener('rtom-insight', function (ev) {
    var i = ev.detail;
    inv('alert-send', {
      kind: 'insight', key: 'insight|' + i.nodeId + '|' + i.kind, priority: i.kind === 'rule' ? 4 : 3,
      subject: 'RTOM ' + (i.kind === 'rule' ? 'RULE: ' : i.kind.toUpperCase() + ': ') + i.signal,
      body: i.text + '\nTime: ' + i.time + '\nServer: ' + endpoint()
    }).catch(function () {});
  });

  // ── Settings dialog ──
  function field(id, label, type, ph) {
    return '<div style="margin-bottom:2px;"><label style="font-size:0.65rem;color:#9ca3af;">' + label + '</label>' +
      '<input id="' + id + '" class="input" type="' + (type || 'text') + '" placeholder="' + (ph || '') + '" style="margin-bottom:4px;"></div>';
  }
  function open() {
    var old = document.getElementById('featModal');
    if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'featModal'; m.className = 'connection-modal'; m.style.zIndex = 1500;
    m.innerHTML = '<div class="connection-modal-box" style="width:520px;"><div class="connection-modal-header"><div class="connection-modal-title">📨 Alert Delivery</div>' +
      '<button class="zoom-modal-close" id="featClose">✕</button></div><div class="connection-modal-body">' +
      '<div class="sidebar-title">What to send</div>' +
      '<label style="font-size:0.75rem;display:block;"><input type="checkbox" id="alOnAlarms" checked> Threshold alarms</label>' +
      '<label style="font-size:0.75rem;display:block;margin-bottom:8px;"><input type="checkbox" id="alOnIns" checked> Trend / anomaly / cross-signal findings</label>' +
      '<div class="sidebar-title">📧 Email (SMTP)</div>' +
      '<label style="font-size:0.75rem;display:block;margin-bottom:4px;"><input type="checkbox" id="emEnabled"> Enable email alerts</label>' +
      field('emHost', 'SMTP server', 'text', 'smtp.office365.com') + field('emPort', 'Port (587 STARTTLS / 465 SSL / 25 none)', 'number', '587') +
      '<label style="font-size:0.65rem;color:#9ca3af;">Security</label><select id="emSecure" class="input" style="margin-bottom:4px;"><option value="starttls">STARTTLS (587)</option><option value="ssl">SSL/TLS (465)</option><option value="none">None (25)</option></select>' +
      field('emUser', 'Username (optional)', 'text', '') + field('emPass', 'Password (stored encrypted)', 'password', '') +
      field('emFrom', 'From address', 'text', 'rtom@company.com') + field('emTo', 'To (comma separated)', 'text', 'you@company.com') +
      '<label style="font-size:0.7rem;display:block;margin-bottom:8px;"><input type="checkbox" id="emSelf"> Allow self-signed certificate</label>' +
      '<div class="sidebar-title">📱 Phone push (ntfy app)</div>' +
      '<div style="font-size:0.65rem;color:#9ca3af;margin-bottom:4px;">Install the free "ntfy" app on your phone and subscribe to your topic. Needs internet unless you self-host ntfy.</div>' +
      '<label style="font-size:0.75rem;display:block;margin-bottom:4px;"><input type="checkbox" id="ntEnabled"> Enable phone push</label>' +
      field('ntServer', 'ntfy server', 'text', 'https://ntfy.sh') + field('ntTopic', 'Topic (make it long and private)', 'text', 'rtom-vignesh-8f3k29x') +
      '<div style="display:flex;gap:6px;margin-top:6px;"><button id="alSave" class="btn btn-primary" style="flex:1;">Save</button><button id="alTest" class="btn btn-secondary">Save &amp; send test</button></div>' +
      '<div id="alMsg" style="font-size:0.75rem;margin-top:6px;color:#9ca3af;"></div></div></div>';
    document.body.appendChild(m);
    var $ = function (id) { return document.getElementById(id); };
    $('featClose').addEventListener('click', function () { m.remove(); });
    inv('alert-get-config').then(function (c) {
      var e = c.email || {}, n = c.ntfy || {}, on = c.on || {};
      $('alOnAlarms').checked = on.alarms !== false; $('alOnIns').checked = on.insights !== false;
      $('emEnabled').checked = !!e.enabled; $('emHost').value = e.host || ''; $('emPort').value = e.port || '';
      $('emSecure').value = e.secure || 'starttls'; $('emUser').value = e.user || '';
      $('emPass').placeholder = e.hasPass ? '(saved — leave blank to keep)' : '';
      $('emFrom').value = e.from || ''; $('emTo').value = e.to || ''; $('emSelf').checked = !!e.allowSelfSigned;
      $('ntEnabled').checked = !!n.enabled; $('ntServer').value = n.server || 'https://ntfy.sh'; $('ntTopic').value = n.topic || '';
    });
    function collect() {
      return {
        on: { alarms: $('alOnAlarms').checked, insights: $('alOnIns').checked },
        email: { enabled: $('emEnabled').checked, host: $('emHost').value.trim(), port: $('emPort').value, secure: $('emSecure').value,
          user: $('emUser').value.trim(), pass: $('emPass').value, from: $('emFrom').value.trim(), to: $('emTo').value.trim(), allowSelfSigned: $('emSelf').checked },
        ntfy: { enabled: $('ntEnabled').checked, server: $('ntServer').value.trim(), topic: $('ntTopic').value.trim() }
      };
    }
    $('alSave').addEventListener('click', function () {
      inv('alert-set-config', collect()).then(function () { $('alMsg').textContent = 'Saved.'; });
    });
    $('alTest').addEventListener('click', function () {
      $('alMsg').textContent = 'Sending test...';
      inv('alert-set-config', collect()).then(function () { return inv('alert-test'); }).then(function (r) {
        var parts = [];
        if (r.email) parts.push('Email: ' + r.email);
        if (r.push) parts.push('Push: ' + r.push);
        $('alMsg').textContent = parts.length ? parts.join('  |  ') : 'Nothing enabled.';
      }).catch(function (e) { $('alMsg').textContent = 'Failed: ' + e.message; });
    });
  }

  var host = document.querySelector('.header-right');
  if (host) {
    var b = document.createElement('button');
    b.className = 'btn btn-sm btn-secondary';
    b.textContent = '📨 Alerts';
    host.insertBefore(b, host.querySelector('.status-badge'));
    b.addEventListener('click', open);
  }
})();
