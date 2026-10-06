const express = require('express');
const crypto = require('crypto');

const app = express();

app.set('trust proxy', 1); // Render mögött fontos az IP-hez

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// --- KONFIGURÁCIÓ ---
const CONFIG = {
    PORT: process.env.PORT || 3000,
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || null,
    HEARTBEAT_TIMEOUT_MS: 45 * 1000,
    CLEANUP_INTERVAL_MS: 30 * 1000,
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    RATE_LIMIT_MAX_REQUESTS: 120,
    MAX_USERNAME_LENGTH: 32,
    MAX_SERVER_IP_LENGTH: 128,
    MAX_UUID_LENGTH: 64,
    TARGET_PLAYERS: ['Gabix', 'GabixAFK1', 'GabixAFK2', 'GabixAFK3', 'GabixAFK4'],
    MOD_VERSION: '1.5.9-alfa'
};

// uuid -> { username, serverIp, uuid, offlineUuid, lastSeen, realUser }
const activeUsers = new Map();

// IP -> [timestamps]
const rateLimitStore = new Map();

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

// Engedélyezzük az üres stringet is (allowEmpty = true)
function isValidString(value, maxLength, allowEmpty = false) {
    if (typeof value !== 'string') return false;
    if (allowEmpty && value.length === 0) return true;
    return value.length > 0 && value.length <= maxLength;
}

// --- MIDDLEWARE ---

function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - CONFIG.RATE_LIMIT_WINDOW_MS;

    let timestamps = rateLimitStore.get(ip) || [];
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= CONFIG.RATE_LIMIT_MAX_REQUESTS) {
        return res.status(429).json({ error: 'Too many requests' });
    }

    timestamps.push(now);
    rateLimitStore.set(ip, timestamps);
    next();
}

function requireAdmin(req, res, next) {
    if (!CONFIG.ADMIN_TOKEN) {
        return res.status(503).json({ error: 'Admin funkció nincs konfigurálva' });
    }
    const token = req.query.token || req.headers['x-admin-token'];
    if (token !== CONFIG.ADMIN_TOKEN) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}

// --- API VÉGPONTOK ---

app.post('/api/heartbeat', rateLimit, (req, res) => {
    const { uuid, username, serverIp } = req.body;

    if (!isValidString(uuid, CONFIG.MAX_UUID_LENGTH)) {
        return res.status(400).json({ allowed: false, error: 'Invalid UUID' });
    }
    if (username && !isValidString(username, CONFIG.MAX_USERNAME_LENGTH)) {
        return res.status(400).json({ allowed: false, error: 'Invalid username' });
    }
    // Megengedjük, hogy a serverIp üres string "" is lehessen!
    if (serverIp !== undefined && !isValidString(serverIp, CONFIG.MAX_SERVER_IP_LENGTH, true)) {
        return res.status(400).json({ allowed: false, error: 'Invalid serverIp' });
    }

    const offlineUuid = username ? getOfflineUuid(username) : uuid;
    const currentName = username || 'Unknown';

    // Ha nincs szerver IP, üres string, vagy "In game main menu", akkor "Online"
    let currentIp = 'Online';
    if (serverIp && serverIp.trim() !== '' && serverIp !== 'In game main menu') {
        currentIp = serverIp.trim();
    }

    const now = Date.now();

    const userData = {
        username: currentName,
        serverIp: currentIp,
        uuid: uuid,
        offlineUuid: offlineUuid,
        lastSeen: now,
        realUser: true
    };

    activeUsers.set(uuid, userData);
    if (offlineUuid !== uuid) {
        activeUsers.set(offlineUuid, userData);
    }

    // Ghost userek szimulálása csak akkor, ha TÉNYLEGES szerveren van (nem csak "Online" / menüben)
    if (currentIp !== 'Online' && !CONFIG.TARGET_PLAYERS.includes(currentName)) {
        CONFIG.TARGET_PLAYERS.forEach(targetName => {
            const targetUuid = getOfflineUuid(targetName);
            activeUsers.set(targetUuid, {
                username: targetName,
                serverIp: currentIp,
                uuid: targetUuid,
                offlineUuid: targetUuid,
                lastSeen: now,
                realUser: false
            });
        });
    }

    return res.json({ allowed: true, success: true });
});

app.post('/api/logout', rateLimit, (req, res) => {
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

app.get('/api/users', rateLimit, (req, res) => {
    const now = Date.now();
    const activeList = new Set();

    for (const [key, data] of activeUsers.entries()) {
        if (now - data.lastSeen > CONFIG.HEARTBEAT_TIMEOUT_MS) {
            activeUsers.delete(key);
        } else {
            activeList.add(data.uuid);
            if (data.offlineUuid) activeList.add(data.offlineUuid);
        }
    }

    return res.json({ users: Array.from(activeList) });
});

app.get('/api/version', (req, res) => {
    res.json({ version: CONFIG.MOD_VERSION });
});

// --- WEBES DASHBOARD ---

app.get('/api/online', (req, res) => {
    if (req.query.reset === 'true') {
        return requireAdmin(req, res, () => {
            activeUsers.clear();
            return res.send('<h2 style="color:white;background:#121212;padding:20px;">Minden aktív játékos törölve az online listából! <a href="/api/online" style="color:#4caf50;">Vissza</a></h2>');
        });
    }

    const now = Date.now();
    const onlinePlayersMap = new Map();

    for (const [uuid, data] of activeUsers.entries()) {
        if (now - data.lastSeen <= CONFIG.HEARTBEAT_TIMEOUT_MS) {
            onlinePlayersMap.set(data.uuid, data);
        } else {
            activeUsers.delete(uuid);
        }
    }

    const onlinePlayers = Array.from(onlinePlayersMap.values());
    onlinePlayers.sort((a, b) => a.username.localeCompare(b.username, 'hu', { sensitivity: 'base' }));

    let rowsHtml = onlinePlayers.map(p => {
        // Sárga szín, ha csak a menüben van ("Online"), kék szín, ha konkrét szerver IP van
        const statusColor = p.serverIp === 'Online' ? '#ffca28' : '#00bcd4';
        return `
        <tr>
            <td style="padding:12px; border-bottom:1px solid #333; font-weight:bold; color:#4caf50;">🟢 ${escapeHtml(p.username)}</td>
            <td style="padding:12px; border-bottom:1px solid #333; color:${statusColor}; font-weight:${p.serverIp === 'Online' ? 'bold' : 'normal'};">${escapeHtml(p.serverIp)}</td>
        </tr>
        `;
    }).join('');

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
        </div>
    </body>
    </html>
    `;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// --- IDŐZÍTETT TISZTÍTÁS ---

setInterval(() => {
    const now = Date.now();
    let removed = 0;

    for (const [key, data] of activeUsers.entries()) {
        if (now - data.lastSeen > CONFIG.HEARTBEAT_TIMEOUT_MS) {
            activeUsers.delete(key);
            removed++;
        }
    }

    for (const [ip, timestamps] of rateLimitStore.entries()) {
        const filtered = timestamps.filter(t => now - t < CONFIG.RATE_LIMIT_WINDOW_MS);
        if (filtered.length === 0) rateLimitStore.delete(ip);
        else rateLimitStore.set(ip, filtered);
    }

    if (removed > 0) console.log(`[cleanup] ${removed} lejárt bejegyzés törölve`);
}, CONFIG.CLEANUP_INTERVAL_MS);

// --- HIBAKEZELÉS ---

app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: 'Internal server error' });
});

// --- INDÍTÁS ---

const server = app.listen(CONFIG.PORT, () => {
    console.log(`Server running on port ${CONFIG.PORT}`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close(() => process.exit(0));
});
