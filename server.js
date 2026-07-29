const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'bookings.db');
const OLD_JSON = path.join(__dirname, 'bookings.json');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// Health check (must be before static to avoid index.html intercepting)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Constants ─────────────────────────────────────────────────────────────────
const TIME_SLOTS = [
  { label: '8:30-9:30',   key: '08:30-09:30', startHour: 8,  startMin: 30 },
  { label: '9:30-10:30',  key: '09:30-10:30', startHour: 9,  startMin: 30 },
  { label: '10:30-11:30', key: '10:30-11:30', startHour: 10, startMin: 30 },
  { label: '15:00-16:00', key: '15:00-16:00', startHour: 15, startMin: 0  },
  { label: '16:00-17:00', key: '16:00-17:00', startHour: 16, startMin: 0  },
];

const MAX_PER_SLOT = 8;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin888';

// ── Database ──────────────────────────────────────────────────────────────────
let db;

function persistDB() {
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch (e) { console.error('DB save error:', e.message); }
}

/** Write queue — sequentialize writes to avoid concurrent save corruption */
let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  writeQueue = writeQueue.then(fn).catch((e) => console.error('DB write error:', e));
  return writeQueue;
}

/** Migrate old JSON data if present and no .db exists */
function maybeMigrate() {
  if (fs.existsSync(DB_PATH)) return;
  if (!fs.existsSync(OLD_JSON)) return;
  try {
    const raw = fs.readFileSync(OLD_JSON, 'utf-8');
    const data = JSON.parse(raw);
    const stmt = db.prepare('INSERT OR IGNORE INTO appointments (id, name, phone, appt_date, time_slot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const a of (data.appointments || [])) {
      stmt.run([a.id, a.name, a.phone, a.appt_date, a.time_slot, a.created_at, a.updated_at]);
    }
    stmt.free();
    persistDB();
    // Rename old file as backup
    fs.renameSync(OLD_JSON, OLD_JSON + '.backup');
    console.log('✅ 已从 bookings.json 迁移数据');
  } catch (e) { console.error('Migration error:', e.message); }
}

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS appointments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    phone       TEXT    NOT NULL,
    appt_date   TEXT    NOT NULL,
    time_slot   TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  )`);
  persistDB();
  maybeMigrate();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toKey(label) {
  const [start] = label.split('-');
  const pad = (t) => { const [h, m] = t.split(':'); return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`; };
  return `${pad(start)}-${pad(label.split('-')[1])}`;
}

function slotStartDateTime(dateStr, slotKey) {
  const [start] = slotKey.split('-');
  const [h, m] = start.split(':').map(Number);
  const d = new Date(dateStr + 'T00:00:00');
  d.setHours(h, m, 0, 0);
  return d;
}

function canModifyOrCancel(dateStr, slotLabel) {
  const key = toKey(slotLabel);
  const slotStart = slotStartDateTime(dateStr, key);
  const now = new Date();
  const twoHoursBefore = new Date(slotStart.getTime() - 2 * 60 * 60 * 1000);
  return now < twoHoursBefore;
}

function getDateRange() {
  const today = new Date();
  const max = new Date(today);
  max.setDate(max.getDate() + 30);
  return { min: ymd(today), max: ymd(max) };
}

function nowStr() {
  return ymd(new Date()) + ' ' + new Date().toTimeString().slice(0, 8);
}

// ── Health check ──────────────────────────────────────────────────────────────
// (defined above)

// ── API Routes ────────────────────────────────────────────────────────────────

// POST /api/admin/verify
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '请输入密码' });
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: '密码错误' });
  const token = Buffer.from(`admin_${Date.now()}_${Math.random()}`).toString('base64');
  res.json({ success: true, token });
});

// GET /api/availability?date=YYYY-MM-DD
app.get('/api/availability', (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '请提供有效日期 (YYYY-MM-DD)' });
  }
  const { min, max } = getDateRange();
  if (date < min || date > max) {
    return res.json({ date, outOfRange: true, slots: [] });
  }

  const countMap = {};
  const stmt = db.prepare('SELECT time_slot, COUNT(*) as cnt FROM appointments WHERE appt_date = ? GROUP BY time_slot');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  for (const row of rows) countMap[row.time_slot] = row.cnt;

  const slots = TIME_SLOTS.map((s) => {
    const booked = countMap[s.label] || 0;
    return {
      label: s.label,
      remaining: Math.max(0, MAX_PER_SLOT - booked),
      full: booked >= MAX_PER_SLOT,
    };
  });

  const totalRemaining = slots.reduce((sum, s) => sum + s.remaining, 0);
  res.json({ date, outOfRange: false, slots, totalRemaining });
});

// GET /api/availability/month
app.get('/api/availability/month', (req, res) => {
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: '请提供有效年份和月份' });
  }

  const { min, max } = getDateRange();
  const daysInMonth = new Date(year, month, 0).getDate();

  const totalMap = {};
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  const stmt = db.prepare('SELECT appt_date, COUNT(*) as cnt FROM appointments WHERE appt_date BETWEEN ? AND ? GROUP BY appt_date');
  stmt.bind([monthStart, monthEnd]);
  while (stmt.step()) {
    const row = stmt.getAsObject();
    totalMap[row.appt_date] = row.cnt;
  }
  stmt.free();

  const days = [];
  const maxSlots = MAX_PER_SLOT * TIME_SLOTS.length;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const inRange = dateStr >= min && dateStr <= max;
    if (!inRange) {
      days.push({ date: dateStr, inRange: false, available: false, totalRemaining: 0 });
    } else {
      const booked = totalMap[dateStr] || 0;
      const totalRemaining = Math.max(0, maxSlots - booked);
      days.push({ date: dateStr, inRange: true, available: totalRemaining > 0, totalRemaining });
    }
  }
  res.json({ year, month, days, min, max });
});

// POST /api/appointments
app.post('/api/appointments', (req, res) => {
  const { name, phone, date, timeSlot } = req.body;
  if (!name || !phone || !date || !timeSlot) {
    return res.status(400).json({ error: '请填写完整信息（姓名、手机号、日期、时间段）' });
  }
  if (!/^1\d{10}$/.test(phone)) {
    return res.status(400).json({ error: '请输入有效的11位手机号码' });
  }
  const { min, max } = getDateRange();
  if (date < min || date > max) {
    return res.status(400).json({ error: '只能预约今天起30天内的日期' });
  }
  const slot = TIME_SLOTS.find((s) => s.label === timeSlot);
  if (!slot) return res.status(400).json({ error: '无效的时间段' });

  // Check capacity
  const cntRow = db.prepare('SELECT COUNT(*) as cnt FROM appointments WHERE appt_date = ? AND time_slot = ?');
  cntRow.bind([date, timeSlot]);
  cntRow.step();
  const bookedCount = cntRow.getAsObject().cnt;
  cntRow.free();

  if (bookedCount >= MAX_PER_SLOT) {
    return res.status(400).json({ error: '该时间段已约满，请选择其他时间段' });
  }

  // Check duplicate name
  const dupRow = db.prepare('SELECT id FROM appointments WHERE appt_date = ? AND time_slot = ? AND name = ?');
  dupRow.bind([date, timeSlot, name]);
  const dupExists = dupRow.step();
  dupRow.free();

  if (dupExists) {
    return res.status(400).json({ error: `"${name}" 已预约了该日期的 ${timeSlot} 时间段，请勿重复预约` });
  }

  const ts = nowStr();
  db.run('INSERT INTO appointments (name, phone, appt_date, time_slot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [name, phone, date, timeSlot, ts, ts]);
  const id = db.prepare('SELECT last_insert_rowid() as id').getAsObject().id;

  enqueueWrite(() => persistDB());

  res.json({ success: true, message: '预约成功！', appointment: { id, name, phone, date, timeSlot } });
});

// GET /api/appointments?phone=xxx
app.get('/api/appointments', (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: '请提供手机号' });

  const stmt = db.prepare('SELECT id, name, phone, appt_date, time_slot, created_at FROM appointments WHERE phone = ? ORDER BY appt_date ASC, time_slot ASC');
  stmt.bind([phone]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  const now = new Date();
  const enriched = rows.map((r) => ({
    ...r,
    canModify: canModifyOrCancel(r.appt_date, r.time_slot),
    isPast: slotStartDateTime(r.appt_date, toKey(r.time_slot)) < now,
  }));

  res.json({ appointments: enriched });
});

// PUT /api/appointments/:id
app.put('/api/appointments/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { date, timeSlot, name, phone } = req.body;

  const stmt = db.prepare('SELECT * FROM appointments WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: '预约记录不存在' }); }
  const existing = stmt.getAsObject();
  stmt.free();

  if (!canModifyOrCancel(existing.appt_date, existing.time_slot)) {
    return res.status(400).json({ error: '已超过修改截止时间（预约时间前2小时），无法修改' });
  }

  const newDate = date || existing.appt_date;
  const newSlot = timeSlot || existing.time_slot;
  const newName = name || existing.name;
  const newPhone = phone || existing.phone;

  const { min, max } = getDateRange();
  if (newDate < min || newDate > max) {
    return res.status(400).json({ error: '只能预约今天起30天内的日期' });
  }
  if (!/^1\d{10}$/.test(newPhone)) {
    return res.status(400).json({ error: '请输入有效的11位手机号码' });
  }
  if (!TIME_SLOTS.find((s) => s.label === newSlot)) {
    return res.status(400).json({ error: '无效的时间段' });
  }

  if (newDate !== existing.appt_date || newSlot !== existing.time_slot) {
    const cStmt = db.prepare('SELECT COUNT(*) as cnt FROM appointments WHERE appt_date = ? AND time_slot = ? AND id != ?');
    cStmt.bind([newDate, newSlot, id]);
    cStmt.step();
    if (cStmt.getAsObject().cnt >= MAX_PER_SLOT) { cStmt.free(); return res.status(400).json({ error: '目标时间段已约满' }); }
    cStmt.free();

    const dStmt = db.prepare('SELECT id FROM appointments WHERE appt_date = ? AND time_slot = ? AND name = ? AND id != ?');
    dStmt.bind([newDate, newSlot, newName, id]);
    if (dStmt.step()) { dStmt.free(); return res.status(400).json({ error: `"${newName}" 已存在于目标时间段` }); }
    dStmt.free();
  }

  const ts = nowStr();
  db.run('UPDATE appointments SET appt_date = ?, time_slot = ?, name = ?, phone = ?, updated_at = ? WHERE id = ?',
    [newDate, newSlot, newName, newPhone, ts, id]);

  enqueueWrite(() => persistDB());

  res.json({ success: true, message: '预约信息已更新' });
});

// DELETE /api/appointments/:id
app.delete('/api/appointments/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);

  const stmt = db.prepare('SELECT * FROM appointments WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: '预约记录不存在' }); }
  const existing = stmt.getAsObject();
  stmt.free();

  if (!canModifyOrCancel(existing.appt_date, existing.time_slot)) {
    return res.status(400).json({ error: '已超过取消截止时间（预约时间前2小时），无法取消' });
  }

  db.run('DELETE FROM appointments WHERE id = ?', [id]);
  enqueueWrite(() => persistDB());

  res.json({ success: true, message: '预约已取消' });
});

// GET /api/admin/appointments?date=YYYY-MM-DD
app.get('/api/admin/appointments', (req, res) => {
  const { date } = req.query;

  let rows = [];
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const stmt = db.prepare('SELECT id, name, phone, appt_date, time_slot, created_at FROM appointments WHERE appt_date = ? ORDER BY time_slot ASC, created_at ASC');
    stmt.bind([date]);
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
  } else {
    const stmt = db.prepare('SELECT id, name, phone, appt_date, time_slot, created_at FROM appointments ORDER BY appt_date DESC, time_slot ASC');
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
  }

  res.json({ appointments: rows });
});

// ── Static files (after all API routes) ────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// API 404 — return JSON, not HTML
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.path}` });
});

// SPA fallback — all other routes go to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ 脊柱侧弯门诊预约系统已启动`);
    console.log(`   http://localhost:${PORT}`);
  });
}).catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
