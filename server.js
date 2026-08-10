const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

const activeUsers = new Map();
const LOG_FILE = path.join(__dirname, 'server_history.log');
const PLAYERS_HISTORY_FILE = path.join(__dirname, 'player_history.json');
const PLAYTIME_FILE = path.join(__dirname, 'playtime_history.json');

// --- 1. PLAYTIME ADATOK BETÖLTÉSE (Szerver / UUID / Time adatszerkezet) ---
let playtimeData = {};

if (fs.existsSync(PLAYTIME_FILE)) {
    try {
        playtimeData = JSON.parse(fs.readFileSync(PLAYTIME_FILE, 'utf8'));
    } catch (err) {
        console.error('Hiba a playtime_history.json olvasásakor:', err);
        playtimeData = {};
    }
}

function savePlaytime() {
    fs.writeFile(PLAYTIME_FILE, JSON.stringify(playtimeData, null, 2), (err) => {
        if (err) console.error('Hiba a playtime mentésekor:', err);
    });
}

// --- 2. JÁTÉKOS HISTORY ---
let knownPlayers = {};
if (fs.existsSync(PLAYERS_HISTORY_FILE)) {
    try {
        knownPlayers = JSON.parse(fs.readFileSync(PLAYERS_HISTORY_FILE, 'utf8'));
    } catch (err) {
        knownPlayers = {};
    }
}

function saveUniquePlayer(uuid, username) {
    if (!knownPlayers[uuid]) {
        knownPlayers[uuid] = {
            username: username,
            firstSeen: new Date().toISOString()
        };
        fs.writeFile(PLAYERS_HISTORY_FILE, JSON.stringify(knownPlayers, null, 2), () => {});
    }
}

function logServerConnection(uuid, username, serverIp) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] Name: ${username} | UUID: ${uuid} | IP: ${serverIp}\n`;
    fs.appendFile(LOG_FILE, logLine, () => {});
}

// --- HEARTBEAT & DINAMIKUS PLAYTIME LOGIKA ---
app.post('/api/heartbeat', (req, res) => {
    const { uuid, username, serverIp } = req.body;
    if (!uuid) return res.status(400).json({ error: 'Missing UUID' });

    const currentName = username || 'Unknown';
    const currentIp = serverIp || 'In game main menu';
    const now = Date.now();
    const existingUser = activeUsers.get(uuid);

    saveUniquePlayer(uuid, currentName);

    if (!existingUser || existingUser.serverIp !== currentIp) {
        logServerConnection(uuid, currentName, currentIp);
    }

    // DINAMIKUS PLAYTIME MÉRÉS
    // Ha nem a főmenüben van, feljegyezzük a szerverhez tartozó időt
    if (currentIp !== 'In game main menu') {
        if (!playtimeData[currentIp]) {
            playtimeData[currentIp] = {};
        }

        if (!playtimeData[currentIp][uuid]) {
            playtimeData[currentIp][uuid] = {
                username: currentName,
                totalSeconds: 0
            };
        } else {
            playtimeData[currentIp][uuid].username = currentName; // Név frissítése
        }

        // Ha az előző heartbeat óta eltelt idő < 35 másodperc, hozzáadjuk az eltelt időt
        if (existingUser && existingUser.serverIp === currentIp) {
            const elapsedSeconds = Math.floor((now - existingUser.lastSeen) / 1000);
            if (elapsedSeconds > 0 && elapsedSeconds < 35) {
                playtimeData[currentIp][uuid].totalSeconds += elapsedSeconds;
                savePlaytime();
            }
        }
    }

    activeUsers.set(uuid, {
        username: currentName,
        serverIp: currentIp,
        lastSeen: now
    });

    return res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
    const { uuid } = req.body;
    if (uuid) {
        activeUsers.delete(uuid);
    }
    return res.json({ success: true });
});

app.get('/api/users', (req, res) => {
    const now = Date.now();
    const TIMEOUT = 45 * 1000;

    for (const [uuid, data] of activeUsers.entries()) {
        if (now - data.lastSeen > TIMEOUT) {
            activeUsers.delete(uuid);
        }
    }

    return res.json({ users: Array.from(activeUsers.keys()) });
});


// --- DINAMIKUS FÜLEKKEL ELLÁTOTT /api/playtime FELÜLET ---
app.get('/api/playtime', (req, res) => {
    const formatTime = (totalSeconds) => {
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        
        let result = [];
        if (hours > 0) result.push(`${hours} óra`);
        if (minutes > 0 || hours > 0) result.push(`${minutes} perc`);
        result.push(`${seconds} mp`);
        return result.join(' ');
    };

    const serverKeys = Object.keys(playtimeData).sort();
    
    // Alapértelmezetten az első elérhető szerver van kiválasztva, vagy amit az URL query-ben megadnak (?server=...)
    let selectedServer = req.query.server || (serverKeys.length > 0 ? serverKeys[0] : null);

    // Dynamic Tab-ek generálása
    let tabsHtml = serverKeys.map(srv => {
        const isActive = srv === selectedServer;
        const style = isActive 
            ? "background:#ff9800; color:#000; font-weight:bold;" 
            : "background:#2a2a2a; color:#ccc;";
        return `<a href="/api/playtime?server=${encodeURIComponent(srv)}" style="display:inline-block; padding:8px 16px; margin:4px; border-radius:8px; text-decoration:none; ${style}">${srv}</a>`;
    }).join('');

    if (serverKeys.length === 0) {
        tabsHtml = '<span style="color:#888;">Még nincsenek rögzített szerver adatok.</span>';
    }

    let rowsHtml = '';
    if (selectedServer && playtimeData[selectedServer]) {
        const sortedPlayers = Object.entries(playtimeData[selectedServer])
            .map(([uuid, p]) => ({
                username: p.username,
                totalSeconds: p.totalSeconds,
                formatted: formatTime(p.totalSeconds)
            }))
            .sort((a, b) => b.totalSeconds - a.totalSeconds);

        rowsHtml = sortedPlayers.map((p, index) => `
            <tr>
                <td style="padding:12px; border-bottom:1px solid #333; font-weight:bold; color:#ff9800;">#${index + 1}</td>
                <td style="padding:12px; border-bottom:1px solid #333; font-weight:bold; color:#2196f3;">👤 ${p.username}</td>
                <td style="padding:12px; border-bottom:1px solid #333; font-weight:bold; color:#4caf50;">⏱️ ${p.formatted}</td>
            </tr>
        `).join('');
    } else {
        rowsHtml = `<tr><td colspan="3" style="padding:20px; text-align:center; color:#888;">Válassz egy szervert a fenti fülek közül!</td></tr>`;
    }

    const html = `
    <!DOCTYPE html>
    <html lang="hu">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="10">
        <title>Szerver Játékidők</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background:#121212; color:#fff; padding:30px; display:flex; justify-content:center; }
            .card { background:#1e1e1e; padding:25px; border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.5); width:100%; max-width:800px; }
            h1 { margin-top:0; color:#fff; }
            .tabs { margin-bottom:20px; border-bottom:1px solid #333; padding-bottom:15px; }
            table { width:100%; border-collapse:collapse; margin-top:15px; }
            th { text-align:left; padding:10px; background:#2a2a2a; color:#aaa; border-bottom:2px solid #444; }
        </style>
    </head>
    <body>
        <div class="card">
            <h1>⏱️ Szerver Játékidők</h1>
            <div class="tabs">
                <strong>Szerverek:</strong><br>
                ${tabsHtml}
            </div>
            <h2>Szerver: <span style="color:#ff9800;">${selectedServer || 'Nincs kiválasztva'}</span></h2>
            <table>
                <thead>
                    <tr>
                        <th>Helyezés</th>
                        <th>Játékos</th>
                        <th>Játékidő ezen a szerveren</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    </body>
    </html>
    `;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// A TÖBBI ENDPOINT (ONLINE, PLAYERS, LOGS) VÁLTOZATLAN...
app.get('/api/online', (req, res) => { /* ... */ });
app.get('/api/players', (req, res) => { /* ... */ });
app.get('/api/logs', (req, res) => { /* ... */ });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
