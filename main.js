const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  AttributeIds
} = require('node-opcua');

let mainWindow;
let opcuaClient = null;
let session = null;
let subscription = null;
let monitoredItems = new Map();
let pollingInterval = null;
let currentSamplingInterval = 1000; // ms — controlled by UI

// Historian settings
let historianEnabled = true;
const DATA_RETENTION_DAYS = 7;
let signalNames = new Map();

// ─── Event Capture ("Black Box") settings ───────────────────────────────────
// Additive feature: does not alter existing subscribe/poll/historian behavior.
// Maintains a short rolling buffer per signal and snapshots it when a
// threshold trigger fires, producing a self-contained "fault package".
// These three are overwritten at startup from rtom-config.json (see loadConfig below),
// so the capture window can be changed without editing code. Defaults are demo-scaled.
let EVENT_PRE_SECONDS = 60;     // "pre-event" window (production would typically use ~30 min)
let EVENT_POST_SECONDS = 30;    // "post-event" window (production would typically use ~10 min)
let EVENT_BUFFER_MAX = 2000;    // hard cap per signal so memory can't grow unbounded
let eventCaptureEnabled = true;
let eventThresholds = new Map();      // nodeId -> { min, max }
let eventRollingBuffer = new Map();   // nodeId -> [{ value, timestamp }] — pinned signals only
let eventCaptures = [];               // finished/in-progress captures, newest first
let activeCapture = null;
let eventCaptureCounter = 0;

// Pinned signals registry — only these nodeIds get buffered and captured
// by the Black Box. Updated from the renderer via 'event-set-pinned' IPC.
var pinnedNodeIds = new Set();

ipcMain.handle('event-set-pinned', async function(event, nodeIds) {
  pinnedNodeIds = new Set(Array.isArray(nodeIds) ? nodeIds : []);
  // Clear buffers for any node no longer pinned
  eventRollingBuffer.forEach(function(_, id) {
    if (!pinnedNodeIds.has(id)) eventRollingBuffer.delete(id);
  });
  console.log('[EVENT] Pinned signals updated:', Array.from(pinnedNodeIds));
  return { success: true };
});

// ─── Rule Engine (loaded from rules.json) ───────────────────────────────────
// Config-driven, NOT machine learning. Every rule is a simple, explicit
// heuristic defined in rules.json — edit that file to add/disable/tune rules
// without touching this code. Falls back to a minimal built-in set if the
// file is missing or malformed, so the app never crashes on a bad config.
const RULES_FILE_PATH = path.join(__dirname, 'rules.json');
const FALLBACK_RULES = {
  name_based_rules: [
    { id: 'possible_overheat', label: 'Possible Overheat (rule-based)', enabled: true, match_any_signal_contains_all: ['temp'] }
  ],
  value_based_rules: [],
  relationship_rules: []
};
let loadedRules = FALLBACK_RULES;

function loadRules() {
  try {
    const raw = fs.readFileSync(RULES_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    loadedRules = {
      name_based_rules: Array.isArray(parsed.name_based_rules) ? parsed.name_based_rules : [],
      value_based_rules: Array.isArray(parsed.value_based_rules) ? parsed.value_based_rules : [],
      relationship_rules: Array.isArray(parsed.relationship_rules) ? parsed.relationship_rules : []
    };
    console.log('[RULES] Loaded', loadedRules.name_based_rules.length, 'name-based and',
      loadedRules.value_based_rules.length, 'value-based rules from rules.json');
  } catch (err) {
    console.error('[RULES] Could not load rules.json (' + err.message + ') — using fallback rules');
    loadedRules = FALLBACK_RULES;
  }
}

loadRules(); // initial load at startup

// Generic name-based matcher: does ANY captured signal name contain ALL of
// this rule's listed substrings (case-insensitive)? Same mechanism the old
// hardcoded RULE_BASED_PATTERNS used, just data-driven now.
function evaluateNameBasedRules(signalNamesInEvent) {
  var matched = [];
  var lowerNames = signalNamesInEvent.map(function(n) { return (n || '').toLowerCase(); });
  loadedRules.name_based_rules.forEach(function(rule) {
    if (rule.enabled === false) return;
    var substrings = rule.match_any_signal_contains_all || [];
    if (substrings.length === 0) return;
    var fires = lowerNames.some(function(name) {
      return substrings.every(function(sub) { return name.indexOf(String(sub).toLowerCase()) !== -1; });
    });
    if (fires) matched.push({ id: rule.id, label: rule.label });
  });
  return matched;
}

// Generic value-based matcher: works on each signal's captured sample series,
// independent of its name. Each tag names the signal that caused it, and the
// trigger signal itself is never evaluated (its change is why the capture exists).
function evaluateValueBasedRules(samplesByNodeId, namesByNodeId, triggerNodeId) {
  var matched = [];
  var MAX_TAGS_PER_RULE = 3;

  function baseLabel(rule) { return String(rule.label || rule.id).replace(/\s*\(rule-based\)\s*$/, ''); }
  function nameOf(nodeId) { return (namesByNodeId && namesByNodeId.get(nodeId)) || nodeId; }
  function tag(rule, nodeId) {
    return { id: rule.id + ':' + nodeId, label: baseLabel(rule) + ': ' + nameOf(nodeId) + ' (rule-based)' };
  }

  loadedRules.value_based_rules.forEach(function(rule) {
    if (rule.enabled === false) return;
    var hits = 0;

    samplesByNodeId.forEach(function(samples, nodeId) {
      if (hits >= MAX_TAGS_PER_RULE || nodeId === triggerNodeId || !samples || samples.length < 3) return;

      if (rule.type === 'no_change_for_duration') {
        // "Frozen": the signal was changing, then stopped changing for min_seconds and
        // stayed flat to the end of the window. A signal that is always constant
        // (e.g. a connection counter) is normal, not a fault.
        var minMs = (rule.min_seconds || 30) * 1000;
        var lastIdx = samples.length - 1;
        var runStart = lastIdx;
        while (runStart > 0 && samples[runStart - 1].value === samples[lastIdx].value) runStart--;
        if (samples[lastIdx].t - samples[runStart].t < minMs) return;
        var priorChanges = 0;
        for (var i = 1; i <= runStart; i++) if (samples[i].value !== samples[i - 1].value) priorChanges++;
        if (priorChanges < (rule.min_prior_changes || 5)) return;
        matched.push(tag(rule, nodeId));
        hits++;
      }

      if (rule.type === 'rate_of_change_exceeds') {
        var factor = rule.factor || 5;
        var sum = 0, maxStep = 0, magnitude = 0;
        for (var j = 1; j < samples.length; j++) {
          var step = Math.abs(samples[j].value - samples[j - 1].value);
          sum += step;
          if (step > maxStep) maxStep = step;
        }
        for (var k = 0; k < samples.length; k++) magnitude += Math.abs(samples[k].value);
        var avgStep = sum / (samples.length - 1);
        magnitude = magnitude / samples.length;
        if (avgStep <= 0 || maxStep < avgStep * factor) return;
        if (maxStep < Math.max(magnitude * 0.05, 1e-9)) return; // ignore jumps below 5% of the typical value
        matched.push(tag(rule, nodeId));
        hits++;
      }
    });
  });

  return matched;
}

// OPC UA 64-bit integers (Int64 = 8, UInt64 = 9) reach us from node-opcua as a
// [high, low] word pair (or BigInt), not a JS number. Charts, thresholds, the
// historian and the Black Box all require numbers, so 64-bit values were being
// silently skipped. Convert scalar 64-bit values to a plain number here, once,
// at the source. Exact up to 2^53 (about 9e15); beyond that precision is lost,
// which is fine for graphing.
function normalizeVariantValue(variant) {
  var value = variant ? variant.value : undefined;
  var dt = variant ? variant.dataType : undefined;
  var is64 = (dt === 8 || dt === 9 || dt === 'Int64' || dt === 'UInt64');
  var isScalar = !variant || variant.arrayType === undefined || variant.arrayType === 0 || variant.arrayType === 'Scalar';
  if (is64 && isScalar) {
    if (typeof value === 'bigint') return Number(value);
    if (Array.isArray(value) && value.length === 2) {
      var hi = value[0];
      var lo = value[1] >>> 0; // low word as unsigned 32-bit
      if ((dt === 8 || dt === 'Int64') && hi > 0x7fffffff) hi -= 4294967296; // signed high word for Int64
      return hi * 4294967296 + lo;
    }
  }
  // Booleans -> 1/0 so on/off signals can be charted and thresholded
  if (typeof value === 'boolean' && isScalar) return value ? 1 : 0;
  return value;
}

function feedEventCapture(payload) {
  if (!eventCaptureEnabled) return;
  try {
    var nodeId = payload.nodeId;
    var value = payload.value;
    if (typeof value !== 'number' || isNaN(value)) return;

    var now = Date.now();

    // Only buffer pinned signals. If no signals are pinned yet, fall back to
    // buffering everything (so Black Box still works before the user pins anything).
    var isPinned = pinnedNodeIds.size === 0 || pinnedNodeIds.has(nodeId);

    // 1) Append to rolling buffer — pinned signals only
    if (isPinned) {
      var buf = eventRollingBuffer.get(nodeId);
      if (!buf) { buf = []; eventRollingBuffer.set(nodeId, buf); }
      buf.push({ value: value, timestamp: payload.timestamp || new Date(now).toISOString(), t: now });
      if (buf.length > EVENT_BUFFER_MAX) buf.shift();
      var cutoff = now - (EVENT_PRE_SECONDS * 1000);
      while (buf.length > 0 && buf[0].t < cutoff) buf.shift();
    }

    // 2) If a capture is in progress, keep recording this signal if it is pinned
    if (activeCapture && isPinned) {
      var sampleArr = activeCapture.samples.get(nodeId);
      if (!sampleArr) { sampleArr = []; activeCapture.samples.set(nodeId, sampleArr); }
      sampleArr.push({ value: value, timestamp: payload.timestamp || new Date(now).toISOString(), t: now });
    }

    // 3) Check trigger thresholds for this signal
    var threshold = eventThresholds.get(nodeId);
    if (!threshold || (threshold.min === null && threshold.max === null)) return;
    var breached = null;
    if (typeof threshold.max === 'number' && !isNaN(threshold.max) && value > threshold.max) breached = { type: 'high', limit: threshold.max };
    else if (typeof threshold.min === 'number' && !isNaN(threshold.min) && value < threshold.min) breached = { type: 'low', limit: threshold.min };
    if (!breached) return;

    // Don't start a new capture if one is already running (avoid overlap storms)
    if (activeCapture) {
      console.log('[EVENT] Breach detected but capture already active, skipping:', nodeId);
      return;
    }
    console.log('[EVENT] Breach detected, starting capture:', nodeId, breached.type, value, 'limit:', breached.limit);

    startEventCapture(nodeId, signalNames.get(nodeId) || nodeId, value, breached);
  } catch (err) {
    console.error('[EVENT] feedEventCapture error:', err.message);
  }
}

function startEventCapture(triggerNodeId, triggerSignalName, triggerValue, breached) {
  eventCaptureCounter++;
  var id = 'evt_' + Date.now() + '_' + eventCaptureCounter;
  var startedAt = Date.now();

  var capture = {
    id: id,
    triggerNodeId: triggerNodeId,
    triggerSignalName: triggerSignalName,
    triggerType: breached.type,
    triggerValue: triggerValue,
    threshold: breached.limit,
    startedAt: startedAt,
    startedAtISO: new Date(startedAt).toISOString(),
    postEndsAt: startedAt + (EVENT_POST_SECONDS * 1000),
    samples: new Map(), // nodeId -> [{value, timestamp, t}]
    status: 'capturing'
  };

  // Seed with everything currently in the rolling buffers (this is the "pre-event" data)
  eventRollingBuffer.forEach(function(buf, nodeId) {
    capture.samples.set(nodeId, buf.slice());
  });

  activeCapture = capture;
  console.log('[EVENT] Capture started:', id, 'trigger:', triggerSignalName, breached.type, triggerValue);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('event-capture-started', {
      id: id, triggerSignalName: triggerSignalName, triggerType: breached.type,
      triggerValue: triggerValue, threshold: breached.limit, startedAtISO: capture.startedAtISO
    });
  }

  // Stop recording the post-event window after EVENT_POST_SECONDS
  capture.timer = setTimeout(function() { finishEventCapture(id); }, EVENT_POST_SECONDS * 1000);
}

function finishEventCapture(id) {
  if (!activeCapture || activeCapture.id !== id) return;
  var capture = activeCapture;
  capture.status = 'complete';
  activeCapture = null;

  // Build a plain-object summary (samples Map -> arrays) for storage/IPC/export
  var signalsOut = {};
  var namesInEvent = [];
  capture.samples.forEach(function(samples, nodeId) {
    var name = signalNames.get(nodeId) || nodeId;
    namesInEvent.push(name);
    signalsOut[nodeId] = {
      signalName: name,
      points: samples.map(function(s) { return { value: s.value, timestamp: s.timestamp }; })
    };
  });

  // Rule-based pattern tagging (NOT machine learning — see rules.json / loadedRules)
  var matchedPatterns = evaluateNameBasedRules(namesInEvent)
    .concat(evaluateValueBasedRules(capture.samples, signalNames, capture.triggerNodeId));

  var record = {
    id: capture.id,
    triggerNodeId: capture.triggerNodeId,
    triggerSignalName: capture.triggerSignalName,
    triggerType: capture.triggerType,
    triggerValue: capture.triggerValue,
    threshold: capture.threshold,
    startedAtISO: capture.startedAtISO,
    finishedAtISO: new Date().toISOString(),
    preSeconds: EVENT_PRE_SECONDS,
    postSeconds: EVENT_POST_SECONDS,
    signals: signalsOut,
    matchedPatterns: matchedPatterns,
    acknowledged: false
  };

  eventCaptures.unshift(record);
  if (eventCaptures.length > 50) eventCaptures.pop(); // cap stored events in memory

  console.log('[EVENT] Capture finished:', id, 'patterns:', matchedPatterns.map(function(p){return p.id;}).join(',') || 'none');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('event-capture-finished', {
      id: record.id,
      triggerSignalName: record.triggerSignalName,
      triggerType: record.triggerType,
      triggerValue: record.triggerValue,
      matchedPatterns: record.matchedPatterns,
      signalCount: Object.keys(signalsOut).length
    });
  }
}

// Get data storage path
function getDataPath() {
  const userDataPath = app.getPath('userData');
  const dataPath = path.join(userDataPath, 'historian');
  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath, { recursive: true });
  }
  return dataPath;
}

// Save to daily CSV file
function saveToCSV(nodeId, signalName, value, timestamp, statusCode) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const csvPath = path.join(getDataPath(), 'data_' + today + '.csv');
    
    if (!fs.existsSync(csvPath)) {
      fs.writeFileSync(csvPath, 'Timestamp,NodeId,SignalName,Value,StatusCode\n');
    }
    
    const safeName = signalName.replace(/"/g, '""');
    const line = timestamp + ',' + nodeId + ',"' + safeName + '",' + value + ',' + statusCode + '\n';
    fs.appendFileSync(csvPath, line);
  } catch (err) {
    console.error('[MAIN] CSV save error:', err.message);
  }
}

// Save to daily JSON file (for querying)
function saveToJSON(nodeId, signalName, value, timestamp, statusCode) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const jsonPath = path.join(getDataPath(), 'data_' + today + '.json');
    
    let data = [];
    if (fs.existsSync(jsonPath)) {
      try {
        const content = fs.readFileSync(jsonPath, 'utf8');
        data = JSON.parse(content);
      } catch (e) {
        data = [];
      }
    }
    
    data.push({
      nodeId: nodeId,
      signalName: signalName,
      value: value,
      timestamp: timestamp,
      statusCode: statusCode
    });
    
    fs.writeFileSync(jsonPath, JSON.stringify(data));
  } catch (err) {
    console.error('[MAIN] JSON save error:', err.message);
  }
}

// Clean old files (older than 7 days)
function cleanOldFiles() {
  try {
    const dataPath = getDataPath();
    const files = fs.readdirSync(dataPath);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - DATA_RETENTION_DAYS);
    
    files.forEach(function(file) {
      if (file.startsWith('data_') && (file.endsWith('.csv') || file.endsWith('.json'))) {
        const dateStr = file.replace('data_', '').replace('.csv', '').replace('.json', '');
        const fileDate = new Date(dateStr);
        
        if (fileDate < cutoffDate) {
          fs.unlinkSync(path.join(dataPath, file));
          console.log('[MAIN] Deleted old file:', file);
        }
      }
    });
  } catch (err) {
    console.error('[MAIN] Clean error:', err.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'RTOM — Realtime OPC Monitor',
    icon: path.join(__dirname, 'assets', 'RTOM_logo.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setTitle('RTOM — Realtime OPC Monitor');
  // DevTools disabled for production — uncomment for debugging:
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(function() {
  cleanOldFiles();
  createWindow();
  console.log('[MAIN] Data stored in:', getDataPath());
});

app.on('window-all-closed', function() {
  if (opcuaClient) {
    disconnectOPCUA();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function() {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle('opcua-connect', async function(event, endpoint, username, password) {
  try {
    opcuaClient = OPCUAClient.create({
      endpoint_must_exist: false,
      connectionStrategy: {
        maxRetry: 3,
        initialDelay: 1000,
        maxDelay: 10000
      },
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None
    });

    await opcuaClient.connect(endpoint);

    const userIdentity = username ? { userName: username, password: password } : null;
    session = await opcuaClient.createSession(userIdentity);

    console.log('[MAIN] Connected');
    return { success: true, message: 'Connected' };
  } catch (error) {
    console.error('[MAIN] Connection error:', error.message);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('opcua-disconnect', async function() {
  try {
    await disconnectOPCUA();
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

async function disconnectOPCUA() {
  stopPolling();
  endRunSession('disconnected');
  
  if (subscription) {
    await subscription.terminate();
    subscription = null;
  }
  monitoredItems.clear();
  signalNames.clear();

  if (session) {
    await session.close();
    session = null;
  }

  if (opcuaClient) {
    await opcuaClient.disconnect();
    opcuaClient = null;
  }
  console.log('[MAIN] Disconnected');
}

ipcMain.handle('opcua-browse', async function(event, nodeId) {
  try {
    if (!session) {
      return { success: false, message: 'Not connected' };
    }

    const browseResult = await session.browse(nodeId || 'i=85');

    const nodes = await Promise.all(
      browseResult.references.map(async function(ref) {
        const node = {
          nodeId: ref.nodeId.toString(),
          browseName: ref.browseName.name,
          displayName: ref.displayName?.text || ref.browseName.name,
          nodeClass: ref.nodeClass.toString(),
          isForward: ref.isForward
        };

        try {
          const childBrowse = await session.browse(ref.nodeId);
          node.hasChildren = childBrowse.references.length > 0;
        } catch (e) {
          node.hasChildren = false;
        }

        if (ref.nodeClass.toString() === 'Variable') {
          try {
            const dataValue = await session.read({
              nodeId: ref.nodeId,
              attributeId: AttributeIds.Value
            });
            node.value = normalizeVariantValue(dataValue.value);
            node.statusCode = dataValue.statusCode.toString();
          } catch (e) {
            node.value = null;
          }
        }

        return node;
      })
    );

    return { success: true, nodes: nodes };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('opcua-read', async function(event, nodeId) {
  try {
    if (!session) {
      return { success: false, message: 'Not connected' };
    }

    const dataValue = await session.read({
      nodeId: nodeId,
      attributeId: AttributeIds.Value
    });

    return {
      success: true,
      value: normalizeVariantValue(dataValue.value),
      timestamp: dataValue.sourceTimestamp,
      statusCode: dataValue.statusCode.toString()
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// opcua-subscribe now accepts samplingInterval as a 4th argument
ipcMain.handle('opcua-subscribe', async function(event, nodeIds, nodeNames, samplingInterval) {
  try {
    if (!session) {
      return { success: false, message: 'Not connected' };
    }

    // Use provided interval or fall back to current setting
    const interval = (typeof samplingInterval === 'number' && samplingInterval > 0)
      ? samplingInterval
      : currentSamplingInterval;

    currentSamplingInterval = interval;
    console.log('[MAIN] Subscribe for:', nodeIds.length, 'nodes at', interval, 'ms');

    // Store signal names
    if (nodeNames && Array.isArray(nodeNames)) {
      nodeIds.forEach(function(id, idx) {
        signalNames.set(id, nodeNames[idx] || id);
      });
    }

    // Signals from extra servers (ids start with '#') are polled by features-servers-main.js
    nodeIds = nodeIds.filter(function(id) { return String(id).charAt(0) !== '#'; });

    if (subscription) {
      await subscription.terminate();
      subscription = null;
      monitoredItems.clear();
    }

    subscription = await session.createSubscription2({
      requestedPublishingInterval: interval,
      requestedLifetimeCount: 1000,
      requestedMaxKeepAliveCount: 20,
      maxNotificationsPerPublish: 100,
      publishingEnabled: true,
      priority: 10
    });

    for (const nodeId of nodeIds) {
      try {
        const monitoredItem = await subscription.monitor(
          { nodeId: nodeId, attributeId: AttributeIds.Value },
          { samplingInterval: interval, discardOldest: true, queueSize: 10 }
        );

        monitoredItem.on('changed', function(dataValue) {
          let value = normalizeVariantValue(dataValue.value);
          if (value === undefined) value = dataValue.value;

          const timestamp = dataValue.sourceTimestamp ? dataValue.sourceTimestamp.toISOString() : new Date().toISOString();
          const statusCode = dataValue.statusCode ? dataValue.statusCode.toString() : 'Good';
          const signalName = signalNames.get(nodeId) || nodeId;

          // Save to historian
          if (historianEnabled && typeof value === 'number') {
            saveToCSV(nodeId, signalName, value, timestamp, statusCode);
          }

          const payload = {
            nodeId: nodeId,
            value: value,
            timestamp: timestamp,
            statusCode: statusCode
          };

          feedEventCapture(payload); // additive: Event Capture / Black Box (does not affect existing flow)

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('opcua-data-changed', payload);
          }
        });

        monitoredItems.set(nodeId, monitoredItem);
      } catch (err) {
        console.error('[MAIN] Monitor error:', nodeId);
      }
    }

    startRunSession();
    startPolling(nodeIds, interval);
    return { success: true, message: 'Monitoring ' + nodeIds.length + ' nodes at ' + interval + 'ms' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

function startPolling(nodeIds, interval) {
  stopPolling();

  const pollMs = interval || currentSamplingInterval;

  pollingInterval = setInterval(async function() {
    if (!session) {
      stopPolling();
      return;
    }

    for (const nodeId of nodeIds) {
      try {
        const dataValue = await session.read({
          nodeId: nodeId,
          attributeId: AttributeIds.Value
        });

        let value = normalizeVariantValue(dataValue.value);
        if (value === undefined) value = dataValue.value;

        const timestamp = new Date().toISOString();
        const statusCode = dataValue.statusCode ? dataValue.statusCode.toString() : 'Good';
        const signalName = signalNames.get(nodeId) || nodeId;

        // Save to historian
        if (historianEnabled && typeof value === 'number') {
          saveToCSV(nodeId, signalName, value, timestamp, statusCode);
        }

        const payload = {
          nodeId: nodeId,
          value: value,
          timestamp: timestamp,
          statusCode: statusCode
        };

        feedEventCapture(payload); // additive: Event Capture / Black Box (does not affect existing flow)

        console.log('[MAIN] Poll:', signalName, '=', value);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('opcua-data-changed', payload);
        }
      } catch (err) {
        console.error('[MAIN] Poll error:', nodeId);
      }
    }
  }, pollMs);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

ipcMain.handle('opcua-unsubscribe', async function() {
  try {
    stopPolling();
    endRunSession('monitoring stopped');
    if (subscription) {
      await subscription.terminate();
      subscription = null;
      monitoredItems.clear();
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// ─── Historian APIs ──────────────────────────────────────────────────────────

ipcMain.handle('historian-get-data-path', async function() {
  return { success: true, path: getDataPath() };
});

ipcMain.handle('historian-get-files', async function() {
  try {
    const dataPath = getDataPath();
    const files = fs.readdirSync(dataPath).filter(function(f) {
      return f.startsWith('data_') && f.endsWith('.csv');
    });
    return { success: true, files: files, path: dataPath };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('historian-toggle', async function(event, enabled) {
  historianEnabled = enabled;
  console.log('[MAIN] Historian', enabled ? 'enabled' : 'disabled');
  return { success: true, enabled: historianEnabled };
});

/**
 * historian-get-data
 * Reads all CSV files that overlap the requested date range and returns
 * filtered rows for the requested nodeId (or all signals if nodeId is null).
 *
 * Returns: { success, records: [{ timestamp, nodeId, signalName, value, statusCode }] }
 */
ipcMain.handle('historian-get-data', async function(event, nodeId, startISO, endISO) {
  try {
    const dataPath = getDataPath();
    const start = startISO ? new Date(startISO) : new Date(0);
    const end   = endISO   ? new Date(endISO)   : new Date();

    // Enumerate CSV files whose date falls within [start, end]
    const allFiles = fs.readdirSync(dataPath).filter(function(f) {
      return f.startsWith('data_') && f.endsWith('.csv');
    });

    const records = [];

    for (const file of allFiles) {
      const dateStr = file.replace('data_', '').replace('.csv', '');
      const fileDate = new Date(dateStr);
      // Keep files that might overlap the range (within ±1 day tolerance)
      const dayAfterEnd = new Date(end); dayAfterEnd.setDate(dayAfterEnd.getDate() + 1);
      const dayBeforeStart = new Date(start); dayBeforeStart.setDate(dayBeforeStart.getDate() - 1);
      if (fileDate < dayBeforeStart || fileDate > dayAfterEnd) continue;

      const csvPath = path.join(dataPath, file);
      let lines;
      try {
        lines = fs.readFileSync(csvPath, 'utf8').split('\n');
      } catch (e) {
        continue;
      }

      // Skip header line
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Parse CSV: Timestamp,NodeId,SignalName,Value,StatusCode
        // SignalName may be quoted and contain commas — handle that
        const firstComma = line.indexOf(',');
        if (firstComma === -1) continue;
        const ts = line.substring(0, firstComma);
        const rest = line.substring(firstComma + 1);

        // NodeId ends at next comma
        const secondComma = rest.indexOf(',');
        if (secondComma === -1) continue;
        const rowNodeId = rest.substring(0, secondComma);
        const rest2 = rest.substring(secondComma + 1);

        // SignalName may be quoted
        let signalName, rest3;
        if (rest2.startsWith('"')) {
          const closeQuote = rest2.indexOf('",', 1);
          if (closeQuote === -1) continue;
          signalName = rest2.substring(1, closeQuote).replace(/""/g, '"');
          rest3 = rest2.substring(closeQuote + 2);
        } else {
          const nextComma = rest2.indexOf(',');
          if (nextComma === -1) continue;
          signalName = rest2.substring(0, nextComma);
          rest3 = rest2.substring(nextComma + 1);
        }

        const lastComma = rest3.lastIndexOf(',');
        const valueStr = lastComma === -1 ? rest3 : rest3.substring(0, lastComma);
        const statusCode = lastComma === -1 ? '' : rest3.substring(lastComma + 1);
        const value = parseFloat(valueStr);

        // Filter by timestamp
        let rowDate;
        try { rowDate = new Date(ts); } catch (e) { continue; }
        if (rowDate < start || rowDate > end) continue;

        // Filter by nodeId if specified
        if (nodeId && rowNodeId !== nodeId) continue;

        records.push({
          timestamp: ts,
          nodeId: rowNodeId,
          signalName: signalName,
          value: isNaN(value) ? valueStr : value,
          statusCode: statusCode
        });
      }
    }

    // Sort by timestamp ascending
    records.sort(function(a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });

    console.log('[MAIN] Historian query returned', records.length, 'records');
    return { success: true, records: records };
  } catch (err) {
    console.error('[MAIN] historian-get-data error:', err.message);
    return { success: false, message: err.message, records: [] };
  }
});

/**
 * historian-get-signals
 * Returns the unique list of (nodeId, signalName) pairs seen across all CSV files.
 */
ipcMain.handle('historian-get-signals', async function() {
  try {
    const dataPath = getDataPath();
    const allFiles = fs.readdirSync(dataPath).filter(function(f) {
      return f.startsWith('data_') && f.endsWith('.csv');
    });

    const signalMap = new Map(); // nodeId -> signalName

    for (const file of allFiles) {
      const csvPath = path.join(dataPath, file);
      let lines;
      try {
        lines = fs.readFileSync(csvPath, 'utf8').split('\n');
      } catch (e) { continue; }

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const firstComma = line.indexOf(',');
        if (firstComma === -1) continue;
        const rest = line.substring(firstComma + 1);
        const secondComma = rest.indexOf(',');
        if (secondComma === -1) continue;
        const rowNodeId = rest.substring(0, secondComma);
        const rest2 = rest.substring(secondComma + 1);

        let signalName;
        if (rest2.startsWith('"')) {
          const closeQuote = rest2.indexOf('",', 1);
          signalName = closeQuote === -1 ? rowNodeId : rest2.substring(1, closeQuote).replace(/""/g, '"');
        } else {
          const nextComma = rest2.indexOf(',');
          signalName = nextComma === -1 ? rest2 : rest2.substring(0, nextComma);
        }

        if (!signalMap.has(rowNodeId)) signalMap.set(rowNodeId, signalName);
      }
    }

    const signals = [];
    signalMap.forEach(function(name, id) { signals.push({ nodeId: id, signalName: name }); });

    return { success: true, signals: signals };
  } catch (err) {
    return { success: false, message: err.message, signals: [] };
  }
});

// Save file to custom path
ipcMain.handle('save-file', async function(event, folderPath, filename, content) {
  try {
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    const filePath = path.join(folderPath, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('[MAIN] Saved file:', filePath);
    return { success: true, path: filePath };
  } catch (err) {
    console.error('[MAIN] Save file error:', err.message);
    return { success: false, message: err.message };
  }
});

// ─── Event Capture APIs ("Black Box") ────────────────────────────────────────
// All additive. Does not modify opcua-subscribe/opcua-data-changed behavior;
// these handlers only read/control the side-buffer fed by feedEventCapture().

ipcMain.handle('event-set-threshold', async function(event, nodeId, min, max) {
  try {
    eventThresholds.set(nodeId, {
      min: (typeof min === 'number') ? min : null,
      max: (typeof max === 'number') ? max : null
    });
    console.log('[EVENT] Threshold set:', nodeId, 'min=', min, 'max=', max);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('event-clear-threshold', async function(event, nodeId) {
  eventThresholds.delete(nodeId);
  return { success: true };
});

ipcMain.handle('event-toggle', async function(event, enabled) {
  eventCaptureEnabled = !!enabled;
  console.log('[MAIN] Event capture', eventCaptureEnabled ? 'enabled' : 'disabled');
  return { success: true, enabled: eventCaptureEnabled };
});

ipcMain.handle('event-get-captures', async function() {
  try {
    // Return lightweight summaries; full signal data fetched separately per-id
    var list = eventCaptures.map(function(c) {
      return {
        id: c.id,
        triggerSignalName: c.triggerSignalName,
        triggerType: c.triggerType,
        triggerValue: c.triggerValue,
        threshold: c.threshold,
        startedAtISO: c.startedAtISO,
        finishedAtISO: c.finishedAtISO,
        matchedPatterns: c.matchedPatterns,
        signalCount: Object.keys(c.signals).length,
        acknowledged: !!c.acknowledged
      };
    });
    var active = activeCapture ? {
      id: activeCapture.id,
      triggerSignalName: activeCapture.triggerSignalName,
      triggerType: activeCapture.triggerType,
      status: 'capturing'
    } : null;
    return { success: true, captures: list, active: active };
  } catch (err) {
    return { success: false, message: err.message, captures: [] };
  }
});

ipcMain.handle('event-get-capture-detail', async function(event, id) {
  try {
    var record = eventCaptures.find(function(c) { return c.id === id; });
    if (!record) return { success: false, message: 'Capture not found' };
    return { success: true, capture: record };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('event-acknowledge', async function(event, id) {
  try {
    var record = eventCaptures.find(function(c) { return c.id === id; });
    if (!record) return { success: false, message: 'Capture not found' };
    record.acknowledged = true;
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('event-clear', async function(event, id) {
  try {
    var idx = eventCaptures.findIndex(function(c) { return c.id === id; });
    if (idx === -1) return { success: false, message: 'Capture not found' };
    // Permanently removes the record AND its captured signal data from memory.
    // This is intentionally irreversible — use event-acknowledge instead if the
    // event should be kept (just marked as seen).
    eventCaptures.splice(idx, 1);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('event-export-package', async function(event, id, folderPath) {
  try {
    var record = eventCaptures.find(function(c) { return c.id === id; });
    if (!record) return { success: false, message: 'Capture not found' };

    if (!folderPath) folderPath = path.join(getDataPath(), 'events');
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

    var baseName = 'fault_package_' + record.id;
    var jsonPath = path.join(folderPath, baseName + '.json');
    var csvPath = path.join(folderPath, baseName + '.csv');

    // JSON: full event summary (trigger, patterns, timestamps, per-signal series)
    fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2), 'utf8');

    // CSV: flattened Timestamp,NodeId,SignalName,Value across all captured signals
    var csvLines = ['Timestamp,NodeId,SignalName,Value'];
    Object.keys(record.signals).forEach(function(nodeId) {
      var sig = record.signals[nodeId];
      sig.points.forEach(function(p) {
        var safeName = (sig.signalName || '').replace(/"/g, '""');
        csvLines.push(p.timestamp + ',' + nodeId + ',"' + safeName + '",' + p.value);
      });
    });
    fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');

    console.log('[EVENT] Fault package exported:', jsonPath, csvPath);
    return { success: true, jsonPath: jsonPath, csvPath: csvPath, folderPath: folderPath };
  } catch (err) {
    console.error('[EVENT] Export error:', err.message);
    return { success: false, message: err.message };
  }
});

// ─── RTOM Mobile API Server ───────────────────────────────────────────────
// --- Monitoring run timer and crash log ---------------------------------------
// Records how long each monitoring run lasts. A heartbeat is written to disk every
// 10 s, so if RTOM or the PC stops unexpectedly, the next start can report how long
// that run lasted (start to last heartbeat, accurate to about 10 s).
const RUN_HEARTBEAT_MS = 10000;
const RUN_HISTORY_MAX = 50;
var monitoringStartedAt = null;   // ms epoch while monitoring, otherwise null
var runHistory = [];              // [{ startedAt, lastHeartbeat, endedAt, endReason }]
var currentRunEntry = null;
var runHeartbeatTimer = null;
var previousRunReport = null;     // set at startup when the last run did not end cleanly

function getRunLogPath() { return path.join(app.getPath('userData'), 'run-history.json'); }

function saveRunHistory() {
  try {
    fs.writeFileSync(getRunLogPath(), JSON.stringify(runHistory.slice(-RUN_HISTORY_MAX), null, 2), 'utf8');
  } catch (e) {
    console.error('[RUN] Could not save run history:', e.message);
  }
}

function runDurationMs(entry) {
  var end = (entry === currentRunEntry) ? Date.now() : Date.parse(entry.endedAt || entry.lastHeartbeat);
  return Math.max(0, end - Date.parse(entry.startedAt));
}

// Called once at startup. A last run with no end time means RTOM (or the PC) stopped
// unexpectedly; its length is measured up to the last heartbeat.
function checkPreviousRun() {
  try {
    var parsed = JSON.parse(fs.readFileSync(getRunLogPath(), 'utf8'));
    runHistory = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    runHistory = [];
  }
  var last = runHistory[runHistory.length - 1];
  if (last && !last.endedAt) {
    last.endedAt = last.lastHeartbeat;
    last.endReason = 'unexpected stop (crash, power loss or forced close)';
    previousRunReport = {
      startedAt: last.startedAt,
      endedAt: last.endedAt,
      durationMs: Math.max(0, Date.parse(last.endedAt) - Date.parse(last.startedAt)),
      endReason: last.endReason
    };
    saveRunHistory();
    console.log('[RUN] Previous run ended unexpectedly after', Math.round(previousRunReport.durationMs / 60000), 'min');
  }
}

function startRunSession() {
  if (monitoringStartedAt) return;   // already running; a re-subscribe keeps the same run
  monitoringStartedAt = Date.now();
  var iso = new Date(monitoringStartedAt).toISOString();
  currentRunEntry = { startedAt: iso, lastHeartbeat: iso, endedAt: null, endReason: null };
  runHistory.push(currentRunEntry);
  saveRunHistory();
  runHeartbeatTimer = setInterval(function() {
    if (!currentRunEntry) return;
    currentRunEntry.lastHeartbeat = new Date().toISOString();
    saveRunHistory();
  }, RUN_HEARTBEAT_MS);
  console.log('[RUN] Monitoring run started');
}

function endRunSession(reason) {
  if (!monitoringStartedAt) return;
  if (runHeartbeatTimer) { clearInterval(runHeartbeatTimer); runHeartbeatTimer = null; }
  if (currentRunEntry) {
    var mins = Math.round(runDurationMs(currentRunEntry) / 60000);
    currentRunEntry.endedAt = new Date().toISOString();
    currentRunEntry.lastHeartbeat = currentRunEntry.endedAt;
    currentRunEntry.endReason = reason;
    saveRunHistory();
    console.log('[RUN] Monitoring run ended (' + reason + ') after', mins, 'min');
  }
  currentRunEntry = null;
  monitoringStartedAt = null;
}

app.on('before-quit', function() { endRunSession('RTOM closed'); });

ipcMain.handle('run-get-status', async function() {
  var hist = runHistory.slice(-15).reverse().map(function(e) {
    return {
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      endReason: e.endReason,
      running: e === currentRunEntry,
      durationMs: runDurationMs(e)
    };
  });
  var prev = previousRunReport;
  previousRunReport = null; // the unexpected-stop report is shown once per launch
  return { success: true, monitoringStartedAt: monitoringStartedAt, previousRun: prev, history: hist };
});

const http = require('http');
const crypto = require('crypto');
const os = require('os');
let MOBILE_PORT = 3000;

// ─── RTOM settings file (userData\rtom-config.json) ─────────────────────────
// Created with defaults on first run; edit it and restart RTOM to change values.
//   eventPreSeconds / eventPostSeconds : Black Box capture window (seconds)
//   mobilePort                         : port of the phone page
//   mobileToken                        : PIN the phone must supply (auto-generated)
var rtomConfig = { eventPreSeconds: 60, eventPostSeconds: 30, mobilePort: 3000, mobileToken: '' };

function getConfigPath() {
  return path.join(app.getPath('userData'), 'rtom-config.json');
}

function loadConfig() {
  var cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')); } catch (e) { cfg = {}; }
  function num(v, def, lo, hi) { v = Number(v); return (isFinite(v) && v >= lo && v <= hi) ? v : def; }
  rtomConfig.eventPreSeconds = num(cfg.eventPreSeconds, 60, 5, 3600);
  rtomConfig.eventPostSeconds = num(cfg.eventPostSeconds, 30, 5, 3600);
  rtomConfig.mobilePort = num(cfg.mobilePort, 3000, 1024, 65535);
  rtomConfig.mobileToken = (typeof cfg.mobileToken === 'string' && cfg.mobileToken.length >= 4)
    ? cfg.mobileToken : String(crypto.randomInt(100000, 1000000));
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(rtomConfig, null, 2), 'utf8');
  } catch (e) {
    console.error('[CONFIG] Could not write config:', e.message);
  }
  EVENT_PRE_SECONDS = rtomConfig.eventPreSeconds;
  EVENT_POST_SECONDS = rtomConfig.eventPostSeconds;
  EVENT_BUFFER_MAX = Math.max(2000, EVENT_PRE_SECONDS * 10);
  MOBILE_PORT = rtomConfig.mobilePort;
  console.log('[CONFIG] Loaded', getConfigPath(), '- capture window', EVENT_PRE_SECONDS + 's before /', EVENT_POST_SECONDS + 's after');
  console.log('[CONFIG] Phone PIN:', rtomConfig.mobileToken);
}

// ─── Phone access control ────────────────────────────────────────────────────
// Every /api/* route needs the PIN (header X-RTOM-Token or ?token=). Wrong PINs
// are rate-limited per client address. This is a LAN-level safeguard: traffic is
// still plain http, so don't expose the port to untrusted networks.
var mobileFails = new Map(); // ip -> { count, until }

function authorizeMobile(req, res) {
  var ip = req.socket.remoteAddress || 'unknown';
  var rec = mobileFails.get(ip) || { count: 0, until: 0 };
  if (rec.until && Date.now() < rec.until) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end('{"error":"too many wrong PINs, try again in a few minutes"}');
    return false;
  }
  var supplied = req.headers['x-rtom-token'];
  if (!supplied) {
    var q = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '';
    var m = /(?:^|&)token=([^&]*)/.exec(q);
    if (m) { try { supplied = decodeURIComponent(m[1]); } catch (e) { supplied = m[1]; } }
  }
  var expected = String(rtomConfig.mobileToken || '');
  var ok = false;
  if (supplied && expected) {
    var a = Buffer.from(String(supplied));
    var b = Buffer.from(expected);
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (ok) { mobileFails.delete(ip); return true; }
  if (supplied) { // only WRONG pins count; a missing pin just means "show the login box"
    rec.count++;
    if (rec.count >= 8) { rec.until = Date.now() + 5 * 60 * 1000; rec.count = 0; }
    mobileFails.set(ip, rec);
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end('{"error":"unauthorized"}');
  return false;
}

// ─── Phone assistant → desktop assistant bridge ──────────────────────────────
// The desktop window owns the full assistant (answers AND commands such as
// "set max for X to 50"), so questions typed on the phone are forwarded to it.
// If the window doesn't answer within 4 s, the simple built-in answers are used.
var pendingMobileChats = new Map();
var mobileChatSeq = 0;

function askDesktopAssistant(text) {
  return new Promise(function(resolve) {
    if (!mainWindow || mainWindow.isDestroyed()) { resolve(null); return; }
    var id = ++mobileChatSeq;
    var timer = setTimeout(function() { pendingMobileChats.delete(id); resolve(null); }, 4000);
    pendingMobileChats.set(id, function(answer) { clearTimeout(timer); resolve(answer); });
    mainWindow.webContents.send('mobile-chat-request', { id: id, text: text });
  });
}

ipcMain.handle('mobile-chat-response', async function(ev, msg) {
  var cb = msg && pendingMobileChats.get(msg.id);
  if (cb) { pendingMobileChats.delete(msg.id); cb(msg.answer); }
  return { success: true };
});

// Lets the desktop show the PIN and phone links (header "Mobile" button)
ipcMain.handle('mobile-get-info', async function() {
  var urls = [];
  var ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function(name) {
    (ifaces[name] || []).forEach(function(ni) {
      if ((ni.family === 'IPv4' || ni.family === 4) && !ni.internal) {
        urls.push({ adapter: name, url: 'http://' + ni.address + ':' + MOBILE_PORT + '/?token=' + rtomConfig.mobileToken });
      }
    });
  });
  return { success: true, port: MOBILE_PORT, token: rtomConfig.mobileToken, urls: urls, configPath: getConfigPath() };
});
var mobileState = { connected: false, endpoint: '', pinnedSignals: [], alarms: [] };

ipcMain.handle('mobile-update-state', async function(ev, s) {
  if (s.connected !== undefined) mobileState.connected = s.connected;
  if (s.endpoint !== undefined) mobileState.endpoint = s.endpoint;
  if (s.pinnedSignals !== undefined) mobileState.pinnedSignals = s.pinnedSignals;
  if (s.alarms !== undefined) mobileState.alarms = s.alarms;
  return { success: true };
});

function getMobileEvents() {
  return eventCaptures.slice(0, 20).map(function(c) {
    return {
      id: c.id, triggerSignalName: c.triggerSignalName, triggerType: c.triggerType,
      triggerValue: c.triggerValue, threshold: c.threshold, startedAtISO: c.startedAtISO,
      matchedPatterns: c.matchedPatterns || [], signalCount: Object.keys(c.signals || {}).length,
      acknowledged: !!c.acknowledged
    };
  });
}

function mobileChatQuery(q) {
  var t = q.toLowerCase();
  var sigs = mobileState.pinnedSignals || [];
  var alarms = mobileState.alarms || [];
  var evts = getMobileEvents();
  if (/^(hi|hello|hey)/.test(t)) return 'Hello! Ask me about any pinned signal, alarm, or Black Box event.';
  if (/help|what can/.test(t)) return 'Try: "Any alarms?", "What signals are pinned?", "How many events?", "Are all signals normal?"';
  if (/alarm|alert/.test(t)) {
    if (!alarms.length) return '\u2705 No alarms. All signals within thresholds.';
    var u = alarms.filter(function(a){return !a.acknowledged;}).length;
    return alarms.length+' alarm(s), '+u+' unacknowledged:\n'+alarms.slice(0,5).map(function(a){return'\u2022 '+(a.signalName||'')+' \u2014 '+(a.type==='high'?'\u25b2 HIGH':'\u25bc LOW')+' at '+a.value;}).join('\n');
  }
  if (/event|black box|capture/.test(t)) {
    if (!evts.length) return 'No events captured yet. Set a threshold on a pinned signal.';
    var ev=evts[0]; return evts.length+' event(s).\nLatest: '+ev.triggerSignalName+' '+(ev.triggerType==='high'?'\u25b2 HIGH':'\u25bc LOW')+' at '+ev.triggerValue+'\nPattern: '+(ev.matchedPatterns.length?ev.matchedPatterns[0].label:'none');
  }
  if (/normal|ok|all.*signal/.test(t)) {
    var u2=alarms.filter(function(a){return !a.acknowledged;}).length;
    return u2===0&&!activeCapture?'\u2705 All clear. No unacknowledged alarms.':'\u26a0\ufe0f '+u2+' unacknowledged alarm(s).'+(activeCapture?' Active capture in progress.':'');
  }
  var m=null;
  sigs.forEach(function(s){if(!m&&t.indexOf((s.name||'').toLowerCase())!==-1)m=s;});
  if(!m){var w=t.replace(/[^a-z0-9]/g,' ').split(' ').filter(function(x){return x.length>3;});w.forEach(function(word){if(!m)m=sigs.find(function(s){return(s.name||'').toLowerCase().indexOf(word)!==-1;});});}
  if(m) return m.name+'\nValue: '+(m.value!==undefined?m.value:'no data')+'\nUpdated: '+(m.timestamp?new Date(m.timestamp).toLocaleTimeString():'unknown');
  return sigs.length?'Didn\u2019t recognise that. Pinned: '+sigs.map(function(s){return s.name;}).join(', ')+'.':'No signals pinned yet. Pin signals in the RTOM desktop app first.';
}

app.whenReady().then(function() {
  loadConfig();
  checkPreviousRun();
  var server = http.createServer(function(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    var url = req.url.split('?')[0];

    if (url === '/' || url === '/index.html') {
      try {
        var html = fs.readFileSync(path.join(__dirname, 'mobile.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch(e) { res.writeHead(500); res.end('mobile.html not found'); }
      return;
    }

    if (url.indexOf('/api/') === 0 && !authorizeMobile(req, res)) return;

    if (url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        connected: mobileState.connected, endpoint: mobileState.endpoint,
        pinnedSignals: mobileState.pinnedSignals, alarms: mobileState.alarms,
        events: getMobileEvents(),
        monitoringElapsedMs: monitoringStartedAt ? (Date.now() - monitoringStartedAt) : null,
        activeCapture: activeCapture ? { id: activeCapture.id, triggerSignalName: activeCapture.triggerSignalName, triggerType: activeCapture.triggerType } : null
      }));
      return;
    }

    if (url === '/api/chat' && req.method === 'POST') {
      var b = ''; req.on('data', function(c){b+=c;}); req.on('end', function(){
        var q = '';
        try { q = String(JSON.parse(b).query || ''); } catch(e) { res.writeHead(400); res.end('{}'); return; }
        askDesktopAssistant(q).then(function(ans) {
          var out = (ans === null || ans === undefined) ? mobileChatQuery(q) : String(ans).replace(/<[^>]*>/g, '');
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({answer: out}));
        });
      }); return;
    }

    if (url === '/api/alarms/ack' && req.method === 'POST') {
      var b2 = ''; req.on('data', function(c){b2+=c;}); req.on('end', function(){
        try { var p2=JSON.parse(b2); mobileState.alarms.forEach(function(a){ if (a.id === p2.id) a.acknowledged = true; }); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mobile-command', { type: 'ack-alarm', id: p2.id }); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"success":true}'); }
        catch(e){res.writeHead(400);res.end('{}');}
      }); return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(MOBILE_PORT, '0.0.0.0', function() {
    console.log('[MOBILE] Server ready on port', MOBILE_PORT, '\u2014 open http://<laptop-ip>:3000 on your phone');
  });
  server.on('error', function(e) { console.error('[MOBILE] Server error:', e.message); });
});


// ─── RTOM feature module (annotations, PDF report, alerts, rules) ───────────
try {
  require('./features-main').init({
    app: app, ipcMain: ipcMain, BrowserWindow: BrowserWindow,
    dialog: require('electron').dialog,
    getMainWindow: function () { return mainWindow; },
    feedEventCapture: feedEventCapture,
    normalizeVariantValue: normalizeVariantValue,
    saveToCSV: saveToCSV,
    signalNames: signalNames,
    isHistorianEnabled: function () { return historianEnabled; }
  });
} catch (e) { console.error('[FEATURES] failed to load:', e.message); }
