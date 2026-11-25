let isConnected = false;
let isMonitoring = false;
let selectedNodes = [];
let pinnedSignals = [];
let charts = new Map();
let chartData = new Map();
let graphValueElements = new Map();
let signalVisibility = new Map();
let signalThresholds = new Map();
let signalStats = new Map();
let previousValues = new Map();
let MAX_DATA_POINTS = 600;
const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

let autoSaveInterval = null;
let autoSavePath = '';
let globalMinThreshold = null;
let globalMaxThreshold = null;
let zoomChart = null;
let currentSamplingInterval = 1000; // ms

// ─── Alarm Log ───────────────────────────────────────────────────────────────
const MAX_ALARM_ENTRIES = 200;
let alarmLog = []; // { time, signalName, nodeId, value, type: 'high'|'low', threshold }

function addAlarm(nodeId, signalName, value, type, threshold) {
  var entry = {
    id: Date.now() + Math.random(),
    time: new Date().toLocaleTimeString(),
    fullTime: new Date().toISOString(),
    signalName: signalName,
    nodeId: nodeId,
    value: typeof value === 'number' ? value.toFixed(3) : value,
    type: type,
    threshold: threshold,
    acknowledged: false
  };
  alarmLog.unshift(entry);
  if (alarmLog.length > MAX_ALARM_ENTRIES) alarmLog.pop();
  renderAlarmLog();
  updateAlarmBadge();
}

function acknowledgeAlarm(id) {
  var entry = alarmLog.find(function(a) { return a.id === id; });
  if (entry) entry.acknowledged = true;
  renderAlarmLog();
  updateAlarmBadge();
}

function clearAlarm(id) {
  alarmLog = alarmLog.filter(function(a) { return a.id !== id; });
  renderAlarmLog();
  updateAlarmBadge();
}

function renderAlarmLog() {
  var tbody = document.getElementById('alarmTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (alarmLog.length === 0) {
    var empty = document.createElement('tr');
    empty.innerHTML = '<td colspan="6" style="text-align:center;color:#6b7280;padding:1rem;">No alarms yet</td>';
    tbody.appendChild(empty);
    return;
  }
  alarmLog.forEach(function(a) {
    var tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #374151';
    if (a.acknowledged) tr.style.opacity = '0.5';
    var color = a.type === 'high' ? '#f87171' : '#60a5fa';
    var label = a.type === 'high' ? '▲ HIGH' : '▼ LOW';
    tr.innerHTML =
      '<td style="padding:0.3rem 0.5rem;color:#9ca3af;font-size:0.7rem;white-space:nowrap;">' + a.time + (a.acknowledged ? ' <span style="color:#34d399;font-size:0.65rem;">(ack)</span>' : '') + '</td>' +
      '<td style="padding:0.3rem 0.5rem;font-size:0.75rem;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + a.signalName + '">' + a.signalName + '</td>' +
      '<td style="padding:0.3rem 0.5rem;font-family:monospace;font-size:0.75rem;color:#4ade80;">' + a.value + '</td>' +
      '<td style="padding:0.3rem 0.5rem;"><span style="color:' + color + ';font-size:0.7rem;font-weight:600;">' + label + '</span></td>' +
      '<td style="padding:0.3rem 0.5rem;color:#9ca3af;font-size:0.7rem;">' + a.threshold + '</td>' +
      '<td style="padding:0.3rem 0.5rem;white-space:nowrap;">' +
        (a.acknowledged ? '' : '<button class="alarm-ack-btn" data-id="' + a.id + '" style="font-size:0.65rem;padding:2px 6px;margin-right:4px;background:#1f4d3d;color:#6ee7b7;border:1px solid #10b981;border-radius:4px;cursor:pointer;">Ack</button>') +
        '<button class="alarm-clear-btn" data-id="' + a.id + '" style="font-size:0.65rem;padding:2px 6px;background:#4c1d1d;color:#fca5a5;border:1px solid #ef4444;border-radius:4px;cursor:pointer;">Clear</button>' +
      '</td>';
    tbody.appendChild(tr);
    var ackBtn = tr.querySelector('.alarm-ack-btn');
    if (ackBtn) ackBtn.addEventListener('click', function() { acknowledgeAlarm(a.id); });
    var clearBtn = tr.querySelector('.alarm-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', function() { clearAlarm(a.id); });
  });
}

function updateAlarmBadge() {
  var badge = document.getElementById('alarmBadge');
  if (!badge) return;
  var unackCount = alarmLog.filter(function(a) { return !a.acknowledged; }).length;
  if (unackCount > 0) {
    badge.textContent = unackCount > 99 ? '99+' : unackCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const connectBtn = document.getElementById('connectBtn');
const endpointInput = document.getElementById('endpoint');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const autoSavePathInput = document.getElementById('autoSavePath');
const globalMinThresholdInput = document.getElementById('globalMinThreshold');
const globalMaxThresholdInput = document.getElementById('globalMaxThreshold');
const samplingIntervalSelect = document.getElementById('samplingInterval');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const mainContent = document.getElementById('mainContent');
const disconnectedState = document.getElementById('disconnectedState');
const nodeTree = document.getElementById('nodeTree');
const controlPanel = document.getElementById('controlPanel');
const emptyState = document.getElementById('emptyState');
const signalTable = document.getElementById('signalTable');
const graphsContainer = document.getElementById('graphsContainer');
const pinnedContainer = document.getElementById('pinnedContainer');
const pinnedSection = document.getElementById('pinnedSection');
const pinnedCount = document.getElementById('pinnedCount');
const monitorBtn = document.getElementById('monitorBtn');
const stopMonitorBtn = document.getElementById('stopMonitorBtn');
const clearBtn = document.getElementById('clearBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const exportImgBtn = document.getElementById('exportImgBtn');
const folderName = document.getElementById('folderName');
const signalCount = document.getElementById('signalCount');
const tableSection = document.getElementById('tableSection');
const graphsSection = document.getElementById('graphsSection');
const timeRange = document.getElementById('timeRange');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const popoutAllBtn = document.getElementById('popoutAllBtn');
const zoomModal = document.getElementById('zoomModal');
const zoomTitle = document.getElementById('zoomTitle');
const zoomStats = document.getElementById('zoomStats');
const zoomClose = document.getElementById('zoomClose');

let dataListenerDisposer = null;

function safeId(nodeId) { return nodeId.replace(/[^a-zA-Z0-9]/g, '_'); }

function normalizeValue(v) {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'object' && 'value' in v) return normalizeValue(v.value);
  return v;
}

// ─── Signal name lookup (for alarm log) ──────────────────────────────────────
function getSignalName(nodeId) {
  var s = pinnedSignals.find(function(x) { return x.nodeId === nodeId; });
  if (s) return s.name;
  var n = selectedNodes.find(function(x) { return x.nodeId === nodeId; });
  return n ? n.name : nodeId;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats(nodeId, value) {
  if (typeof value !== 'number') return;
  var stats = signalStats.get(nodeId) || { min: Infinity, max: -Infinity, sum: 0, count: 0 };
  stats.min = Math.min(stats.min, value);
  stats.max = Math.max(stats.max, value);
  stats.sum += value;
  stats.count++;
  stats.avg = stats.sum / stats.count;
  signalStats.set(nodeId, stats);
  var statsEl = document.getElementById('stats-' + safeId(nodeId));
  if (statsEl) {
    statsEl.innerHTML = '<span class="stat-min">Min: ' + stats.min.toFixed(1) + '</span>' +
                        '<span class="stat-max">Max: ' + stats.max.toFixed(1) + '</span>' +
                        '<span class="stat-avg">Avg: ' + stats.avg.toFixed(1) + '</span>';
  }
}

// ─── Change arrow ─────────────────────────────────────────────────────────────
function getChangeArrow(nodeId, newValue) {
  var prev = previousValues.get(nodeId);
  previousValues.set(nodeId, newValue);
  if (prev === undefined || prev === newValue) return '<span class="graph-arrow arrow-stable">―</span>';
  if (newValue > prev) return '<span class="graph-arrow arrow-up">▲</span>';
  return '<span class="graph-arrow arrow-down">▼</span>';
}

// ─── Threshold check ─────────────────────────────────────────────────────────
// Track active alarm state to avoid flooding log with duplicate entries
var _alarmActive = new Map(); // nodeId -> 'high'|'low'|null

function checkThresholds(nodeId, value) {
  var elemId = safeId(nodeId);
  var card = document.getElementById('graph-container-' + elemId) || document.getElementById('pinned-' + elemId);
  if (!card) return;

  card.classList.remove('alert-high', 'alert-low');

  var threshold = signalThresholds.get(nodeId) || {};
  var min = threshold.min;
  var max = threshold.max;
  if (min === undefined || min === null) min = globalMinThreshold;
  if (max === undefined || max === null) max = globalMaxThreshold;

  // Mirror effective threshold to main.js so Black Box capture triggers in sync
  // with alarms. Do this every time we have a non-null threshold, not just on
  // breach, so main.js always has the latest value.
  if ((min !== null && min !== undefined) || (max !== null && max !== undefined)) {
    if (window.eventCapture) {
      window.eventCapture.setThreshold(nodeId,
        (min !== null && min !== undefined) ? min : null,
        (max !== null && max !== undefined) ? max : null
      );
    }
  }

  var prevAlarm = _alarmActive.get(nodeId) || null;

  if (max !== null && max !== undefined && value > max) {
    card.classList.add('alert-high');
    if (prevAlarm !== 'high') {
      addAlarm(nodeId, getSignalName(nodeId), value, 'high', max);
      _alarmActive.set(nodeId, 'high');
    }
  } else if (min !== null && min !== undefined && value < min) {
    card.classList.add('alert-low');
    if (prevAlarm !== 'low') {
      addAlarm(nodeId, getSignalName(nodeId), value, 'low', min);
      _alarmActive.set(nodeId, 'low');
    }
  } else {
    _alarmActive.set(nodeId, null);
  }
}

// ─── Time range ───────────────────────────────────────────────────────────────
timeRange.addEventListener('change', function() {
  MAX_DATA_POINTS = parseInt(this.value);
  chartData.forEach(function(data, nodeId) {
    if (data.length > MAX_DATA_POINTS) {
      var trimmed = data.slice(-MAX_DATA_POINTS);
      chartData.set(nodeId, trimmed);
      var chart = charts.get(nodeId);
      if (chart) {
        chart.data.labels = trimmed.map(function(d) { return d.time; });
        chart.data.datasets[0].data = trimmed.map(function(d) { return d.value; });
        chart.update('none');
      }
    }
  });
});

// ─── Sampling interval ────────────────────────────────────────────────────────
if (samplingIntervalSelect) {
  samplingIntervalSelect.addEventListener('change', function() {
    currentSamplingInterval = parseInt(this.value);
  });
}

// ─── Threshold inputs ─────────────────────────────────────────────────────────
globalMinThresholdInput.addEventListener('change', function() {
  globalMinThreshold = this.value ? parseFloat(this.value) : null;
});
globalMaxThresholdInput.addEventListener('change', function() {
  globalMaxThreshold = this.value ? parseFloat(this.value) : null;
});

// ─── Select All ───────────────────────────────────────────────────────────────
selectAllCheckbox.addEventListener('change', function() {
  var checked = this.checked;
  var checkboxes = signalTable.querySelectorAll('input.show-checkbox');
  checkboxes.forEach(function(cb) {
    cb.checked = checked;
    var nodeId = cb.dataset.nodeId;
    if (nodeId) {
      signalVisibility.set(nodeId, checked);
      updateGraphVisibility(nodeId, checked);
    }
  });
});

function updateGraphVisibility(nodeId, visible) {
  var elemId = safeId(nodeId);
  var container = document.getElementById('graph-container-' + elemId);
  if (container) container.style.display = visible ? 'block' : 'none';
}

function updatePinnedCount() {
  if (pinnedSignals.length > 0) {
    pinnedCount.textContent = '(' + pinnedSignals.length + ' pinned)';
    pinnedSection.classList.remove('hidden');
  } else {
    pinnedCount.textContent = '';
    pinnedSection.classList.add('hidden');
  }
}

function isPinned(nodeId) { return pinnedSignals.some(function(s) { return s.nodeId === nodeId; }); }

function syncPinnedToMainProcess() {
  if (window.eventCapture) {
    window.eventCapture.setPinned(pinnedSignals.map(function(s) { return s.nodeId; }));
  }
  syncMobileState();
}

function syncMobileState() {
  if (!window.opcua) return;
  var pinnedForMobile = pinnedSignals.map(function(s) {
    var d = chartData.get(s.nodeId) || [];
    var last = d.length > 0 ? d[d.length - 1] : null;
    var th = signalThresholds.get(s.nodeId) || {};
    var tmin = (th.min !== undefined && th.min !== null) ? th.min : globalMinThreshold;
    var tmax = (th.max !== undefined && th.max !== null) ? th.max : globalMaxThreshold;
    return {
      nodeId: s.nodeId,
      name: s.name,
      value: last ? last.value : null,
      timestamp: last ? last.time : null,
      min: tmin,
      max: tmax,
      history: d.slice(-120).map(function(p) { return { t: p.time, v: p.value }; })
    };
  });
  var alarmsForMobile = alarmLog.map(function(a) {
    return {
      id: a.id,
      nodeId: a.nodeId,
      signalName: a.signalName,
      value: a.value,
      type: a.type,
      threshold: a.threshold,
      time: a.time,
      acknowledged: !!a.acknowledged
    };
  });
  window.opcua.invoke('mobile-update-state', {
    connected: isConnected,
    endpoint: endpointInput ? endpointInput.value : '',
    pinnedSignals: pinnedForMobile,
    alarms: alarmsForMobile
  }).catch(function() {});
}

function togglePin(nodeId, signalName, value) {
  var idx = pinnedSignals.findIndex(function(s) { return s.nodeId === nodeId; });
  if (idx !== -1) {
    pinnedSignals.splice(idx, 1);
    var pinnedCard = document.getElementById('pinned-' + safeId(nodeId));
    if (pinnedCard) pinnedCard.remove();
  } else {
    pinnedSignals.push({ nodeId: nodeId, name: signalName, value: value });
    if (isMonitoring) createPinnedChart({ nodeId: nodeId, name: signalName, value: value }, pinnedSignals.length - 1);
  }
  syncPinnedToMainProcess();
  updatePinnedCount();
  updatePinButtons();
}

function updatePinButtons() {
  document.querySelectorAll('.pin-btn').forEach(function(btn) {
    var nodeId = btn.dataset.nodeId;
    btn.textContent = isPinned(nodeId) ? 'Unpin' : 'Pin';
    btn.className = isPinned(nodeId) ? 'btn btn-warning btn-sm pin-btn' : 'btn btn-secondary btn-sm pin-btn';
  });
  document.querySelectorAll('.pin-checkbox').forEach(function(cb) { cb.checked = isPinned(cb.dataset.nodeId); });
}

// ─── Data change listener ─────────────────────────────────────────────────────
function setupDataChangeListener() {
  if (dataListenerDisposer) { dataListenerDisposer(); dataListenerDisposer = null; }
  dataListenerDisposer = window.opcua.onDataChanged(function(change) {
    try {
      var updates = Array.isArray(change) ? change : [change];
      for (var i = 0; i < updates.length; i++) {
        var upd = updates[i];
        var nodeId = upd.nodeId;
        var val = upd.value;
        if (val && typeof val === 'object' && 'value' in val) val = val.value;
        if (typeof val === 'string' && !isNaN(val)) val = parseFloat(val);
        var timestamp = upd.timestamp || new Date().toISOString();
        var elemId = safeId(nodeId);

        var idx = selectedNodes.findIndex(function(n) { return n.nodeId === nodeId; });
        if (idx !== -1) {
          selectedNodes[idx].value = val;
          var valueCell = document.getElementById('value-' + elemId);
          if (valueCell && typeof val === 'number') valueCell.textContent = val.toFixed(2);
        }

        var pIdx = pinnedSignals.findIndex(function(s) { return s.nodeId === nodeId; });
        if (pIdx !== -1) pinnedSignals[pIdx].value = val;

        var graphValueEl = graphValueElements.get(nodeId);
        if (graphValueEl && typeof val === 'number') {
          var arrow = getChangeArrow(nodeId, val);
          graphValueEl.innerHTML = val.toFixed(2) + ' ' + arrow;
        }

        updateStats(nodeId, val);
        if (typeof val === 'number') checkThresholds(nodeId, val);

        var chart = charts.get(nodeId);
        var dataArray = chartData.get(nodeId);
        if (chart && dataArray && typeof val === 'number' && !isNaN(val)) {
          var time = new Date(timestamp).toLocaleTimeString();
          dataArray.push({ time: time, value: val });
          if (dataArray.length > MAX_DATA_POINTS) dataArray.shift();
          chart.data.labels = dataArray.map(function(d) { return d.time; });
          chart.data.datasets[0].data = dataArray.map(function(d) { return d.value; });
          chart.update('none');
        }
      }
    } catch (err) { console.error('[APP] Error:', err); }
  });
}

setupDataChangeListener();

// ─── Connect / Disconnect ─────────────────────────────────────────────────────
if (connectBtn) {
  connectBtn.addEventListener('click', async function() {
    if (isConnected) { await disconnect(); } else { await connect(); }
  });
} else {
  console.error('[APP] connectBtn not found in DOM — check index.html for id="connectBtn"');
}

async function connect() {
  var endpoint = endpointInput.value.trim();
  var username = usernameInput.value.trim() || null;
  var password = passwordInput.value.trim() || null;
  autoSavePath = autoSavePathInput.value.trim();
  if (!endpoint) { alert('Please enter an OPC UA endpoint'); return; }
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting...';
  try {
    var result = await window.opcua.connect(endpoint, username, password);
    if (result.success) {
      isConnected = true;
      statusIndicator.className = 'w-3 h-3 rounded-full bg-green-500';
      statusText.textContent = 'Connected';
      connectBtn.textContent = 'Disconnect';
      connectBtn.className = 'btn btn-danger';
      connectBtn.style.width = '100%';
      endpointInput.disabled = true;
      usernameInput.disabled = true;
      passwordInput.disabled = true;
      disconnectedState.classList.add('hidden');
      mainContent.classList.remove('hidden');
      if (autoSavePath) startAutoSave();
      nodeTree.innerHTML = '';
      nodeTree.removeAttribute('data-loaded');
      await browseNode('i=85', nodeTree);
      closeConnectionModal(endpoint); // collapse to thin bar now that we're connected
    } else {
      alert('Connection failed: ' + result.message);
      connectBtn.textContent = 'Connect';
    }
  } catch (error) {
    alert('Error: ' + error.message);
    connectBtn.textContent = 'Connect';
  }
  connectBtn.disabled = false;
}

async function disconnect() {
  if (isMonitoring) await stopMonitoring();
  stopAutoSave();
  await window.opcua.disconnect();
  isConnected = false;
  statusIndicator.className = 'w-3 h-3 rounded-full bg-gray-600';
  statusText.textContent = 'Disconnected';
  connectBtn.textContent = 'Connect';
  connectBtn.className = 'btn btn-primary';
  connectBtn.style.width = '100%';
  endpointInput.disabled = false;
  usernameInput.disabled = false;
  passwordInput.disabled = false;
  mainContent.classList.add('hidden');
  disconnectedState.classList.remove('hidden');
  nodeTree.innerHTML = '';
  nodeTree.removeAttribute('data-loaded');
  controlPanel.classList.add('hidden');
  emptyState.classList.remove('hidden');
  tableSection.style.display = 'none';
  graphsSection.style.display = 'none';
  selectedNodes = [];
  signalVisibility.clear();
  signalStats.clear();
  previousValues.clear();
  _alarmActive.clear();
  monitorBtn.disabled = false;
  monitorBtn.textContent = 'Start';
  monitorBtn.className = 'btn btn-success';
  updateConnectionBar(false, null);
  openConnectionModal(); // reopen so the user can reconnect or change settings
}

// ─── Connection Modal open/close/collapse ─────────────────────────────────────
// Additive UI behavior: the connection inputs themselves (#endpoint, #username,
// etc.) are unchanged — only their container visibility is toggled, so connect()
// and disconnect() above keep working exactly as before.
var connectionModalEl = document.getElementById('connectionModal');
var connectionBarEl = document.getElementById('connectionBar');
var connectionBarDotEl = document.getElementById('connectionBarDot');
var connectionBarTextEl = document.getElementById('connectionBarText');
var connectionModalCloseBtnEl = document.getElementById('connectionModalCloseBtn');

function openConnectionModal() {
  if (connectionModalEl) { connectionModalEl.classList.remove('hidden'); connectionModalEl.style.display = 'flex'; }
  if (connectionModalCloseBtnEl) connectionModalCloseBtnEl.style.display = isConnected ? 'inline-block' : 'none';
}

function closeConnectionModal(endpointLabel) {
  if (connectionModalEl) { connectionModalEl.classList.add('hidden'); connectionModalEl.style.display = 'none'; }
  updateConnectionBar(true, endpointLabel);
}

function updateConnectionBar(connected, endpointLabel) {
  if (!connectionBarDotEl || !connectionBarTextEl) return;
  if (connected) {
    connectionBarDotEl.style.backgroundColor = '#22c55e';
    connectionBarTextEl.textContent = endpointLabel || 'Connected';
  } else {
    connectionBarDotEl.style.backgroundColor = '#4b5563';
    connectionBarTextEl.textContent = 'Not connected — click to set up';
  }
}

if (connectionBarEl) {
  connectionBarEl.addEventListener('click', function() { openConnectionModal(); });
}
if (connectionModalCloseBtnEl) {
  connectionModalCloseBtnEl.addEventListener('click', function() {
    if (isConnected) closeConnectionModal(endpointInput.value.trim());
  });
}
// Stop backdrop clicks from bubbling — prevents the overlay from swallowing
// button clicks inside the modal box.
if (connectionModalEl) {
  connectionModalEl.addEventListener('click', function(e) {
    // Only close on backdrop click (not on the modal box itself)
    if (e.target === connectionModalEl && isConnected) {
      closeConnectionModal(endpointInput.value.trim());
    }
  });
  var modalBox = connectionModalEl.querySelector('.connection-modal-box');
  if (modalBox) modalBox.addEventListener('click', function(e) { e.stopPropagation(); });
}

// ─── Auto-save ────────────────────────────────────────────────────────────────
function startAutoSave() {
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(function() {
    if (isMonitoring && autoSavePath) saveHourlyCSV();
  }, 3600000);
}
function stopAutoSave() {
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
}
function saveHourlyCSV() {
  if (!autoSavePath) return;
  var csv = generateColumnCSV();
  var filename = 'opcua_' + new Date().toISOString().slice(0, 13).replace(/[:-]/g, '') + '.csv';
  if (window.opcua.saveFile) window.opcua.saveFile(autoSavePath, filename, csv);
}

function generateColumnCSV() {
  var allSignals = getAllMonitoredSignals();
  if (allSignals.length === 0) return '';
  var allTimestamps = new Set();
  allSignals.forEach(function(signal) {
    var data = chartData.get(signal.nodeId) || [];
    data.forEach(function(d) { allTimestamps.add(d.time); });
  });
  var timestamps = Array.from(allTimestamps).sort();
  var header = 'Timestamp';
  allSignals.forEach(function(signal) { header += ',"' + signal.name.replace(/"/g, '""') + '"'; });
  var rows = [header];
  timestamps.forEach(function(ts) {
    var row = ts;
    allSignals.forEach(function(signal) {
      var data = chartData.get(signal.nodeId) || [];
      var point = data.find(function(d) { return d.time === ts; });
      row += ',' + (point ? point.value : '');
    });
    rows.push(row);
  });
  return rows.join('\n');
}

function getAllMonitoredSignals() {
  var signals = [];
  var seen = new Set();
  pinnedSignals.forEach(function(s) { if (!seen.has(s.nodeId)) { signals.push(s); seen.add(s.nodeId); } });
  selectedNodes.forEach(function(s) { if (!seen.has(s.nodeId)) { signals.push(s); seen.add(s.nodeId); } });
  return signals;
}

// ─── Node browser ─────────────────────────────────────────────────────────────
async function browseNode(nodeId, containerElement, level) {
  level = level || 0;
  if (containerElement.dataset.loaded === nodeId) return;
  containerElement.dataset.loaded = nodeId;
  try {
    var result = await window.opcua.browse(nodeId);
    containerElement.innerHTML = '';

    // De-duplicate by nodeId. Some OPC UA servers expose the same child via
    // multiple reference types (e.g. Organizes + HasComponent both pointing
    // at the same target), so browse() can legitimately return the same
    // node more than once in a single response. Without this, folders like
    // HostSet/LocalServiceSet/ServiceSet repeat in the tree.
    var seenNodeIds = new Set();
    var dedupedNodes = [];
    for (var di = 0; di < result.nodes.length; di++) {
      var dn = result.nodes[di];
      if (seenNodeIds.has(dn.nodeId)) continue;
      seenNodeIds.add(dn.nodeId);
      dedupedNodes.push(dn);
    }

    for (var i = 0; i < dedupedNodes.length; i++) {
      var node = dedupedNodes[i];
      var nodeElement = document.createElement('div');
      nodeElement.style.marginLeft = (level * 12) + 'px';
      nodeElement.style.padding = '3px 6px';
      nodeElement.style.cursor = 'pointer';
      nodeElement.style.borderRadius = '3px';
      nodeElement.style.fontSize = '0.8rem';
      nodeElement.textContent = node.displayName || node.browseName;
      nodeElement.addEventListener('mouseover', function() { this.style.backgroundColor = '#374151'; });
      nodeElement.addEventListener('mouseout', function() { this.style.backgroundColor = 'transparent'; });
      var childContainer = document.createElement('div');
      childContainer.style.display = 'none';
      (function(n, el, cc, lv) {
        el.addEventListener('click', async function(e) {
          e.stopPropagation();
          var cls = Number(n.nodeClass);
          if (cls === 2) {
            try {
              var res = await window.opcua.read(n.nodeId);
              var val = normalizeValue(res.value);
              selectedNodes = [{ nodeId: n.nodeId, name: (window.RTOM_PRIMARY_NAME ? '[' + window.RTOM_PRIMARY_NAME + '] ' : '') + n.displayName, value: val, statusCode: res.statusCode || 'Good', selected: true }];
              signalVisibility.set(n.nodeId, true);
              folderName.textContent = n.displayName;
              signalCount.textContent = '1 signal';
              updateSignalTable();
              emptyState.classList.add('hidden');
              controlPanel.classList.remove('hidden');
              tableSection.style.display = 'block';
              monitorBtn.disabled = false;
            } catch (err) { console.error('Read error:', err); }
            return;
          }
          if (cls === 1 || n.hasChildren) {
            if (el.classList.contains('expanded')) {
              el.classList.remove('expanded');
              cc.style.display = 'none';
            } else {
              el.classList.add('expanded');
              cc.style.display = 'block';
              if (!cc.dataset.loaded) await browseNode(n.nodeId, cc, lv + 1);
            }
            await selectFolder(n);
          }
        });
      })(node, nodeElement, childContainer, level);
      containerElement.appendChild(nodeElement);
      containerElement.appendChild(childContainer);
    }
  } catch (error) { console.error('Browse error:', error); }
}

async function selectFolder(node) {
  try {
    var result = await window.opcua.browse(node.nodeId);

    // Same de-duplication as browseNode() — a server can return the same
    // child node via multiple reference types in one browse response.
    var seenNodeIds = new Set();
    var dedupedResultNodes = [];
    for (var di = 0; di < result.nodes.length; di++) {
      var dn = result.nodes[di];
      if (seenNodeIds.has(dn.nodeId)) continue;
      seenNodeIds.add(dn.nodeId);
      dedupedResultNodes.push(dn);
    }

    var variables = [];
    for (var i = 0; i < dedupedResultNodes.length; i++) {
      var child = dedupedResultNodes[i];
      if (Number(child.nodeClass) === 2) {
        try {
          var readResult = await window.opcua.read(child.nodeId);
          var val = normalizeValue(readResult.value);
          if (typeof val === 'number' || typeof val === 'boolean') {
            variables.push({ nodeId: child.nodeId, displayName: child.displayName, browseName: child.browseName, value: val, statusCode: readResult.statusCode || 'Good' });
          }
        } catch (e) {}
      }
    }
    if (variables.length === 0) { console.log('[APP] No numeric signals in:', node.displayName); return; }
    folderName.textContent = node.displayName;
    signalCount.textContent = variables.length + ' signals';
    selectedNodes = variables.map(function(v) {
      signalVisibility.set(v.nodeId, true);
      return { nodeId: v.nodeId, name: (window.RTOM_PRIMARY_NAME ? '[' + window.RTOM_PRIMARY_NAME + '] ' : '') + (v.displayName || v.browseName || v.nodeId), value: v.value, selected: true, statusCode: v.statusCode || 'Good' };
    });
    selectAllCheckbox.checked = true;
    updateSignalTable();
    emptyState.classList.add('hidden');
    controlPanel.classList.remove('hidden');
    tableSection.style.display = 'block';
    monitorBtn.disabled = false;
    if (isMonitoring) recreateCurrentFolderGraphs();
  } catch (err) { console.error('Select folder error:', err); }
}

function updateSignalTable() {
  signalTable.innerHTML = '';
  for (var i = 0; i < selectedNodes.length; i++) {
    var signal = selectedNodes[i];
    var row = document.createElement('tr');
    var checkCell = document.createElement('td');
    checkCell.className = 'checkbox-cell';
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'show-checkbox';
    checkbox.checked = signalVisibility.get(signal.nodeId) !== false;
    checkbox.dataset.nodeId = signal.nodeId;
    checkbox.addEventListener('change', function() {
      signalVisibility.set(this.dataset.nodeId, this.checked);
      updateGraphVisibility(this.dataset.nodeId, this.checked);
    });
    checkCell.appendChild(checkbox);
    row.appendChild(checkCell);

    var pinCell = document.createElement('td');
    pinCell.className = 'checkbox-cell';
    var pinCb = document.createElement('input');
    pinCb.type = 'checkbox';
    pinCb.className = 'pin-checkbox';
    pinCb.checked = isPinned(signal.nodeId);
    pinCb.dataset.nodeId = signal.nodeId;
    pinCb.dataset.name = signal.name;
    pinCb.addEventListener('change', function() { togglePin(this.dataset.nodeId, this.dataset.name, 0); });
    pinCell.appendChild(pinCb);
    row.appendChild(pinCell);

    var nameCell = document.createElement('td');
    nameCell.textContent = signal.name;
    nameCell.style.maxWidth = '150px';
    nameCell.style.overflow = 'hidden';
    nameCell.style.textOverflow = 'ellipsis';
    nameCell.title = signal.name;
    row.appendChild(nameCell);

    var valueCell = document.createElement('td');
    valueCell.style.fontFamily = 'monospace';
    valueCell.style.fontWeight = '600';
    valueCell.style.color = '#4ade80';
    valueCell.id = 'value-' + safeId(signal.nodeId);
    var rawVal = normalizeValue(signal.value);
    valueCell.textContent = typeof rawVal === 'number' ? rawVal.toFixed(2) : '-';
    row.appendChild(valueCell);

    var statusCell = document.createElement('td');
    statusCell.textContent = signal.statusCode || 'Good';
    statusCell.style.color = '#9ca3af';
    row.appendChild(statusCell);

    signalTable.appendChild(row);
  }
}

// ─── Monitor start/stop ───────────────────────────────────────────────────────
monitorBtn.addEventListener('click', async function() {
  try {
    var allSignals = getAllMonitoredSignals();
    var nodeIds = allSignals.map(function(s) { return s.nodeId; });
    var nodeNames = allSignals.map(function(s) { return s.name; });
    if (nodeIds.length === 0) { alert('Select at least one signal'); return; }

    setupDataChangeListener();
    graphsContainer.innerHTML = '';
    pinnedContainer.innerHTML = '';
    graphValueElements.clear();
    signalStats.clear();
    previousValues.clear();
    _alarmActive.clear();
    graphsSection.style.display = 'block';

    pinnedSignals.forEach(function(signal, idx) { createPinnedChart(signal, idx); });
    selectedNodes.forEach(function(signal, idx) {
      if (!isPinned(signal.nodeId)) createChart(signal, idx, false);
    });
    updatePinnedCount();

    var result = await window.opcua.subscribe(nodeIds, nodeNames, currentSamplingInterval);
    if (!result.success) { alert('Subscribe failed: ' + result.message); return; }

    isMonitoring = true;
    monitorBtn.disabled = true;
    monitorBtn.textContent = 'Running...';
    monitorBtn.className = 'btn btn-secondary';
    stopMonitorBtn.disabled = false;

    // Show sampling rate in UI
    var rateLabel = document.getElementById('samplingRateLabel');
    if (rateLabel) rateLabel.textContent = (currentSamplingInterval >= 1000 ? (currentSamplingInterval / 1000) + 's' : currentSamplingInterval + 'ms') + ' rate';
  } catch (err) {
    console.error('Start error:', err);
    alert('Error: ' + err.message);
  }
});

function recreateCurrentFolderGraphs() {
  graphsContainer.innerHTML = '';
  selectedNodes.forEach(function(signal, idx) {
    if (!isPinned(signal.nodeId)) createChart(signal, idx, false);
  });
  var allSignals = getAllMonitoredSignals();
  window.opcua.subscribe(allSignals.map(function(s) { return s.nodeId; }), allSignals.map(function(s) { return s.name; }), currentSamplingInterval);
}

stopMonitorBtn.addEventListener('click', async function() { await stopMonitoring(); });

async function stopMonitoring() {
  try {
    await window.opcua.unsubscribe();
    charts.forEach(function(chart) { chart.destroy(); });
    charts.clear();
    chartData.clear();
    graphValueElements.clear();
    graphsContainer.innerHTML = '';
    pinnedContainer.innerHTML = '';
    graphsSection.style.display = 'none';
    isMonitoring = false;
    monitorBtn.disabled = false;
    monitorBtn.textContent = 'Start';
    monitorBtn.className = 'btn btn-success';
    stopMonitorBtn.disabled = true;
    var rateLabel = document.getElementById('samplingRateLabel');
    if (rateLabel) rateLabel.textContent = '';
  } catch (err) { console.error('Stop error:', err); }
}

// ─── Chart creation ───────────────────────────────────────────────────────────
function createPinnedChart(signal, colorIndex) { createChart(signal, colorIndex, true); }

function createChart(signal, colorIndex, isPinnedChart) {
  if (typeof Chart === 'undefined') { alert('Chart.js not loaded!'); return; }
  var elemId = safeId(signal.nodeId);
  var isVisible = signalVisibility.get(signal.nodeId) !== false;
  var container = isPinnedChart ? pinnedContainer : graphsContainer;

  var chartContainer = document.createElement('div');
  chartContainer.className = 'graph-card' + (isPinnedChart ? ' pinned' : '');
  chartContainer.id = (isPinnedChart ? 'pinned-' : 'graph-container-') + elemId;
  chartContainer.style.display = isVisible ? 'block' : 'none';
  chartContainer.dataset.nodeId = signal.nodeId;
  chartContainer.dataset.name = signal.name;

  var header = document.createElement('div');
  header.className = 'graph-header';
  var title = document.createElement('div');
  title.className = 'graph-title';
  title.textContent = signal.name;
  title.title = signal.name;
  header.appendChild(title);

  var actions = document.createElement('div');
  actions.className = 'graph-actions';

  var thresholdWrap = document.createElement('div');
  thresholdWrap.className = 'threshold-mini';
  thresholdWrap.innerHTML = '<input type="number" class="thresh-input" placeholder="Min" id="thresh-min-' + elemId + '" title="Min threshold">' +
                            '<input type="number" class="thresh-input" placeholder="Max" id="thresh-max-' + elemId + '" title="Max threshold">';
  actions.appendChild(thresholdWrap);

  var existingThreshold = signalThresholds.get(signal.nodeId);
  setTimeout(function() {
    var minInput = document.getElementById('thresh-min-' + elemId);
    var maxInput = document.getElementById('thresh-max-' + elemId);
    if (existingThreshold) {
      if (minInput && existingThreshold.min !== undefined) minInput.value = existingThreshold.min;
      if (maxInput && existingThreshold.max !== undefined) maxInput.value = existingThreshold.max;
    }
    if (minInput) {
      minInput.addEventListener('change', function() {
        var thresh = signalThresholds.get(signal.nodeId) || {};
        thresh.min = this.value ? parseFloat(this.value) : null;
        signalThresholds.set(signal.nodeId, thresh);
      });
      minInput.addEventListener('click', function(e) { e.stopPropagation(); });
    }
    if (maxInput) {
      maxInput.addEventListener('change', function() {
        var thresh = signalThresholds.get(signal.nodeId) || {};
        thresh.max = this.value ? parseFloat(this.value) : null;
        signalThresholds.set(signal.nodeId, thresh);
      });
      maxInput.addEventListener('click', function(e) { e.stopPropagation(); });
    }
  }, 50);

  var pinBtn = document.createElement('button');
  pinBtn.className = isPinned(signal.nodeId) ? 'btn btn-warning btn-sm pin-btn' : 'btn btn-secondary btn-sm pin-btn';
  pinBtn.textContent = isPinned(signal.nodeId) ? 'Unpin' : 'Pin';
  pinBtn.dataset.nodeId = signal.nodeId;
  pinBtn.onclick = function(e) { e.stopPropagation(); togglePin(signal.nodeId, signal.name, signal.value); };
  actions.appendChild(pinBtn);
  header.appendChild(actions);
  chartContainer.appendChild(header);

  chartContainer.addEventListener('click', function(e) {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
    openZoomModal(signal.nodeId, signal.name);
  });

  var valueRow = document.createElement('div');
  valueRow.className = 'graph-value-row';
  var valueDisplay = document.createElement('div');
  valueDisplay.className = 'graph-value';
  valueDisplay.innerHTML = (typeof signal.value === 'number' ? signal.value.toFixed(2) : '-') + ' <span class="graph-arrow arrow-stable">―</span>';
  valueRow.appendChild(valueDisplay);
  chartContainer.appendChild(valueRow);
  graphValueElements.set(signal.nodeId, valueDisplay);

  var statsRow = document.createElement('div');
  statsRow.className = 'graph-stats';
  statsRow.id = 'stats-' + elemId;
  statsRow.innerHTML = '<span class="stat-min">Min: -</span><span class="stat-max">Max: -</span><span class="stat-avg">Avg: -</span>';
  chartContainer.appendChild(statsRow);

  var canvas = document.createElement('canvas');
  canvas.id = 'chart-' + elemId;
  canvas.style.height = '80px';
  canvas.style.maxHeight = '80px';
  chartContainer.appendChild(canvas);
  container.appendChild(chartContainer);

  var ctx = canvas.getContext('2d');
  var color = colors[colorIndex % colors.length];
  var existingData = chartData.get(signal.nodeId) || [];

  var chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: existingData.map(function(d) { return d.time; }),
      datasets: [{ label: signal.name, data: existingData.map(function(d) { return d.value; }), borderColor: color, backgroundColor: color + '30', borderWidth: 2, tension: 0.3, fill: true, pointRadius: 0 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { display: true, ticks: { color: '#6b7280', maxTicksLimit: 4, font: { size: 8 } }, grid: { color: '#374151' } },
        y: { display: true, ticks: { color: '#6b7280', font: { size: 8 } }, grid: { color: '#374151' } }
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    }
  });

  charts.set(signal.nodeId, chart);
  if (!chartData.has(signal.nodeId)) {
    var initialData = [];
    if (typeof signal.value === 'number') initialData.push({ time: new Date().toLocaleTimeString(), value: signal.value });
    chartData.set(signal.nodeId, initialData);
  }
}

// ─── Zoom Modal ───────────────────────────────────────────────────────────────
function openZoomModal(nodeId, name) {
  var data = chartData.get(nodeId) || [];
  var stats = signalStats.get(nodeId);
  var chart = charts.get(nodeId);
  var color = chart ? chart.data.datasets[0].borderColor : '#3b82f6';
  zoomTitle.textContent = name;
  zoomStats.innerHTML = stats ?
    '<span style="color:#60a5fa">Min: ' + stats.min.toFixed(2) + '</span>' +
    '<span style="color:#f87171">Max: ' + stats.max.toFixed(2) + '</span>' +
    '<span style="color:#a78bfa">Avg: ' + stats.avg.toFixed(2) + '</span>' +
    '<span style="color:#9ca3af">Points: ' + stats.count + '</span>' : '';
  zoomModal.classList.remove('hidden');
  if (zoomChart) zoomChart.destroy();
  var ctx = document.getElementById('zoomChart').getContext('2d');
  zoomChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(function(d) { return d.time; }),
      datasets: [{ label: name, data: data.map(function(d) { return d.value; }), borderColor: color, backgroundColor: color + '30', borderWidth: 2, tension: 0.3, fill: true, pointRadius: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: {
        x: { ticks: { color: '#9ca3af', maxTicksLimit: 10 }, grid: { color: '#374151' } },
        y: { ticks: { color: '#9ca3af' }, grid: { color: '#374151' } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

zoomClose.addEventListener('click', function() { zoomModal.classList.add('hidden'); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { zoomModal.classList.add('hidden'); closeHistorianModal(); if (typeof closeEventModal === 'function' && eventModalOpen) closeEventModal(); if (typeof isConnected !== 'undefined' && isConnected && typeof closeConnectionModal === 'function') closeConnectionModal(endpointInput.value.trim()); } });

// ─── Export image ─────────────────────────────────────────────────────────────
exportImgBtn.addEventListener('click', function() {
  var visibleCharts = [];
  charts.forEach(function(chart, nodeId) {
    if (signalVisibility.get(nodeId) !== false || isPinned(nodeId)) {
      var signal = pinnedSignals.find(function(s) { return s.nodeId === nodeId; }) || selectedNodes.find(function(s) { return s.nodeId === nodeId; });
      var stats = signalStats.get(nodeId);
      if (signal) visibleCharts.push({ chart: chart, name: signal.name, value: graphValueElements.get(nodeId)?.textContent || '-', stats: stats });
    }
  });
  if (visibleCharts.length === 0) { alert('No visible charts'); return; }
  var chartWidth = 380, chartHeight = 200;
  var cols = Math.min(3, visibleCharts.length);
  var rows = Math.ceil(visibleCharts.length / cols);
  var padding = 10;
  var combinedCanvas = document.createElement('canvas');
  combinedCanvas.width = cols * chartWidth + (cols + 1) * padding;
  combinedCanvas.height = rows * chartHeight + (rows + 1) * padding + 40;
  var ctx = combinedCanvas.getContext('2d');
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  ctx.fillStyle = '#f3f4f6';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('OPC UA Monitor - ' + new Date().toLocaleString(), padding, 25);
  visibleCharts.forEach(function(item, idx) {
    var col = idx % cols;
    var row = Math.floor(idx / cols);
    var x = padding + col * (chartWidth + padding);
    var y = 40 + padding + row * (chartHeight + padding);
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(x, y, chartWidth, chartHeight);
    ctx.fillStyle = '#e5e7eb';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(item.name, x + 10, y + 18);
    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 18px monospace';
    ctx.fillText(item.value.split(' ')[0], x + 10, y + 42);
    if (item.stats) {
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#60a5fa'; ctx.fillText('Min:' + item.stats.min.toFixed(1), x + 10, y + 58);
      ctx.fillStyle = '#f87171'; ctx.fillText('Max:' + item.stats.max.toFixed(1), x + 80, y + 58);
      ctx.fillStyle = '#a78bfa'; ctx.fillText('Avg:' + item.stats.avg.toFixed(1), x + 150, y + 58);
    }
    ctx.drawImage(item.chart.canvas, x + 5, y + 65, chartWidth - 10, chartHeight - 75);
  });
  var link = document.createElement('a');
  link.download = 'opcua_snapshot_' + new Date().toISOString().slice(0, 19).replace(/[:-]/g, '') + '.png';
  link.href = combinedCanvas.toDataURL('image/png');
  link.click();
});

// ─── Export CSV ───────────────────────────────────────────────────────────────
exportCsvBtn.addEventListener('click', function() {
  var csv = generateColumnCSV();
  if (!csv) { alert('No data'); return; }
  var blob = new Blob([csv], { type: 'text/csv' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'opcua_data_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Clear ────────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', function() {
  chartData.forEach(function(data, nodeId) {
    chartData.set(nodeId, []);
    var chart = charts.get(nodeId);
    if (chart) { chart.data.labels = []; chart.data.datasets[0].data = []; chart.update(); }
  });
  signalStats.clear();
  document.querySelectorAll('.graph-stats').forEach(function(el) {
    el.innerHTML = '<span class="stat-min">Min: -</span><span class="stat-max">Max: -</span><span class="stat-avg">Avg: -</span>';
  });
});

// ─── Popout ───────────────────────────────────────────────────────────────────
popoutAllBtn.addEventListener('click', function() {
  var allSignals = getAllMonitoredSignals().filter(function(s) { return signalVisibility.get(s.nodeId) !== false || isPinned(s.nodeId); });
  if (allSignals.length === 0) { alert('No visible signals'); return; }
  var html = '<!DOCTYPE html><html><head><title>OPC UA Graphs</title>';
  html += '<style>*{box-sizing:border-box;}body{margin:0;padding:15px;background:#111827;color:#f3f4f6;font-family:sans-serif;}';
  html += '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;}';
  html += '.card{background:#1f2937;border-radius:6px;padding:10px;border:1px solid #374151;height:220px;overflow:hidden;}';
  html += '.title{font-size:0.8rem;font-weight:bold;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}';
  html += '.value{font-size:1.3rem;font-weight:bold;color:#4ade80;font-family:monospace;margin-bottom:3px;}';
  html += '.stats{font-size:0.7rem;color:#9ca3af;margin-bottom:5px;}';
  html += '.chart-wrap{height:130px;position:relative;}</style></head>';
  html += '<body><h3 style="margin-bottom:15px;">OPC UA Monitor</h3><div class="grid">';
  allSignals.forEach(function(signal, idx) {
    var val = graphValueElements.get(signal.nodeId)?.textContent || '-';
    var stats = signalStats.get(signal.nodeId);
    html += '<div class="card"><div class="title" title="' + signal.name + '">' + signal.name + '</div>';
    html += '<div class="value">' + val.split(' ')[0] + '</div>';
    html += '<div class="stats">' + (stats ? 'Min:' + stats.min.toFixed(1) + ' Max:' + stats.max.toFixed(1) + ' Avg:' + stats.avg.toFixed(1) : '') + '</div>';
    html += '<div class="chart-wrap"><canvas id="c' + idx + '"></canvas></div></div>';
  });
  html += '</div><script src="assets/chart.min.js"><\/script><script>';
  allSignals.forEach(function(signal, idx) {
    var data = chartData.get(signal.nodeId) || [];
    var chart = charts.get(signal.nodeId);
    var color = chart ? chart.data.datasets[0].borderColor : colors[idx % colors.length];
    html += 'new Chart(document.getElementById("c' + idx + '"),{type:"line",data:{labels:' + JSON.stringify(data.map(function(d){return d.time;})) + ',datasets:[{data:' + JSON.stringify(data.map(function(d){return d.value;})) + ',borderColor:"' + color + '",backgroundColor:"' + color + '30",borderWidth:2,tension:0.3,fill:true,pointRadius:0}]},options:{responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{ticks:{color:"#6b7280",maxTicksLimit:4},grid:{color:"#374151"}},y:{ticks:{color:"#6b7280"},grid:{color:"#374151"}}},plugins:{legend:{display:false}}}});';
  });
  html += '<\/script></body></html>';
  var win = window.open('', '_blank', 'width=1100,height=700');
  win.document.write(html);
  win.document.close();
});

// ─── Alarm Panel toggle ───────────────────────────────────────────────────────
var alarmPanelOpen = false;

document.getElementById('alarmPanelBtn').addEventListener('click', function() {
  var panel = document.getElementById('alarmPanel');
  alarmPanelOpen = !alarmPanelOpen;
  if (alarmPanelOpen) {
    panel.classList.remove('hidden');
    renderAlarmLog();
  } else {
    panel.classList.add('hidden');
  }
});

document.getElementById('alarmClearBtn').addEventListener('click', function() {
  alarmLog = [];
  _alarmActive.clear();
  renderAlarmLog();
  updateAlarmBadge();
});

document.getElementById('alarmCloseBtn').addEventListener('click', function() {
  document.getElementById('alarmPanel').classList.add('hidden');
  alarmPanelOpen = false;
});

// ─── Historian Modal ──────────────────────────────────────────────────────────
var historianChart = null;

document.getElementById('historianBtn').addEventListener('click', function() {
  openHistorianModal();
});

async function openHistorianModal() {
  var modal = document.getElementById('historianModal');
  modal.classList.remove('hidden');

  // Populate signal picker
  var select = document.getElementById('histSignalSelect');
  select.innerHTML = '<option value="">— All Signals —</option>';
  try {
    var result = await window.opcua.historian.getSignals();
    if (result.success && result.signals.length > 0) {
      result.signals.forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s.nodeId;
        opt.textContent = s.signalName || s.nodeId;
        select.appendChild(opt);
      });
    } else {
      var opt = document.createElement('option');
      opt.disabled = true;
      opt.textContent = 'No historian data found';
      select.appendChild(opt);
    }
  } catch (e) { console.error('getSignals error:', e); }

  // Default dates: today
  var today = new Date().toISOString().slice(0, 10);
  document.getElementById('histStartDate').value = today + 'T00:00';
  document.getElementById('histEndDate').value = today + 'T23:59';
}

function closeHistorianModal() {
  var modal = document.getElementById('historianModal');
  if (modal) modal.classList.add('hidden');
}

document.getElementById('histCloseBtn').addEventListener('click', closeHistorianModal);

document.getElementById('histLoadBtn').addEventListener('click', async function() {
  var nodeId = document.getElementById('histSignalSelect').value || null;
  var startVal = document.getElementById('histStartDate').value;
  var endVal = document.getElementById('histEndDate').value;
  if (!startVal || !endVal) { alert('Please select a date range'); return; }

  var startISO = new Date(startVal).toISOString();
  var endISO = new Date(endVal).toISOString();

  var statusEl = document.getElementById('histStatus');
  statusEl.textContent = 'Loading...';

  var result = await window.opcua.historian.getData(nodeId, startISO, endISO);
  if (!result.success) { statusEl.textContent = 'Error: ' + result.message; return; }

  var records = result.records;
  statusEl.textContent = records.length + ' records loaded';

  if (records.length === 0) {
    if (historianChart) { historianChart.destroy(); historianChart = null; }
    return;
  }

  // Group by signal for multi-signal display
  var signalGroups = new Map();
  records.forEach(function(r) {
    var key = r.nodeId;
    if (!signalGroups.has(key)) signalGroups.set(key, { name: r.signalName || r.nodeId, points: [] });
    signalGroups.get(key).points.push({ x: new Date(r.timestamp).toLocaleTimeString(), y: r.value });
  });

  var datasets = [];
  var colorIdx = 0;
  signalGroups.forEach(function(group) {
    datasets.push({
      label: group.name,
      data: group.points.map(function(p) { return p.y; }),
      borderColor: colors[colorIdx % colors.length],
      backgroundColor: colors[colorIdx % colors.length] + '30',
      borderWidth: 2,
      tension: 0.3,
      fill: false,
      pointRadius: records.length < 200 ? 2 : 0
    });
    colorIdx++;
  });

  // Use timestamps from first group as labels (best-effort for multi-signal)
  var firstGroup = signalGroups.values().next().value;
  var labels = firstGroup.points.map(function(p) { return p.x; });

  if (historianChart) { historianChart.destroy(); historianChart = null; }
  var ctx = document.getElementById('historianChart').getContext('2d');
  historianChart = new Chart(ctx, {
    type: 'line',
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: {
        x: { ticks: { color: '#9ca3af', maxTicksLimit: 12 }, grid: { color: '#374151' } },
        y: { ticks: { color: '#9ca3af' }, grid: { color: '#374151' } }
      },
      plugins: {
        legend: { display: signalGroups.size > 1, labels: { color: '#d1d5db' } },
        tooltip: { mode: 'index', intersect: false }
      }
    }
  });

  // Export historian CSV
  document.getElementById('histExportBtn').onclick = function() {
    var csv = 'Timestamp,NodeId,SignalName,Value,StatusCode\n';
    records.forEach(function(r) {
      csv += r.timestamp + ',' + r.nodeId + ',"' + (r.signalName || '').replace(/"/g, '""') + '",' + r.value + ',' + (r.statusCode || '') + '\n';
    });
    var blob = new Blob([csv], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'historian_export_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  };
});

// ─── Misc controls ────────────────────────────────────────────────────────────
if (stopMonitorBtn) stopMonitorBtn.disabled = true;

var toggleSignalsBtn = document.getElementById('toggleSignals');
if (toggleSignalsBtn) {
  toggleSignalsBtn.addEventListener('click', function() {
    var section = document.getElementById('tableSection');
    if (section.classList.contains('minimized')) {
      section.classList.remove('minimized');
      this.textContent = '▼';
      this.title = 'Minimize';
    } else {
      section.classList.add('minimized');
      this.textContent = '▶';
      this.title = 'Maximize';
    }
  });
}

// ─── Event Capture ("Black Box") ──────────────────────────────────────────────────────────────────────────────────
// Additive feature. Listens to window.eventCapture (separate bridge from
// window.opcua) and renders its own modal. Does not modify live graphs,
// thresholds, alarms, or historian behavior above.
var eventModalOpen = false;
var eventCapturesCache = [];
var eventActiveCapture = null;
var selectedEventId = null;
var eventReplayCharts = [];        // array of Chart.js instances, one per value-range group
var eventReplayData = null;        // { timeline, seriesByNode, nodeIds, groups: [{ nodeIds, label }] }
var eventReplayPlaying = false;
var eventReplayTimer = null;
var eventReplayIndex = 0;
var eventReplayMaxIndex = 0;

function updateEventBadge() {
  var badge = document.getElementById('eventBadge');
  if (!badge) return;
  if (eventActiveCapture) {
    badge.textContent = '●';
    badge.classList.remove('hidden');
    badge.classList.add('capturing');
  } else {
    var unackCount = eventCapturesCache.filter(function(c) { return !c.acknowledged; }).length;
    if (unackCount > 0) {
      badge.textContent = unackCount > 99 ? '99+' : unackCount;
      badge.classList.remove('hidden');
      badge.classList.remove('capturing');
    } else {
      badge.classList.add('hidden');
    }
  }
}

// Wire threshold inputs (already on each graph card) to also register an
// event-capture trigger threshold. This reuses the existing thresh-min/max
// inputs created in createChart() — additive listener, doesn't replace the
// existing 'change' handler that updates signalThresholds.
function wireEventThresholdMirror(nodeId, elemId) {
  var minInput = document.getElementById('thresh-min-' + elemId);
  var maxInput = document.getElementById('thresh-max-' + elemId);
  function pushThreshold() {
    var min = minInput && minInput.value ? parseFloat(minInput.value) : null;
    var max = maxInput && maxInput.value ? parseFloat(maxInput.value) : null;
    if (window.eventCapture) window.eventCapture.setThreshold(nodeId, min, max);
  }
  if (minInput) minInput.addEventListener('change', pushThreshold);
  if (maxInput) maxInput.addEventListener('change', pushThreshold);
}

// Hook into createChart's existing setTimeout-based input wiring by
// re-scanning for new threshold inputs whenever a chart is created.
// We do this via a lightweight MutationObserver-free approach: just
// call wireEventThresholdMirror right after monitorBtn starts monitoring.
var _origMonitorBtnListenerAdded = true; // marker only; no removal of existing listeners

function wireAllVisibleThresholdMirrors() {
  getAllMonitoredSignals().forEach(function(signal) {
    wireEventThresholdMirror(signal.nodeId, safeId(signal.nodeId));
  });
}

// Call once after monitoring starts (existing monitorBtn click handler above
// already creates the charts synchronously before this would run on next tick)
setTimeout(function() {
  if (monitorBtn) {
    monitorBtn.addEventListener('click', function() {
      setTimeout(wireAllVisibleThresholdMirrors, 200); // after charts + inputs exist
    });
  }
}, 0);

function renderEventList() {
  var list = document.getElementById('eventList');
  if (!list) return;
  list.innerHTML = '';

  if (eventActiveCapture) {
    var activeItem = document.createElement('div');
    activeItem.className = 'event-list-item';
    activeItem.style.borderColor = '#ef4444';
    activeItem.innerHTML =
      '<div class="event-list-item-title" style="color:#f87171;">\u25cf RECORDING\u2026</div>' +
      '<div class="event-list-item-meta">' + (eventActiveCapture.triggerSignalName || '') + ' — ' + (eventActiveCapture.triggerType || '') + '</div>';
    list.appendChild(activeItem);
  }

  if (eventCapturesCache.length === 0 && !eventActiveCapture) {
    var empty = document.createElement('div');
    empty.style.color = '#6b7280';
    empty.style.fontSize = '0.75rem';
    empty.style.padding = '1rem';
    empty.style.textAlign = 'center';
    empty.textContent = 'No captured events yet.';
    list.appendChild(empty);
    return;
  }

  eventCapturesCache.forEach(function(c) {
    var item = document.createElement('div');
    item.className = 'event-list-item' + (c.id === selectedEventId ? ' selected' : '') + (c.acknowledged ? ' acknowledged' : '');
    var typeLabel = c.triggerType === 'high' ? '\u25b2 HIGH' : '\u25bc LOW';
    var typeColor = c.triggerType === 'high' ? '#f87171' : '#60a5fa';
    var when = new Date(c.startedAtISO).toLocaleString();
    var html = '<div class="event-list-item-title">' + (c.triggerSignalName || c.id) + (c.acknowledged ? ' <span class="event-ack-tag">ACKNOWLEDGED</span>' : '') + '</div>';
    html += '<div class="event-list-item-meta">' + when + '</div>';
    html += '<div class="event-list-item-meta"><span style="color:' + typeColor + ';font-weight:600;">' + typeLabel + '</span> at ' + c.triggerValue + ' (limit ' + c.threshold + ')</div>';
    html += '<div class="event-list-item-meta">' + c.signalCount + ' signals captured</div>';
    if (c.matchedPatterns && c.matchedPatterns.length > 0) {
      c.matchedPatterns.forEach(function(p) {
        html += '<span class="event-pattern-tag">' + p.label + '</span>';
      });
    }
    html += '<div class="event-list-item-actions">' +
      (c.acknowledged ? '' : '<button class="event-ack-btn" data-id="' + c.id + '">Acknowledge</button>') +
      '<button class="event-clear-btn" data-id="' + c.id + '">Clear</button>' +
      '</div>';
    item.innerHTML = html;
    item.addEventListener('click', function(e) {
      if (e.target.classList.contains('event-ack-btn') || e.target.classList.contains('event-clear-btn')) return;
      selectEvent(c.id);
    });
    var ackBtn = item.querySelector('.event-ack-btn');
    if (ackBtn) ackBtn.addEventListener('click', function(e) { e.stopPropagation(); acknowledgeEvent(c.id); });
    var clearBtnEl = item.querySelector('.event-clear-btn');
    if (clearBtnEl) clearBtnEl.addEventListener('click', function(e) { e.stopPropagation(); clearEvent(c.id); });
    list.appendChild(item);
  });
}

async function acknowledgeEvent(id) {
  try {
    var result = await window.eventCapture.acknowledge(id);
    if (result.success) {
      var cached = eventCapturesCache.find(function(c) { return c.id === id; });
      if (cached) cached.acknowledged = true;
      renderEventList();
    }
  } catch (e) { console.error('[EVENT] acknowledge error:', e); }
}

async function clearEvent(id) {
  try {
    var result = await window.eventCapture.clear(id);
    if (result.success) {
      eventCapturesCache = eventCapturesCache.filter(function(c) { return c.id !== id; });
      if (selectedEventId === id) {
        selectedEventId = null;
        document.getElementById('eventDetailContent').classList.add('hidden');
        document.getElementById('eventEmptyState').classList.remove('hidden');
      }
      renderEventList();
      updateEventBadge();
    }
  } catch (e) { console.error('[EVENT] clear error:', e); }
}

async function refreshEventCaptures() {
  if (!window.eventCapture) return;
  try {
    var result = await window.eventCapture.getCaptures();
    if (result.success) {
      eventCapturesCache = result.captures || [];
      eventActiveCapture = result.active || null;
      renderEventList();
      updateEventBadge();
    }
  } catch (e) { console.error('[EVENT] refreshEventCaptures error:', e); }
}

async function selectEvent(id) {
  selectedEventId = id;
  renderEventList();
  try {
    var result = await window.eventCapture.getCaptureDetail(id);
    if (!result.success) return;
    showEventDetail(result.capture);
  } catch (e) { console.error('[EVENT] selectEvent error:', e); }
}

function showEventDetail(capture) {
  document.getElementById('eventEmptyState').classList.add('hidden');
  document.getElementById('eventDetailContent').classList.remove('hidden');

  var title = document.getElementById('eventDetailTitle');
  var meta = document.getElementById('eventDetailMeta');
  var patternsEl = document.getElementById('eventDetailPatterns');

  title.textContent = (capture.triggerSignalName || capture.id) + ' — ' + (capture.triggerType === 'high' ? 'High' : 'Low') + ' threshold breach';
  meta.textContent = 'Triggered ' + new Date(capture.startedAtISO).toLocaleString() +
    '  |  Value ' + capture.triggerValue + ' vs limit ' + capture.threshold +
    '  |  Window: ' + capture.preSeconds + 's before / ' + capture.postSeconds + 's after';

  patternsEl.innerHTML = '';
  if (capture.matchedPatterns && capture.matchedPatterns.length > 0) {
    capture.matchedPatterns.forEach(function(p) {
      var tag = document.createElement('span');
      tag.className = 'event-pattern-tag';
      tag.textContent = p.label;
      patternsEl.appendChild(tag);
    });
  } else {
    var tag = document.createElement('span');
    tag.className = 'event-pattern-tag';
    tag.style.background = '#374151';
    tag.style.color = '#9ca3af';
    tag.textContent = 'No rule-based pattern matched';
    patternsEl.appendChild(tag);
  }

  buildReplayData(capture);
  renderReplayChart(0);

  document.getElementById('eventExportBtn').onclick = function() { exportFaultPackage(capture.id); };
}

function buildReplayData(capture) {
  // Merge all signal series into a common, sorted timeline.
  // IMPORTANT: each signal's samples arrive with independent sourceTimestamps
  // (millisecond-level), so raw timestamp strings almost never match across
  // signals. We bucket every sample to its nearest second so all signals
  // align on the same set of timeline points — this is what makes the
  // replay chart actually draw lines instead of mostly-null data.
  function bucketKey(isoTs) {
    var d = new Date(isoTs);
    d.setMilliseconds(0);
    return d.toISOString();
  }

  var allBucketKeys = new Set();
  var seriesByNode = {};
  var rangeByNode = {}; // nodeId -> { min, max, signalName }

  Object.keys(capture.signals).forEach(function(nodeId) {
    var sig = capture.signals[nodeId];
    var valueByBucket = {};
    var min = Infinity, max = -Infinity;
    sig.points.forEach(function(p) {
      valueByBucket[bucketKey(p.timestamp)] = p.value; // latest sample wins if duplicate bucket
      allBucketKeys.add(bucketKey(p.timestamp));
      if (typeof p.value === 'number') {
        if (p.value < min) min = p.value;
        if (p.value > max) max = p.value;
      }
    });
    seriesByNode[nodeId] = valueByBucket;
    rangeByNode[nodeId] = { min: min, max: max, signalName: sig.signalName || nodeId };
  });

  var timeline = Array.from(allBucketKeys).sort(function(a, b) { return new Date(a) - new Date(b); });

  // ─── Cluster signals into groups by value-range similarity ─────────────────
  // Heuristic (no unit metadata available from OPC UA): two signals are
  // considered "the same kind of quantity" if their value ranges overlap or
  // sit within roughly one order of magnitude of each other. This keeps
  // e.g. CurrentLoad/MaxLoad/MinLoad together (all ~0.8-1.05) while putting
  // something like Voltage (~0-480) on its own chart.
  var nodeIds = Object.keys(rangeByNode);
  var groups = []; // [{ nodeIds: [...], lo, hi }]

  function rangesCompatible(a, b) {
    var aLo = a.min, aHi = a.max, bLo = b.min, bHi = b.max;
    if (!isFinite(aLo) || !isFinite(bLo)) return true; // no numeric data yet, don't split
    var aSpan = Math.max(Math.abs(aHi), Math.abs(aLo), 1e-9);
    var bSpan = Math.max(Math.abs(bHi), Math.abs(bLo), 1e-9);
    var ratio = aSpan > bSpan ? aSpan / bSpan : bSpan / aSpan;
    // Overlapping ranges -> definitely compatible. Otherwise allow up to ~10x
    // magnitude difference before splitting onto a separate chart.
    var overlap = aLo <= bHi && bLo <= aHi;
    return overlap || ratio <= 10;
  }

  nodeIds.forEach(function(nodeId) {
    var r = rangeByNode[nodeId];
    var placed = false;
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (rangesCompatible({ min: g.lo, max: g.hi }, r)) {
        g.nodeIds.push(nodeId);
        g.lo = Math.min(g.lo, r.min);
        g.hi = Math.max(g.hi, r.max);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ nodeIds: [nodeId], lo: r.min, hi: r.max });
    }
  });

  var groupDescriptors = groups.map(function(g) {
    var names = g.nodeIds.map(function(id) { return rangeByNode[id].signalName; });
    return { nodeIds: g.nodeIds, label: names.join(', ') };
  });

  eventReplayData = {
    timeline: timeline,
    seriesByNode: seriesByNode,
    rangeByNode: rangeByNode,
    nodeIds: nodeIds,
    groups: groupDescriptors
  };
  eventReplayMaxIndex = Math.max(0, timeline.length - 1);
  eventReplayIndex = 0;

  var slider = document.getElementById('eventReplaySlider');
  slider.min = 0;
  slider.max = eventReplayMaxIndex;
  slider.value = 0;

  // Build the DOM: one card + canvas per group, replacing previous content
  var wrap = document.getElementById('eventReplayChartWrap');
  eventReplayCharts.forEach(function(c) { c.destroy(); });
  eventReplayCharts = [];
  wrap.innerHTML = '';

  groupDescriptors.forEach(function(group, gIdx) {
    var card = document.createElement('div');
    card.className = 'event-replay-group';
    var title = document.createElement('div');
    title.className = 'event-replay-group-title';
    title.textContent = '📊 ' + group.label;
    card.appendChild(title);
    var canvasWrap = document.createElement('div');
    canvasWrap.className = 'event-replay-group-canvas-wrap';
    var canvas = document.createElement('canvas');
    canvas.id = 'eventReplayCanvas_' + gIdx;
    canvasWrap.appendChild(canvas);
    card.appendChild(canvasWrap);
    wrap.appendChild(card);
  });
}

function renderReplayChart(uptoIndex) {
  if (!eventReplayData) return;
  uptoIndex = Math.max(0, Math.min(uptoIndex, eventReplayMaxIndex));
  eventReplayIndex = uptoIndex;

  var labels = eventReplayData.timeline.slice(0, uptoIndex + 1).map(function(ts) {
    return new Date(ts).toLocaleTimeString();
  });

  eventReplayData.groups.forEach(function(group, gIdx) {
    var datasets = group.nodeIds.map(function(nodeId, i) {
      var series = eventReplayData.seriesByNode[nodeId];
      var range = eventReplayData.rangeByNode[nodeId];
      var colorIdx = eventReplayData.nodeIds.indexOf(nodeId);
      var data = eventReplayData.timeline.slice(0, uptoIndex + 1).map(function(ts) {
        return Object.prototype.hasOwnProperty.call(series, ts) ? series[ts] : null;
      });
      return {
        label: range.signalName,
        data: data,
        borderColor: colors[colorIdx % colors.length],
        backgroundColor: colors[colorIdx % colors.length] + '30',
        borderWidth: 2,
        tension: 0.3,
        fill: false,
        pointRadius: 2,
        spanGaps: true
      };
    });

    var existing = eventReplayCharts[gIdx];
    if (existing) {
      existing.data.labels = labels;
      existing.data.datasets = datasets;
      existing.update('none');
    } else {
      var canvas = document.getElementById('eventReplayCanvas_' + gIdx);
      if (!canvas) return;
      var ctx = canvas.getContext('2d');
      eventReplayCharts[gIdx] = new Chart(ctx, {
        type: 'line',
        data: { labels: labels, datasets: datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: {
            x: { ticks: { color: '#9ca3af', maxTicksLimit: 8, font: { size: 9 } }, grid: { color: '#374151' } },
            y: { ticks: { color: '#9ca3af', font: { size: 9 } }, grid: { color: '#374151' } }
          },
          plugins: {
            legend: { display: datasets.length > 1, labels: { color: '#d1d5db', font: { size: 9 } } },
            tooltip: { mode: 'index', intersect: false }
          }
        }
      });
    }
  });

  var slider = document.getElementById('eventReplaySlider');
  slider.value = uptoIndex;
  var timeLabel = document.getElementById('eventReplayTimeLabel');
  var currentTs = eventReplayData.timeline[uptoIndex];
  timeLabel.textContent = currentTs ? new Date(currentTs).toLocaleTimeString() : '--:--:--';
}

document.getElementById('eventReplaySlider').addEventListener('input', function() {
  stopReplayPlayback();
  renderReplayChart(parseInt(this.value, 10));
});

function stopReplayPlayback() {
  eventReplayPlaying = false;
  if (eventReplayTimer) { clearInterval(eventReplayTimer); eventReplayTimer = null; }
  var btn = document.getElementById('eventPlayBtn');
  if (btn) btn.textContent = '\u25b6\ufe0f Play';
}

document.getElementById('eventPlayBtn').addEventListener('click', function() {
  if (eventReplayPlaying) { stopReplayPlayback(); return; }
  if (!eventReplayData) return;
  eventReplayPlaying = true;
  this.textContent = '\u23f8\ufe0f Pause';
  if (eventReplayIndex >= eventReplayMaxIndex) eventReplayIndex = 0; // restart if at end
  eventReplayTimer = setInterval(function() {
    eventReplayIndex++;
    if (eventReplayIndex > eventReplayMaxIndex) { stopReplayPlayback(); return; }
    renderReplayChart(eventReplayIndex);
  }, 150); // playback speed: ~6.7 steps/sec
});

async function exportFaultPackage(id) {
  try {
    var result = await window.eventCapture.exportPackage(id, null); // null -> default historian/events folder
    if (result.success) {
      alert('Fault package exported:\n' + result.jsonPath + '\n' + result.csvPath);
    } else {
      alert('Export failed: ' + result.message);
    }
  } catch (e) {
    alert('Export error: ' + e.message);
  }
}

function openEventModal() {
  document.getElementById('eventModal').classList.remove('hidden');
  eventModalOpen = true;
  refreshEventCaptures();
}

function closeEventModal() {
  document.getElementById('eventModal').classList.add('hidden');
  eventModalOpen = false;
  stopReplayPlayback();
}

document.getElementById('eventPanelBtn').addEventListener('click', function() {
  if (eventModalOpen) closeEventModal(); else openEventModal();
});
document.getElementById('eventCloseBtn').addEventListener('click', closeEventModal);

// Live updates while connected: poll capture list periodically (lightweight;
// only hits IPC, doesn't touch the OPC UA session) and react to push events.
if (window.eventCapture) {
  window.eventCapture.onCaptureStarted(function(payload) {
    eventActiveCapture = payload;
    updateEventBadge();
    if (eventModalOpen) renderEventList();
    console.log('[EVENT] Capture started:', payload.triggerSignalName, payload.triggerType, payload.triggerValue);
  });
  window.eventCapture.onCaptureFinished(function(payload) {
    eventActiveCapture = null;
    refreshEventCaptures();
    console.log('[EVENT] Capture finished:', payload.triggerSignalName, 'patterns:', (payload.matchedPatterns || []).map(function(p){return p.id;}).join(',') || 'none');
  });
}
setInterval(function() { if (isConnected) refreshEventCaptures(); }, 5000);

// Push live state to mobile API server every 2 seconds — always, not just when connected
setInterval(function() { syncMobileState(); }, 2000);

// Also sync on connect/disconnect
var _origConnect = connect;
var _origDisconnect = disconnect;

// ─── RTOM Assistant (Tier 1: rule-based intent matcher) ─────────────────────────────────────
// Understands natural-language questions about live signal values, thresholds,
// alarms, and captured events by reading data already in app.js memory.
// No API calls, no external dependency, works fully offline.
// Phase 2 roadmap: replace processQuery() with a Claude API call for free-form
// diagnostic reasoning and cross-signal analysis.
var chatOpen = false;
var chatHistory = []; // for display only (not sent anywhere in Tier 1)

function processQuery(q) {
  var raw = q.trim();
  var text = raw.toLowerCase();

  // ─ Helpers ───────────────────────────────────────────────────────────
  function allSignals() { return getAllMonitoredSignals(); }
  function latestValue(nodeId) {
    var d = chartData.get(nodeId) || [];
    return d.length > 0 ? d[d.length - 1].value : null;
  }
  function findSignalByName(hint) {
    var h = hint.toLowerCase();
    return allSignals().find(function(s) { return s.name.toLowerCase().indexOf(h) !== -1; });
  }

  // ─ Intent: greeting ─────────────────────────────────────────────────────
  if (/^(hi|hello|hey|howdy)\b/.test(text)) {
    return 'Hello! I\u2019m the RTOM Assistant. Ask me about any monitored signal, threshold, alarm, or captured event.';
  }

  // ─ Intent: help / what can you do ─────────────────────────────────────
  if (/help|what can you|capabilities|commands/.test(text)) {
    return 'I can answer questions like:\n\u2022 \u201cWhat is [signal name]?\u201d\n\u2022 \u201cThreshold for [signal]?\u201d\n\u2022 \u201cAny active alarms?\u201d\n\u2022 \u201cHow many events are captured?\u201d\n\u2022 \u201cWhich signal is highest right now?\u201d\n\u2022 \u201cAre all signals normal?\u201d\n\u2022 \u201cShow me the latest event\u201d';
  }

  // ─ Intent: list all signals ───────────────────────────────────────────────
  if (/what signals|list signals|show signals|which signals|signals (are|being) monitor|monitored signals/.test(text)) {
    var sigs = allSignals();
    if (sigs.length === 0) return 'No signals are currently being monitored. Start monitoring first.';
    var lines = sigs.map(function(s) {
      var v = latestValue(s.nodeId);
      return '• ' + s.name + (v !== null ? ': ' + v.toFixed(3) : ' (no data yet)');
    });
    return '<strong>' + sigs.length + ' signals monitored:</strong>\n' + lines.join('\n');
  }

  // ─ Intent: connection status ───────────────────────────────────────────────
  if (/connect|status|online|offline/.test(text) && !/failedconnect|activeconnect/.test(text)) {
    return isConnected
      ? '✅ Connected to OPC UA server. ' + (isMonitoring ? allSignals().length + ' signals being monitored.' : 'Not yet monitoring any signals.')
      : '❌ Not connected to any OPC UA server.';
  }

  // ─ Intent: alarms ────────────────────────────────────────────────────────────
  if (/alarm|alert|breach/.test(text)) {
    if (alarmLog.length === 0) return '✅ No alarms in the log. All signals within thresholds.';
    var unack = alarmLog.filter(function(a) { return !a.acknowledged; });
    var recent = alarmLog.slice(0, 5);
    var lines = recent.map(function(a) {
      return '• [' + a.time + '] ' + a.signalName + ' — ' + (a.type === 'high' ? '▲ HIGH' : '▼ LOW') + ' at ' + a.value + ' (limit: ' + a.threshold + ')' + (a.acknowledged ? ' ✓ack' : '');
    });
    return '<strong>' + alarmLog.length + ' alarm(s) total, ' + unack.length + ' unacknowledged:</strong>\n' + lines.join('\n') + (alarmLog.length > 5 ? '\n… and ' + (alarmLog.length - 5) + ' more' : '');
  }

  // ─ Intent: events / black box ────────────────────────────────────────────────
  if (/event|black box|capture|fault package|recorded/.test(text)) {
    if (eventCapturesCache.length === 0 && !eventActiveCapture) {
      return 'No events captured yet. Set a threshold on any signal to trigger the Black Box.';
    }
    var reply = '';
    if (eventActiveCapture) reply += '🔴 Currently recording an event for <strong>' + eventActiveCapture.triggerSignalName + '</strong>\n';
    if (eventCapturesCache.length > 0) {
      reply += '<strong>' + eventCapturesCache.length + ' event(s) captured.</strong>\n';
      var latest = eventCapturesCache[0];
      var patterns = latest.matchedPatterns && latest.matchedPatterns.length > 0
        ? latest.matchedPatterns.map(function(p) { return p.label; }).join(', ')
        : 'No pattern matched';
      reply += 'Latest: ' + latest.triggerSignalName + ' — ' + (latest.triggerType === 'high' ? '▲ HIGH' : '▼ LOW') + ' at ' + latest.triggerValue + '\n';
      reply += 'Pattern: ' + patterns + '\n';
      reply += 'Time: ' + new Date(latest.startedAtISO).toLocaleString();
    }
    return reply;
  }

  // ─ Intent: highest / lowest / max / min value signal ──────────────────────────
  if (/highest|largest|maximum value|max value|biggest/.test(text)) {
    var sigs = allSignals();
    if (sigs.length === 0) return 'No signals monitored yet.';
    var best = null, bestVal = -Infinity;
    sigs.forEach(function(s) { var v = latestValue(s.nodeId); if (v !== null && v > bestVal) { bestVal = v; best = s; } });
    return best ? '<strong>' + best.name + '</strong> has the highest current value at <strong>' + bestVal.toFixed(3) + '</strong>.' : 'No numeric data available yet.';
  }

  if (/lowest|smallest|minimum value|min value/.test(text)) {
    var sigs = allSignals();
    if (sigs.length === 0) return 'No signals monitored yet.';
    var best = null, bestVal = Infinity;
    sigs.forEach(function(s) { var v = latestValue(s.nodeId); if (v !== null && v < bestVal) { bestVal = v; best = s; } });
    return best ? '<strong>' + best.name + '</strong> has the lowest current value at <strong>' + bestVal.toFixed(3) + '</strong>.' : 'No numeric data available yet.';
  }

  // ─ Intent: are all signals normal ───────────────────────────────────────────────
  if (/all (signals )?(normal|ok|fine|good)|everything (ok|normal|fine)/.test(text)) {
    var unack = alarmLog.filter(function(a) { return !a.acknowledged; });
    if (unack.length === 0 && !eventActiveCapture) {
      return '✅ All signals appear normal. No unacknowledged alarms and no active event capture.';
    }
    var parts = [];
    if (unack.length > 0) parts.push(unack.length + ' unacknowledged alarm(s)');
    if (eventActiveCapture) parts.push('one event currently being recorded for ' + eventActiveCapture.triggerSignalName);
    return '⚠️ Not all clear: ' + parts.join(', ') + '.';
  }

  // ─ Intent: SET threshold for a signal ──────────────────────────────────────────────
  // Patterns: "set max for X to 50", "set threshold X max 50", "set X min 10"
  if (/set.*(threshold|max|min|limit)/i.test(raw) || /max.*for|min.*for/.test(text)) {
    var sigs = allSignals();
    var matched = null;
    sigs.forEach(function(s) {
      if (!matched && text.indexOf(s.name.toLowerCase()) !== -1) matched = s;
    });
    if (!matched) {
      var words2 = text.replace(/[^a-z0-9]/g, ' ').split(' ').filter(function(w) { return w.length > 3; });
      words2.forEach(function(word) {
        if (!matched) matched = sigs.find(function(s) { return s.name.toLowerCase().indexOf(word) !== -1; });
      });
    }
    if (!matched) return 'I can’t find that signal. Try: “set max for FailedConnection to 50”';

    // Extract the number from the query
    var nums = raw.match(/[-+]?\d+(\.\d+)?/g);
    if (!nums || nums.length === 0) return 'Please include a number. Example: “set max for ' + matched.name + ' to 50”';
    var numVal = parseFloat(nums[0]);

    // Determine min or max from keywords
    var isMax = /max|high|upper|above|over/.test(text);
    var isMin = /min|low|lower|below|under/.test(text);
    if (!isMax && !isMin) isMax = true; // default to max if ambiguous

    var thresh = signalThresholds.get(matched.nodeId) || {};
    if (isMax) thresh.max = numVal;
    if (isMin) thresh.min = numVal;
    signalThresholds.set(matched.nodeId, thresh);

    // Update the visual input on the graph card
    var elemId = safeId(matched.nodeId);
    if (isMax) { var el = document.getElementById('thresh-max-' + elemId); if (el) el.value = numVal; }
    if (isMin) { var el = document.getElementById('thresh-min-' + elemId); if (el) el.value = numVal; }

    // Mirror to main process for Black Box
    if (window.eventCapture) {
      window.eventCapture.setThreshold(matched.nodeId,
        thresh.min !== undefined ? thresh.min : null,
        thresh.max !== undefined ? thresh.max : null
      );
    }

    return '✅ ' + (isMax ? 'Max' : 'Min') + ' threshold for <strong>' + matched.name + '</strong> set to <strong>' + numVal + '</strong>. Alarms and Black Box will trigger if the value ' + (isMax ? 'exceeds' : 'falls below') + ' this.';
  }

  // ─ Intent: CLEAR alarms ─────────────────────────────────────────────────────────
  if (/clear.*(alarm|alert)|acknowledge.*(alarm|alert)|dismiss.*(alarm|alert)/.test(text)) {
    if (alarmLog.length === 0) return 'No alarms to clear.';
    // Check if a specific signal is named
    var sigs = allSignals();
    var matched = null;
    sigs.forEach(function(s) {
      if (!matched && text.indexOf(s.name.toLowerCase()) !== -1) matched = s;
    });
    if (!matched) {
      var words2 = text.replace(/[^a-z0-9]/g, ' ').split(' ').filter(function(w) { return w.length > 3; });
      words2.forEach(function(word) {
        if (!matched) matched = sigs.find(function(s) { return s.name.toLowerCase().indexOf(word) !== -1; });
      });
    }
    var isAck = /acknowledge|ack/.test(text);
    if (matched) {
      // Clear/ack alarms for that specific signal only
      var count = 0;
      alarmLog.forEach(function(a) {
        if (a.nodeId === matched.nodeId) {
          if (isAck) { a.acknowledged = true; count++; }
          else { count++; }
        }
      });
      if (!isAck) alarmLog = alarmLog.filter(function(a) { return a.nodeId !== matched.nodeId; });
      renderAlarmLog();
      updateAlarmBadge();
      return '✅ ' + (isAck ? 'Acknowledged' : 'Cleared') + ' ' + count + ' alarm(s) for <strong>' + matched.name + '</strong>.';
    } else {
      // Clear/ack all alarms
      var count = alarmLog.length;
      if (isAck) {
        alarmLog.forEach(function(a) { a.acknowledged = true; });
      } else {
        alarmLog = [];
        _alarmActive.clear();
      }
      renderAlarmLog();
      updateAlarmBadge();
      return '✅ ' + (isAck ? 'Acknowledged' : 'Cleared') + ' all ' + count + ' alarm(s).';
    }
  }

  // ─ Intent: threshold for a named signal (read) ───────────────────────────────────
  if (/threshold|limit|min|max/.test(text)) {
    // Try to extract signal name from the question
    var sigs = allSignals();
    var matched = null;
    sigs.forEach(function(s) {
      if (!matched && text.indexOf(s.name.toLowerCase()) !== -1) matched = s;
    });
    if (!matched) {
      // Try partial word match
      var words = text.replace(/[^a-z0-9]/g, ' ').split(' ').filter(function(w) { return w.length > 3; });
      words.forEach(function(word) {
        if (!matched) matched = sigs.find(function(s) { return s.name.toLowerCase().indexOf(word) !== -1; });
      });
    }
    if (matched) {
      var t = signalThresholds.get(matched.nodeId) || {};
      var minVal = t.min !== undefined && t.min !== null ? t.min : (globalMinThreshold !== null ? globalMinThreshold + ' (global)' : 'not set');
      var maxVal = t.max !== undefined && t.max !== null ? t.max : (globalMaxThreshold !== null ? globalMaxThreshold + ' (global)' : 'not set');
      return '<strong>' + matched.name + '</strong> thresholds:\nMin: ' + minVal + '\nMax: ' + maxVal;
    }
    // No signal matched — return global thresholds
    return 'Global thresholds:\nMin: ' + (globalMinThreshold !== null ? globalMinThreshold : 'not set') + '\nMax: ' + (globalMaxThreshold !== null ? globalMaxThreshold : 'not set') + '.\nAsk about a specific signal for per-signal thresholds.';
  }

  // ─ Intent: value of a named signal ────────────────────────────────────────────────
  // This runs last so more specific intents above take priority
  var sigs = allSignals();
  var matched = null;
  sigs.forEach(function(s) {
    if (!matched && text.indexOf(s.name.toLowerCase()) !== -1) matched = s;
  });
  if (!matched) {
    var words = text.replace(/[^a-z0-9]/g, ' ').split(' ').filter(function(w) { return w.length > 3; });
    words.forEach(function(word) {
      if (!matched) matched = sigs.find(function(s) { return s.name.toLowerCase().indexOf(word) !== -1; });
    });
  }
  if (matched) {
    var v = latestValue(matched.nodeId);
    var stats = signalStats.get(matched.nodeId);
    var t = signalThresholds.get(matched.nodeId) || {};
    var reply = '<strong>' + matched.name + '</strong>\nCurrent value: <strong>' + (v !== null ? v.toFixed(3) : 'no data yet') + '</strong>';
    if (stats) reply += '\nMin: ' + stats.min.toFixed(3) + '  Max: ' + stats.max.toFixed(3) + '  Avg: ' + stats.avg.toFixed(3);
    if (t.min !== undefined || t.max !== undefined) {
      reply += '\nThreshold: ' + (t.min !== null ? 'Min ' + t.min : '') + (t.max !== null ? '  Max ' + t.max : '');
    }
    var inAlarm = _alarmActive.get(matched.nodeId);
    if (inAlarm) reply += '\n⚠️ Currently in ' + inAlarm.toUpperCase() + ' alarm';
    return reply;
  }

  // ─ Fallback ──────────────────────────────────────────────────────────────────────
  var sigNames = allSignals().map(function(s) { return s.name; });
  if (sigNames.length > 0) {
    return 'I didn’t recognise that query. I can see these signals: ' + sigNames.slice(0, 5).join(', ') + (sigNames.length > 5 ? '…' : '') + '.\nTry asking “what is [signal name]?” or type “help”.';
  }
  return 'I’m not sure what you mean. Try typing \u201chelp\u201d to see what I can answer, or start monitoring some signals first.';
}

function addChatMessage(text, role) {
  var msgs = document.getElementById('chatMessages');
  var div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  // Convert \n to <br> and keep any <strong> tags
  div.innerHTML = text.replace(/\n/g, '<br>');
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function submitChat() {
  var input = document.getElementById('chatInput');
  var q = input.value.trim();
  if (!q) return;
  input.value = '';
  addChatMessage(q, 'user');
  // Small delay so the user message renders first, then the answer appears
  setTimeout(function() {
    var answer = processQuery(q);
    addChatMessage(answer, 'bot');
  }, 120);
}

document.getElementById('chatBtn').addEventListener('click', function() {
  var panel = document.getElementById('chatPanel');
  chatOpen = !chatOpen;
  panel.classList.toggle('hidden', !chatOpen);
  if (chatOpen && document.getElementById('chatMessages').children.length === 0) {
    // Welcome message on first open
    addChatMessage('Hello! I’m the RTOM Assistant. I can tell you about any monitored signal, threshold, alarm, or captured event.\n\nTry asking: <strong>“What is FailedConnection?”</strong> or click a suggestion below.', 'bot');
    document.getElementById('chatBadge').classList.add('hidden');
  }
});

document.getElementById('chatCloseBtn').addEventListener('click', function() {
  document.getElementById('chatPanel').classList.add('hidden');
  chatOpen = false;
});

document.getElementById('chatSendBtn').addEventListener('click', submitChat);

document.getElementById('chatInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') submitChat();
});

// Suggestion pill clicks
document.getElementById('chatSuggestions').addEventListener('click', function(e) {
  if (e.target.classList.contains('chat-suggestion')) {
    document.getElementById('chatInput').value = e.target.textContent;
    submitChat();
  }
});

// ─── Phone access: PIN + links ("Mobile" button in the header) ────────────────
(function setupMobileInfoButton() {
  var hr = document.querySelector('.header-right');
  if (!hr || !window.opcua || !window.opcua.invoke) return;
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  var btn = document.createElement('button');
  btn.className = 'btn btn-secondary btn-sm';
  btn.textContent = '\uD83D\uDCF1 Mobile';
  hr.insertBefore(btn, hr.firstChild);
  btn.addEventListener('click', async function() {
    var info = null;
    try { info = await window.opcua.invoke('mobile-get-info'); } catch (e) {}
    var old = document.getElementById('mobileInfoModal');
    if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.id = 'mobileInfoModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:1500;display:flex;align-items:center;justify-content:center;';
    var html = '<div style="background:#1f2937;border:1px solid #374151;border-radius:10px;padding:20px 24px;max-width:560px;width:92%;color:#f3f4f6;font-size:13px;line-height:1.55;">';
    html += '<div style="font-size:16px;font-weight:700;margin-bottom:10px;">\uD83D\uDCF1 RTOM on your phone</div>';
    if (!info || !info.success) {
      html += '<div>Could not read the phone server settings.</div>';
    } else {
      html += '<div>Phone and laptop must be on the same network (a mobile hotspot works). Open one of these links in Chrome on the phone:</div>';
      if (info.urls.length === 0) html += '<div style="margin:8px 0;color:#fca5a5;">No network connection found.</div>';
      info.urls.forEach(function(u) {
        html += '<div style="margin:8px 0;padding:8px 10px;background:#111827;border-radius:6px;font-family:monospace;word-break:break-all;">' + esc(u.url) + '<div style="font-family:sans-serif;font-size:11px;color:#9ca3af;">' + esc(u.adapter) + '</div></div>';
      });
      html += '<div style="margin-top:8px;">PIN: <strong style="font-size:15px;letter-spacing:2px;">' + esc(info.token) + '</strong> &nbsp;(the links above already include it)</div>';
      html += '<div style="margin-top:8px;font-size:11px;color:#9ca3af;">Settings file (capture window, port, PIN): ' + esc(info.configPath) + '</div>';
    }
    html += '<div style="text-align:right;margin-top:14px;"><button id="mobileInfoClose" class="btn btn-secondary btn-sm">Close</button></div></div>';
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function(e) { if (e.target === wrap) wrap.remove(); });
    document.getElementById('mobileInfoClose').addEventListener('click', function() { wrap.remove(); });
  });
})();

// ─── Phone -> desktop bridge ─────────────────────────────────────────────────
// The phone's assistant runs through the same processQuery() as the desktop one,
// so it can read AND run commands (set thresholds, clear/acknowledge alarms).
if (window.opcua && window.opcua.onMobileChatRequest) {
  window.opcua.onMobileChatRequest(function(msg) {
    var answer;
    try { answer = processQuery(String(msg.text || '')); } catch (e) { answer = 'Error: ' + e.message; }
    window.opcua.invoke('mobile-chat-response', { id: msg.id, answer: answer }).catch(function() {});
  });
}
if (window.opcua && window.opcua.onMobileCommand) {
  window.opcua.onMobileCommand(function(cmd) {
    if (cmd && cmd.type === 'ack-alarm') acknowledgeAlarm(cmd.id);
  });
}

// --- Monitoring run timer + unexpected-stop report ---------------------------
(function setupRunTimer() {
  var hr = document.querySelector('.header-right');
  if (!hr || !window.opcua || !window.opcua.invoke) return;

  var startedAt = null;   // when the current monitoring run began (same PC clock as the main process)
  var lastStatus = null;

  function pad(n) { return String(n).padStart(2, '0'); }
  function hms(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }
  function human(ms) {
    var m = Math.floor(Math.max(0, ms) / 60000), h = Math.floor(m / 60);
    return (h > 0 ? h + ' h ' : '') + (m % 60) + ' min';
  }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function when(iso) { return iso ? new Date(iso).toLocaleString() : '-'; }

  var timerEl = document.createElement('span');
  timerEl.id = 'runTimer';
  timerEl.title = 'How long the current monitoring run has been going. Click for run history.';
  timerEl.style.cssText = 'font-family:monospace;font-size:0.8rem;padding:4px 8px;border:1px solid #374151;border-radius:6px;cursor:pointer;margin-right:8px;';
  hr.insertBefore(timerEl, hr.firstChild);

  function paint() {
    timerEl.textContent = '\u23F1 ' + (startedAt ? hms(Date.now() - startedAt) : 'not monitoring');
    timerEl.style.color = startedAt ? '#34d399' : '#6b7280';
  }

  function openModal(inner) {
    var old = document.getElementById('runModal');
    if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.id = 'runModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:1500;display:flex;align-items:center;justify-content:center;';
    wrap.innerHTML = '<div style="background:#1f2937;border:1px solid #374151;border-radius:10px;padding:20px 24px;max-width:640px;width:94%;max-height:80vh;overflow:auto;color:#f3f4f6;font-size:13px;line-height:1.55;">' + inner +
      '<div style="text-align:right;margin-top:14px;"><button id="runModalClose" class="btn btn-secondary btn-sm">Close</button></div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function(e) { if (e.target === wrap) wrap.remove(); });
    document.getElementById('runModalClose').addEventListener('click', function() { wrap.remove(); });
  }

  function showPreviousRun(p) {
    openModal(
      '<div style="font-size:16px;font-weight:700;margin-bottom:8px;color:#fbbf24;">\u26A0 RTOM did not shut down cleanly last time</div>' +
      '<div>The last monitoring run lasted <strong style="font-size:15px;">' + esc(human(p.durationMs)) + '</strong> before it stopped unexpectedly (crash, power loss or forced close).</div>' +
      '<div style="margin-top:8px;color:#9ca3af;">Started: ' + esc(when(p.startedAt)) + '<br>Last activity: ' + esc(when(p.endedAt)) + ' (accurate to about 10 seconds)</div>'
    );
  }

  function showHistory() {
    var rows = (lastStatus && lastStatus.history) || [];
    var html = '<div style="font-size:16px;font-weight:700;margin-bottom:8px;">\u23F1 Monitoring run history</div>';
    if (!rows.length) {
      html += '<div style="color:#9ca3af;">No monitoring runs recorded yet. A run starts when you click Start monitoring.</div>';
    } else {
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="text-align:left;color:#9ca3af;"><th style="padding:4px 6px;">Started</th><th style="padding:4px 6px;">Duration</th><th style="padding:4px 6px;">Ended</th></tr></thead><tbody>';
      rows.forEach(function(r) {
        var unexpected = r.endReason && r.endReason.indexOf('unexpected') === 0;
        html += '<tr style="border-top:1px solid #374151;"><td style="padding:5px 6px;white-space:nowrap;">' + esc(when(r.startedAt)) + '</td>' +
          '<td style="padding:5px 6px;font-weight:700;">' + esc(human(r.durationMs)) + '</td>' +
          '<td style="padding:5px 6px;color:' + (r.running ? '#34d399' : (unexpected ? '#fbbf24' : '#9ca3af')) + ';">' + (r.running ? 'running now' : esc(r.endReason || '')) + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    openModal(html);
  }

  async function sync() {
    try {
      var st = await window.opcua.invoke('run-get-status');
      if (st && st.success) { lastStatus = st; startedAt = st.monitoringStartedAt || null; paint(); return st; }
    } catch (e) {}
    return null;
  }

  timerEl.addEventListener('click', async function() { await sync(); showHistory(); });
  // Refresh quickly after Start / Stop is clicked (the regular check runs every 5 s)
  if (typeof monitorBtn !== 'undefined' && monitorBtn) monitorBtn.addEventListener('click', function() { setTimeout(sync, 1500); setTimeout(sync, 4000); });
  if (typeof stopMonitorBtn !== 'undefined' && stopMonitorBtn) stopMonitorBtn.addEventListener('click', function() { setTimeout(sync, 500); });

  paint();
  sync().then(function(st) { if (st && st.previousRun) showPreviousRun(st.previousRun); });
  setInterval(sync, 5000);
  setInterval(paint, 1000);
})();

console.log('[APP] OPC UA Monitor ready');
