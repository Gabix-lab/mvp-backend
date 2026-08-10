const express = require('express');
const app = express();
app.use(express.json());

// Memóriában tároljuk az aktív usereket: UUID -> Utolsó aktivitás (timestamp)
const activeUsers = new Map();

// 1. Regisztráció / Heartbeat (Ugyanaz az endpoint kezeli mindkettőt)
app.post('/api/heartbeat', (req, res) => {
    const { uuid } = req.body;
    if (!uuid) {
        return res.status(400).json({ error: 'Missing UUID' });
    }
    
    activeUsers.set(uuid, Date.now());
    return res.json({ success: true });
});

// 2. Aktív userek lekérése (Törli a 3 percnél régebbi, inaktív usereket)
app.get('/api/users', (req, res) => {
    const now = Date.now();
    const TIMEOUT = 3 * 60 * 1000; // 3 perc inaktivitás után törlés

    for (const [uuid, lastSeen] of activeUsers.entries()) {
        if (now - lastSeen > TIMEOUT) {
            activeUsers.delete(uuid);
        }
    }

    return res.json({ users: Array.from(activeUsers.keys()) });
});

// Szerver indítása
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Actionbar Backend fut a ${PORT}-es porton.`));