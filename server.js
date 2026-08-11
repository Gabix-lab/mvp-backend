const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const activeUsers = new Map();
const LOG_FILE = path.join(__dirname, 'server_history.log');
const PLAYERS_HISTORY_FILE = path.join(__dirname, 'player_history.json');
const PLAYTIME_FILE = path.join(__dirname, 'playtime_history.json');
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');

// --- 1. TILTÓLISTA (BLACKLIST) KEZELÉSE ---
let blacklist = [];
if (fs.existsSync(BLACKLIST_FILE)) {
    try {
        blacklist = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
    } catch (err) {
        console.error('Hiba a blacklist.json olvasásakor:', err);
        blacklist = [];
    }
}

function saveBlacklist() {
    fs.writeFile(BLACKLIST_FILE, JSON.stringify(blacklist, null, 2), (err) => {
        if (err) console.error('Hiba a blacklist mentésekor:', err);
    });
}

// --- 2. PLAYTIME ADATOK BETÖLTÉSE & MENTÉSE ---
let playtimeData = {};
if (fs.existsSync(PLAYTIME_FILE)) {
    try {
        playtimeData = JSON.parse(fs.readFileSync(PLAYTIME_FILE, 'utf8'));
    } catch (err) {
        console.error('Hiba a playtime_history.json olvasásakor:', err);
        playtimeData = {};
    }
}

// Biztonságos, szinkron mentés az adatvesztés és fájlsérülés ellen
function savePlaytime() {
    try {
        fs.writeFileSync(PLAYTIME_FILE, JSON.stringify(playtimeData, null, 2), 'utf8');
    } catch (err) {
        console.error('Hiba a playtime mentésekor:', err);
    }
}

// --- 3. JÁTÉKOS HISTORY KEZELÉSE ---
let knownPlayers = {};
if (fs.existsSync(PLAYERS_HISTORY_FILE)) {
    try {
        knownPlayers = JSON.parse(fs.readFileSync(PLAYERS_HISTORY_FILE, 'utf8'));
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
        fs.writeFile(PLAYERS_HISTORY_FILE, JSON.stringify(knownPlayers, null, 2), () => {});
    }
}

// --- 4. LOG FILE KEZELÉSE ---
function logServerConnection(uuid, username, serverIp) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] Name: ${username} | UUID: ${uuid} | IP: ${serverIp}\n`;
    fs.appendFile(LOG_FILE, logLine, () => {});
}

// ==========================================
// API ENDPOINT-OK (Szervernek és Modnak)
// ==========================================

app.post('/api/heartbeat', (req, res) => {
    const { uuid, username, serverIp } = req.body;
    if (!uuid) return res.status(400).json({ allowed: false, error: 'Missing UUID' });

    // TILTÁS ELLENŐRZÉSE
    if (blacklist.includes(uuid)) {
        // Ha le van tiltva, eltávolítjuk az aktív játékosok közül is
        activeUsers.delete(uuid);
        return res.json({ 
            allowed: false, 
            reason: 'A mod használati joga ehhez a fiókhoz le lett tiltva!' 
        });
    }

    const currentName = username || 'Unknown';
    const currentIp = serverIp || 'In game main menu';
    const now = Date.now();
    const existingUser = activeUsers.get(uuid);

    saveUniquePlayer(uuid, currentName);

    if (!existingUser || existingUser.serverIp !== currentIp) {
        logServerConnection(uuid, currentName, currentIp);
    }

    // DINAMIKUS PLAYTIME MÉRÉS
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
            playtimeData[currentIp][uuid].username = currentName;
        }

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

    return res.json({ allowed: true, success: true });
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

// ==========================================
// TILTÁSOK KEZELÉSE FELÜLET (/api/ban)
// ==========================================

app.get('/api/ban', (req, res) => {
    // Akciók kezelése URL query paraméterekből (?action=ban&uuid=...)
    const { action, uuid } = req.query;

    if (action === 'ban' && uuid) {
        if (!blacklist.includes(uuid)) {
            blacklist.push(uuid);
            saveBlacklist();
            activeUsers.delete(uuid);
        }
        return res.redirect('/api/ban');
    }

    if (action === 'unban' && uuid) {
        blacklist = blacklist.filter(id => id !== uuid);
        saveBlacklist();
        return res.redirect('/api/ban');
    }

    // 1. Online játékosok kigyűjtése
    const now = Date.now();
    const TIMEOUT = 45 * 1000;
    const onlinePlayers = [];

    for (const [pUuid, data] of activeUsers.entries()) {
        if (now - data.lastSeen <= TIMEOUT) {
            if (!blacklist.includes(pUuid)) {
                onlinePlayers.push({ uuid: pUuid, ...data });
            }
        } else {
            activeUsers.delete(pUuid);
        }
    }

    onlinePlayers.sort((a, b) => a.username.localeCompare(b.username, 'hu', { sensitivity: 'base' }));

    let onlineRowsHtml = onlinePlayers.map(p => `
        <tr>
            <td style="padding:12px; border-bottom:1px solid #333; font-weight:bold; color:#4caf50;">🟢 ${p.username}</td>
            <td style="padding:12px; border-bottom:1px solid #333; color:#00bcd4;">${p.serverIp}</td>
            <td style="padding:12px; border-bottom:1px solid #333; font-size:12px; color:#aaa; font-family:monospace;">${p.uuid}</td>
            <td style="padding:12px; border-bottom:1px solid #333; text-align:right;">
                <a href="/api/ban?action=ban&uuid=${encodeURIComponent(p.uuid)}" 
                   style="background:#f44336; color:#fff; padding:6px 14px; text-decoration:none; border-radius:6px; font-weight:bold; font-size:13px;"
                   onclick="return confirm('Biztosan le akarod tiltani ezt a játékost?');">🔴 Tiltás</a>
            </td>
        </tr>
    `).join('');

    if (onlinePlayers.length === 0) {
        onlineRowsHtml = `<tr><td colspan="4" style="padding:20px; text-align:center; color:#888;">Nincs online játékos jelenleg.</td></tr>`;
    }

    // 2. Tiltott játékosok listája
    let bannedRowsHtml = blacklist.map(bUuid => {
        const name = knownPlayers[bUuid] ? knownPlayers[bUuid].username : 'Ismeretlen Név';
        return `
            <tr>
                <td style="padding:12px; border-bottom:1px solid #333; font-weight:bold; color:#f44336;">🔴 ${name}</td>
                <td style="padding:12px; border-bottom:1px solid #333; font-size:12px; color:#aaa; font-family:monospace;">${bUuid}</td>
                <td style="padding:12px; border-bottom:1px solid #333; text-align:right;">
                    <a href="/api/ban?action=unban&uuid=${encodeURIComponent(bUuid)}" 
                       style="background:#4caf50; color:#000; padding:6px 14px; text-decoration:none; border-radius:6px; font-weight:bold; font-size:13px;">🟢 Feloldás</a>
                </td>
            </tr>
        `;
    }).join('');

    if (blacklist.length === 0) {
        bannedRowsHtml = `<tr><td colspan="3" style="padding:20px; text-align:center; color:#888;">Nincs egyetlen tiltott játékos sem.</td></tr>`;
    }

    const html = `
    <!DOCTYPE html>
    <html lang="hu">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="10">
        <title>Mod Tiltások & Admin</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background:#121212; color:#fff; padding:30px; display:flex; justify-content:center; }
            .card { background:#1e1e1e; padding:25px; border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.5); width:100%; max-width:900px; }
            h1 { margin-top:0; color:#fff; }
            h2 { margin-top:30px; border-bottom:1px solid #333; padding-bottom:8px; font-size:18px; }
            table { width:100%; border-collapse:collapse; margin-top:10px; }
            th { text-align:left; padding:10px; background:#2a2a2a; color:#aaa; border-bottom:2px solid #444; }
        </style>
    </head>
    <body>
        <div class="card">
            <h1>🛡️ Mod Ban & Admin Felület</h1>
            
            <h2>🟢 Jelenleg Online Játékosok (${onlinePlayers.length})</h2>
            <table>
                <thead>
                    <tr>
                        <th>Név</th>
                        <th>Szerver IP</th>
                        <th>UUID</th>
                        <th style="text-align:right;">Művelet</th>
                    </tr>
                </thead>
                <tbody>
                    ${onlineRowsHtml}
                </tbody>
            </table>

            <h2>🔴 Tiltott Játékosok (${blacklist.length})</h2>
            <table>
                <thead>
                    <tr>
                        <th>Név</th>
                        <th>UUID</th>
                        <th style="text-align:right;">Művelet</th>
                    </tr>
                </thead>
                <tbody>
                    ${bannedRowsHtml}
                </tbody>
            </table>
        </div>
    </body>
    </html>
    `;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// ==========================================
// A TÖBBI BÖNGÉSZŐS FELÜLET
// ==========================================

// 1. ONLINE JÁTÉKOSOK LISTÁJA
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
            if (!blacklist.includes(uuid)) {
                onlinePlayers.push(data);
            }
        } else {
            activeUsers.delete(uuid);
        }
    }

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

// 2. DINAMIKUS PLAYTIME
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
    let selectedServer = req.query.server || (serverKeys.length > 0 ? serverKeys[0] : null);

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

// 3. ÖSSZES JÁTÉKOS HISTORY
app.get('/api/players', (req, res) => {
    const totalCount = Object.keys(knownPlayers).length;

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

// 4. LOGOK
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
