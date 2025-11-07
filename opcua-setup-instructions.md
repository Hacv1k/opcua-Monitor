# OPC UA Diagnostic Monitor - Desktop App Setup Guide

## 📋 Prerequisites

Before you begin, make sure you have:

1. **Node.js** (v18 or higher) - [Download here](https://nodejs.org/)
2. **Git** (optional) - [Download here](https://git-scm.com/)
3. Your OPC UA server endpoint (e.g., `opc.tcp://127.0.0.1:48010`)

---

## 🚀 Quick Start Installation

### Step 1: Create Project Folder

```bash
mkdir opcua-diagnostic-monitor
cd opcua-diagnostic-monitor
```

### Step 2: Create Required Files

Create these 5 files in your project folder:

#### 1. `package.json`
Copy the package.json content from the first artifact

#### 2. `main.js`
Copy the main.js content from the first artifact

#### 3. `preload.js`
Copy the preload.js content from the first artifact

#### 4. `index.html`
Copy the index.html content from the first artifact

#### 5. `app.js`
Copy the app.js content from the second artifact

### Step 3: Install Dependencies

```bash
npm install
```

This will install:
- `electron` - Desktop app framework
- `node-opcua` - OPC UA client library
- `electron-builder` - For creating installers

### Step 4: Run the Application

```bash
npm start
```

The application window should open!

---

## 🎯 How to Use

### 1. Connect to OPC UA Server

1. Enter your OPC UA endpoint (e.g., `opc.tcp://127.0.0.50:48012`)
2. Optionally enter username/password if required
3. Click **Connect**

### 2. Browse Node Tree

- The left panel shows your OPC UA server's node structure
- Click the arrows to expand folders
- Click on any folder to explore its contents

### 3. Select Diagnostics Folder

- Navigate to your **MBTCP > Diagnostics** folder
- Click on the Diagnostics folder
- All numeric signals will appear in the table

### 4. Start Monitoring

1. Check/uncheck signals you want to monitor
2. Click **Start Monitoring**
3. Real-time graphs will appear for each selected signal
4. Values update every second

### 5. Export Data

- Click **Export CSV** to download all current data
- File includes timestamps, signal names, and values

---

## 📦 Create Installer (Optional)

To create an installable application:

### For Windows:
```bash
npm run build-win
```
Creates: `dist/OPC UA Diagnostic Monitor Setup.exe`

### For macOS:
```bash
npm run build-mac
```
Creates: `dist/OPC UA Diagnostic Monitor.dmg`

### For Linux:
```bash
npm run build-linux
```
Creates: `dist/OPC UA Diagnostic Monitor.AppImage`

The installer will be in the `dist` folder.

---

## 🔧 Configuration

### Change Server Endpoint Default

Edit `index.html`, line with endpoint input:
```html
value="opc.tcp://YOUR-SERVER-IP:PORT"
```

### Adjust Update Frequency

Edit `main.js`, in the subscription section:
```javascript
requestedPublishingInterval: 1000, // Change to desired milliseconds
```

### Adjust Data Retention

Edit `app.js`:
```javascript
const MAX_DATA_POINTS = 60; // Change to desired number of data points
```

---

## 🐛 Troubleshooting

### "Cannot connect to OPC UA server"
- Verify the endpoint URL is correct
- Check if OPC UA server is running
- Ensure firewall allows connection
- Try with anonymous authentication first

### "No signals detected"
- Make sure you're selecting a folder with Variable nodes
- Check if the variables have numeric data types
- Some nodes may not be readable

### "Application won't start"
- Make sure Node.js is installed: `node --version`
- Delete `node_modules` and run `npm install` again
- Check console for error messages

### "Graphs not updating"
- Verify the OPC UA server supports subscriptions
- Check the subscription interval in main.js
- Look for errors in Developer Tools (uncomment `openDevTools()` in main.js)

---

## 📝 Project Structure

```
opcua-diagnostic-monitor/
├── package.json          # Project configuration
├── main.js              # Electron main process (OPC UA logic)
├── preload.js           # Bridge between main and renderer
├── index.html           # UI structure
├── app.js               # Frontend logic
├── node_modules/        # Dependencies (created by npm install)
└── dist/                # Built installers (created by build command)
```

---

## 🔐 Security Notes

- This app connects directly to OPC UA servers
- Credentials are not stored permanently
- For production use, consider implementing:
  - Certificate-based authentication
  - Encrypted credential storage
  - Connection profiles/presets

---

## 🎨 Customization

### Change Theme Colors

Edit `index.html` Tailwind classes:
- `bg-gray-900` - Background color
- `bg-gray-800` - Card backgrounds
- `text-blue-400` - Accent color

### Add More Graph Options

Edit `app.js` Chart.js configuration in `createChart()` function

### Modify Node Tree Icons

Edit `app.js` in `browseNode()` function where icons are set

---

## 📞 Support

If you encounter issues:

1. Check the console for errors (View > Toggle Developer Tools)
2. Verify OPC UA server is accessible
3. Test connection with UA Expert first
4. Check Node.js and Electron versions

---

## ✨ Features

✅ Real OPC UA connection (not simulated)  
✅ Browse entire node tree  
✅ Select any folder for monitoring  
✅ Real-time graphs (updates every second)  
✅ Multiple signals simultaneously  
✅ Export data to CSV  
✅ Connection status indicator  
✅ Optional authentication  
✅ Cross-platform (Windows, Mac, Linux)  

---

## 🚀 Next Steps

1. Install dependencies: `npm install`
2. Run the app: `npm start`
3. Connect to your OPC UA server
4. Navigate to MBTCP > Diagnostics
5. Start monitoring!

Enjoy your new OPC UA Diagnostic Monitor! 🎉