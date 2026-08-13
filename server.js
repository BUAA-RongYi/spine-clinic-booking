const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'bookings.db');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// Health check (must be before static to avoid index.html intercepting)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Constants ─────────────────────────────────────────────────────────────────
const TIME_SLOTS = [
  { label: '8:30-9:30',   key: '08:30-09:30', startHour: 8,  startMin: 30, session: 'morning' },
  { label: '9:30-10:30',  key: '09:30-10:30', startHour: 9,  startMin: 30, session: 'morning' },
  { label: '10:30-11:30', key: '10:30-11:30', startHour: 10, startMin: 30, session: 'morning' },
  { label: '15:00-16:00', key: '15:00-16:00', startHour: 15, startMin: 0,  session: 'afternoon' },
  { label: '16:00-17:00', key: '16:00-17:00', startHour: 16, startMin: 0,  session: 'afternoon' },
];

const MAX_PER_SLOT = 8;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin888';
let adminToken = null; // stored server-side, validated per request

// ── Admin Auth Middleware ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== adminToken) {
    return res.status(401).json({ error: '未授权，请先登录管理后台' });
  }
  next();
}

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
    status      TEXT    NOT NULL DEFAULT '已完成',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  )`);
  // Migration: add status column for existing databases
  try { db.run('ALTER TABLE appointments ADD COLUMN status TEXT NOT NULL DEFAULT \'已完成\''); } catch(e) { /* column exists */ }
  db.run(`CREATE TABLE IF NOT EXISTS blocked_dates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    block_date TEXT    NOT NULL,
    session    TEXT    NOT NULL CHECK(session IN ('morning','afternoon','all_day')),
    created_at TEXT    NOT NULL,
    UNIQUE(block_date, session)
  )`);
  persistDB();
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
  adminToken = Buffer.from(`admin_${Date.now()}_${Math.random()}`).toString('base64');
  res.json({ success: true, token: adminToken });
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
  const stmt = db.prepare("SELECT time_slot, COUNT(*) as cnt FROM appointments WHERE appt_date = ? AND status != '未到场' GROUP BY time_slot");
  stmt.bind([date]);
  while (stmt.step()) {
    const row = stmt.getAsObject();
    countMap[row.time_slot] = row.cnt;
  }
  stmt.free();

  // Query blocked sessions for this date
  const blockStmt = db.prepare('SELECT session FROM blocked_dates WHERE block_date = ?');
  blockStmt.bind([date]);
  const blockedSessions = new Set();
  while (blockStmt.step()) blockedSessions.add(blockStmt.getAsObject().session);
  blockStmt.free();

  const isAllDayBlocked = blockedSessions.has('all_day');
  const isMorningBlocked = blockedSessions.has('morning');
  const isAfternoonBlocked = blockedSessions.has('afternoon');

  const slots = TIME_SLOTS.map((s, idx) => {
    const isMorningSlot = idx <= 2;
    const slotBlocked = isAllDayBlocked ||
      (isMorningSlot && isMorningBlocked) ||
      (!isMorningSlot && isAfternoonBlocked);

    if (slotBlocked) {
      return { label: s.label, remaining: 0, full: true, blocked: true };
    }

    const booked = countMap[s.label] || 0;
    return {
      label: s.label,
      remaining: Math.max(0, MAX_PER_SLOT - booked),
      full: booked >= MAX_PER_SLOT,
    };
  });

  const totalRemaining = slots.reduce((sum, s) => sum + (s.blocked ? 0 : s.remaining), 0);
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
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

  // Query per-slot booking counts
  const slotMap = {};
  const slotStmt = db.prepare("SELECT appt_date, time_slot, COUNT(*) as cnt FROM appointments WHERE appt_date BETWEEN ? AND ? AND status != '未到场' GROUP BY appt_date, time_slot");
  slotStmt.bind([monthStart, monthEnd]);
  while (slotStmt.step()) {
    const row = slotStmt.getAsObject();
    if (!slotMap[row.appt_date]) slotMap[row.appt_date] = {};
    slotMap[row.appt_date][row.time_slot] = row.cnt;
  }
  slotStmt.free();

  // Query blocked dates
  const blockedMap = {};
  const blockStmt = db.prepare('SELECT block_date, session FROM blocked_dates WHERE block_date BETWEEN ? AND ?');
  blockStmt.bind([monthStart, monthEnd]);
  while (blockStmt.step()) {
    const row = blockStmt.getAsObject();
    if (!blockedMap[row.block_date]) blockedMap[row.block_date] = new Set();
    blockedMap[row.block_date].add(row.session);
  }
  blockStmt.free();

  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const inRange = dateStr >= min && dateStr <= max;

    if (!inRange) {
      days.push({ date: dateStr, inRange: false, available: false, totalRemaining: 0 });
      continue;
    }

    const bSessions = blockedMap[dateStr] || new Set();
    const isAllDay = bSessions.has('all_day');
    const isMorningB = bSessions.has('morning');
    const isAfternoonB = bSessions.has('afternoon');
    const isFullyBlocked = isAllDay || (isMorningB && isAfternoonB);

    if (isFullyBlocked) {
      days.push({ date: dateStr, inRange: true, available: false, totalRemaining: 0, blocked: true });
      continue;
    }

    const dateSlots = slotMap[dateStr] || {};
    let totalRemaining = 0;
    for (let i = 0; i < TIME_SLOTS.length; i++) {
      const slot = TIME_SLOTS[i];
      const isMorning = i <= 2;
      if ((isMorning && isMorningB) || (!isMorning && isAfternoonB)) continue;
      const booked = dateSlots[slot.label] || 0;
      totalRemaining += Math.max(0, MAX_PER_SLOT - booked);
    }

    const isPartial = isMorningB || isAfternoonB;
    days.push({
      date: dateStr, inRange: true,
      available: totalRemaining > 0, totalRemaining,
      blocked: isPartial || undefined
    });
  }
  res.json({ year, month, days, min, max });
});

// POST /api/appointments
app.post('/api/appointments', (req, res) => {
  const { name, phone, date, timeSlot } = req.body;
  if (!name || !phone || !date || !timeSlot) {
    return res.status(400).json({ error: '请填写完整信息（姓名、手机号、日期、时间段）' });
  }
  // Name validation (M1: prevent XSS + unreasonable input)
  const cleanName = String(name).trim();
  if (cleanName.length < 2 || cleanName.length > 20) {
    return res.status(400).json({ error: '姓名长度需为2-20个字符' });
  }
  if (/[<>]/.test(cleanName)) {
    return res.status(400).json({ error: '姓名包含非法字符' });
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

  // Check capacity (exclude no-shows)
  const cntRow = db.prepare("SELECT COUNT(*) as cnt FROM appointments WHERE appt_date = ? AND time_slot = ? AND status != '未到场'");
  cntRow.bind([date, timeSlot]);
  cntRow.step();
  const bookedCount = cntRow.getAsObject().cnt;
  cntRow.free();

  if (bookedCount >= MAX_PER_SLOT) {
    return res.status(400).json({ error: '该时间段已约满，请选择其他时间段' });
  }

  // Check duplicate name
  const dupRow = db.prepare('SELECT id FROM appointments WHERE appt_date = ? AND time_slot = ? AND name = ?');
  dupRow.bind([date, timeSlot, cleanName]);
  const dupExists = dupRow.step();
  dupRow.free();

  if (dupExists) {
    return res.status(400).json({ error: `"${cleanName}" 已预约了该日期的 ${timeSlot} 时间段，请勿重复预约` });
  }

  // Check phone uniqueness per day (one phone = one slot per day)
  const phoneRow = db.prepare('SELECT time_slot FROM appointments WHERE appt_date = ? AND phone = ?');
  phoneRow.bind([date, phone]);
  if (phoneRow.step()) {
    const existing = phoneRow.getAsObject();
    phoneRow.free();
    return res.status(400).json({
      error: `该手机号在${date}已预约了 ${existing.time_slot}，一天只能预约一个时间段`
    });
  }
  phoneRow.free();

  // Check if date/session is blocked
  const session = TIME_SLOTS.find(s => s.label === timeSlot).session;
  const blockCheck = db.prepare('SELECT id FROM blocked_dates WHERE block_date = ? AND session IN (?, ?)');
  blockCheck.bind([date, session, 'all_day']);
  if (blockCheck.step()) {
    blockCheck.free();
    return res.status(400).json({ error: '该时段已被管理员关闭，无法预约' });
  }
  blockCheck.free();

  const ts = nowStr();
  db.run('INSERT INTO appointments (name, phone, appt_date, time_slot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [cleanName, phone, date, timeSlot, ts, ts]);
  const idStmt = db.prepare('SELECT last_insert_rowid() as id');
  idStmt.step();
  const id = idStmt.getAsObject().id;
  idStmt.free();

  enqueueWrite(() => persistDB());

  res.json({ success: true, message: '预约成功！', appointment: { id, name: cleanName, phone, date, timeSlot } });
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

  // R1: identity check — phone must match the original booking
  if (!phone || phone !== existing.phone) {
    return res.status(403).json({ error: '手机号与预约记录不符，无法修改' });
  }

  if (!canModifyOrCancel(existing.appt_date, existing.time_slot)) {
    return res.status(400).json({ error: '已超过修改截止时间（预约时间前2小时），无法修改' });
  }

  // Phone is the identity credential, not changeable here
  const newDate = date || existing.appt_date;
  const newSlot = timeSlot || existing.time_slot;
  const newName = name || existing.name;
  const newPhone = existing.phone;

  const { min, max } = getDateRange();
  if (newDate < min || newDate > max) {
    return res.status(400).json({ error: '只能预约今天起30天内的日期' });
  }
  if (!TIME_SLOTS.find((s) => s.label === newSlot)) {
    return res.status(400).json({ error: '无效的时间段' });
  }
  // Name validation (same as booking)
  const trimmedName = String(newName).trim();
  if (trimmedName.length < 2 || trimmedName.length > 20) {
    return res.status(400).json({ error: '姓名长度需为2-20个字符' });
  }
  if (/[<>]/.test(trimmedName)) {
    return res.status(400).json({ error: '姓名包含非法字符' });
  }

  const dateChanged = newDate !== existing.appt_date;
  const slotChanged = newSlot !== existing.time_slot;
  const nameChanged = trimmedName !== existing.name;

  // Capacity + blocked check — only needed when date/slot changed
  if (dateChanged || slotChanged) {
    const cStmt = db.prepare("SELECT COUNT(*) as cnt FROM appointments WHERE appt_date = ? AND time_slot = ? AND id != ? AND status != '未到场'");
    cStmt.bind([newDate, newSlot, id]);
    cStmt.step();
    if (cStmt.getAsObject().cnt >= MAX_PER_SLOT) { cStmt.free(); return res.status(400).json({ error: '目标时间段已约满' }); }
    cStmt.free();

    // Check target date/session not blocked
    const slotSess = TIME_SLOTS.find(s => s.label === newSlot).session;
    const bStmt = db.prepare('SELECT id FROM blocked_dates WHERE block_date = ? AND session IN (?, ?)');
    bStmt.bind([newDate, slotSess, 'all_day']);
    if (bStmt.step()) { bStmt.free(); return res.status(400).json({ error: '目标日期/时段已被管理员屏蔽，无法修改' }); }
    bStmt.free();
  }

  // Duplicate name check — when date/slot/name changed
  if (dateChanged || slotChanged || nameChanged) {
    const dStmt = db.prepare('SELECT id FROM appointments WHERE appt_date = ? AND time_slot = ? AND name = ? AND id != ?');
    dStmt.bind([newDate, newSlot, trimmedName, id]);
    if (dStmt.step()) { dStmt.free(); return res.status(400).json({ error: `"${trimmedName}" 已存在于目标时间段` }); }
    dStmt.free();
  }

  // Phone-per-day check — when date changed (phone cannot change)
  if (dateChanged) {
    const pStmt = db.prepare('SELECT id FROM appointments WHERE appt_date = ? AND phone = ? AND id != ?');
    pStmt.bind([newDate, newPhone, id]);
    if (pStmt.step()) { pStmt.free(); return res.status(400).json({ error: '该手机号当天已预约过，一天只能预约一个时间段' }); }
    pStmt.free();
  }

  const ts = nowStr();
  db.run('UPDATE appointments SET appt_date = ?, time_slot = ?, name = ?, updated_at = ? WHERE id = ?',
    [newDate, newSlot, trimmedName, ts, id]);

  enqueueWrite(() => persistDB());

  res.json({ success: true, message: '预约信息已更新' });
});

// DELETE /api/appointments/:id
app.delete('/api/appointments/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { phone } = req.body;

  const stmt = db.prepare('SELECT * FROM appointments WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: '预约记录不存在' }); }
  const existing = stmt.getAsObject();
  stmt.free();

  // R1: identity check — phone must match the original booking
  if (!phone || phone !== existing.phone) {
    return res.status(403).json({ error: '手机号与预约记录不符，无法取消' });
  }

  if (!canModifyOrCancel(existing.appt_date, existing.time_slot)) {
    return res.status(400).json({ error: '已超过取消截止时间（预约时间前2小时），无法取消' });
  }

  db.run('DELETE FROM appointments WHERE id = ?', [id]);
  enqueueWrite(() => persistDB());

  res.json({ success: true, message: '预约已取消' });
});

// GET /api/admin/appointments?date=YYYY-MM-DD
app.get('/api/admin/appointments', requireAdmin, (req, res) => {
  const { date } = req.query;

  let rows = [];
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const stmt = db.prepare('SELECT id, name, phone, appt_date, time_slot, status, created_at FROM appointments WHERE appt_date = ? ORDER BY time_slot ASC, created_at ASC');
    stmt.bind([date]);
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
  } else {
    const stmt = db.prepare('SELECT id, name, phone, appt_date, time_slot, status, created_at FROM appointments ORDER BY appt_date DESC, time_slot ASC');
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
  }

  res.json({ appointments: rows });
});

// PUT /api/admin/appointments/:id/status
app.put('/api/admin/appointments/:id/status', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body;
  if (!['已完成', '未到场'].includes(status)) {
    return res.status(400).json({ error: '无效的状态值' });
  }

  const stmt = db.prepare('SELECT * FROM appointments WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: '预约记录不存在' }); }
  stmt.free();

  db.run('UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?', [status, nowStr(), id]);
  enqueueWrite(() => persistDB());
  res.json({ success: true, message: `已标记为"${status}"`, status });
});

// GET /api/admin/patient-stats?name=&start=&end=
app.get('/api/admin/patient-stats', requireAdmin, (req, res) => {
  const { name, start, end } = req.query;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '请输入患者姓名' });
  }
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: '请提供有效的日期范围' });
  }
  if (start > end) {
    return res.status(400).json({ error: '开始日期不能晚于结束日期' });
  }

  const stmt = db.prepare(
    'SELECT id, appt_date, time_slot, status, created_at FROM appointments WHERE name = ? AND appt_date BETWEEN ? AND ? ORDER BY appt_date ASC, time_slot ASC'
  );
  stmt.bind([name.trim(), start, end]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  const total = rows.length;
  const attended = rows.filter(r => r.status !== '未到场').length;
  const noshow = rows.filter(r => r.status === '未到场').length;

  res.json({ name: name.trim(), start, end, total, attended, noshow, appointments: rows });
});

// ── Blocked Dates Management ───────────────────────────────────────────────────

// GET /api/admin/blocked-dates
app.get('/api/admin/blocked-dates', requireAdmin, (req, res) => {
  const stmt = db.prepare('SELECT id, block_date, session, created_at FROM blocked_dates ORDER BY block_date ASC');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json({ blockedDates: rows });
});

// POST /api/admin/blocked-dates
app.post('/api/admin/blocked-dates', requireAdmin, (req, res) => {
  const { date, session } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '请提供有效日期' });
  }
  if (!['morning', 'afternoon', 'all_day'].includes(session)) {
    return res.status(400).json({ error: '无效的时段类型' });
  }

  // Check existing blocks for this date
  const exStmt = db.prepare('SELECT session FROM blocked_dates WHERE block_date = ?');
  exStmt.bind([date]);
  const existingSessions = new Set();
  while (exStmt.step()) existingSessions.add(exStmt.getAsObject().session);
  exStmt.free();

  if (existingSessions.has('all_day')) {
    return res.status(400).json({ error: '该日期已被全天屏蔽' });
  }
  if (session === 'all_day' && existingSessions.size > 0) {
    db.run('DELETE FROM blocked_dates WHERE block_date = ?', [date]);
  }
  if (session !== 'all_day' && existingSessions.has(session)) {
    return res.status(400).json({ error: '该时段已被屏蔽，请勿重复操作' });
  }

  const ts = nowStr();
  db.run('INSERT INTO blocked_dates (block_date, session, created_at) VALUES (?, ?, ?)',
    [date, session, ts]);
  enqueueWrite(() => persistDB());
  res.json({ success: true, message: '屏蔽设置成功' });
});

// DELETE /api/admin/blocked-dates/:id
app.delete('/api/admin/blocked-dates/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stmt = db.prepare('SELECT * FROM blocked_dates WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: '屏蔽记录不存在' }); }
  stmt.free();
  db.run('DELETE FROM blocked_dates WHERE id = ?', [id]);
  enqueueWrite(() => persistDB());
  res.json({ success: true, message: '已取消屏蔽' });
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
