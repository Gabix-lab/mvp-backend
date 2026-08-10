const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

const activeUsers = new Map();
const LOG_FILE = path.join(__dirname, 'server_history.log');

function logServerConnection(uuid, serverIp) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] UUID: ${uuid} | IP: ${serverIp}\n`;

    fs.appendFile(LOG_FILE, logLine, (err) => {
        if (err) {
            console.error('Hiba a fájlba íráskor:', err);
        }
    });
}

app.post('/api/heartbeat', (req, res) => {
    const { uuid, serverIp } = req.body;
    if (!uuid) return res.status(400).json({ error: 'Missing UUID' });

    const currentIp = serverIp || 'Unknown';
    const existingUser = activeUsers.get(uuid);

    // Csak akkor írunk a fájlba, ha a játékos most lépett fel, vagy szervert váltott
    if (!existingUser || existingUser.serverIp !== currentIp) {
        logServerConnection(uuid, currentIp);
    }

    activeUsers.set(uuid, {
        lastSeen: Date.now(),
        serverIp: currentIp
    });

    return res.json({ success: true });
});

// Tab listához szükséges felhasználók lekérése
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

app.get('/api/stats', (req, res) => {
    const stats = [];
    for (const [uuid, data] of activeUsers.entries()) {
        stats.push({
            uuid: uuid,
            serverIp: data.serverIp,
            lastSeen: new Date(data.lastSeen).toISOString()
        });
    }
    return res.json({ activeCount: stats.length, players: stats });
});

app.get('/api/logs', (req, res) => {
    fs.readFile(LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                return res.send('Még nem készült el a log fájl (nincs rögzített adat).');
            }
            return res.status(500).send('Hiba a log fájl olvasásakor.');
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(data);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
