const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
// Раздаём статику из ТЕКУЩЕЙ папки (где лежит server.js и index.html)
app.use(express.static(__dirname));

// --- База данных SQLite ---
const db = new sqlite3.Database(path.join(__dirname, 'smarthome.db'));

// Функция для добавления колонки, если её нет
function addColumnIfNotExists(table, column, type) {
  db.all(`PRAGMA table_info(${table})`, (err, columns) => {
    if (err) return;
    const exists = columns.some(col => col.name === column);
    if (!exists) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`✅ Добавлена колонка ${column} в таблицу ${table}`);
    }
  });
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT DEFAULT '👤',
    nickname TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    room TEXT NOT NULL,
    status INTEGER DEFAULT 0,
    pos_x REAL DEFAULT 0,
    pos_y REAL DEFAULT 0.5,
    pos_z REAL DEFAULT 0,
    manufacturer TEXT,
    state TEXT,
    battery INTEGER,
    targetTemp INTEGER,
    connectedDevice TEXT,
    targetRoom TEXT,
    program TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  addColumnIfNotExists('devices', 'program', 'TEXT');

  db.run(`CREATE TABLE IF NOT EXISTS device_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    action TEXT,
    old_value TEXT,
    new_value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Вспомогательная функция для получения userId из заголовка
function getUserFromHeader(req) {
  const userId = req.headers['x-user-id'];
  if (!userId) throw new Error('Не указан x-user-id');
  return parseInt(userId);
}

// --- API маршруты ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)',
      [username, hashedPassword, username],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Пользователь уже существует' });
          return res.status(500).json({ error: 'Ошибка сервера' });
        }
        res.json({ id: this.lastID, username });
      });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Неверные учётные данные' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Неверные учётные данные' });
    res.json({ id: user.id, username: user.username });
  });
});

app.get('/api/profile', (req, res) => {
  try {
    const userId = getUserFromHeader(req);
    db.get('SELECT id, username, avatar, nickname FROM users WHERE id = ?', [userId], (err, row) => {
      if (err || !row) return res.status(404).json({ error: 'Пользователь не найден' });
      res.json(row);
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.put('/api/profile', (req, res) => {
  try {
    const userId = getUserFromHeader(req);
    const { avatar, nickname } = req.body;
    db.run('UPDATE users SET avatar = ?, nickname = ? WHERE id = ?', [avatar, nickname, userId], (err) => {
      if (err) return res.status(500).json({ error: 'Ошибка обновления профиля' });
      res.json({ success: true });
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

app.get('/api/devices', (req, res) => {
  try {
    const userId = getUserFromHeader(req);
    db.all(`SELECT device_id as id, name, type, room, status,
            pos_x, pos_y, pos_z, manufacturer, state, battery,
            targetTemp, connectedDevice, targetRoom, program
            FROM devices WHERE user_id = ?`, [userId], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Ошибка загрузки устройств' });
      const devices = rows.map(row => ({
        id: row.id,
        name: row.name,
        type: row.type,
        room: row.room,
        status: row.status === 1,
        pos: { x: row.pos_x, y: row.pos_y, z: row.pos_z },
        manufacturer: row.manufacturer,
        state: row.state,
        battery: row.battery,
        targetTemp: row.targetTemp,
        connectedDevice: row.connectedDevice,
        targetRoom: row.targetRoom,
        program: row.program,
        temperature: row.targetTemp
      }));
      res.json(devices);
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки устройств' });
  }
});

app.post('/api/devices', (req, res) => {
  try {
    const userId = getUserFromHeader(req);
    const { device_id, name, room, type, status, pos, manufacturer, state, battery, targetTemp, connectedDevice, targetRoom, program } = req.body;
    db.run(`INSERT INTO devices (device_id, user_id, name, type, room, status, pos_x, pos_y, pos_z, manufacturer, state, battery, targetTemp, connectedDevice, targetRoom, program)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [device_id, userId, name, type, room, status ? 1 : 0,
       pos?.x || 0, pos?.y || 0.5, pos?.z || 0,
       manufacturer, state, battery, targetTemp, connectedDevice, targetRoom, program],
      (err) => {
        if (err) return res.status(500).json({ error: 'Ошибка добавления устройства' });
        res.json({ success: true, device_id });
      });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка добавления устройства' });
  }
});

app.put('/api/devices/:device_id', (req, res) => {
  try {
    const userId = getUserFromHeader(req);
    const { device_id } = req.params;
    const { name, room, type, status, pos, manufacturer, state, battery, targetTemp, connectedDevice, targetRoom, program } = req.body;
    db.run(`UPDATE devices SET name=?, room=?, type=?, status=?, pos_x=?, pos_y=?, pos_z=?, manufacturer=?, state=?, battery=?, targetTemp=?, connectedDevice=?, targetRoom=?, program=?
            WHERE device_id=? AND user_id=?`,
      [name, room, type, status ? 1 : 0, pos?.x || 0, pos?.y || 0.5, pos?.z || 0,
       manufacturer, state, battery, targetTemp, connectedDevice, targetRoom, program, device_id, userId],
      (err) => {
        if (err) return res.status(500).json({ error: 'Ошибка обновления устройства' });
        res.json({ success: true });
      });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления устройства' });
  }
});

app.delete('/api/devices/:device_id', (req, res) => {
  try {
    const userId = getUserFromHeader(req);
    const { device_id } = req.params;
    db.run('DELETE FROM devices WHERE device_id = ? AND user_id = ?', [device_id, userId], (err) => {
      if (err) return res.status(500).json({ error: 'Ошибка удаления устройства' });
      res.json({ success: true });
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления устройства' });
  }
});

// Все остальные запросы отдаём index.html (для SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
  console.log(`📁 Данные хранятся в файле smarthome.db в папке ${__dirname}`);
});
