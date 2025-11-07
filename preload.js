const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('opcua', {
  connect: (endpoint, username, password) => 
    ipcRenderer.invoke('opcua-connect', endpoint, username, password),
  
  disconnect: () => 
    ipcRenderer.invoke('opcua-disconnect'),
  
  browse: (nodeId) => 
    ipcRenderer.invoke('opcua-browse', nodeId),
  
  read: (nodeId) => 
    ipcRenderer.invoke('opcua-read', nodeId),
  
  subscribe: (nodeIds) => 
    ipcRenderer.invoke('opcua-subscribe', nodeIds),
  
  unsubscribe: () => 
    ipcRenderer.invoke('opcua-unsubscribe'),
  
  onDataChanged: (callback) => 
    ipcRenderer.on('opcua-data-changed', (event, data) => callback(data))
});