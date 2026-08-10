const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

const activeUsers = new Map();
const LOG_FILE = path.join(__dirname, 'server_history.log');
const PLAYERS_HISTORY_FILE = path.join(__dirname, 'player_history.json');

// --- 1. JÁTÉKOS HISTORY KEZELÉSE (Memória + Fájl) ---
let knownPlayers = {};

// Betöltjük a korábban elmentett játékosokat indításkor
if (fs.existsSync(PLAYERS_HISTORY_FILE)) {
    try {
        const rawData = fs.readFileSync(PLAYERS_HISTORY_FILE, 'utf8');
        knownPlayers = JSON.parse(rawData);
    } catch (err) {
        console.error('Hiba a player_history.json olvasásakor:', err);
        knownPlayers = {};
    }
}

// Új játékos elmentése a fájlba (csak ha még nem létezik)
function saveUniquePlayer(uuid, username) {
    if (!knownPlayers[uuid]) {
        knownPlayers[uuid] = {
            username: username,
            firstSeen: new Date().toISOString()
        };

        // Elmentjük a lemezre JSON formátumban
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

// --- API ENDPOINT-OK ---

// Heartbeat fogadása
app.post('/api/heartbeat', (req, res) => {
    const { uuid, username, serverIp } = req.body;
    if (!uuid) return res.status(400).json({ error: 'Missing UUID' });

    const currentName = username || 'Unknown';
    const currentIp = serverIp || 'Unknown';
    const existingUser = activeUsers.get(uuid);

    // 1. Megpróbáljuk elmenteni az egyedi játékos listába (csak egyszer fogja elmenteni!)
    saveUniquePlayer(uuid, currentName);

    // 2. Eseménynapló (IP váltás vagy új belépés esetén)
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

// A modoknak átadott aktív UUID lista (Tab listához)
app.get('/api/users', (req, res) => {
    const now = Date.now();
    const TIMEOUT = 3 * 60 * 1000;

    for (const [uuid, data] of activeUsers.entries()) {
        if (now - data.lastSeen > TIMEOUT) {
            activeUsers.delete(uuid);
        }
    }

    return res.json({ users: Array.from(activeUsers.keys()) });
});

// Online játékosok statisztikája
app.get('/api/stats', (req, res) => {
    const stats = [];
    for (const [uuid, data] of activeUsers.entries()) {
        stats.push({
            username: data.username,
            uuid: uuid,
            serverIp: data.serverIp,
            lastSeen: new Date(data.lastSeen).toISOString()
        });
    }
    return res.json({ activeCount: stats.length, players: stats });
});

// Szerver csatlakozási logok
app.get('/api/logs', (req, res) => {
    fs.readFile(LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.send('Nincs rögzített adat.');
            return res.status(500).send('Hiba a fájl olvasásakor.');
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(data);
    });
});

// ÚJ ENDPOINT: Az összes eddig regisztrált egyedi játékos listája
// Nyisd meg a böngészőben: https://mvp-backend-bods.onrender.com/api/players
app.get('/api/players', (req, res) => {
    return res.json({
        totalUniquePlayers: Object.keys(knownPlayers).length,
        players: knownPlayers
    });
});

app.get('/api/online', (req, res) => {
    const now = Date.now();
    const TIMEOUT = 3 * 60 * 1000; // 3 perc inaktivitás után offline-nak számít

    const onlinePlayers = [];

    for (const [uuid, data] of activeUsers.entries()) {
        if (now - data.lastSeen <= TIMEOUT) {
            onlinePlayers.push({
                username: data.username,
                serverIp: data.serverIp
            });
        } else {
            activeUsers.delete(uuid);
        }
    }

    return res.json({
        onlineCount: onlinePlayers.length,
        players: onlinePlayers
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
