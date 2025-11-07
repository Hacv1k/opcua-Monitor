{
  "name": "opcua-diagnostic-monitor",
  "version": "1.0.0",
  "description": "OPC UA Diagnostic Monitor Desktop App",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder",
    "build-win": "electron-builder --win",
    "build-mac": "electron-builder --mac",
    "build-linux": "electron-builder --linux"
  },
  "build": {
    "appId": "com.opcua.diagnosticmonitor",
    "productName": "OPC UA Diagnostic Monitor",
    "directories": {
      "output": "dist"
    },
    "win": {
      "target": "nsis",
      "icon": "icon.ico"
    },
    "mac": {
      "target": "dmg",
      "icon": "icon.icns"
    },
    "linux": {
      "target": "AppImage",
      "icon": "icon.png"
    }
  },
  "dependencies": {
    "node-opcua": "^2.117.0"
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^24.9.1"
  }
}