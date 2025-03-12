// server.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';


// โหลด environment variables
dotenv.config();

const connectedDevicesMap = new Map();

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',  // หรือระบุ URL ที่อนุญาตให้เชื่อมต่อได้ เช่น 'http://example.com'
        methods: ['GET', 'POST'],
    }
});

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

app.use(cors({
    origin: '*',  // อนุญาตให้ทุกต้นทางเชื่อมต่อกับ API
    methods: ['GET', 'POST'],
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));




app.post('/api/insert-device', async (req, res) => {
    const { deviceName } = req.body;

    if (!deviceName) {
        return res.status(400).json({ error: 'Device name is required' });
    }

    try {
        // ตรวจสอบว่ามีอุปกรณ์อยู่ใน Database หรือยัง
        const checkDevice = await pool.query(
            'SELECT * FROM devices WHERE LOWER(name) = LOWER($1)', 
            [deviceName]
        );

        if (checkDevice.rowCount === 0) {
            // ถ้ายังไม่มีอุปกรณ์นี้ ให้ INSERT ค่าเริ่มต้น โดยไม่ต้องระบุ id (ให้ PostgreSQL จัดการ)
            await pool.query(
                `INSERT INTO devices (name, status, online_time, current, thb, life_time, ledbulb, electricity_rate) 
                VALUES ($1, false, 0, 0, 0, 3600000, 0, 0)`, 
                [deviceName]
            );

            console.log(`✅ Inserted new device '${deviceName}' into database.`);
        } else {
            console.log(`Device '${deviceName}' already exists. No need to insert.`);
        }

        res.json({ success: true, message: `Device '${deviceName}' processed successfully.` });

    } catch (error) {
        console.error(`❌ Error inserting device:`, error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// 🔹 ดึงข้อมูลอุปกรณ์
app.get('/api/devices', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM devices ORDER BY id ASC');
        const devices = result.rows.map(device => ({
            ...device
        }));
        res.status(200).json(devices);
    } catch (err) {
        console.error("❌ Error fetching devices:", err.message);
        res.status(500).send('Server Error');
    }
});

// 🔹 อัปเดต `online_time` และลด `life_time` ทุกวินาที
setInterval(async () => {
    const now = Date.now();

    for (const [deviceName, startTime] of connectedDevicesMap.entries()) {
        try {
            const result = await pool.query(`SELECT online_time, life_time FROM devices WHERE LOWER(name) = LOWER($1)`, [deviceName]);
            if (result.rowCount === 0) continue;

            let lifeTime = parseFloat(result.rows[0].life_time) || 0;
            let onlineTime = parseFloat(result.rows[0].online_time) || 0;

            // เพิ่มเวลาทุก ๆ วินาที
            onlineTime += 1;  // เพิ่ม online_time ทีละ 1 วินาที
            lifeTime -= 1;    // ลด life_time ทีละ 1 วินาที

            if (lifeTime < 0) lifeTime = 0; // ป้องกันค่าติดลบ

            // อัปเดต `online_time` และ `life_time` ในฐานข้อมูล
            await pool.query(`UPDATE devices SET online_time = $1, life_time = $2 WHERE LOWER(name) = LOWER($3)`, 
                [onlineTime, lifeTime, deviceName]);

            // แสดงผลใน log โดยแสดงเวลาทั้งสองในหน่วยวินาที
            console.log(`✅ Updated ${deviceName}: online_time = ${onlineTime.toFixed(2)} s., life_time = ${lifeTime.toFixed(2)} s.`);

        } catch (err) {
            console.error(`❌ Error updating time for ${deviceName}:`, err);
        }
    }
}, 1000); // ทำงานทุก 1 วินาที

// 🔹 Reset `online_time` เป็น 0 เมื่ออุปกรณ์ Disconnect
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('device_connected', async (deviceName) => {
        const normalizedDeviceName = deviceName.trim().toLowerCase();
        if (!connectedDevicesMap.has(normalizedDeviceName)) {
            connectedDevicesMap.set(normalizedDeviceName, Date.now());
            console.log(`🔗 Device Connected: ${normalizedDeviceName}`);
        }
    });

    socket.on('device_disconnected', async (deviceName) => {
        const normalizedDeviceName = deviceName.trim().toLowerCase();
        if (connectedDevicesMap.has(normalizedDeviceName)) {
            connectedDevicesMap.delete(normalizedDeviceName);
            console.log(`🔴 Device Disconnected: ${normalizedDeviceName}`);

            try {
                // รีเซ็ต `online_time` เป็น 0
                await pool.query(`UPDATE devices SET online_time = 0 WHERE LOWER(name) = LOWER($1)`, [normalizedDeviceName]);
                console.log(`🔄 Reset online_time for ${normalizedDeviceName} to 0`);
            } catch (err) {
                console.error(`❌ Error resetting online_time for ${normalizedDeviceName}:`, err);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

// 🔹 อัปเดต `energy` และ `thb`

app.post('/api/update-electricity-rate', async (req, res) => {
    try {
        console.log("📥 Received Request Body:", req.body);
        
        const { rate } = req.body;
        if (isNaN(rate) || rate <= 0) {
            console.error("❌ Invalid rate value", { rate });
            return res.status(400).json({ error: "Invalid rate value" });
        }

        await pool.query(`UPDATE devices SET electricity_rate = $1`, [rate]);
        
        console.log(`✅ Electricity rate updated to ${rate} THB/kWh for all devices`);
        res.status(200).json({ message: "Electricity rate updated for all devices" });
    } catch (err) {
        console.error("❌ Error updating electricity rate:", err);
        res.status(500).json({ error: "Server Error" });
    }
});



app.post('/api/update-ledbulb', async (req, res) => {
    try {
        const { deviceName, ledbulb } = req.body;
        if (!deviceName || isNaN(ledbulb)) {
            return res.status(400).json({ error: "Invalid input" });
        }

        await pool.query(`UPDATE devices SET ledbulb = $1 WHERE LOWER(name) = LOWER($2)`, [ledbulb, deviceName]);
        console.log(`✅ Updated ledbulb for ${deviceName} to ${ledbulb} W`);
        res.status(200).json({ message: "ledbulb updated" });
    } catch (err) {
        console.error("❌ Error updating ledbulb:", err);
        res.status(500).json({ error: "Server Error" });
    }
});


app.post('/api/update-energy', async (req, res) => {
    try {
        const { records } = req.body;
        
        if (!records || !Array.isArray(records) || records.length === 0) {
            console.error("❌ Invalid records data received:", records);
            return res.status(400).json({ error: "Invalid records data" });
        }

        console.log("✅ Received records for update:", records);
        let updatedDevices = [];

        let dashboardRecords = []; // เก็บข้อมูลที่ต้องการอัปเดตเข้า dashboard

        for (const record of records) {
            const { name, timeInSeconds } = record;
            if (!name || isNaN(timeInSeconds)) {
                console.warn("⚠️ Skipping invalid record:", record);
                continue;
            }

            console.log(`🔄 Fetching data for device: ${name}`);
            const result = await pool.query(
                `SELECT ledbulb, electricity_rate FROM devices WHERE LOWER(name) = LOWER($1)`,
                [name]
            );

            if (result.rowCount === 0) {
                console.warn(`⚠️ No device found in database for: ${name}`);
                continue;
            }

            const esp = 1.00; // ตั้งค่า default
            const ledbulb = parseFloat(result.rows[0].ledbulb) || 0.00;
            const ratePerKWh = parseFloat(result.rows[0].electricity_rate) || 5.00;
            
            console.log(`📊 Device ${name}: ledbulb=${ledbulb}, rate=${ratePerKWh}`);

            const timeInHours = timeInSeconds / 3600;
            const energyUsage = ((esp + ledbulb) * timeInHours) / 1000;
            const cost = energyUsage * ratePerKWh;

            console.log(`⚡ Calculated energy: ${energyUsage.toFixed(6)} kWh, Cost: ${cost.toFixed(2)} THB`);

            await pool.query(
                `UPDATE devices SET current = current + $1, thb = thb + $2 WHERE LOWER(name) = LOWER($3)`,
                [energyUsage, cost, name]
            );

            updatedDevices.push({ name, energyUsage, cost });

            // 📌 เพิ่มข้อมูลสำหรับอัปเดตเข้า dashboard
            const updatedAt = new Date().toISOString().split("T")[0]; // ใช้เฉพาะวันที่
            dashboardRecords.push({ name, energyUsage, cost, updatedAt });
        }

        if (dashboardRecords.length > 0) {
            // 🔹 สร้าง SQL Query (ใช้ Batch Insert)
            const queryText = `
                INSERT INTO dashboard (name, current, thb, updated_at)
                VALUES ${dashboardRecords.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(", ")}
                ON CONFLICT (name, updated_at) DO UPDATE 
                SET current = dashboard.current + EXCLUDED.current, thb = dashboard.thb + EXCLUDED.thb;
            `;

            // 🔹 สร้างค่าพารามิเตอร์สำหรับ Query
            const queryParams = dashboardRecords.flatMap(({ name, energyUsage, cost, updatedAt }) => [name, energyUsage, cost, updatedAt]);

            // 🔹 รัน Query
            await pool.query(queryText, queryParams);
            console.log("✅ Dashboard data inserted/updated successfully.");
        }

        res.status(200).json({ 
            message: "Energy data updated successfully", 
            updatedDevices 
        });
        console.log("✅ Energy data updated successfully for:", updatedDevices);
    } catch (err) {
        console.error("❌ Server Error while updating energy:", err);
        res.status(500).json({ error: "Server Error" });
    }
});




app.post('/api/save-device-status', async (req, res) => {
    const { deviceName, status } = req.body;

    try {
        // เพิ่มข้อมูลลงในฐานข้อมูล (ตัวอย่าง SQL Query)
        await pool.query(
            `UPDATE devices SET status =  $1 WHERE LOWER(name) = LOWER($2)`,
            [status, deviceName]
        );

        res.status(200).json({ message: 'Status updated successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});


// ✅ API สำหรับดึงข้อมูลการใช้ไฟฟ้า
app.get("/api/electricity-summary", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT SUM(current) AS total_usage, SUM(thb) AS total_cost FROM devices
        `);

        res.status(200).json({
            totalUsage: result.rows[0]?.total_usage || 0,
            totalCost: result.rows[0]?.total_cost || 0,
        });
    } catch (error) {
        console.error("❌ Error fetching electricity summary:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});



// ตัวอย่าง API สำหรับดึงข้อมูลจากฐานข้อมูล PostgreSQL สำหรับ 7 วันล่าสุด
app.get('/api/dashboard-last-7-days', async (req, res) => {
    try {
        // ดึงข้อมูล 7 วันล่าสุดจากฐานข้อมูล พร้อมรวม current ของทุกอุปกรณ์ในแต่ละวัน
        const result = await pool.query(`
            SELECT DATE(updated_at) AS date, SUM(current) AS total_current
            FROM dashboard
            WHERE updated_at >= NOW() - INTERVAL '7 days'
            GROUP BY DATE(updated_at)
            ORDER BY DATE(updated_at) DESC
        `);

        // ดึงข้อมูล current ของแต่ละอุปกรณ์ในแต่ละวัน
        const deviceResult = await pool.query(`
            SELECT DATE(updated_at) AS date, name, SUM(current) AS current
            FROM dashboard
            WHERE updated_at >= NOW() - INTERVAL '7 days'
            GROUP BY DATE(updated_at), name
            ORDER BY DATE(updated_at) DESC
        `);

        // ส่งข้อมูลทั้งหมดไปยัง frontend
        res.json({
            summary: result.rows,  // ข้อมูลรวมสำหรับกราฟแท่ง
            details: deviceResult.rows  // ข้อมูลสำหรับกราฟโดนัท
        });
    } catch (error) {
        console.error('Error fetching dashboard data:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/insert-log', async (req, res) => {
    try {
        const { date, time, message } = req.body;
        if (!date || !time || !message) {
            return res.status(400).json({ error: "Invalid data format" });
        }

        const queryText = `
            INSERT INTO logs (log_date, log_time, message)
            VALUES ($1, $2, $3);
        `;
        await pool.query(queryText, [date, time, message]);

        res.status(200).json({ message: 'Log inserted successfully' });
        console.log(`✅ Log saved: ${date} ${time} - ${message}`);
    } catch (error) {
        console.error("❌ Error inserting log:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/get-logs', async (req, res) => {
    try {
        let { filter } = req.query;
        let timeCondition = "";
        
        if (filter === '1h') {
            timeCondition = "WHERE created_at >= NOW() - INTERVAL '1 hour'";
        } else if (filter === '1d') {
            timeCondition = "WHERE created_at >= NOW() - INTERVAL '1 day'";
        } else if (filter === '1w') {
            timeCondition = "WHERE created_at >= NOW() - INTERVAL '1 week'";
        }

        const queryText = `
            SELECT 
                TO_CHAR(log_date, 'DD Mon YYYY') AS log_date, 
                log_time, 
                message 
            FROM logs 
            ${timeCondition}
            ORDER BY created_at DESC 
            LIMIT 20;
        `;

        const result = await pool.query(queryText);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error("❌ Error fetching logs:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

async function createHashedPassword(plainPassword) {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(plainPassword, salt);
    console.log('Hashed Password:', hashedPassword);
    return hashedPassword;
}

// เรียกใช้ฟังก์ชันสร้างแฮช
createHashedPassword('Far0982');

app.post('/login', async (req, res) => {
    const { user_id, password } = req.body;

    try {
        // Check if user exists
        const result = await pool.query('SELECT * FROM users WHERE user_id = $1', [user_id]);

        if (result.rows.length > 0) {
            // Compare the entered password with the hashed password in the database
            const user = result.rows[0];
            const isMatch = await bcrypt.compare(password, user.password); // Make sure user.password is hashed

            if (isMatch) {
                // Password is correct, login successful
                res.json({ success: true, message: 'Login successful' });
            } else {
                // Invalid password
                res.status(401).json({ success: false, message: 'Invalid credentials' });
            }
        } else {
            // User not found
            res.status(404).json({ success: false, message: 'User not found' });
        }
    } catch (err) {
        console.error('Error during login:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});


// Start server
server.listen(port, () => {
    console.log(`🚀 Server running on http://0.0.0.0:${port}`);
});
