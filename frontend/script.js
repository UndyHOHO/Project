
const sideMenu = document.querySelector('aside');
const menuBtn = document.getElementById('menu-btn');
const closeBtn = document.getElementById('close-btn');




menuBtn.addEventListener('click', () => {
    sideMenu.style.display = 'block';
});

closeBtn.addEventListener('click', () => {
    sideMenu.style.display = 'none';
});


document.getElementById("logout-link").addEventListener("click", function(event) {
    event.preventDefault();  // Prevent default anchor behavior
    
    // Redirect to login page, removing current page from history stack
    window.location.replace("../index.html");
});


// SPA
let activityLog = []; 
let connectedDevices = [];
let characteristic = null;
let currentPage = null;
let isGattOperationInProgress = false;
let debounceTimeout = null; // สำหรับ debounce
let commandQueue = [];
let isProcessingQueue = false;

const socket = io('http://192.168.0.109:3000');

document.addEventListener('DOMContentLoaded', function () {

    // ฟังก์ชันโหลดเนื้อหาเพจ
    function loadContent(page) {
        if (currentPage === page) {
            console.log('Page is already loaded.');
            return;
        }
    
        currentPage = page;
    
        const contentDiv = document.getElementById('content');
        if (!contentDiv) {
            console.error('Content div not found');
            return;
        }
    
        fetch(`pages/${page}.html?t=${new Date().getTime()}`) // เพิ่ม timestamp
            .then(response => {
                if (!response.ok) throw new Error('Page not found');
                return response.text();
            })
            .then(html => {
                contentDiv.innerHTML = html;
    
                if (page === 'dashboard') {
                    initializeBarChart();
                    updateDoughnutChart();
                    
                } else if (page === 'device') {
                    setupDeviceControls();

                    connectedDevices.forEach((device, index) => {
                        if (device && device.device.gatt.connected) {
                            createDeviceCard(device.device.name || `Device ${index + 1}`, index + 1);
                        }
                    });
                } else if (page === 'log') {
                    const logBox = document.getElementById('log');
                    if (logBox) {
                        fetchLogs('', false, true);
                    }
                }else if (page === 'analytic') {
                    fetchDevices(); // โหลดข้อมูลเมื่อเข้า analytic
                    loadanalytic();
                }else if (page === 'settings') {
                    loadSettings();
                }
            })
            .catch(error => {
                console.error(error);
                contentDiv.innerHTML = '<h1>404 Page Not Found</h1>';
            });
    }
    
    

    // ตั้งค่า links
    function setUpLinks() {
        const dashboardLink = document.getElementById('dashboard-link');
        const analyticLink = document.getElementById('analytic-link');
        const deviceLink = document.getElementById('device-link');
        const logLink = document.getElementById('log-link');
        const settingsLink = document.getElementById('settings-link');

        if (dashboardLink) {
            dashboardLink.addEventListener('click', (event) => {
                event.preventDefault();
                loadContent('dashboard');
                window.history.pushState(null, '', '#dashboard');
            });
        }

        if (analyticLink) {
            analyticLink.addEventListener('click', (event) => {
                event.preventDefault();
                loadContent('analytic');
                window.history.pushState(null, '', '#analytic');
            });
        }

        if (deviceLink) {
            deviceLink.addEventListener('click', (event) => {
                event.preventDefault();
                loadContent('device');
                window.history.pushState(null, '', '#device');
            });
        }

        if (logLink) {
            logLink.addEventListener('click', (event) => {
                event.preventDefault();
                loadContent('log');
                window.history.pushState(null, '', '#log');
            });
        }

        if (settingsLink) {
            settingsLink.addEventListener('click', (event) => {
                event.preventDefault();
                loadContent('settings');
                window.history.pushState(null, '', '#settings');
            });
        }
    }



    // ฟังก์ชันจัดการ Bluetooth
    async function setupDeviceControls() {
        try {
            if (isGattOperationInProgress) {
                console.warn('A GATT operation is already in progress. Please wait.');
                addLog('A GATT operation is already in progress. Please wait.');
                return;
            }

            const scanButton = document.getElementById('scan');
            if (!scanButton) {
                console.error('Scan button not found.');
                return;
            }

            scanButton.addEventListener('click', async () => {
                // Debounce to prevent multiple rapid clicks
                if (debounceTimeout) {
                    console.warn('Please wait before trying again.');
                    return;
                }
                debounceTimeout = setTimeout(() => {
                    debounceTimeout = null;
                }, 2000); // 2-second debounce

                if (isGattOperationInProgress) {
                    console.warn('A GATT operation is already in progress. Please wait.');
                    addLog('A GATT operation is already in progress. Please wait.');
                    return;
                }

                isGattOperationInProgress = true; // Set the flag to prevent concurrent operations

                try {
                    const device = await navigator.bluetooth.requestDevice({
                        acceptAllDevices: true,
                        optionalServices: ['12345678-1234-1234-1234-123456789012']
                    });

                    const server = await device.gatt.connect();
                    const service = await server.getPrimaryService('12345678-1234-1234-1234-123456789012');
                    const characteristic = await service.getCharacteristic('87654321-4321-4321-4321-210987654321');

                    await characteristic.startNotifications();
                    characteristic.addEventListener('characteristicvaluechanged', event => {
                        const value = new TextDecoder().decode(event.target.value);
                        addLog(`Device ${device.name || 'Unknown'} sent: ${value}`);
                    });
                    
                    device.addEventListener('gattserverdisconnected', () => handleDisconnection(device));
                    device.gatt.ondisconnect = () => handleDisconnection(device);

                    const connectionStartTime = Math.floor(Date.now() / 1000); // บันทึกเวลาที่เริ่มเชื่อมต่อ
                    connectedDevices.push({ device, characteristic, connectionStartTime });
                    
                    socket.emit('device_connected', device.name);
                    createDeviceCard(device.name, connectedDevices.length);
                    
                    await saveDeviceStatusToDatabase(device.name, true);

                    await insertDeviceIfNotExists(device.name);

                    const controls = document.getElementById('controls');
                    if (controls) {
                        controls.style.display = 'flex';
                    }

                    addLog(`Successfully connected to ${device.name || 'Unknown Device'}`);
                } catch (error) {
                    if (error.name === 'NotFoundError') {
                        console.warn('User canceled Bluetooth device selection.');
                        addLog('Device selection was canceled. Please try again.');
                    } else {
                        console.error('Connection failed:', error);
                        addLog(`Failed to connect: ${error.message}`);
                    }
                } finally {
                    isGattOperationInProgress = false; // Reset the flag after operation
                }
            });
        } catch (error) {
            isGattOperationInProgress = false; // Reset flag on error
            console.error('Setup Device Controls Error:', error);
            addLog(`Error: ${error.message}`);
        }
    }


    async function insertDeviceIfNotExists(deviceName) {
        try {
            const response = await fetch('/api/insert-device', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ deviceName })
            });
    
            if (!response.ok) {
                throw new Error(`Failed to insert device: ${response.statusText}`);
            }
    
            console.log(`Device '${deviceName}' checked/inserted successfully.`);
        } catch (error) {
            console.error(`Error inserting device '${deviceName}':`, error);
        }
    }


    function handleDisconnection(device) {
        console.warn(`Device ${device.name} disconnected unexpectedly.`);
        
        saveDeviceStatusToDatabase(device.name, false);
        // ส่งแจ้งเตือนไป Backend
        socket.emit('device_disconnected', device.name);
    
        // ลบ UI ของอุปกรณ์
        const deviceCard = document.getElementById(`device-card-${device.name}`);
        if (deviceCard) {
            deviceCard.remove();
            console.log(`🗑️ Removed device card: ${device.name}`);
        }
    
        // ลบออกจาก connectedDevices
        connectedDevices = connectedDevices.filter(dev => dev.device.name !== device.name);
    
        // ลบค่าใน localStorage
        localStorage.removeItem(`deviceStatus_${device.name}`);
    
        addLog(`${device.name} disconnected.`);
    }
    

    window.addEventListener("beforeunload", () => {
        console.log("🔄 Disconnecting all devices before page reload...");
    
        connectedDevices.forEach(deviceEntry => {
            if (deviceEntry.device.gatt.connected) {
                deviceEntry.device.gatt.disconnect();
                handleDisconnection(deviceEntry.device);
            }
        });
    
        console.log("All devices disconnected successfully.");
    });
    

    async function fetchDevices() {
        const tableBody = document.getElementById('device-table-body');
        if (!tableBody) {
            console.warn('Warning: Table body not found. Skipping fetchDevices().');
            return;
        }
    
        try {
            const response = await fetch('http://192.168.0.109:3000/api/devices');
            const devices = await response.json();
            devices.sort((a, b) => a.id - b.id);
    
            // ดึงค่า currency จาก localStorage
            const savedCurrency = localStorage.getItem('currency') || 'THB';
    
            tableBody.innerHTML = '';
    
            devices.forEach(device => {
                const onlineTimeValue = Number(device.online_time) || 0;
                const lifeTimeValue = Number(device.life_time) || 0;
                const energyValue = Number(device.current) || 0;
                const costTHB = Number(device.thb) || 0;
    
                // แปลงค่า cost ตาม currency ที่เลือก
                const costValue = convertCurrency(costTHB, "THB", savedCurrency);
    
                const row = `
                    <tr>
                        <td>${device.name}</td>
                        <td>${device.status ? '<span class="material-icons-sharp">flash_on</span>' : '<span class="material-icons-sharp">flash_off</span>'}</td>
                        <td>${onlineTimeValue.toFixed(2)}</td> 
                        <td>${energyValue.toFixed(2)}</td>
                        <td>${costValue} ${savedCurrency}</td>
                        <td><strong>${lifeTimeValue.toFixed(2)}</strong></td>
                    </tr>
                `;
                tableBody.insertAdjacentHTML('beforeend', row);
            });
    
            console.log(`Fetched devices successfully with currency: ${savedCurrency}`);
    
        } catch (err) {
            console.error('Error fetching devices:', err);
        }
    }

    

    async function updateLightbulbStatus() {
        try {
            // ดึงข้อมูลอุปกรณ์จาก Backend
            const response = await fetch('http://192.168.0.109:3000/api/devices');
            const devices = await response.json();
    
            if (!response.ok) throw new Error("Failed to fetch device data");
    
            // นับจำนวนอุปกรณ์ทั้งหมด และอุปกรณ์ที่เปิด (status = true)
            const totalDevices = devices.length;
            const activeDevices = devices.filter(device => device.status === true).length;
    
            // อัปเดต UI
            const lightbulbElement = document.querySelector('.card-content .number');
            if (lightbulbElement) {
                lightbulbElement.textContent = `${activeDevices}/${totalDevices}`;
            }
    
            // เก็บค่า activeDevices และ totalDevices ลงใน localStorage
            localStorage.setItem('activeDevices', activeDevices);
            localStorage.setItem('totalDevices', totalDevices);
    
            console.log(`Lightbulb Status Updated: ${activeDevices}/${totalDevices}`);
        } catch (error) {
            console.error("Error updating lightbulb status:", error);
        }
    }
    
    // เรียกใช้ฟังก์ชันทุกๆ 1 วินาทีด้วย setInterval
    setInterval(updateLightbulbStatus, 1000);


    function loadanalytic() {
        const savedCurrency = localStorage.getItem('currency') || 'THB';  // โหลดค่า currency จาก localStorage หรือใช้ค่า default
        updateCurrencyInHTML(savedCurrency);
    }
    
    function updateCurrencyInHTML(currency) {
        const currencyElements = document.querySelectorAll('.currency'); // เลือกทุก element ที่มี class currency
    
        currencyElements.forEach(element => {
            element.textContent = currency;  // เปลี่ยนค่าในแต่ละ element เป็นค่า currency ที่เลือก
        });
    }

    
    function loadSettings() {
        const rateInput = document.getElementById('rate');
        const currencySelect = document.getElementById('currency');
    
        // โหลดค่าที่บันทึกไว้ (ถ้ามี)
        const savedRate = localStorage.getItem('electricityRate');
        const savedCurrency = localStorage.getItem('currency');
    
        if (savedRate) rateInput.value = savedRate;
        if (savedCurrency) {
            currencySelect.value = savedCurrency;
            updateCurrencyInHTML(savedCurrency);
        }
    
        // ✅ เมื่อเปลี่ยนค่า Rate ให้ส่งไปยัง Backend
        rateInput.addEventListener('input', async () => {
            const rateValue = parseFloat(rateInput.value);
            if (isNaN(rateValue) || rateValue <= 0) {
                console.error("Invalid rate value:", rateValue);
                return;
            }
        
            console.log("📤 Sending request with:", { rate: rateValue });
        
            try {
                const response = await fetch('http://192.168.0.109:3000/api/update-electricity-rate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rate: rateValue })
                });
        
                const result = await response.json();
                console.log("Response:", result);

                localStorage.setItem('electricityRate', rateInput.value);
            } catch (error) {
                console.error("Error updating electricity rate:", error);
            }
        });
    
        currencySelect.addEventListener('change', () => {
            const selectedCurrency = currencySelect.value;
            localStorage.setItem('currency', selectedCurrency);
            console.log('Currency saved:', selectedCurrency);
            updateCurrencyInHTML(selectedCurrency);
        });
    } 
    

    const exchangeRates = {
        THB: 1,   // ค่าเริ่มต้นเป็นบาท
        USD: 0.028, // 1 THB ≈ 0.028 USD
        EUR: 0.025  // 1 THB ≈ 0.025 EUR
    };
    
    function convertCurrency(amount, from = "THB", to = "THB") {
        if (exchangeRates[to] && exchangeRates[from]) {
            return (amount * exchangeRates[to] / exchangeRates[from]).toFixed(2);
        }
        return amount.toFixed(2); // ถ้าไม่มีเรท ให้คืนค่าเดิม
    }


    
    // อัปเดตพลังงานและสถานะของอุปกรณ์
    
    function updateDevicesEnergyAsync() {
        setInterval(async () => {
            let recordsToInsert = [];
            
            for (let deviceEntry of connectedDevices) {
                if (!deviceEntry || !deviceEntry.device || !deviceEntry.device.name) continue;
    
                deviceEntry.accumulatedTime = (deviceEntry.accumulatedTime || 0) + 1;
                
                if (deviceEntry.accumulatedTime >= 30) {
                    recordsToInsert.push({
                        name: deviceEntry.device.name.trim().toLowerCase(),
                        timeInSeconds: deviceEntry.accumulatedTime
                    });
                    deviceEntry.accumulatedTime = 0; 
                }
            }
    
            if (recordsToInsert.length > 0) {
                try {
                    await fetch('http://192.168.0.109:3000/api/update-energy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ records: recordsToInsert })
                    });
                    console.log("Energy data sent to backend successfully.");
                } catch (error) {
                    console.error("Error sending energy data:", error);
                }
            }
        }, 1000);
    }
    
    updateDevicesEnergyAsync();
    
    
    

    
    
    
    setInterval(fetchDevices, 15000);
    


    window.createDeviceCard = function (deviceName) {
        const container = document.getElementById('device-container');
    
        if (!container) {
            console.error('Device container not found.');
            return;
        }
    
        const card = document.createElement('div');
        card.className = 'light-card';
        card.id = `device-card-${deviceName}`;
    
        // ✅ Load saved status from localStorage with the new key name (deviceState)
        const savedStatus = JSON.parse(localStorage.getItem(`deviceState_${deviceName}`)) || false;
    
        card.innerHTML = `
            <h2>${deviceName}</h2>
            <span class="material-icons-sharp icon">lightbulb</span>
            <label class="switch">
                <input type="checkbox" id="switch-${deviceName}" ${savedStatus ? 'checked' : ''} onchange="toggleLight('${deviceName}')">
                <span class="slider-switch"></span>
            </label>
            <label>Choose Color: <input type="color" id="colorPicker-${deviceName}" value="#ffffff" onchange="changeColor('${deviceName}')"></label>
            <input type="range" id="slider-${deviceName}" class="slider" min="0" max="1" step="0.1" value="1.0" oninput="adjustBrightness('${deviceName}')">
            <button class="disconnect-btn" onclick="disconnectDevice('${deviceName}')">Disconnect</button>
        `;
    
        container.appendChild(card);
        console.log(`Created device card for ${deviceName}`);
    };
    
    

    window.disconnectDevice = async function (deviceName) {
        // ค้นหาอุปกรณ์ใน connectedDevices โดยใช้ deviceName
        const deviceIndex = connectedDevices.findIndex(deviceEntry => 
            deviceEntry && deviceEntry.device.name.toLowerCase() === deviceName.toLowerCase()
        );
    
        if (deviceIndex === -1) {
            console.error(`Device ${deviceName} not found in connectedDevices.`);
            return;
        }
    
        const deviceEntry = connectedDevices[deviceIndex];
    
        if (deviceEntry && deviceEntry.device.gatt.connected) {
            try {
                deviceEntry.device.gatt.disconnect();
                socket.emit('device_disconnected', deviceEntry.device.name); // แจ้งไปยัง backend
    
                console.log(`Device Disconnected: ${deviceEntry.device.name}`);
    
                // ลบ Card ของอุปกรณ์ออกจาก UI
                const deviceCard = document.getElementById(`device-card-${deviceName}`);
                if (deviceCard) {
                    deviceCard.remove();
                    console.log(`Removed device card: ${deviceEntry.device.name}`);
                }
    
                // ลบอุปกรณ์จาก connectedDevices
                connectedDevices.splice(deviceIndex, 1);
    
                // ลบค่าใน localStorage เพื่อไม่ให้สถานะค้าง
                localStorage.removeItem(`deviceStatus_${deviceName}`);
    
                await saveDeviceStatusToDatabase(deviceEntry.device.name, false);

            } catch (error) {
                console.error('Failed to disconnect:', error);
            }
        }
        
    };
    
    
    
    

    async function sendCommand(deviceName, command) {
        const deviceEntry = connectedDevices.find(device => device.device.name === deviceName);
        
        if (deviceEntry && deviceEntry.characteristic) {
            try {
                const encoder = new TextEncoder();
                await deviceEntry.characteristic.writeValue(encoder.encode(command));
                addLog(`Command sent to ${deviceName}: ${command}`);
            } catch (error) {
                addLog(`Failed to send command to ${deviceName}: ${error.message}`);
                console.error(error);
            }
        } else {
            addLog(`Device ${deviceName} is not connected!`);
        }
    }
    
    
    async function processQueue() {
        if (isProcessingQueue || commandQueue.length === 0) return;
    
        isProcessingQueue = true;
        while (commandQueue.length > 0) {
            const { deviceName, command } = commandQueue.shift();
            await sendCommand(deviceName, command);
        }
        isProcessingQueue = false;
    }

    
    window.toggleLight = async function (deviceName) {
        const switchElement = document.getElementById(`switch-${deviceName}`);
        if (!switchElement) {
            console.error(`Switch element for ${deviceName} not found.`);
            return;
        }
    
        const status = switchElement.checked;
        localStorage.setItem(`deviceState_${deviceName}`, JSON.stringify(status));
    
        let ledbulb = status ? 7.02 : 0.00;
        localStorage.setItem(`ledbulb_${deviceName}`, ledbulb.toFixed(2));
    
        console.log(`📝 ToggleLight | ${deviceName} | Status: ${status} | ledbulb: ${ledbulb}`);
    
        // ✅ ส่งค่า ledbulb ไปที่ Backend
        try {
            await fetch('http://192.168.0.109:3000/api/update-ledbulb', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceName, ledbulb })
            });
            console.log(`Updated ledbulb for ${deviceName} in backend.`);
        } catch (error) {
            console.error("Error updating ledbulb:", error);
        }
    
        // ส่งคำสั่งเปิด/ปิดไปที่อุปกรณ์
        await sendCommand(deviceName, `${deviceName}:${status ? 'on' : 'off'}`);
    };
    
    


    function loadSwitchStates() {
        setTimeout(() => {
            document.querySelectorAll('[id^="switch-"]').forEach(switchElement => {
                const deviceName = switchElement.id.replace('switch-', '').trim().toLowerCase();
                const savedStatus = localStorage.getItem(`deviceStatus_${deviceName}`);
                if (savedStatus !== null) {
                    switchElement.checked = JSON.parse(savedStatus);
                }
            });
        }, 500); // รอให้ DOM โหลดเสร็จก่อน
    }
    
    window.addEventListener('load', loadSwitchStates);
    
    
    
    async function saveDeviceStatusToDatabase(deviceName, status) {
    try {
        const response = await fetch('/api/save-device-status', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                deviceName,
                status
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to save device status: ${response.statusText}`);
        }

        console.log(`Device status for ${deviceName} saved to database successfully.`);
    } catch (error) {
        console.error(`Error saving status for ${deviceName}:`, error);
    }
    }
    
    async function updateElectricitySummary() {
        try {
            const response = await fetch('http://192.168.0.109:3000/api/electricity-summary');
            const data = await response.json();
    
            if (!response.ok) throw new Error(data.error || "Failed to fetch data");
    
            // ✅ ป้องกัน null/undefined โดยใช้ || 0
            const totalUsage = Number(data.totalUsage) || 0;
            const totalCostTHB = Number(data.totalCost) || 0;
    
            const savedCurrency = localStorage.getItem('currency') || 'THB';
    
            const totalCostConverted = convertCurrency(totalCostTHB, "THB", savedCurrency);
    
            // ✅ ใช้ .querySelectorAll เพื่อให้เลือกได้ถูกต้อง
            const elements = document.querySelectorAll('.card-name1');
            if (elements.length >= 2) {
                elements[0].textContent = `${totalUsage.toFixed(2)} kW`;
                elements[1].textContent = `${totalCostConverted} ${savedCurrency}`;
            }
    
            console.log(`Electricity Summary Updated: ${totalUsage} kW, ${totalCostConverted} ${savedCurrency}`);
        } catch (error) {
            console.error("Error updating electricity summary:", error);
        }
    }

    async function dashboardElectricitySummary() {
        try {
            const response = await fetch('http://192.168.0.109:3000/api/electricity-summary');
            const data = await response.json();
    
            if (!response.ok) throw new Error(data.error || "Failed to fetch data");
    
            // ✅ ป้องกัน null/undefined โดยใช้ || 0
            const totalUsage = Number(data.totalUsage) || 0;
            const totalCost = Number(data.totalCost) || 0;

            const savedCurrency = localStorage.getItem('currency') || 'THB';
    
            const totalCostConverted1 = convertCurrency(totalCost, "THB", savedCurrency);
    
    
            // ✅ อัปเดตค่าใน HTML ให้ตรงกับข้อมูลจากฐานข้อมูล
            const energyElement = document.getElementById('energy');
            const thbElement = document.getElementById('thb');
    
            if (energyElement) {
                energyElement.textContent = `${totalUsage.toFixed(2)} kWh`; // อัปเดตพลังงานรวม
            }
    
            if (thbElement) {
                thbElement.textContent = `${totalCostConverted1} ${savedCurrency}`; // อัปเดตราคาค่าไฟ
            }
    
            console.log(`Electricity Summary Updated: ${totalUsage} kWh, ${totalCost} THB`);
    
        } catch (error) {
            console.error("Error updating electricity summary:", error);
        }
    }
    
    // ✅ เรียกฟังก์ชันทุก 15 วินาที เพื่ออัปเดตข้อมูลอัตโนมัติ
    setInterval(dashboardElectricitySummary,3000);
    
    setInterval(updateElectricitySummary,3000);
    


    let brightnessDebounceTimeout = null;

    window.adjustBrightness = function (deviceName) {
        const slider = document.getElementById(`slider-${deviceName}`);
        let brightness = Math.round(slider.value * 100);
    
        if (brightnessDebounceTimeout) clearTimeout(brightnessDebounceTimeout);
    
        brightnessDebounceTimeout = setTimeout(async () => {
            
            let adjustedLedBulb = (brightness / 100) * 7.02;
    
            localStorage.setItem(`ledbulb_${deviceName}`, adjustedLedBulb.toFixed(2));
    
            console.log(`💡 Brightness for ${deviceName}: ${brightness}% | ledbulb: ${adjustedLedBulb}`);
    
            // ✅ ส่งค่า ledbulb ไปที่ Backend
            try {
                await fetch('http://192.168.0.109:3000/api/update-ledbulb', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceName, ledbulb: adjustedLedBulb })
                });
                console.log(`Updated brightness for ${deviceName} in backend.`);
            } catch (error) {
                console.error("Error updating brightness:", error);
            }
    
            // ส่งคำสั่งปรับความสว่างไปที่อุปกรณ์
            const command = `${deviceName}:brightness:${slider.value}`;
            commandQueue.push({ deviceName, command });
            processQueue();
        }, 200);
    };

    


    async function addLog(message) {
        const now = new Date();
        const formattedDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
        const formattedTime = now.toTimeString().split(' ')[0]; // HH:MM:SS
        
        await fetchLogs();
    
        // 🔹 บันทึก Log ลงใน Database
        await saveLogToDatabase(formattedDate, formattedTime, message);
    }
    
    async function saveLogToDatabase(date, time, message) {
        try {
            const response = await fetch('http://192.168.0.109:3000/api/insert-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date, time, message })
            });
    
            if (!response.ok) throw new Error("Failed to insert log data");
    
            console.log("Log saved to database successfully");
        } catch (error) {
            console.error("Error saving log to database:", error);
        }
    }
    
    async function fetchLogs(filter = '', save = false, initialize = false) {
        try {
            const filterElement = document.getElementById("logFilter");
            if (!filterElement) {
                console.error("Filter dropdown not found");
                return;
            }

            if (initialize) {
                let savedFilter = sessionStorage.getItem("logFilter") || "";
                if (!savedFilter) {
                    savedFilter = await getLatestFilter();
                    sessionStorage.setItem("logFilter", savedFilter);
                }
                filterElement.value = savedFilter;
                filter = savedFilter;
            }

            if (save) {
                sessionStorage.setItem("logFilter", filter);
            }

            filterElement.removeEventListener("change", filterChangeHandler);
            filterElement.addEventListener("change", filterChangeHandler);
            
            async function filterChangeHandler() {
                await fetchLogs(filterElement.value, true);
            }

            const response = await fetch(`http://192.168.0.109:3000/api/get-logs?filter=${filter}`);
            const logs = await response.json();
    
            if (!response.ok) throw new Error("Failed to fetch logs");
    
            const logBox = document.getElementById('log');
            if (logBox) {
                logBox.innerHTML = '';
                logs.forEach(logEntry => {
                    const logElement = document.createElement('div');
                    logElement.className = 'log-entry';
                    logElement.textContent = `${logEntry.log_date} ${logEntry.log_time} - ${logEntry.message}`;
                    logBox.appendChild(logElement);
                });
                logBox.scrollTop = logBox.scrollHeight;
            }
    
            console.log("Logs fetched successfully");
    
        } catch (error) {
            console.error("Error fetching logs:", error);
        }
    }

    async function getLatestFilter() {
        try {
            const response = await fetch(`http://192.168.0.109:3000/api/get-latest-filter`);
            const data = await response.json();
            return data.latestFilter || "1d";
        } catch (error) {
            console.error("Error fetching latest filter:", error);
            return "1d";
        }
    }
    
    

    
    
    window.changeColor = function (deviceName) {
        const colorPicker = document.getElementById(`colorPicker-${deviceName}`);
        const color = colorPicker.value;
        const rgb = hexToRgb(color);
    
        if (rgb) {
            sendCommand(deviceName, `${deviceName}:color:${rgb.r},${rgb.g},${rgb.b}`);
            addLog(`🎨 Color changed for ${deviceName} to RGB(${rgb.r}, ${rgb.g}, ${rgb.b})`);
        } else {
            addLog(`Failed to parse color for ${deviceName}`);
        }
    };
    
    function hexToRgb(hex) {
        const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
        if (match) {
            return {
                r: parseInt(match[1], 16),
                g: parseInt(match[2], 16),
                b: parseInt(match[3], 16)
            };
        }
        return null; // กรณีไม่ใช่ HEX ที่ถูกต้อง
    }
    


    

    // ฟังก์ชันสำหรับกราฟ
    async function initializeBarChart() {
        const canvas = document.getElementById('barChart');
        if (canvas) {
            const ctx = canvas.getContext('2d');
        
            try {
                // ดึงข้อมูลจาก API สำหรับ 7 วันล่าสุด
                const response = await fetch('http://192.168.0.109:3000/api/dashboard-last-7-days');
                const data = await response.json();
        
                if (!response.ok) {
                    throw new Error('Failed to fetch data');
                }
        
                // สร้าง label และ data สำหรับกราฟ
                let labels = [];
                let dataValues = [];
                let dailyDeviceUsage = [];
        
                // สร้างข้อมูลกราฟจากข้อมูลที่ดึงมา
                data.summary.forEach(record => {
                    const date = new Date(record.date);
                    const formattedDate = date.toLocaleDateString('th-TH', { weekday: 'short' }); // ใช้ภาษาไทย
        
                    // เพิ่มวันใน labels
                    labels.push(formattedDate); // ใช้วันที่จากฐานข้อมูลใน labels
        
                    // เพิ่มค่า total_current (ผลรวม current ทุกอุปกรณ์)
                    dataValues.push(record.total_current); // ใช้ผลรวม current ของทุกอุปกรณ์ในวันนั้น
        
                    // เพิ่มข้อมูลอุปกรณ์ในแต่ละวัน
                    dailyDeviceUsage.push(
                        data.details.filter(detail => detail.date === record.date)  // ข้อมูลของอุปกรณ์ในวันนั้น
                    );
                });
        
                // สร้างกราฟแท่ง
                const barChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Energy Usage (kWh)',
                            data: dataValues,
                            backgroundColor: 'rgba(54, 162, 235, 0.6)',
                            borderColor: 'rgba(54, 162, 235, 1)',
                            borderWidth: 1,
                        }],
                    },
                    options: {
                        responsive: true,
                        onClick: (event, elements) => {
                            if (elements.length > 0) {
                                const index = elements[0].index;
                                updateDoughnutChart(labels[index], dailyDeviceUsage[index]);
                            } else {
                                updateDoughnutChart(null, null);
                            }
                        },
                        scales: {
                            y: {
                                beginAtZero: true,
                                title: {
                                    display: true,
                                    text: 'kWh Used'
                                }
                            },
                            x: {
                                title: {
                                    display: true,
                                    text: 'Days'
                                }
                            }
                        }
                    }
                });
        
                // แสดงกราฟโดนัทของวันล่าสุด (ดึงข้อมูลวันล่าสุดจาก dailyDeviceUsage)
                if (dailyDeviceUsage.length > 0) {
                    const lastDayData = dailyDeviceUsage[0]; // วันล่าสุด
                    updateDoughnutChart(labels[0], lastDayData); // เรียกใช้งาน updateDoughnutChart เพื่อแสดงกราฟโดนัทของวันล่าสุด
                }
        
            } catch (error) {
                console.error('Error fetching data:', error);
            }
        }
    }
    
    function updateDoughnutChart(selectedDay, specificData) {
        const canvas = document.getElementById('doughnutChart');
        if (!canvas) return; // ถ้า canvas ไม่พบให้หยุดการทำงาน
    
        const ctx = canvas.getContext('2d');
    
        // ตรวจสอบว่า specificData เป็นอาร์เรย์ที่มีข้อมูลหรือไม่
        if (!Array.isArray(specificData) || specificData.length === 0) {
            console.error("No valid data to display in the doughnut chart.");
            return;
        }
    
        const labels = specificData.map(device => device.name); // ชื่ออุปกรณ์
        const data = specificData.map(device => device.current); // ค่า current ของแต่ละอุปกรณ์
    
        // รีเซ็ตกราฟเก่าและสร้างกราฟใหม่
        if (window.doughnutChartInstance) {
            window.doughnutChartInstance.destroy(); // ทำลายกราฟเก่าก่อน
        }
    
        // สร้างกราฟใหม่
        window.doughnutChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Energy Usage (kWh)',
                    data: data,
                    backgroundColor: [
                        'rgba(255, 99, 132, 1)',
                        'rgba(255, 206, 86, 1)',
                        'rgba(41, 155, 99, 1)',
                        'rgba(54, 162, 235, 1)'
                    ],
                    borderWidth: 1,
                }],
            },
            options: {
                responsive: true,
            }
        });
    }
    
    

    // ตั้งค่า popstate
    window.addEventListener('popstate', function () {
        const hash = window.location.hash.slice(1);
        loadContent(hash);
    });

    // โหลดเพจแรกเมื่อเปิด SPA
    window.addEventListener('load', function () {
        const hash = window.location.hash.slice(1) || 'dashboard';
        loadContent(hash);
        setUpLinks();
    });
});
