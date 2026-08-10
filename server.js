const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

const activeUsers = new Map();
const LOG_FILE = path.join(__dirname, 'server_history.log');
const PLAYERS_HISTORY_FILE = path.join(__dirname, 'player_history.json');

// --- 1. JÁTÉKOS HISTORY KEZELÉSE ---
let knownPlayers = {};

if (fs.existsSync(PLAYERS_HISTORY_FILE)) {
    try {
        const rawData = fs.readFileSync(PLAYERS_HISTORY_FILE, 'utf8');
        knownPlayers = JSON.parse(rawData);
    } catch (err) {
        console.error('Hiba a player_history.json olvasásakor:', err);
        knownPlayers = {};
    }
}

function saveUniquePlayer(uuid, username) {
    if (!knownPlayers[uuid]) {
        knownPlayers[uuid] = {
            username: username,
            firstSeen: new Date().toISOString()
        };

        fs.writeFile(PLAYERS_HISTORY_FILE, JSON.stringify(knownPlayers, null, 2), (err) => {
            if (err) {
                console.error('Hiba a player_history.json mentésekor:', err);
            }
        });
    }
}

// --- 2. LOG FILE KEZELÉSE ---
function logServerConnection(uuid, username, serverIp) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] Name: ${username} | UUID: ${uuid} | IP: ${serverIp}\n`;

    fs.appendFile(LOG_FILE, logLine, (err) => {
        if (err) {
            console.error('Hiba a log fájlba íráskor:', err);
        }
    });
}

// --- API ENDPOINT-OK (Szervernek és Modnak) ---

app.post('/api/heartbeat', (req, res) => {
    const { uuid, username, serverIp } = req.body;
    if (!uuid) return res.status(400).json({ error: 'Missing UUID' });

    const currentName = username || 'Unknown';
    const currentIp = serverIp || 'Unknown';
    const existingUser = activeUsers.get(uuid);

    saveUniquePlayer(uuid, currentName);

    if (!existingUser || existingUser.serverIp !== currentIp) {
        logServerConnection(uuid, currentName, currentIp);
    }

    activeUsers.set(uuid, {
        username: currentName,
        serverIp: currentIp,
        lastSeen: Date.now()
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


// --- SZÉP BÖNGÉSZŐS FELÜLETEK (HTML) ABC-SORRENDBEN ---

// 1. ONLINE FELÜLET (ABC-sorrendbe rendezve)
app.get('/api/online', (req, res) => {
    if (req.query.reset === 'true') {
        activeUsers.clear();
        return res.send('<h2 style="color:white;background:#121212;padding:20px;">Minden aktív játékos törölve az online listából! <a href="/api/online" style="color:#4caf50;">Vissza az online listára</a></h2>');
    }

    const now = Date.now();
    const TIMEOUT = 45 * 1000; 
    const onlinePlayers = [];

    for (const [uuid, data] of activeUsers.entries()) {
        if (now - data.lastSeen <= TIMEOUT) {
            onlinePlayers.push(data);
        } else {
            activeUsers.delete(uuid);
        }
    }

    // ABC-sorrendbe rendezés a játékosnév (username) alapján
    onlinePlayers.sort((a, b) => a.username.localeCompare(b.username, 'hu', { sensitivity: 'base' }));

    let rowsHtml = onlinePlayers.map(p => `
        <tr>
            <td style="padding:12px; border-bottom:1px solid #333; font-weight:bold; color:#4caf50;">🟢 ${p.username}</td>
            <td style="padding:12px; border-bottom:1px solid #333; color:#00bcd4;">${p.serverIp}</td>
        </tr>
    `).join('');

    if (onlinePlayers.length === 0) {
        rowsHtml = `<tr><td colspan="2" style="padding:20px; text-align:center; color:#888;">Jelenleg senki sincs online.</td></tr>`;
    }

    const html = `
    <!DOCTYPE html>
    <html lang="hu">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="15">
        <title>Online Játékosok</title>
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
            <h1>🟢 Online Játékosok <span class="badge">${onlinePlayers.length} online</span></h1>
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

// 2. ÖSSZES JÁTÉKOS FELÜLET (ABC-sorrendbe rendezve)
app.get('/api/players', (req, res) => {
    const totalCount = Object.keys(knownPlayers).length;

    // Átalakítás tömbbé és ABC-sorrendbe rendezés a játékosnév (username) alapján
    const sortedPlayers = Object.entries(knownPlayers).sort((a, b) => {
        return a[1].username.localeCompare(b[1].username, 'hu', { sensitivity: 'base' });
    });

    let rowsHtml = sortedPlayers.map(([uuid, player]) => `
        <tr>
            <td style="padding:12px; border-bottom:1px solid #333; font-weight:bold; color:#2196f3;">👤 ${player.username}</td>
            <td style="padding:12px; border-bottom:1px solid #333; font-size:12px; color:#aaa; font-family:monospace;">${uuid}</td>
            <td style="padding:12px; border-bottom:1px solid #333; color:#ff9800;">${new Date(player.firstSeen).toLocaleString('hu-HU')}</td>
        </tr>
    `).join('');

    if (totalCount === 0) {
        rowsHtml = `<tr><td colspan="3" style="padding:20px; text-align:center; color:#888;">Még nem regisztrált egyetlen játékos sem.</td></tr>`;
    }

    const html = `
    <!DOCTYPE html>
    <html lang="hu">
    <head>
        <meta charset="UTF-8">
        <title>Összes Játékos History</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background:#121212; color:#fff; padding:30px; display:flex; justify-content:center; }
            .card { background:#1e1e1e; padding:25px; border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.5); width:100%; max-width:800px; }
            h1 { margin-top:0; color:#fff; display:flex; justify-content:space-between; align-items:center; }
            .badge { background:#2196f3; color:#fff; padding:5px 12px; border-radius:20px; font-size:16px; font-weight:bold; }
            table { width:100%; border-collapse:collapse; margin-top:15px; }
            th { text-align:left; padding:10px; background:#2a2a2a; color:#aaa; border-bottom:2px solid #444; }
        </style>
    </head>
    <body>
        <div class="card">
            <h1>👥 Összes Használó <span class="badge">${totalCount} játékos</span></h1>
            <table>
                <thead>
                    <tr>
                        <th>Név (A-Z)</th>
                        <th>UUID</th>
                        <th>Első belépés</th>
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

// 3. CSATLAKOZÁSI LOGOK
app.get('/api/logs', (req, res) => {
    fs.readFile(LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.send('Nincs rögzített adat.');
            return res.status(500).send('Hiba a fájl olvasásakor.');
        }
        
        const html = `
        <!DOCTYPE html>
        <html lang="hu">
        <head>
            <meta charset="UTF-8">
            <title>Szerver Logok</title>
            <style>
                body { background:#0d1117; color:#c9d1d9; font-family:monospace; padding:20px; }
                pre { background:#161b22; padding:20px; border-radius:8px; border:1px solid #30363d; overflow-x:auto; }
            </style>
        </head>
        <body>
            <h2>📜 Csatlakozási és IP Előzmények (Logok)</h2>
            <pre>${data}</pre>
        </body>
        </html>
        `;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
