# OPC UA Monitor — Claude Project Context

## Project Overview
OPC UA Diagnostic Monitor is a desktop application for real-time monitoring, visualization, and historical logging of OPC UA server data. It connects to OPC UA endpoints, browses the node tree, subscribes to variable changes, plots live charts, and saves data to a local CSV/JSON historian.

## Purpose
Industrial diagnostics and monitoring tool for OPC UA servers. Used in ICS/OT environments alongside other tools like StrikeOT and SilentWatch. Primarily for observing live signal values, detecting anomalies, and exporting data.

## Tech Stack
- **Runtime:** Electron v28 (desktop app, Windows target)
- **OPC UA library:** `node-opcua` v2.117+
- **Frontend:** Vanilla JS + HTML/CSS (`app.js`, `index.html`)
- **IPC:** Electron `ipcMain` / `ipcRenderer` (via `preload.js` with `contextIsolation: true`)
- **Historian:** Local CSV + JSON files stored in Electron `userData` path under `historian/`
- **Build:** `electron-builder` → Windows NSIS installer (`dist/`)
- **Version:** 2.1.0

## Project Structure
```
opcuamonitor/
├── main.js          # Electron main process — OPC UA client, IPC handlers, historian I/O
├── preload.js       # Context bridge exposing IPC APIs to renderer
├── app.js           # Renderer process — UI logic, charts, signal table, pinned signals
├── index.html       # Main UI layout
├── assets/          # Icons, images
├── dist/            # Built installer output
├── package.json
└── node_modules/
```

## Architecture

### Main Process (`main.js`)
Owns the OPC UA connection lifecycle:
- `opcua-connect` → creates `OPCUAClient`, connects, creates session (with optional username/password)
- `opcua-browse` → browses node tree from a given nodeId (default root: `i=85`)
- `opcua-subscribe` → creates OPC UA subscription + monitored items for selected nodeIds; also starts a 1-second polling loop as a fallback
- `opcua-read` → one-shot read of a node value
- `opcua-disconnect` → terminates subscription, closes session, disconnects client
- Historian: saves numeric values to daily `data_YYYY-MM-DD.csv` and `.json` files; auto-cleans files older than 7 days

### Renderer Process (`app.js`)
- Manages UI state: connection status, node tree, signal table, graphs, pinned signals
- Receives live data via `opcua-data-changed` IPC event from main process
- Charts: `Chart.js` style maps — up to 600 data points per signal (`MAX_DATA_POINTS`)
- Per-signal thresholds (min/max), global thresholds, signal statistics (min/max/avg)
- Export: CSV export, image export of graphs
- Zoom modal for individual signal charts
- Auto-save to custom folder path

### IPC Channels (preload.js bridge)
| Channel | Direction | Purpose |
|---|---|---|
| `opcua-connect` | invoke | Connect to endpoint |
| `opcua-disconnect` | invoke | Disconnect |
| `opcua-browse` | invoke | Browse node tree |
| `opcua-subscribe` | invoke | Start monitoring nodeIds |
| `opcua-unsubscribe` | invoke | Stop monitoring |
| `opcua-read` | invoke | One-shot read |
| `opcua-data-changed` | on (event) | Live value updates |
| `historian-get-files` | invoke | List CSV files |
| `historian-toggle` | invoke | Enable/disable historian |
| `save-file` | invoke | Save export to custom path |

## Key Design Rules & Constraints
1. **`contextIsolation: true`** — renderer has NO direct access to Node.js. All IPC must go through `preload.js` context bridge. Never use `nodeIntegration: true`.
2. **Polling + subscription dual approach** — OPC UA subscription is set up first; polling at 1s interval runs in parallel as a fallback. Both push `opcua-data-changed` to renderer.
3. **Historian stores numeric values only** — `typeof value === 'number'` check is required before saving to CSV.
4. **MAX_DATA_POINTS = 600** — cap in-memory chart data to avoid memory growth.
5. **Security mode: None** — `MessageSecurityMode.None` and `SecurityPolicy.None` are the defaults. Do not add certificate handling unless explicitly requested.
6. **Connection retry:** maxRetry = 3, initialDelay = 1000ms, maxDelay = 10000ms.
7. **IPC result shape:** all handlers return `{ success: boolean, ... }` — always check `success` in renderer before using data.
8. **Node tree root:** default browse starts at `i=85` (OPC UA Objects folder).

## Common Tasks in This Project
- Adding new IPC handlers in `main.js` + corresponding preload bridge entries
- Extending the signal table (new columns, sorting, filtering)
- Adding new chart types or modifying zoom modal
- Improving historian query (e.g., load historical data into chart)
- Fixing subscription reliability issues (missed updates, stale values)
- Building the Windows installer via `electron-builder`
- Debugging Electron IPC issues (serialization errors, missing handlers)

## Running & Building
```bash
# Install dependencies
npm install

# Run in dev mode
npm start

# Build Windows installer
npm run build-win
```

## Data Storage
- **Historian path:** `%APPDATA%\opcua-diagnostic-monitor\historian\` (Electron userData)
- **Files:** `data_YYYY-MM-DD.csv` and `data_YYYY-MM-DD.json` per day
- **Retention:** 7 days (auto-cleaned on app start)
- **CSV columns:** `Timestamp, NodeId, SignalName, Value, StatusCode`

## Developer Notes
- Vignesh is the primary developer. ICS/OT background.
- This tool is part of a broader ICS monitoring ecosystem (StrikeOT for active testing, SilentWatch for passive monitoring).
- When editing `main.js`, be careful about subscription lifecycle — always terminate existing subscriptions before creating new ones.
- When editing `app.js`, note that `safeId(nodeId)` sanitizes nodeIds for use as DOM element IDs.
- The `preload.js` context bridge is the ONLY communication path between main and renderer — always add new APIs there when adding IPC handlers.
