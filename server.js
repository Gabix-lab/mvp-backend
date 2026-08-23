const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// BEÁLLÍTÁSOK ÉS BIZTONSÁG
// ==========================================
// Változtasd meg ezt a tokent egy erős, titkos kulcsra!
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'NAGYON_TITKOS_ADMIN_TOKEN_123';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Fájlok útvonalai
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');
const PLAYERS_FILE = path.join(__dirname, 'players.json');

// Memóriában tárolt adatok
let activeUsers = new Map();
let uniquePlayers = new Map();
let blacklist = [];

// ==========================================
// SEGÉDFÜGGVÉNYEK
// ==========================================

// XSS elleni védelmet biztosító HTML kódoló
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Biztonságos JSON betöltés
function loadJsonFile(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error(`Hiba a(z) ${filePath} olvasásakor:`, err.message);
    }
    return defaultValue;
}

// Biztonságos JSON mentés hibakezeléssel
function saveJsonFile(filePath, data) {
    fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8', (err) => {
        if (err) {
            console.error(`Hiba a(z) ${filePath} mentésekor:`, err.message);
        }
    });
}

// Admin hitelesítő middleware
function authenticateAdmin(req, res, next) {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (token && token === ADMIN_TOKEN) {
        return next();
    }
    return res.status(401).json({ error: 'Ferderátlan vagy hiányzó Admin Token!' });
}

// Inaktív userek takarítása (5 percnél régebbi heartbeat)
function cleanupInactiveUsers() {
    const now = Date.now();
    const timeout = 5 * 60 * 1000;
    for (const [username, user] of activeUsers.entries()) {
        if (now - user.lastSeen > timeout) {
            activeUsers.delete(username);
        }
    }
}

// ==========================================
// KORÁBBI ADATOK BETÖLTÉSE
// ==========================================
blacklist = loadJsonFile(BLACKLIST_FILE, []);
const savedPlayers = loadJsonFile(PLAYERS_FILE, {});
for (const [key, val] of Object.entries(savedPlayers)) {
    uniquePlayers.set(key, val);
}

// Időzített takarítás 5 percenként
setInterval(cleanupInactiveUsers, 5 * 60 * 1000);

// ==========================================
// API VÉGPONTOK
// ==========================================

// Telemetria / Heartbeat fogadása a modból
app.post('/api/heartbeat', (req, res) => {
    const { username, serverIp } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!username) {
        return res.status(400).json({ error: 'A felhasználónév megadása kötelező!' });
    }

    // Blacklist ellenőrzés
    if (blacklist.includes(username)) {
        return res.status(403).json({ error: 'Tiltott felhasználó!' });
    }

    const now = Date.now();

    // Aktív státusz frissítése
    activeUsers.set(username, {
        username,
        serverIp: serverIp || 'Ismeretlen',
        clientIp,
        lastSeen: now
    });

    // Játékidő és statisztika frissítése
    let playerData = uniquePlayers.get(username) || {
        username,
        firstSeen: now,
        playTimeMinutes: 0,
        lastIp: clientIp
    };

    playerData.playTimeMinutes += 1; // Tételezzük fel, hogy 1 percenként érkezik heartbeat
    playerData.lastSeen = now;
    playerData.lastIp = clientIp;

    uniquePlayers.set(username, playerData);
    saveJsonFile(PLAYERS_FILE, Object.fromEntries(uniquePlayers));

    res.json({ status: 'ok' });
});

// Aktív userek lekérése
app.get('/api/users', (req, res) => {
    cleanupInactiveUsers();
    const users = Array.from(activeUsers.values());
    res.json(users);
});

// Admin: Feketelista kezelése
app.post('/api/ban', authenticateAdmin, (req, res) => {
    const { username } = req.body;
    if (!username) {
        return res.status(400).json({ error: 'Nincs megadva felhasználónév!' });
    }

    if (!blacklist.includes(username)) {
        blacklist.push(username);
        saveJsonFile(BLACKLIST_FILE, blacklist);
        activeUsers.delete(username);
    }

    res.json({ message: `${username} sikeresen tiltólistára került.`, blacklist });
});

// Admin: Online lista kézi ürítése
app.post('/api/online/reset', authenticateAdmin, (req, res) => {
    activeUsers.clear();
    res.json({ message: 'Az online játékosok listája kiürítve.' });
});

// ==========================================
// DÁSHBOARD / WEB FELÜLET (XSS VÉDETT)
// ==========================================
app.get('/dashboard', (req, res) => {
    cleanupInactiveUsers();

    const activeList = Array.from(activeUsers.values())
        .map(u => `<li><b>${escapeHtml(u.username)}</b> - Szerver: ${escapeHtml(u.serverIp)} (IP: ${escapeHtml(u.clientIp)})</li>`)
        .join('');

    const allList = Array.from(uniquePlayers.values())
        .map(p => `<li><b>${escapeHtml(p.username)}</b> - Összes játékidő: ${p.playTimeMinutes} perc (Utolsó IP: ${escapeHtml(p.lastIp)})</li>`)
        .join('');

    const html = `
    <!DOCTYPE html>
    <html lang="hu">
    <head>
        <meta charset="UTF-8">
        <title>Minecraft Telemetria</title>
        <style>
            body { font-family: sans-serif; margin: 20px; background: #f4f4f9; color: #333; }
            h2 { color: #2c3e50; border-bottom: 2px solid #2c3e50; padding-bottom: 5px; }
            ul { background: white; padding: 15px 30px; border-radius: 5px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
            li { margin-bottom: 5px; }
        </style>
    </head>
    <body>
        <h1>Minecraft Szerver Telemetria</h1>
        
        <h2>Jelenleg Online (${activeUsers.size})</h2>
        <ul>${activeList || '<li>Nincs online játékos.</li>'}</ul>

        <h2>Összes Regisztrált Játékos (${uniquePlayers.size})</h2>
        <ul>${allList || '<li>Nincs rögzített játékos.</li>'}</ul>
    </body>
    </html>
    `;

    res.send(html);
});

// Szerver indítása
app.listen(PORT, () => {
    console.log(`Szerver fut a következő porton: ${PORT}`);
});
