const { contextBridge, ipcRenderer } = require('electron');

let _dataChangedAttached = false;
const _dataChangedCallbacks = new Set();

function _attachDataChangedOnce() {
  if (_dataChangedAttached) return;
  ipcRenderer.removeAllListeners('opcua-data-changed');
  ipcRenderer.on('opcua-data-changed', (_event, payload) => {
    console.log('[PRELOAD] Data received:', JSON.stringify(payload));
    for (const cb of _dataChangedCallbacks) {
      try { cb(payload); } catch (e) { console.error('[PRELOAD] Callback error:', e); }
    }
  });
  _dataChangedAttached = true;
  console.log('[PRELOAD] IPC listener attached');
}

_attachDataChangedOnce();

// ─── Event Capture ("Black Box") listener setup ─────────────────────────────
// Additive: separate channel, separate callback set. Does not touch the
// opcua-data-changed wiring above.
let _eventStartedAttached = false;
let _eventFinishedAttached = false;
const _eventStartedCallbacks = new Set();
const _eventFinishedCallbacks = new Set();

function _attachEventListenersOnce() {
  if (!_eventStartedAttached) {
    ipcRenderer.on('event-capture-started', (_event, payload) => {
      for (const cb of _eventStartedCallbacks) {
        try { cb(payload); } catch (e) { console.error('[PRELOAD] Event-started callback error:', e); }
      }
    });
    _eventStartedAttached = true;
  }
  if (!_eventFinishedAttached) {
    ipcRenderer.on('event-capture-finished', (_event, payload) => {
      for (const cb of _eventFinishedCallbacks) {
        try { cb(payload); } catch (e) { console.error('[PRELOAD] Event-finished callback error:', e); }
      }
    });
    _eventFinishedAttached = true;
  }
}

_attachEventListenersOnce();

contextBridge.exposeInMainWorld('opcua', {
  connect: (endpoint, username, password) => ipcRenderer.invoke('opcua-connect', endpoint, username, password),
  disconnect: () => ipcRenderer.invoke('opcua-disconnect'),
  browse: (nodeId) => ipcRenderer.invoke('opcua-browse', nodeId),
  read: (nodeId) => ipcRenderer.invoke('opcua-read', nodeId),
  // samplingInterval (ms) is now forwarded to main process
  subscribe: (nodeIds, nodeNames, samplingInterval) => ipcRenderer.invoke('opcua-subscribe', nodeIds, nodeNames, samplingInterval),
  unsubscribe: () => ipcRenderer.invoke('opcua-unsubscribe'),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  // Phone -> desktop bridge (the phone's assistant questions and acknowledge commands)
  onMobileChatRequest: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('mobile-chat-request', (_event, msg) => {
      try { callback(msg); } catch (e) { console.error('[PRELOAD] mobile chat error:', e); }
    });
  },
  onMobileCommand: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('mobile-command', (_event, cmd) => {
      try { callback(cmd); } catch (e) { console.error('[PRELOAD] mobile command error:', e); }
    });
  },
  onDataChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    _attachDataChangedOnce();
    _dataChangedCallbacks.add(callback);
    return () => { _dataChangedCallbacks.delete(callback); };
  },
  historian: {
    getData: (nodeId, startDate, endDate) => ipcRenderer.invoke('historian-get-data', nodeId, startDate, endDate),
    getSignals: () => ipcRenderer.invoke('historian-get-signals'),
    getDataPath: () => ipcRenderer.invoke('historian-get-data-path'),
    getFiles: () => ipcRenderer.invoke('historian-get-files'),
    toggle: (enabled) => ipcRenderer.invoke('historian-toggle', enabled)
  },
  saveFile: (folderPath, filename, content) => ipcRenderer.invoke('save-file', folderPath, filename, content)
});

// ─── Event Capture ("Black Box") bridge ───────────────────────────────────
// Additive: separate global, does not modify window.opcua above.
contextBridge.exposeInMainWorld('eventCapture', {
  setThreshold: (nodeId, min, max) => ipcRenderer.invoke('event-set-threshold', nodeId, min, max),
  clearThreshold: (nodeId) => ipcRenderer.invoke('event-clear-threshold', nodeId),
  toggle: (enabled) => ipcRenderer.invoke('event-toggle', enabled),
  getCaptures: () => ipcRenderer.invoke('event-get-captures'),
  getCaptureDetail: (id) => ipcRenderer.invoke('event-get-capture-detail', id),
  setPinned: (nodeIds) => ipcRenderer.invoke('event-set-pinned', nodeIds),
  acknowledge: (id) => ipcRenderer.invoke('event-acknowledge', id),
  clear: (id) => ipcRenderer.invoke('event-clear', id),
  exportPackage: (id, folderPath) => ipcRenderer.invoke('event-export-package', id, folderPath),
  onCaptureStarted: (callback) => {
    if (typeof callback !== 'function') return () => {};
    _attachEventListenersOnce();
    _eventStartedCallbacks.add(callback);
    return () => { _eventStartedCallbacks.delete(callback); };
  },
  onCaptureFinished: (callback) => {
    if (typeof callback !== 'function') return () => {};
    _attachEventListenersOnce();
    _eventFinishedCallbacks.add(callback);
    return () => { _eventFinishedCallbacks.delete(callback); };
  }
});

console.log('[PRELOAD] OPC UA bridge initialized');
