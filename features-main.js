// RTOM feature module (main process): annotations, PDF report, feature settings.
// Loaded from main.js with one line:  require('./features-main').init({ ... });
const fs = require('fs');
const os = require('os');
const path = require('path');

function init(ctx) {
  const { app, ipcMain, BrowserWindow, dialog } = ctx;
  const dir = app.getPath('userData');
  const annPath = path.join(dir, 'annotations.json');
  const cfgPath = path.join(dir, 'rtom-features.json');

  function readJson(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
  }
  function writeJson(p, obj) {
    try { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); return true; }
    catch (e) { console.error('[FEATURES] write failed:', p, e.message); return false; }
  }

  // ── Feature settings (rules, alerts, servers... later steps use this) ──
  let features = readJson(cfgPath, {});
  ctx.getFeatures = function () { return features; };
  ctx.saveFeatures = function () { return writeJson(cfgPath, features); };

  ipcMain.handle('feat-get-config', async function () { return features; });
  ipcMain.handle('feat-set-config', async function (_e, patch) {
    features = Object.assign({}, features, patch || {});
    return { success: writeJson(cfgPath, features) };
  });

  // ── Annotations ──
  let annotations = readJson(annPath, []);
  if (!Array.isArray(annotations)) annotations = [];

  ipcMain.handle('ann-list', async function () { return annotations; });
  ipcMain.handle('ann-add', async function (_e, note) {
    const entry = {
      id: Date.now() + '-' + Math.floor(Math.random() * 1000),
      time: new Date().toISOString(),
      text: String((note && note.text) || '').slice(0, 1000),
      nodeId: (note && note.nodeId) || null,
      signal: (note && note.signal) || null
    };
    if (!entry.text) return { success: false, error: 'Empty note' };
    annotations.unshift(entry);
    if (annotations.length > 1000) annotations.pop();
    writeJson(annPath, annotations);
    return { success: true, entry: entry, annotations: annotations };
  });
  ipcMain.handle('ann-delete', async function (_e, id) {
    annotations = annotations.filter(function (a) { return a.id !== id; });
    writeJson(annPath, annotations);
    return { success: true, annotations: annotations };
  });

  // ── PDF report ──
  ipcMain.handle('report-save-pdf', async function (_e, html, defaultName) {
    let win = null;
    const tmp = path.join(os.tmpdir(), 'rtom-report-' + Date.now() + '.html');
    try {
      fs.writeFileSync(tmp, html, 'utf8');
      win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true } });
      await win.loadFile(tmp);
      await new Promise(function (r) { setTimeout(r, 400); });
      const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
      const parent = BrowserWindow.getFocusedWindow() || ctx.getMainWindow && ctx.getMainWindow() || undefined;
      const res = await dialog.showSaveDialog(parent, {
        title: 'Save incident report',
        defaultPath: path.join(app.getPath('documents'), defaultName || 'RTOM_Incident_Report.pdf'),
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      });
      if (res.canceled || !res.filePath) return { success: false, canceled: true };
      fs.writeFileSync(res.filePath, pdf);
      return { success: true, path: res.filePath };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      try { if (win) win.destroy(); } catch (e) {}
      try { fs.unlinkSync(tmp); } catch (e) {}
    }
  });

  try { require('./features-alerts-main').init(ctx); } catch (e) { console.error('[FEATURES] alerts module failed:', e.message); }

  try { require('./features-servers-main').init(ctx); } catch (e) { console.error('[FEATURES] servers module failed:', e.message); }

  console.log('[FEATURES] Module ready (annotations, report, settings, alerts, servers)');
}

module.exports = { init };
