const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { 
  OPCUAClient, 
  MessageSecurityMode, 
  SecurityPolicy,
  AttributeIds,
  DataType
} = require('node-opcua');

let mainWindow;
let opcuaClient = null;
let session = null;
let subscription = null;
let monitoredItems = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icon.png')
  });

  mainWindow.loadFile('index.html');
  
  // Open DevTools in development
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (opcuaClient) {
    disconnectOPCUA();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// OPC UA Connection Handler
ipcMain.handle('opcua-connect', async (event, endpoint, username, password) => {
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
    
    return { success: true, message: 'Connected successfully' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// OPC UA Disconnect Handler
ipcMain.handle('opcua-disconnect', async () => {
  try {
    await disconnectOPCUA();
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

async function disconnectOPCUA() {
  if (subscription) {
    await subscription.terminate();
    subscription = null;
  }
  monitoredItems.clear();
  
  if (session) {
    await session.close();
    session = null;
  }
  
  if (opcuaClient) {
    await opcuaClient.disconnect();
    opcuaClient = null;
  }
}

// Browse Node Tree
ipcMain.handle('opcua-browse', async (event, nodeId) => {
  try {
    if (!session) {
      return { success: false, message: 'Not connected' };
    }

    const browseResult = await session.browse(nodeId || 'i=85'); // Root folder
    
    const nodes = await Promise.all(
      browseResult.references.map(async (ref) => {
        const node = {
          nodeId: ref.nodeId.toString(),
          browseName: ref.browseName.name,
          displayName: ref.displayName?.text || ref.browseName.name,
          nodeClass: ref.nodeClass.toString(),
          isForward: ref.isForward
        };

        // Check if it has children
        try {
          const childBrowse = await session.browse(ref.nodeId);
          node.hasChildren = childBrowse.references.length > 0;
        } catch (e) {
          node.hasChildren = false;
        }

        // If it's a variable, get its data type and value
        if (ref.nodeClass.toString() === 'Variable') {
          try {
            const dataValue = await session.read({
              nodeId: ref.nodeId,
              attributeId: AttributeIds.Value
            });
            
            const dataType = await session.read({
              nodeId: ref.nodeId,
              attributeId: AttributeIds.DataType
            });

            node.value = dataValue.value.value;
            node.dataType = dataType.value.value.toString();
            node.statusCode = dataValue.statusCode.toString();
            
            // Check if numeric
            node.isNumeric = [
              DataType.Double, 
              DataType.Float, 
              DataType.Int16, 
              DataType.Int32, 
              DataType.UInt16, 
              DataType.UInt32,
              DataType.Byte,
              DataType.SByte
            ].includes(dataValue.value.dataType);
          } catch (e) {
            node.value = null;
          }
        }

        return node;
      })
    );

    return { success: true, nodes };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// Read Node Value
ipcMain.handle('opcua-read', async (event, nodeId) => {
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
      value: dataValue.value.value,
      timestamp: dataValue.sourceTimestamp,
      statusCode: dataValue.statusCode.toString()
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// Subscribe to Nodes
ipcMain.handle('opcua-subscribe', async (event, nodeIds) => {
  try {
    if (!session) {
      return { success: false, message: 'Not connected' };
    }

    // Clean up existing subscription
    if (subscription) {
      await subscription.terminate();
      subscription = null;
      monitoredItems.clear();
    }

    // Create new subscription
    subscription = await session.createSubscription2({
      requestedPublishingInterval: 1000,
      requestedLifetimeCount: 100,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 100,
      publishingEnabled: true,
      priority: 10
    });

    subscription.on('started', () => {
      console.log('Subscription started');
    });

    // Monitor each node
    for (const nodeId of nodeIds) {
      const itemToMonitor = {
        nodeId: nodeId,
        attributeId: AttributeIds.Value
      };

      const monitoredItem = await subscription.monitor(
        itemToMonitor,
        {
          samplingInterval: 1000,
          discardOldest: true,
          queueSize: 10
        }
      );

      monitoredItem.on('changed', (dataValue) => {
        mainWindow.webContents.send('opcua-data-changed', {
          nodeId: nodeId,
          value: dataValue.value.value,
          timestamp: dataValue.sourceTimestamp.toISOString(),
          statusCode: dataValue.statusCode.toString()
        });
      });

      monitoredItems.set(nodeId, monitoredItem);
    }

    return { success: true, message: `Monitoring ${nodeIds.length} nodes` };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// Unsubscribe
ipcMain.handle('opcua-unsubscribe', async () => {
  try {
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