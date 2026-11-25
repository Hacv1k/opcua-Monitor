// RTOM alert delivery (main process): email via SMTP (no extra npm packages) and phone push via ntfy.
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { safeStorage } = require('electron');

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function asciiSafe(s) { return String(s || '').replace(/[^\x20-\x7e]/g, '?'); }

// ── Minimal SMTP client: SSL (465) or STARTTLS (587) or plain (25), AUTH PLAIN/LOGIN ──
async function smtpSend(cfg, mail) {
  const host = cfg.host;
  const mode = cfg.secure || 'starttls'; // 'ssl' | 'starttls' | 'none'
  const port = parseInt(cfg.port, 10) || (mode === 'ssl' ? 465 : mode === 'none' ? 25 : 587);
  const tlsOpts = { host: host, servername: host, rejectUnauthorized: !cfg.allowSelfSigned };
  let sock = null, buf = '', waiter = null, err = null;

  function onData(d) { buf += d; pump(); }
  function onErr(e) { err = e; if (waiter) { const w = waiter; waiter = null; w.reject(e); } }
  function pump() {
    if (!waiter) return;
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3}( |$)/.test(lines[i])) {
        const text = lines.slice(0, i + 1).join('\n');
        buf = lines.slice(i + 1).join('\r\n');
        const w = waiter; waiter = null;
        w.resolve({ code: parseInt(lines[i].slice(0, 3), 10), text: text });
        return;
      }
    }
  }
  function read() { return new Promise(function (resolve, reject) { if (err) return reject(err); waiter = { resolve: resolve, reject: reject }; pump(); }); }
  function attach(s) {
    sock = s;
    s.on('data', function (d) { onData(d.toString('utf8')); }); s.on('error', onErr);
    s.on('close', function () { onErr(new Error('Connection closed')); });
  }
  function write(line) { sock.write(line + '\r\n'); }
  async function cmd(line, okFirstDigits) {
    write(line);
    const r = await read();
    if (okFirstDigits.indexOf(String(r.code)[0]) === -1) throw new Error('SMTP ' + r.text.split('\n').pop());
    return r;
  }
  function connect() {
    return new Promise(function (resolve, reject) {
      const s = mode === 'ssl' ? tls.connect(port, host, tlsOpts) : net.connect(port, host);
      s.once(mode === 'ssl' ? 'secureConnect' : 'connect', function () { s.removeListener('error', reject); resolve(s); });
      s.once('error', reject);
    });
  }

  const work = (async function () {
    attach(await connect());
    let r = await read();
    if (r.code !== 220) throw new Error('SMTP greeting: ' + r.text);
    r = await cmd('EHLO rtom.local', ['2']);
    if (mode === 'starttls') {
      if (!/STARTTLS/i.test(r.text)) throw new Error('Server does not offer STARTTLS');
      await cmd('STARTTLS', ['2']);
      const plain = sock;
      plain.removeAllListeners('data');
      plain.removeAllListeners('error');
      plain.removeAllListeners('close');
      buf = '';
      const secured = await new Promise(function (resolve, reject) {
        const t = tls.connect(Object.assign({ socket: plain }, tlsOpts), function () { resolve(t); });
        t.once('error', reject);
      });
      attach(secured);
      await cmd('EHLO rtom.local', ['2']);
    }
    if (cfg.user) {
      try { await cmd('AUTH PLAIN ' + b64('\0' + cfg.user + '\0' + cfg.pass), ['2']); }
      catch (e) {
        await cmd('AUTH LOGIN', ['3']);
        await cmd(b64(cfg.user), ['3']);
        await cmd(b64(cfg.pass), ['2']);
      }
    }
    const from = cfg.from || cfg.user;
    await cmd('MAIL FROM:<' + from + '>', ['2']);
    const rcpts = String(cfg.to || '').split(/[;,\s]+/).filter(Boolean);
    if (!rcpts.length) throw new Error('No recipient');
    for (const rc of rcpts) await cmd('RCPT TO:<' + rc + '>', ['2']);
    await cmd('DATA', ['3']);
    const subj = /^[\x20-\x7e]*$/.test(mail.subject) ? mail.subject : '=?UTF-8?B?' + b64(mail.subject) + '?=';
    const body = String(mail.body).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const msg = ['From: RTOM <' + from + '>', 'To: ' + rcpts.join(', '), 'Subject: ' + subj, 'Date: ' + new Date().toUTCString(),
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
      b64(body).replace(/(.{76})/g, '$1\r\n'), '.'].join('\r\n');
    sock.write(msg + '\r\n');
    r = await read();
    if (r.code >= 400) throw new Error('SMTP ' + r.text);
    try { write('QUIT'); } catch (e) {}
    return true;
  })();

  let timer;
  const timeout = new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error('SMTP timeout')); }, 25000); });
  try { return await Promise.race([work, timeout]); }
  finally { clearTimeout(timer); try { if (sock) sock.destroy(); } catch (e) {} work.catch(function () {}); }
}

// ── ntfy push (works with ntfy.sh or a self-hosted server; free phone app) ──
function ntfySend(cfg, mail, priority) {
  return new Promise(function (resolve, reject) {
    const base = String(cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
    let u;
    try { u = new URL(base + '/' + encodeURIComponent(cfg.topic)); } catch (e) { return reject(new Error('Bad ntfy server/topic')); }
    const mod = u.protocol === 'http:' ? http : https;
    const data = Buffer.from(String(mail.body).slice(0, 3000), 'utf8');
    const req = mod.request(u, {
      method: 'POST', timeout: 15000,
      headers: { 'Title': asciiSafe(mail.subject).slice(0, 120), 'Priority': String(priority || 4), 'Tags': 'warning', 'Content-Length': data.length }
    }, function (res) {
      res.resume();
      res.on('end', function () { res.statusCode < 300 ? resolve(true) : reject(new Error('ntfy HTTP ' + res.statusCode)); });
    });
    req.on('timeout', function () { req.destroy(new Error('ntfy timeout')); });
    req.on('error', reject);
    req.end(data);
  });
}

function init(ctx) {
  const ipcMain = ctx.ipcMain;
  const lastSent = {};
  function cfgAll() { const f = ctx.getFeatures(); if (!f.alerts) f.alerts = { email: {}, ntfy: {}, on: { alarms: true, insights: true } }; return f.alerts; }
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

  ipcMain.handle('alert-get-config', async function () {
    const a = cfgAll();
    const email = Object.assign({}, a.email); email.hasPass = !!email.passEnc; delete email.passEnc;
    return { email: email, ntfy: a.ntfy || {}, on: a.on || { alarms: true, insights: true } };
  });
  ipcMain.handle('alert-set-config', async function (_e, c) {
    const a = cfgAll();
    const prevPass = (a.email || {}).passEnc;
    const email = Object.assign({}, c.email || {});
    email.passEnc = email.pass ? encPass(email.pass) : prevPass;
    delete email.pass; delete email.hasPass;
    a.email = email; a.ntfy = c.ntfy || {}; a.on = c.on || { alarms: true, insights: true };
    return { success: ctx.saveFeatures() };
  });

  async function deliver(subject, body, priority) {
    const a = cfgAll(); const results = {};
    const jobs = [];
    if (a.email && a.email.enabled && a.email.host) {
      jobs.push(smtpSend(Object.assign({}, a.email, { pass: decPass(a.email.passEnc) }), { subject: subject, body: body })
        .then(function () { results.email = 'sent'; }, function (e) { results.email = 'ERROR: ' + e.message; console.error('[ALERT] email failed:', e.message); }));
    }
    if (a.ntfy && a.ntfy.enabled && a.ntfy.topic) {
      jobs.push(ntfySend(a.ntfy, { subject: subject, body: body }, priority)
        .then(function () { results.push = 'sent'; }, function (e) { results.push = 'ERROR: ' + e.message; console.error('[ALERT] push failed:', e.message); }));
    }
    await Promise.all(jobs);
    return results;
  }

  ipcMain.handle('alert-send', async function (_e, p) {
    const a = cfgAll();
    const kind = (p && p.kind) || 'alarm';
    if (kind === 'alarm' && a.on && a.on.alarms === false) return { skipped: true };
    if (kind !== 'alarm' && a.on && a.on.insights === false) return { skipped: true };
    const key = (p && p.key) || (p && p.subject);
    const now = Date.now();
    if (lastSent[key] && now - lastSent[key] < 60000) return { skipped: 'cooldown' };
    lastSent[key] = now;
    return deliver(String(p.subject || 'RTOM alert'), String(p.body || ''), p.priority);
  });
  ipcMain.handle('alert-test', async function () {
    return deliver('RTOM test alert', 'This is a test alert from RTOM at ' + new Date().toLocaleString() + '.', 3);
  });
}

module.exports = { init };
