// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Раздача статических файлов из корневой папки (где лежат index.html, style.css, script.js)
app.use(express.static(path.join(__dirname, '../')));

// Создание пула соединений с MySQL
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Middleware для проверки авторизации (x-user-id)
const authMiddleware = (req, res, next) => {
    const userId = req.headers['x-user-id'];
    if (!userId) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    req.userId = parseInt(userId);
    next();
};

// ---------- Роуты ----------

// Регистрация
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Имя пользователя и пароль обязательны' });
    }
    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const [result] = await pool.execute(
            'INSERT INTO users (username, password_hash, nickname) VALUES (?, ?, ?)',
            [username, passwordHash, username]
        );
        res.json({ id: result.insertId, username });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ error: 'Пользователь уже существует' });
        } else {
            console.error(err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    }
});

// Вход
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
        }
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
        }
        res.json({
            id: user.id,
            username: user.username,
            avatar: user.avatar || '👤',
            nickname: user.nickname || user.username
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Получить профиль пользователя
app.get('/api/profile', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT id, username, avatar, nickname FROM users WHERE id = ?', [req.userId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Обновить профиль (аватар, никнейм)
app.put('/api/profile', authMiddleware, async (req, res) => {
    const { avatar, nickname } = req.body;
    try {
        await pool.execute('UPDATE users SET avatar = ?, nickname = ? WHERE id = ?', [avatar, nickname, req.userId]);
        res.json({ message: 'Профиль обновлён' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Получить все устройства пользователя
app.get('/api/devices', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM devices WHERE user_id = ?', [req.userId]);
        const devices = rows.map(dev => ({
            id: dev.device_id,
            name: dev.name,
            room: dev.room,
            type: dev.type,
            status: Boolean(dev.status),
            pos: { x: dev.pos_x, y: dev.pos_y, z: dev.pos_z },
            manufacturer: dev.manufacturer,
            state: dev.state,
            battery: dev.battery,
            targetTemp: dev.target_temp,
            connectedDevice: dev.connected_device,
            targetRoom: dev.target_room
        }));
        res.json(devices);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Добавить новое устройство
app.post('/api/devices', authMiddleware, async (req, res) => {
    const { device_id, name, room, type, status, pos, manufacturer, state, battery, targetTemp, connectedDevice, targetRoom } = req.body;
    try {
        await pool.execute(
            `INSERT INTO devices (user_id, device_id, name, room, type, status, pos_x, pos_y, pos_z, manufacturer, state, battery, target_temp, connected_device, target_room)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.userId, device_id, name, room, type, status, pos.x, pos.y, pos.z, manufacturer, state, battery, targetTemp, connectedDevice, targetRoom]
        );
        res.json({ message: 'Устройство добавлено', device_id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Обновить устройство (частичное обновление)
app.put('/api/devices/:device_id', authMiddleware, async (req, res) => {
    const { device_id } = req.params;
    const updates = req.body;
    const fields = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
        let dbField = key;
        if (key === 'targetTemp') dbField = 'target_temp';
        if (key === 'connectedDevice') dbField = 'connected_device';
        if (key === 'targetRoom') dbField = 'target_room';
        fields.push(`${dbField} = ?`);
        values.push(value);
    }
    if (fields.length === 0) {
        return res.status(400).json({ error: 'Нет данных для обновления' });
    }
    values.push(device_id, req.userId);
    try {
        await pool.execute(`UPDATE devices SET ${fields.join(', ')} WHERE device_id = ? AND user_id = ?`, values);
        res.json({ message: 'Устройство обновлено' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Удалить устройство
app.delete('/api/devices/:device_id', authMiddleware, async (req, res) => {
    const { device_id } = req.params;
    try {
        await pool.execute('DELETE FROM devices WHERE device_id = ? AND user_id = ?', [device_id, req.userId]);
        res.json({ message: 'Устройство удалено' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
