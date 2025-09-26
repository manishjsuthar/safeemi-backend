const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const QRCode = require("qrcode");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv");
const bcrypt = require("bcrypt");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const pool = new Pool({
  host: "35.154.227.178",
  port: 5432,
  database: "emisafe",
  user: "postgres",
  password: "root",
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const UPLOAD_DIR = path.join(__dirname, "uploads");
const APK_FILE = "app-release.apk";

async function updateLastSeen(imei) {
  try {
    const query = `
      UPDATE device_loans
      SET last_active = NOW()
      WHERE imei = $1
      RETURNING *;
    `;
    const { rows } = await pool.query(query, [imei]);

    if (rows.length === 0) {
      return null;
    }

    return rows[0];
  } catch (error) {
    console.error("Error updating last_seen:", error);
    throw error;
  }
}

async function getCustomerByDeviceId(id) {
  try {
    const query = `
      SELECT c.*
      FROM device_loans dl
      JOIN customers c ON dl.customer_id = c.id
      WHERE dl.imei = $1
    `;
    const { rows } = await pool.query(query, [id]);

    if (rows.length === 0) return null;

    return rows[0];
  } catch (error) {
    console.error("Error fetching customer:", error);
    throw error;
  }
}

let deviceCommands = [];

// Store active connections
const deviceConnections = new Map();
const adminConnections = new Map();

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on("register_device", async (data) => {
    try {
      const { deviceId } = data;
      console.log(`Device registration: ${deviceId} for customer ${1}`);

      const customer = await getCustomerByDeviceId(deviceId);
      if (!customer) {
        socket.emit("registration_error", {
          error: "Invalid device or customer",
        });
        return;
      }

      deviceConnections.set(deviceId, {
        socket,
        customerId: parseInt(customer.id),
        connectedAt: new Date(),
        lastSeen: new Date(),
      });

      customer.deviceStatus = "online";
      await updateLastSeen(deviceId);

      socket.join(`device_${deviceId}`);
      socket.emit("registration_success", {
        deviceId,
        customerId: customer.id,
        customer: customer,
        status: "connected",
      });

      io.to("admins").emit("device_online", {
        deviceId,
        customerId: customer.id,
        customerName: customer.name,
      });

      console.log(`Device ${deviceId} registered successfully`);
    } catch (error) {
      console.error("Device registration error:", error);
      socket.emit("registration_error", { error: error.message });
    }
  });

  socket.on("register_admin", (data) => {
    try {
      const { adminId, adminName } = data;

      adminConnections.set(adminId, {
        socket,
        adminName,
        connectedAt: new Date(),
      });

      socket.join("admins");
      // socket.emit("admin_registration_success", {
      //   adminId,
      //   adminName,
      //   status: "connected",
      // });

      console.log(`Admin ${adminName} (${adminId}) connected`);
    } catch (error) {
      console.error("Admin registration error:", error);
      socket.emit("registration_error", { error: error.message });
    }
  });

  socket.on("device_heartbeat", async (data) => {
    try {
      const { deviceId } = data;
      const connection = deviceConnections.get(deviceId);

      if (connection) {
        await updateLastSeen(deviceId);
      }
    } catch (error) {
      console.error("Heartbeat error:", error);
    }
  });

  socket.on("location_update", async (data) => {
    try {
      console.log("location_update ", data);
    } catch (error) {
      console.error("location_update error:", error);
    }
  });

  socket.on("command_result", async (data) => {
    try {
      const { deviceId, commandId, status, result } = data;
      console.log(`Command result: ${commandId} - ${result}`);

      const query = `
        UPDATE command_history
        SET "updatedAt" = $1, status = $2, result=$3
        WHERE id=$4
        RETURNING *;
      `;
      const { rows } = await pool.query(query, [new Date(), status, result, commandId]);

      // const customer = await getCustomerByDeviceId(deviceId);
      // if (customer && status === "success") {
      //   if (command.commandType === "LOCK_DEVICE") {
      //     customer.deviceStatus = "locked";
      //   } else if (command.commandType === "UNLOCK_DEVICE") {
      //     customer.deviceStatus = "online";
      //   }
      // }

      io.to("admins").emit(`command_completed`, {
        deviceId,
        commandId,
        commandType: rows[0]?.commandType,
        status,
        result,
      });
    } catch (error) {
      console.error("Command result error:", error);
    }
  });

  socket.on("disconnect", async () => {
    try {
      for (const [deviceId, connection] of deviceConnections) {
        if (connection.socket.id === socket.id) {
          const customer = await getCustomerByDeviceId(deviceId);
          if (customer) {
            customer.deviceStatus =
              customer.deviceStatus === "locked" ? "locked" : "offline";
          }

          deviceConnections.delete(deviceId);

          io.to("admins").emit(`device_offline-${connection.customerId}`, {
            deviceId,
            customerId: connection.customerId,
            customerName: customer?.name,
          });

          console.log(`Device ${deviceId} disconnected`);
          break;
        }
      }

      for (const [adminId, connection] of adminConnections) {
        if (connection.socket.id === socket.id) {
          adminConnections.delete(adminId);
          console.log(`Admin ${connection.adminName} disconnected`);
          break;
        }
      }
    } catch (error) {
      console.error("Disconnect handling error:", error);
    }
  });
});

function generateEMISchedule(totalEmis, emiAmount, startDate) {
  const emiHistory = [];
  let currentDate = new Date(startDate);

  for (let i = 0; i < totalEmis; i++) {
    emiHistory.push({
      month: currentDate.toLocaleString("default", { month: "short" }),
      paid: false,
      amount: emiAmount,
      paid_date: currentDate.toISOString().split("T")[0], // YYYY-MM-DD
    });

    currentDate.setMonth(currentDate.getMonth() + 1);
  }

  return emiHistory;
}

app.get("/api/commandHistory", async (req, res) => {
  try {
    const deviceId = req.query.deviceId
    const result = await pool.query(
      `SELECT c.* FROM command_history as c where "deviceId"=$1 ORDER BY c."updatedAt" DESC`, [deviceId]
    );
    res.json(result.rows ?? []);
  } catch (err) {
    console.error("Error fetching dealers:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/customers", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      dealerId,
      name,
      phone,
      email,
      address,
      deviceIMEI,
      deviceModel,
      isLocked,
      loan,
    } = req.body;

    if (!dealerId)
      return res.status(400).json({ error: "dealerId is required" });

    await client.query("BEGIN");

    const customerResult = await client.query(
      `INSERT INTO customers (dealer_id, name, phone, email, address)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [dealerId, name, phone, email, address]
    );
    const customerId = customerResult.rows[0].id;

    const deviceLoanResult = await client.query(
      `INSERT INTO device_loans (customer_id, imei, model, is_locked, loan_amount, emi_amount, total_emis)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        customerId,
        deviceIMEI,
        deviceModel,
        isLocked || false,
        loan.amount,
        loan.emiAmount,
        loan.totalEmis,
      ]
    );

    const deviceLoanId = deviceLoanResult.rows[0].id;

    const startDate = loan.startDate || new Date(); // use loan.startDate if provided
    const emiHistory = generateEMISchedule(
      loan.totalEmis,
      loan.emiAmount,
      startDate
    );

    const emiInsertPromises = emiHistory.map((emi) =>
      client.query(
        `INSERT INTO emi_history (device_loan_id, month, paid, amount, paid_date)
         VALUES ($1,$2,$3,$4,$5)`,
        [deviceLoanId, emi.month, emi.paid, emi.amount, emi.paid_date]
      )
    );
    await Promise.all(emiInsertPromises);

    await client.query("COMMIT");
    res.json({ success: true, customerId, deviceLoanId, emiHistory });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error creating customer:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

app.get("/api/customers", async (req, res) => {
  const dealerId = req.query.dealerId;
  if (!dealerId) return res.status(400).json({ error: "dealerId is required" });

  try {
    const customersRes = await pool.query(
      `SELECT * FROM customers WHERE dealer_id=$1`,
      [dealerId]
    );

    const customers = [];
    const today = new Date();

    for (const customer of customersRes.rows) {
      const deviceRes = await pool.query(
        `SELECT * FROM device_loans WHERE customer_id=$1`,
        [customer.id]
      );

      for (const device of deviceRes.rows) {
        const emiRes = await pool.query(
          `SELECT * FROM emi_history WHERE device_loan_id=$1 ORDER BY id`,
          [device.id]
        );

        const emiHistory = emiRes.rows.map((e) => ({
          month: e.month,
          paid: e.paid,
          amount: parseFloat(e.amount),
          paid_date: e.paid_date,
          id: e.id,
        }));

        let overdueAmount = 0;
        let nextDueDate = null;
        let paidEmis = 0;

        for (const emi of emiRes.rows) {
          const emiDate = new Date(emi.paid_date);
          if (emi.paid) {
            paidEmis += 1;
          }
          if (!emi.paid && emiDate < today) {
            overdueAmount += parseFloat(emi.amount);
          }
          if (!emi.paid && !nextDueDate) {
            nextDueDate = emiDate.toISOString().split("T")[0];
          }
        }

        customers.push({
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          address: customer.address,

          deviceIMEI: device.imei,
          deviceModel: device.model,
          isLocked: device.is_locked,

          loan: {
            amount: parseFloat(device.loan_amount),
            emiAmount: parseFloat(device.emi_amount),
            totalEmis: device.total_emis,
            paidEmis,
            nextDueDate,
            overdueAmount,
          },

          emiHistory,
        });
      }
    }

    res.json({ customers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/api/customers/:id", async (req, res) => {
  const { id } = req.params;
  const { name, phone, email, address } = req.body;

  try {
    const result = await pool.query(
      `UPDATE customers 
       SET name=$1, phone=$2, email=$3, address=$4
       WHERE id=$5 RETURNING *`,
      [name, phone, email, address, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }

    res.json({ success: true, customer: result.rows[0] });
  } catch (err) {
    console.error("Error updating customer:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/api/payemi/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const emiRes = await pool.query(`SELECT * FROM emi_history WHERE id=$1`, [
      id,
    ]);
    if (emiRes.rowCount === 0) {
      return res.status(404).json({ error: "EMI record not found" });
    }

    const emi = emiRes.rows[0];

    if (emi.paid) {
      return res.status(400).json({ error: "EMI already paid" });
    }

    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    // Mark EMI as paid
    await pool.query(
      `UPDATE emi_history SET paid=true, paid_date=$1 WHERE id=$2`,
      [today, id]
    );

    res.json({
      success: true,
      emiId: id,
    });
  } catch (err) {
    console.error("Error paying EMI:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/dealers", async (req, res) => {
  const { name, phone, email, password } = req.body;

  if (!name || !phone || !email || !password) {
    return res
      .status(400)
      .json({ error: "Name, phone, email, and password are required" });
  }

  try {
    // const hashedPassword = await bcrypt.hash(password, 10); // hash password

    const id = Math.floor(10000 + Math.random() * 90000);

    const result = await pool.query(
      `INSERT INTO dealers (id, name, phone, email, password) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, phone, email`,
      [id, name, phone, email, password]
    );

    res.json({ success: true, dealer: result.rows[0] });
  } catch (err) {
    console.error("Error creating dealer:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/api/dealers/:id", async (req, res) => {
  const { id } = req.params;
  const { name, phone, email } = req.body;

  try {
    let query, values;

    query = `UPDATE dealers SET name=$1, phone=$2, email=$3 WHERE id=$4 RETURNING id, name, phone, email`;
    values = [name, phone, email, id];

    const result = await pool.query(query, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Dealer not found" });
    }

    res.json({ success: true, dealer: result.rows[0] });
  } catch (err) {
    console.error("Error updating dealer:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/dealers", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, email FROM dealers ORDER BY id`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching dealers:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/dealers/login", async (req, res) => {
  const { dealerCode, password } = req.body;

  if (!password || !dealerCode) {
    return res
      .status(400)
      .json({ error: "DealerCode and password are required" });
  }

  try {
    const result = await pool.query(`SELECT * FROM dealers WHERE id=$1`, [
      dealerCode,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Dealer not found" });
    }

    const dealer = result.rows[0];

    // const match = await bcrypt.compare(password, dealer.password);
    if (password !== dealer.password) {
      return res.status(401).json({ error: "Invalid Credential" });
    }

    res.json({
      success: true,
      dealer: {
        id: dealer.id,
        name: dealer.name,
        phone: dealer.phone,
        email: dealer.email,
      },
    });
  } catch (err) {
    console.error("Error logging in dealer:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/device-control/command", async (req, res) => {
  const client = await pool.connect();
  try {
    const { command, payload, deviceId } = req.body;

    const commandResult = await pool.query(
      `INSERT INTO command_history(
      type, status, "createdAt", "updatedAt", "deviceId", result, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        command,
        "pending",
        new Date(),
        new Date(),
        deviceId,
        "",
        JSON.stringify(payload),
      ]
    );
    const commandId = commandResult.rows[0].id;

    const deviceConnection = deviceConnections.get(deviceId);

    if (deviceConnection) {
      deviceConnection.socket.emit("device_command", {
        commandId: commandId,
        command,
        payload: payload || {},
      });

      res.json({
        success: true,
        commandId: commandId,
        message: `Command ${command} sent to device ${deviceId}`,
      });
    } else {
      res.status(400).json({
        error: "Device not connected",
        deviceStatus: "online",
      });
    }
  } catch (err) {
    console.error("Command sending error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

app.get("/api/dashboard/stats/:dealerId", async (req, res) => {
  const { dealerId } = req.params;
  const client = await pool.connect();

  try {
    const totalCustomersRes = await client.query(
      `SELECT COUNT(*) FROM customers WHERE dealer_id = $1`,
      [dealerId]
    );

    const onlineDevicesRes = await client.query(
      `SELECT COUNT(*) 
       FROM device_loans dl
       JOIN customers c ON c.id = dl.customer_id
       WHERE c.dealer_id = $1 AND dl.status='online'`,
      [dealerId]
    );

    const lockedDevicesRes = await client.query(
      `SELECT COUNT(*) 
       FROM device_loans dl
       JOIN customers c ON c.id = dl.customer_id
       WHERE c.dealer_id = $1 AND dl.status='locked'`,
      [dealerId]
    );

    const dealerCustomerRes = await client.query(
      `SELECT id FROM customers WHERE dealer_id = $1`,
      [dealerId]
    );
    const dealerCustomerIds = dealerCustomerRes.rows.map((r) => r.id);

    const commandsToday = deviceCommands.filter((cmd) => {
      const today = new Date();
      const cmdDate = new Date(cmd.createdAt);
      return (
        cmdDate.toDateString() === today.toDateString() &&
        dealerCustomerIds.includes(cmd.customerId)
      );
    }).length;

    res.json({
      totalCustomers: parseInt(totalCustomersRes.rows[0].count),
      onlineDevices: parseInt(onlineDevicesRes.rows[0].count),
      lockedDevices: parseInt(lockedDevicesRes.rows[0].count),
      commandsToday,
    });
  } catch (err) {
    console.error("Error fetching dealer dashboard stats:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

app.post("/api/test/reset/:deviceLoanId", async (req, res) => {
  const { deviceLoanId } = req.params;
  const client = await pool.connect();

  try {
    await client.query(
      `UPDATE emi_history SET paid=false, paid_date=NULL WHERE device_loan_id=$1`,
      [deviceLoanId]
    );
    await client.query(`UPDATE device_loans SET status='offline' WHERE id=$1`, [
      deviceLoanId,
    ]);

    res.json({ success: true, message: "Device loan and EMI data reset" });
  } catch (err) {
    console.error("Error resetting device loan data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

app.post("/api/test/emergency-unlock/:deviceLoanId", async (req, res) => {
  const { deviceLoanId } = req.params;
  const client = await pool.connect();

  try {
    await client.query(`UPDATE device_loans SET status='online' WHERE id=$1`, [
      deviceLoanId,
    ]);

    const deviceRes = await client.query(
      `SELECT device_id FROM device_loans WHERE id=$1`,
      [deviceLoanId]
    );
    const deviceId = deviceRes.rows[0].device_id;
    const deviceConnection = deviceConnections.get(deviceId);

    if (deviceConnection) {
      deviceConnection.socket.emit("emergency_unlock", {
        reason: "Customer service override",
        duration: 30,
      });
    }

    res.json({ success: true, message: "Emergency unlock activated" });
  } catch (err) {
    console.error("Error in emergency unlock:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

app.post("/generate-qr", async (req, res) => {
  try {
    const apkPath = path.join(UPLOAD_DIR, APK_FILE);

    if (!fs.existsSync(apkPath)) {
      console.error("Release APK not found:", apkPath);
      return;
    }

    // const payload = {
    //   "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME":
    //     "com.safeemiclient.receiver.EMISafeDeviceAdmin",
    //   "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM":
    //     "FAH0fHmkQWBv8uWFe6iM5giPLBeW1E2fxH7mVfUztO4=",
    //   "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION":
    //     "http://35.154.227.178:3000/uploads/app-release.apk",
    //   "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": true,
    //   "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": false,
//     // };


     const payload = {
"android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "com.safeemiclient/.EMISafeDeviceAdmin",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": "http://35.154.227.178:3000/uploads/app-release.apk",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": "EcXGdkYfSBWFxXyr3o3ohVxb/HqhGXgTZ8JjnlPhB2E=",
  "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": true,
  "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": false,
}



    // Generate QR code as PNG
    const qrBuffer = await QRCode.toBuffer(JSON.stringify(payload), {
      type: "png",
      width: 400,
      color: { dark: "#000000", light: "#FFFFFF" },
    });
    res.setHeader("Content-Type", "image/png");
    res.send(qrBuffer);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Failed to generate QR code", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 EMI Safe server running on port ${PORT}`);
});
