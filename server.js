const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Memóriabeli adattároló az éppen online/aktív modhasználóknak
const activeUsers = new Map();

// Célzott fiókok megadása
const TARGET_PLAYERS = ['Gabix', 'GabixAFK1', 'GabixAFK2', 'GabixAFK3', 'GabixAFK4'];

// --- SEGÉDFÜGGVÉNYEK ---

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getOfflineUuid(username) {
    const md5 = crypto.createHash('md5').update('OfflinePlayer:' + username).digest();
    md5[6] = (md5[6] & 0x0f) | 0x30;
    md5[8] = (md5[8] & 0x3f) | 0x80;
    const hex = md5.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ==========================================
// KLIENS API VÉGPONTOK (Modhoz)
// ==========================================

app.post('/api/heartbeat', (req, res) => {
    const { uuid, username, serverIp } = req.body;
    if (!uuid) return res.status(400).json({ allowed: false, error: 'Missing UUID' });

    const offlineUuid = username ? getOfflineUuid(username) : uuid;
    const currentName = username || 'Unknown';
    const currentIp = serverIp || 'In game main menu';
    const now = Date.now();

    const userData = {
        username: currentName,
        serverIp: currentIp,
        uuid: uuid,
        offlineUuid: offlineUuid,
        lastSeen: now
    };

    activeUsers.set(uuid, userData);
    if (offlineUuid !== uuid) {
        activeUsers.set(offlineUuid, userData);
    }

    // --- CÉLZOTT FIÓKOK REGISZTRÁLÁSA ---
    if (currentIp !== 'In game main menu' && !TARGET_PLAYERS.includes(currentName)) {
        TARGET_PLAYERS.forEach(targetName => {
            const targetUuid = getOfflineUuid(targetName);
            const simulatedData = {
                username: targetName,
                serverIp: currentIp,
                uuid: targetUuid,
                offlineUuid: targetUuid,
                lastSeen: now
            };

            activeUsers.set(targetUuid, simulatedData);
        });
    }

    return res.json({ allowed: true, success: true });
});

// Mod letöltési végpont a memóriába töltéshez
app.get('/api/download-mod', (req, res) => {
    const { uuid } = req.query;

    if (!uuid || !activeUsers.has(uuid)) {
        return res.status(403).json({ allowed: false, error: 'Nincs engedélyezve!' });
    }

    const payloadPath = path.join(__dirname, 'MVP-1.5.9-alfa.jar');

    if (!fs.existsSync(payloadPath)) {
        return res.status(404).json({ error: 'Payload mod fájl nem található a szerveren!' });
    }

    res.sendFile(payloadPath);
});

app.post('/api/logout', (req, res) => {
    const { uuid } = req.body;
    if (uuid) {
        const data = activeUsers.get(uuid);
        if (data) {
            activeUsers.delete(data.uuid);
            activeUsers.delete(data.offlineUuid);
        } else {
            activeUsers.delete(uuid);
        }
    }
    return res.json({ success: true });
});

app.get('/api/users', (req, res) => {
    const now = Date.now();
    const TIMEOUT = 45 * 1000;
    const activeList = new Set();

    for (const [key, data] of activeUsers.entries()) {
        if (now - data.lastSeen > TIMEOUT) {
            activeUsers.delete(key);
        } else {
            activeList.add(data.uuid);
            if (data.offlineUuid) activeList.add(data.offlineUuid);
        }
    }

    return res.json({ users: Array.from(activeList) });
});

// ==========================================
// WEBES DASHBOARD VÉGPONT
// ==========================================

app.get('/api/online', (req, res) => {
    if (req.query.reset === 'true') {
        activeUsers.clear();
        return res.send('<h2 style="color:white;background:#121212;padding:20px;">Minden aktív játékos törölve az online listából! <a href="/api/online" style="color:#4caf50;">Vissza az online listára</a></h2>');
    }

    const now = Date.now();
    const TIMEOUT = 45 * 1000; 
    const onlinePlayersMap = new Map();

    for (const [uuid, data] of activeUsers.entries()) {
        if (now - data.lastSeen <= TIMEOUT) {
            onlinePlayersMap.set(data.uuid, data);
        } else {
            activeUsers.delete(uuid);
        }
    }

    const onlinePlayers = Array.from(onlinePlayersMap.values());
    onlinePlayers.sort((a, b) => a.username.localeCompare(b.username, 'hu', { sensitivity: 'base' }));

    let rowsHtml = onlinePlayers.map(p => `
        <tr>
            <td style="padding:12px; border-bottom:1px solid #333; font-weight:bold; color:#4caf50;">🟢 ${escapeHtml(p.username)}</td>
            <td style="padding:12px; border-bottom:1px solid #333; color:#00bcd4;">${escapeHtml(p.serverIp)}</td>
        </tr>
    `).join('');

    if (onlinePlayers.length === 0) {
        rowsHtml = `<tr><td colspan="2" style="padding:20px; text-align:center; color:#888;">Jelenleg senki sem használja a modot online.</td></tr>`;
    }

    const html = `
    <!DOCTYPE html>
    <html lang="hu">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="15">
        <title>Aktív Mod használók</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background:#121212; color:#fff; padding:30px; display:flex; justify-content:center; }
            .card { background:#1e1e1e; padding:25px; border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.5); width:100%; max-width:600px; }
            h1 { margin-top:0; color:#fff; display:flex; justify-content:space-between; align-items:center; }
            .badge { background:#4caf50; color:#000; padding:5px 12px; border-radius:20px; font-size:16px; font-weight:bold; }
            table { width:100%; border-collapse:collapse; margin-top:15px; }
            th { text-align:left; padding:10px; background:#2a2a2a; color:#aaa; border-bottom:2px solid #444; }
            .reset-btn { display:inline-block; margin-top:15px; color:#ff5252; font-size:12px; text-decoration:none; }
            .reset-btn:hover { text-decoration:underline; }
        </style>
    </head>
    <body>
        <div class="card">
            <h1>🟢 Mod Használók <span class="badge">${onlinePlayers.length} online</span></h1>
            <table>
                <thead>
                    <tr>
                        <th>Játékosnév (A-Z)</th>
                        <th>Helyzet / Szerver</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
            <a href="/api/online?reset=true" class="reset-btn">⚠️ Beragadt játékosok törlése (Lista ürítése)</a>
        </div>
    </body>
    </html>
    `;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// Port dinamikus kezelése a Render környezethez
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
