// app.js - Frontend Logic for OPC UA Desktop Monitor

let isConnected = false;
let isMonitoring = false;
let selectedNodes = [];
let charts = new Map();
let chartData = new Map();
const MAX_DATA_POINTS = 60;
const colors = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', 
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
];

// DOM Elements
const connectBtn = document.getElementById('connectBtn');
const endpointInput = document.getElementById('endpoint');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const mainContent = document.getElementById('mainContent');
const disconnectedState = document.getElementById('disconnectedState');
const nodeTree = document.getElementById('nodeTree');
const controlPanel = document.getElementById('controlPanel');
const emptyState = document.getElementById('emptyState');
const signalTable = document.getElementById('signalTable');
const graphsContainer = document.getElementById('graphsContainer');
const monitorBtn = document.getElementById('monitorBtn');
const clearBtn = document.getElementById('clearBtn');
const exportBtn = document.getElementById('exportBtn');
const folderName = document.getElementById('folderName');
const signalCount = document.getElementById('signalCount');

// Connect/Disconnect Handler
connectBtn.addEventListener('click', async () => {
  if (isConnected) {
    await disconnect();
  } else {
    await connect();
  }
});

async function connect() {
  const endpoint = endpointInput.value.trim();
  const username = usernameInput.value.trim() || null;
  const password = passwordInput.value.trim() || null;

  if (!endpoint) {
    alert('Please enter an OPC UA endpoint');
    return;
  }

  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting...';

  try {
    const result = await window.opcua.connect(endpoint, username, password);
    
    if (result.success) {
      isConnected = true;
      statusIndicator.className = 'w-3 h-3 rounded-full bg-green-500';
      statusText.textContent = 'Connected';
      connectBtn.textContent = 'Disconnect';
      connectBtn.className = 'w-full px-6 py-2 bg-red-600 hover:bg-red-700 rounded font-medium transition-colors';
      
      disconnectedState.classList.add('hidden');
      mainContent.classList.remove('hidden');
      
      // Browse root node
      await browseNode('i=85', nodeTree);
    } else {
      alert(`Connection failed: ${result.message}`);
      connectBtn.textContent = 'Connect';
    }
  } catch (error) {
    alert(`Error: ${error.message}`);
    connectBtn.textContent = 'Connect';
  }
  
  connectBtn.disabled = false;
}

async function disconnect() {
  if (isMonitoring) {
    await stopMonitoring();
  }

  await window.opcua.disconnect();
  
  isConnected = false;
  statusIndicator.className = 'w-3 h-3 rounded-full bg-gray-600';
  statusText.textContent = 'Disconnected';
  connectBtn.textContent = 'Connect';
  connectBtn.className = 'w-full px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded font-medium transition-colors';
  
  mainContent.classList.add('hidden');
  disconnectedState.classList.remove('hidden');
  nodeTree.innerHTML = '';
  controlPanel.classList.add('hidden');
  emptyState.classList.remove('hidden');
  selectedNodes = [];
}

// Browse Node Tree
async function browseNode(nodeId, containerElement, level = 0) {
  const result = await window.opcua.browse(nodeId);
  
  if (!result.success) {
    console.error('Browse failed:', result.message);
    return;
  }

  for (const node of result.nodes) {
    const nodeDiv = document.createElement('div');
    nodeDiv.className = 'select-none';
    
    const nodeContent = document.createElement('div');
    nodeContent.className = 'flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-gray-700 rounded';
    nodeContent.style.paddingLeft = `${level * 16 + 8}px`;
    
    // Expand/Collapse arrow
    if (node.hasChildren) {
      const arrow = document.createElement('span');
      arrow.textContent = '▶';
      arrow.className = 'text-gray-400 text-xs';
      nodeContent.appendChild(arrow);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'text-xs';
      spacer.innerHTML = '&nbsp;&nbsp;';
      nodeContent.appendChild(spacer);
    }
    
    // Icon
    const icon = document.createElement('span');
    if (node.nodeClass === 'Object') {
      icon.innerHTML = '📁';
    } else if (node.nodeClass === 'Variable') {
      icon.innerHTML = '📊';
    } else {
      icon.innerHTML = '📄';
    }
    nodeContent.appendChild(icon);
    
    // Node name
    const nameSpan = document.createElement('span');
    nameSpan.textContent = node.displayName;
    nameSpan.className = 'text-sm text-gray-200';
    nodeContent.appendChild(nameSpan);
    
    // Value for variables
    if (node.nodeClass === 'Variable' && node.value !== null) {
      const valueSpan = document.createElement('span');
      valueSpan.textContent = ` = ${node.value}`;
      valueSpan.className = 'text-xs text-gray-500 ml-auto';
      nodeContent.appendChild(valueSpan);
    }
    
    nodeDiv.appendChild(nodeContent);
    
    // Child container
    const childContainer = document.createElement('div');
    childContainer.className = 'hidden';
    nodeDiv.appendChild(childContainer);
    
    // Click handler
    let expanded = false;
    nodeContent.addEventListener('click', async () => {
      if (node.hasChildren) {
        expanded = !expanded;
        const arrow = nodeContent.querySelector('span');
        arrow.textContent = expanded ? '▼' : '▶';
        childContainer.classList.toggle('hidden');
        
        if (expanded && childContainer.children.length === 0) {
          await browseNode(node.nodeId, childContainer, level + 1);
        }
      }
      
      // If it's an object with children, allow selection for monitoring
      if (node.nodeClass === 'Object' && node.hasChildren) {
        await selectFolder(node);
      }
    });
    
    containerElement.appendChild(nodeDiv);
  }
}

// Select Folder for Monitoring
async function selectFolder(node) {
  const result = await window.opcua.browse(node.nodeId);
  
  if (!result.success) {
    alert('Failed to browse folder');
    return;
  }
  
  // Filter only numeric variables
  const variables = result.nodes.filter(n => n.nodeClass === 'Variable' && n.isNumeric);
  
  if (variables.length === 0) {
    alert('No numeric signals found in this folder');
    return;
  }
  
  selectedNodes = variables.map(v => ({
    nodeId: v.nodeId,
    name: v.displayName,
    value: v.value,
    selected: true,
    statusCode: v.statusCode
  }));
  
  folderName.textContent = node.displayName;
  signalCount.textContent = `${selectedNodes.length} signals detected`;
  
  updateSignalTable();
  emptyState.classList.add('hidden');
  controlPanel.classList.remove('hidden');
}

// Update Signal Table
function updateSignalTable() {
  signalTable.innerHTML = '';
  
  selectedNodes.forEach((signal, index) => {
    const row = document.createElement('tr');
    row.className = 'border-b border-gray-700 hover:bg-gray-750';
    
    row.innerHTML = `
      <td class="py-2 px-3">
        <input type="checkbox" ${signal.selected ? 'checked' : ''} 
               data-index="${index}" class="signal-checkbox w-4 h-4">
      </td>
      <td class="py-2 px-3 font-medium">${signal.name}</td>
      <td class="py-2 px-3 font-mono" id="value-${index}">
        ${signal.value !== null ? signal.value.toFixed(2) : '-'}
      </td>
      <td class="py-2 px-3 text-xs text-gray-500">${signal.nodeId}</td>
      <td class="py-2 px-3 text-xs">
        <span class="px-2 py-1 rounded ${signal.statusCode === 'Good' ? 'bg-green-600' : 'bg-yellow-600'}">
          ${signal.statusCode}
        </span>
      </td>
    `;
    
    signalTable.appendChild(row);
  });
  
  // Add checkbox listeners
  document.querySelectorAll('.signal-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const index = parseInt(e.target.dataset.index);
      selectedNodes[index].selected = e.target.checked;
      
      if (isMonitoring) {
        if (e.target.checked) {
          createChart(selectedNodes[index], index);
        } else {
          removeChart(selectedNodes[index].nodeId);
        }
      }
    });
  });
}

// Monitoring Controls
monitorBtn.addEventListener('click', async () => {
  if (isMonitoring) {
    await stopMonitoring();
  } else {
    await startMonitoring();
  }
});

async function startMonitoring() {
  const nodesToMonitor = selectedNodes
    .filter(s => s.selected)
    .map(s => s.nodeId);
  
  if (nodesToMonitor.length === 0) {
    alert('Please select at least one signal to monitor');
    return;
  }
  
  const result = await window.opcua.subscribe(nodesToMonitor);
  
  if (result.success) {
    isMonitoring = true;
    monitorBtn.textContent = 'Stop Monitoring';
    monitorBtn.className = 'px-6 py-2 bg-red-600 hover:bg-red-700 rounded font-medium';
    
    // Create charts
    graphsContainer.innerHTML = '';
    selectedNodes.forEach((signal, index) => {
      if (signal.selected) {
        createChart(signal, index);
      }
    });
  } else {
    alert(`Failed to start monitoring: ${result.message}`);
  }
}

async function stopMonitoring() {
  await window.opcua.unsubscribe();
  isMonitoring = false;
  monitorBtn.textContent = 'Start Monitoring';
  monitorBtn.className = 'px-6 py-2 bg-green-600 hover:bg-green-700 rounded font-medium';
  
  // Destroy all charts
  charts.forEach(chart => chart.destroy());
  charts.clear();
  chartData.clear();
  graphsContainer.innerHTML = '';
}

// Create Chart for Signal
function createChart(signal, colorIndex) {
  const chartContainer = document.createElement('div');
  chartContainer.className = 'bg-gray-800 rounded-lg p-4 shadow-lg';
  chartContainer.id = `chart-container-${signal.nodeId}`;
  
  chartContainer.innerHTML = `
    <h4 class="font-semibold mb-2 text-sm">${signal.name}</h4>
    <canvas id="chart-${signal.nodeId}"></canvas>
  `;
  
  graphsContainer.appendChild(chartContainer);
  
  const ctx = document.getElementById(`chart-${signal.nodeId}`).getContext('2d');
  
  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: signal.name,
        data: [],
        borderColor: colors[colorIndex % colors.length],
        backgroundColor: colors[colorIndex % colors.length] + '20',
        borderWidth: 2,
        tension: 0.4,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          display: true,
          ticks: { color: '#9ca3af', maxTicksLimit: 6 },
          grid: { color: '#374151' }
        },
        y: {
          display: true,
          ticks: { color: '#9ca3af' },
          grid: { color: '#374151' }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1f2937',
          borderColor: '#374151',
          borderWidth: 1
        }
      }
    }
  });
  
  charts.set(signal.nodeId, chart);
  chartData.set(signal.nodeId, []);
}

function removeChart(nodeId) {
  const chart = charts.get(nodeId);
  if (chart) {
    chart.destroy();
    charts.delete(nodeId);
  }
  
  chartData.delete(nodeId);
  
  const container = document.getElementById(`chart-container-${nodeId}`);
  if (container) {
    container.remove();
  }
}

// Listen for OPC UA Data Changes
window.opcua.onDataChanged((data) => {
  // Update table value
  const index = selectedNodes.findIndex(s => s.nodeId === data.nodeId);
  if (index !== -1) {
    selectedNodes[index].value = data.value;
    const valueCell = document.getElementById(`value-${index}`);
    if (valueCell) {
      valueCell.textContent = data.value.toFixed(2);
    }
  }
  
  // Update chart
  const chart = charts.get(data.nodeId);
  const dataArray = chartData.get(data.nodeId);
  
  if (chart && dataArray) {
    const time = new Date(data.timestamp).toLocaleTimeString();
    
    dataArray.push({ time, value: data.value });
    
    // Keep only last MAX_DATA_POINTS
    if (dataArray.length > MAX_DATA_POINTS) {
      dataArray.shift();
    }
    
    chart.data.labels = dataArray.map(d => d.time);
    chart.data.datasets[0].data = dataArray.map(d => d.value);
    chart.update('none');
  }
});

// Clear Graphs
clearBtn.addEventListener('click', () => {
  chartData.forEach((data, nodeId) => {
    const chart = charts.get(nodeId);
    if (chart) {
      chartData.set(nodeId, []);
      chart.data.labels = [];
      chart.data.datasets[0].data = [];
      chart.update();
    }
  });
});

// Export to CSV
exportBtn.addEventListener('click', () => {
  let csv = 'Timestamp,Signal,Value,NodeId\n';
  
  chartData.forEach((data, nodeId) => {
    const signal = selectedNodes.find(s => s.nodeId === nodeId);
    data.forEach(point => {
      csv += `${point.time},${signal.name},${point.value},${nodeId}\n`;
    });
  });
  
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `opcua-diagnostics-${new Date().toISOString()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});