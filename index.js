// server.js - Minimal Backend Server with Socket.IO
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const APK_FILE = 'app-release.apk'; // your release APK filename
const EXTRAS = { env: 'production' }; // optional extras
const APK_URL_BASE = 'http://13.233.85.210:3000/uploads/'
const SIGNATURE_CHECKSUM = "1401f47c79a441606ff2e5857ba88ce6088f2c1796d44d9fc47ee655f533b4e";

// In-memory data storage
let customers = [
  {
    id: 1,
    name: 'Rajesh Kumar',
    phone: '9876543210',
    email: 'rajesh@example.com',
    address: 'Jaipur, Rajasthan',
    deviceId: 'device_001',
    deviceStatus: 'offline',
    lastSeen: null,
    loan: {
      id: 1,
      amount: 50000,
      emiAmount: 4500,
      tenureMonths: 12,
      paidEMIs: 3,
      overdueAmount: 9000,
      overdueDays: 15,
      status: 'active'
    }
  },
  {
    id: 2,
    name: 'Priya Sharma',
    phone: '9876543211',
    email: 'priya@example.com',
    address: 'Delhi, India',
    deviceId: 'device_002',
    deviceStatus: 'offline',
    lastSeen: null,
    loan: {
      id: 2,
      amount: 75000,
      emiAmount: 6800,
      tenureMonths: 12,
      paidEMIs: 2,
      overdueAmount: 13600,
      overdueDays: 8,
      status: 'active'
    }
  },
  {
    id: 3,
    name: 'Amit Singh',
    phone: '9876543212',
    email: 'amit@example.com',
    address: 'Mumbai, Maharashtra',
    deviceId: 'device_003',
    deviceStatus: 'locked',
    lastSeen: new Date(Date.now() - 300000), // 5 minutes ago
    loan: {
      id: 3,
      amount: 100000,
      emiAmount: 9000,
      tenureMonths: 12,
      paidEMIs: 1,
      overdueAmount: 27000,
      overdueDays: 25,
      status: 'active'
    }
  }
];

let deviceCommands = [];
let commandIdCounter = 1;

// Store active connections
const deviceConnections = new Map();
const adminConnections = new Map();

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Device registration
  socket.on('register_device', (data) => {
    try {
      const { deviceId, customerId } = data;
      console.log(`Device registration: ${deviceId} for customer ${customerId}`);
      
      // Find customer
      const customer = customers.find(c => c.id == customerId && c.deviceId === deviceId);
      if (!customer) {
        socket.emit('registration_error', { error: 'Invalid device or customer' });
        return;
      }

      // Store device connection
      deviceConnections.set(deviceId, {
        socket,
        customerId: parseInt(customerId),
        connectedAt: new Date(),
        lastSeen: new Date()
      });

      // Update customer status
      customer.deviceStatus = 'online';
      customer.lastSeen = new Date();

      socket.join(`device_${deviceId}`);
      socket.emit('registration_success', { 
        deviceId, 
        customerId,
        customer: customer,
        status: 'connected' 
      });
      
      // Notify admins
      io.to('admins').emit('device_online', {
        deviceId,
        customerId,
        customerName: customer.name
      });
      
      console.log(`Device ${deviceId} registered successfully`);
    } catch (error) {
      console.error('Device registration error:', error);
      socket.emit('registration_error', { error: error.message });
    }
  });

  // Admin registration
  socket.on('register_admin', (data) => {
    try {
      const { adminId, adminName } = data;
      
      adminConnections.set(adminId, {
        socket,
        adminName,
        connectedAt: new Date()
      });

      socket.join('admins');
      socket.emit('admin_registration_success', { 
        adminId, 
        adminName,
        status: 'connected',
        customers: customers // Send all customer data
      });
      
      console.log(`Admin ${adminName} (${adminId}) connected`);
    } catch (error) {
      console.error('Admin registration error:', error);
      socket.emit('registration_error', { error: error.message });
    }
  });

  // Device heartbeat
  socket.on('device_heartbeat', (data) => {
    try {
      const { deviceId } = data;
      const connection = deviceConnections.get(deviceId);
      
      if (connection) {
        connection.lastSeen = new Date();
        
        // Update customer last seen
        const customer = customers.find(c => c.deviceId === deviceId);
        if (customer) {
          customer.lastSeen = new Date();
        }
      }
    } catch (error) {
      console.error('Heartbeat error:', error);
    }
  });

  // Device command execution result
  socket.on('command_result', (data) => {
    try {
      const { deviceId, commandId, status, result, error } = data;
      console.log(`Command result: ${commandId} - ${status}`);
      
      // Update command status
      const command = deviceCommands.find(cmd => cmd.id == commandId);
      if (command) {
        command.status = status;
        command.result = result;
        command.error = error;
        command.completedAt = new Date();
      }

      // Update customer device status based on command
      const customer = customers.find(c => c.deviceId === deviceId);
      if (customer && status === 'success') {
        if (command.commandType === 'LOCK_DEVICE') {
          customer.deviceStatus = 'locked';
        } else if (command.commandType === 'UNLOCK_DEVICE') {
          customer.deviceStatus = 'online';
        }
      }

      // Notify admins
      io.to('admins').emit('command_completed', {
        deviceId,
        commandId,
        commandType: command?.commandType,
        status,
        result,
        error,
        customerName: customer?.name
      });

    } catch (error) {
      console.error('Command result error:', error);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    try {
      // Find and remove device connection
      for (const [deviceId, connection] of deviceConnections) {
        if (connection.socket.id === socket.id) {
          const customer = customers.find(c => c.deviceId === deviceId);
          if (customer) {
            customer.deviceStatus = customer.deviceStatus === 'locked' ? 'locked' : 'offline';
          }
          
          deviceConnections.delete(deviceId);
          
          // Notify admins
          io.to('admins').emit('device_offline', {
            deviceId,
            customerId: connection.customerId,
            customerName: customer?.name
          });
          
          console.log(`Device ${deviceId} disconnected`);
          break;
        }
      }

      // Find and remove admin connection
      for (const [adminId, connection] of adminConnections) {
        if (connection.socket.id === socket.id) {
          adminConnections.delete(adminId);
          console.log(`Admin ${connection.adminName} disconnected`);
          break;
        }
      }
    } catch (error) {
      console.error('Disconnect handling error:', error);
    }
  });
});


// Endpoint: Upload APK and generate QR
app.post('/generate-qr', async (req, res) => {
  try {
    const apkPath = path.join(UPLOAD_DIR, APK_FILE);

    if (!fs.existsSync(apkPath)) {
      console.error('Release APK not found:', apkPath);
      return;
    }

    // Full APK URL accessible by the device
    const apkUrl = `${APK_URL_BASE}${APK_FILE}`;

    // Payload for QR code (Device Owner provisioning)
    const payload = {
      "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "com.safeemiclient/.EMISafeDeviceAdmin",
      "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM": "Z6Iv_muVY8V8tRHWVr6kIyU576PAJmy9pkH3ZWq7R2M",
      "android.app.extra.PROVISIONING_DEVICE_PACKAGE_DOWNLOAD_LOCATION": apkUrl,
      "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": EXTRAS
    };

    // Generate QR code as PNG
    const qrBuffer = await QRCode.toBuffer(JSON.stringify(payload), {
      type: 'png',
      width: 400,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
    res.setHeader('Content-Type', 'image/png');
    res.send(qrBuffer);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate QR code', details: err.message });
  }
});

// Get all customers with overdue EMIs
app.get('/api/customers/overdue', (req, res) => {
  const overdueCustomers = customers.filter(c => c.loan.overdueAmount > 0);
  res.json(overdueCustomers);
});

// Get all customers
app.get('/api/customers', (req, res) => {
  res.json(customers);
});

// Send device command
app.post('/api/device-control/command', (req, res) => {
  try {

    const { customerId, command, payload } = req.body;

    // Find customer
    const customer = customers.find(c => c.id == customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const { deviceId, deviceStatus } = customer;

    // Create command record
    const newCommand = {
      id: commandIdCounter++,
      customerId: parseInt(customerId),
      deviceId,
      commandType: command,
      payload: payload || {},
      status: 'pending',
      createdAt: new Date(),
      completedAt: null,
      result: null,
      error: null
    };

    deviceCommands.push(newCommand);

    // Check if device is connected
    const deviceConnection = deviceConnections.get(deviceId);
    
    if (deviceConnection) {
      // Send command to device
      deviceConnection.socket.emit('device_command', {
        commandId: newCommand.id,
        command,
        payload: payload || {}
      });

      res.json({ 
        success: true, 
        commandId: newCommand.id, 
        message: `Command ${command} sent to device ${deviceId}` 
      });
    } else {
      newCommand.status = 'failed';
      newCommand.error = 'Device not connected';
      res.status(400).json({ 
        error: 'Device not connected',
        deviceStatus 
      });
    }
  } catch (error) {
    console.error('Command sending error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get device command history
app.get('/api/device-control/commands/:customerId', (req, res) => {
  const { customerId } = req.params;
  const customerCommands = deviceCommands
    .filter(cmd => cmd.customerId == customerId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20); // Last 20 commands

  res.json(customerCommands);
});

// Get customer loan details
app.get('/api/customer/:customerId/loan', (req, res) => {
  const { customerId } = req.params;
  const customer = customers.find(c => c.id == customerId);
  
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  res.json(customer);
});

// Dashboard stats
app.get('/api/dashboard/stats', (req, res) => {
  const stats = {
    totalCustomers: customers.length,
    onlineDevices: customers.filter(c => c.deviceStatus === 'online').length,
    lockedDevices: customers.filter(c => c.deviceStatus === 'locked').length,
    commandsToday: deviceCommands.filter(cmd => {
      const today = new Date();
      const cmdDate = new Date(cmd.createdAt);
      return cmdDate.toDateString() === today.toDateString();
    }).length,
    totalOverdueAmount: customers.reduce((sum, c) => sum + (c.loan.overdueAmount || 0), 0)
  };

  res.json(stats);
});

// Test endpoints

// Simulate payment received
app.post('/api/test/payment/:customerId', (req, res) => {
  const { customerId } = req.params;
  const { amount } = req.body;
  
  const customer = customers.find(c => c.id == customerId);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  // Simulate payment processing
  const paidAmount = amount || customer.loan.emiAmount;
  customer.loan.overdueAmount = Math.max(0, customer.loan.overdueAmount - paidAmount);
  customer.loan.paidEMIs++;
  
  if (customer.loan.overdueAmount === 0) {
    customer.loan.overdueDays = 0;
  }

  // Notify device if connected
  const deviceConnection = deviceConnections.get(customer.deviceId);
  if (deviceConnection) {
    deviceConnection.socket.emit('payment_received', {
      amount: paidAmount,
      remainingOverdue: customer.loan.overdueAmount
    });
  }

  // Notify admins
  io.to('admins').emit('payment_received', {
    customerId: customer.id,
    customerName: customer.name,
    amount: paidAmount,
    remainingOverdue: customer.loan.overdueAmount
  });

  res.json({ 
    success: true, 
    message: 'Payment processed',
    newOverdueAmount: customer.loan.overdueAmount
  });
});

// Reset customer data
app.post('/api/test/reset/:customerId', (req, res) => {
  const { customerId } = req.params;
  const customer = customers.find(c => c.id == customerId);
  
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  // Reset to original overdue state
  customer.deviceStatus = 'offline';
  customer.loan.overdueAmount = customer.loan.emiAmount * (4 - customer.loan.paidEMIs);
  customer.loan.overdueDays = 5 + (customer.id * 5); // Different overdue days
  
  res.json({ success: true, message: 'Customer data reset' });
});

// Emergency unlock (simulate customer service action)
app.post('/api/test/emergency-unlock/:customerId', (req, res) => {
  const { customerId } = req.params;
  const customer = customers.find(c => c.id == customerId);
  
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  customer.deviceStatus = 'online';
  
  // Notify device
  const deviceConnection = deviceConnections.get(customer.deviceId);
  if (deviceConnection) {
    deviceConnection.socket.emit('emergency_unlock', {
      reason: 'Customer service override',
      duration: 30 // 30 minutes
    });
  }

  res.json({ success: true, message: 'Emergency unlock activated' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 EMI Safe server running on port ${PORT}`);
});