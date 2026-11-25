// RTOM multi-server monitoring (main process).
// The primary connection (Connect dialog) is unchanged. Extra servers added here get their own
// client + session + poll loop. Their signals use the id  "#<ServerName>#<rawNodeId>"  so ids never
// collide across servers and the primary subscribe code ignores them.
const { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds } = require('node-opcua');
const { safeStorage } = require('electron');

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

function init(ctx) {
  const ipcMain = ctx.ipcMain;
  const live = new Map(); // serverId -> { client, session, timer, signals: Map(pid -> {raw,name}), busy, failCount }
  let pollMs = 1000;

  function cfgList() {
    const f = ctx.getFeatures();
    if (!Array.isArray(f.servers)) f.servers = [];
    return f.servers;
  }
  function findCfg(id) { return cfgList().filter(function (s) { return s.id === id; })[0]; }
  function encPass(p) {
    try { if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(p).toString('base64'); } catch (e) {}
    return 'b64:' + b64(p);
  }
  function decPass(p) {
    if (!p) return '';
    try {
      if (p.indexOf('enc:') === 0) return safeStorage.decryptString(Buffer.from(p.slice(4), 'base64'));
      if (p.indexOf('b64:') === 0) return Buffer.from(p.slice(4), 'base64').toString('utf8');
    } catch (e) {}
    return '';
  }
  function prefix(cfg) { return '#' + cfg.name + '#'; }
  function summary(cfg) {
    const l = live.get(cfg.id);
    return { id: cfg.id, name: cfg.name, endpoint: cfg.endpoint, user: cfg.user || '',
      connected: !!(l && l.session), polling: !!(l && l.timer), signalCount: l ? l.signals.size : 0 };
  }

  ipcMain.handle('srv-list', async function () { return cfgList().map(summary); });

  ipcMain.handle('srv-save', async function (_e, s) {
    const name = String((s && s.name) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12);
    if (!name) return { success: false, message: 'Short name required (letters/numbers, e.g. PLC2)' };
    if (!s.endpoint) return { success: false, message: 'Endpoint required' };
    const list = cfgList();
    if (list.some(function (x) { return x.name === name; })) return { success: false, message: 'Name already used' };
    const cfg = { id: 's' + Date.now(), name: name, endpoint: String(s.endpoint).trim(), user: s.user || '', passEnc: s.pass ? encPass(s.pass) : '' };
    list.push(cfg);
    ctx.saveFeatures();
    return { success: true, server: summary(cfg) };
  });

  ipcMain.handle('srv-remove', async function (_e, id) {
    await disconnect(id);
    const f = ctx.getFeatures();
    f.servers = cfgList().filter(function (s) { return s.id !== id; });
    ctx.saveFeatures();
    return { success: true };
  });

  async function connect(id) {
    const cfg = findCfg(id);
    if (!cfg) throw new Error('Unknown server');
    if (live.has(id) && live.get(id).session) return;
    const client = OPCUAClient.create({
      endpoint_must_exist: false,
      connectionStrategy: { maxRetry: 2, initialDelay: 1000, maxDelay: 5000 },
      securityMode: MessageSecurityMode.None, securityPolicy: SecurityPolicy.None
    });
    await client.connect(cfg.endpoint);
    const identity = cfg.user ? { userName: cfg.user, password: decPass(cfg.passEnc) } : null;
    const session = await client.createSession(identity);
    const prev = live.get(id);
    live.set(id, { client: client, session: session, timer: prev ? prev.timer : null, signals: prev ? prev.signals : new Map(), busy: false, failCount: 0 });
  }

  async function disconnect(id) {
    const l = live.get(id);
    if (!l) return;
    if (l.timer) clearInterval(l.timer);
    try { if (l.session) await l.session.close(); } catch (e) {}
    try { if (l.client) await l.client.disconnect(); } catch (e) {}
    live.delete(id);
  }

  ipcMain.handle('srv-connect', async function (_e, id) {
    try { await connect(id); return { success: true }; }
    catch (e) { return { success: false, message: e.message }; }
  });
  ipcMain.handle('srv-disconnect', async function (_e, id) {
    await disconnect(id); return { success: true };
  });

  ipcMain.handle('srv-browse', async function (_e, id, nodeId) {
    try {
      const l = live.get(id);
      if (!l || !l.session) return { success: false, message: 'Not connected' };
      const r = await l.session.browse(nodeId || 'i=85');
      const seen = new Set(); const nodes = [];
      r.references.forEach(function (ref) {
        const nid = ref.nodeId.toString();
        if (seen.has(nid)) return;
        seen.add(nid);
        nodes.push({ nodeId: nid, displayName: (ref.displayName && ref.displayName.text) || ref.browseName.name, nodeClass: Number(ref.nodeClass) });
      });
      return { success: true, nodes: nodes };
    } catch (e) { return { success: false, message: e.message }; }
  });

  // Read one value now (used to show the current value on the new graph card)
  async function readOne(l, raw) {
    const dv = await l.session.read({ nodeId: raw, attributeId: AttributeIds.Value });
    return ctx.normalizeVariantValue(dv.value);
  }

  // Add signals to a server's poll list and make sure polling runs
  ipcMain.handle('srv-add-signals', async function (_e, id, signals, intervalMs) {
    try {
      const cfg = findCfg(id);
      const l = live.get(id);
      if (!cfg || !l || !l.session) return { success: false, message: 'Server not connected' };
      if (typeof intervalMs === 'number' && intervalMs >= 200) pollMs = intervalMs;
      const out = [];
      for (const s of signals) {
        const pid = prefix(cfg) + s.nodeId;
        l.signals.set(pid, { raw: s.nodeId, name: s.name });
        ctx.signalNames.set(pid, '[' + cfg.name + '] ' + s.name);
        let value = null;
        try { value = await readOne(l, s.nodeId); } catch (e) {}
        out.push({ nodeId: pid, name: '[' + cfg.name + '] ' + s.name, value: typeof value === 'number' ? value : null });
      }
      startPolling(id);
      return { success: true, signals: out };
    } catch (e) { return { success: false, message: e.message }; }
  });

  ipcMain.handle('srv-remove-signal', async function (_e, pid) {
    live.forEach(function (l) { l.signals.delete(pid); });
    return { success: true };
  });

  function startPolling(id) {
    const l = live.get(id);
    if (!l) return;
    if (l.timer) clearInterval(l.timer);
    l.timer = setInterval(function () { pollOnce(id); }, pollMs);
  }

  async function pollOnce(id) {
    const l = live.get(id);
    if (!l || !l.session || l.busy || !l.signals.size) return;
    l.busy = true;
    try {
      const entries = Array.from(l.signals.entries());
      const results = await l.session.read(entries.map(function (e) { return { nodeId: e[1].raw, attributeId: AttributeIds.Value }; }));
      const win = ctx.getMainWindow();
      const ts = new Date().toISOString();
      entries.forEach(function (e, i) {
        const dv = results[i];
        let value = ctx.normalizeVariantValue(dv.value);
        if (value === undefined) value = dv.value;
        const status = dv.statusCode ? dv.statusCode.toString() : 'Good';
        if (ctx.isHistorianEnabled() && typeof value === 'number') {
          ctx.saveToCSV(e[0], ctx.signalNames.get(e[0]) || e[0], value, ts, status);
        }
        const payload = { nodeId: e[0], value: value, timestamp: ts, statusCode: status };
        ctx.feedEventCapture(payload);
        if (win && !win.isDestroyed()) win.webContents.send('opcua-data-changed', payload);
      });
      l.failCount = 0;
    } catch (err) {
      l.failCount++;
      console.error('[SERVERS] poll error on', id, err.message);
      if (l.failCount >= 3) { // lost connection: try to re-establish quietly
        try { if (l.timer) clearInterval(l.timer); } catch (e) {}
        const signals = l.signals;
        live.delete(id);
        try { await l.client.disconnect(); } catch (e) {}
        try {
          await connect(id);
          const nl = live.get(id); nl.signals = signals; startPolling(id);
          console.log('[SERVERS] reconnected', id);
        } catch (e2) {
          console.error('[SERVERS] reconnect failed, will not retry until reconnected manually:', e2.message);
        }
        return;
      }
    } finally { if (live.get(id)) live.get(id).busy = false; }
  }

  // Stop polling on every extra server (used when the user stops monitoring)
  ipcMain.handle('srv-stop-all', async function () {
    live.forEach(function (l) { if (l.timer) { clearInterval(l.timer); l.timer = null; } });
    return { success: true };
  });
  // Restart polling for servers that still hold signals (used when the user presses Start)
  ipcMain.handle('srv-resume', async function (_e, intervalMs) {
    if (typeof intervalMs === 'number' && intervalMs >= 200) pollMs = intervalMs;
    live.forEach(function (l, id) { if (l.signals.size) startPolling(id); });
    const out = [];
    live.forEach(function (l, id) { const cfg = findCfg(id); l.signals.forEach(function (v, pid) { out.push({ nodeId: pid, name: '[' + (cfg ? cfg.name : '?') + '] ' + v.name }); }); });
    return { success: true, signals: out };
  });

  require('electron').app.on('before-quit', function () {
    live.forEach(function (l) { if (l.timer) clearInterval(l.timer); });
  });
}

module.exports = { init };
