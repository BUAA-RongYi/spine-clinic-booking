/**
 * 端到端用户旅程测试：模拟真实患者+管理员的完整操作链
 * 运行: node --test tests/journey.test.js
 * 覆盖：预约→查询→修改→取消→管理员全流程
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 3102;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASS = 'journey-pass';
const DB_FILE = path.join(os.tmpdir(), `journey-${Date.now()}.db`);
let serverProc;

async function api(method, pathName, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + pathName, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function freeSlot() {
  for (let offset = 2; offset < 29; offset++) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const r = await api('GET', `/api/availability?date=${date}`);
    const free = r.data.slots && r.data.slots.find(s => !s.full && !s.blocked);
    if (free) return { date, slot: free.label };
  }
  throw new Error('无可用时段');
}

before(async () => {
  serverProc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB_FILE, ADMIN_PASSWORD: ADMIN_PASS },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('启动超时');
});

after(() => {
  if (serverProc) serverProc.kill();
  try { fs.unlinkSync(DB_FILE); } catch {}
});

test('完整旅程：患者预约→查看→修改→取消', async () => {
  const { date, slot } = await freeSlot();
  const other = (await api('GET', `/api/availability?date=${date}`)).data.slots.find(s => !s.full && !s.blocked && s.label !== slot);

  // 1. 患者预约
  const bk = await api('POST', '/api/appointments', { name: '旅程患者', phone: '13813130001', date, timeSlot: slot });
  assert.equal(bk.status, 200, '预约失败');
  const id = bk.data.appointment.id;

  // 2. 我的预约查询（手机号+姓名）
  const q = await api('GET', `/api/appointments?phone=13813130001&name=${encodeURIComponent('旅程患者')}`);
  assert.equal(q.status, 200);
  assert.ok(q.data.appointments.some(a => a.id === id), '查询不到预约');

  // 3. 修改预约（换时段，成功路径）
  if (other) {
    const up = await api('PUT', `/api/appointments/${id}`, { phone: '13813130001', date, timeSlot: other.label, name: '旅程患者' });
    assert.equal(up.status, 200, '修改失败');
  }

  // 4. 取消预约
  const del = await api('DELETE', `/api/appointments/${id}`, { phone: '13813130001' });
  assert.equal(del.status, 200, '取消失败');

  // 5. 确认已取消
  const q2 = await api('GET', `/api/appointments?phone=13813130001&name=${encodeURIComponent('旅程患者')}`);
  assert.ok(!q2.data.appointments.some(a => a.id === id), '取消后仍存在');
});

test('完整旅程：管理员登录→查当天→标记状态→删除→屏蔽→统计', async () => {
  const token = (await api('POST', '/api/admin/verify', { password: ADMIN_PASS })).data.token;

  // 1. 建一条预约供管理员操作
  const { date, slot } = await freeSlot();
  const bk = await api('POST', '/api/appointments', { name: '管理患者', phone: '13813130002', date, timeSlot: slot });
  const id = bk.data.appointment.id;

  // 2. 管理员查当天
  const list = await api('GET', `/api/admin/appointments?date=${date}`, null, token);
  assert.equal(list.status, 200);
  assert.ok(list.data.appointments.some(a => a.id === id));

  // 3. 标记未到场
  const st = await api('PUT', `/api/admin/appointments/${id}/status`, { status: '未到场' }, token);
  assert.equal(st.status, 200, '标记状态失败');

  // 4. 管理员删除
  const del = await api('DELETE', `/api/admin/appointments/${id}`, null, token);
  assert.equal(del.status, 200, '管理员删除失败');

  // 5. 屏蔽日期
  const blk = await api('POST', '/api/admin/blocked-dates', { date, session: 'morning' }, token);
  assert.equal(blk.status, 200, '屏蔽失败');

  // 6. 到场统计（模糊查询）
  const stats = await api('GET', `/api/admin/patient-stats?name=${encodeURIComponent('管理')}&start=2026-01-01&end=2030-12-31`, null, token);
  assert.equal(stats.status, 200);

  // 7. 整月视图
  const month = date.slice(0, 7);
  const mv = await api('GET', `/api/admin/appointments?month=${month}`, null, token);
  assert.equal(mv.status, 200, '整月查询失败');

  // 8. 取消屏蔽（清理）
  const blist = await api('GET', '/api/admin/blocked-dates', null, token);
  for (const b of blist.data.blockedDates) {
    if (b.block_date === date) await api('DELETE', `/api/admin/blocked-dates/${b.id}`, null, token);
  }
});

test('配置接口与前端一致', async () => {
  const cfg = (await api('GET', '/api/config')).data;
  assert.equal(cfg.slots.length, 5);
  assert.equal(cfg.maxPerSlot, 8);
  assert.equal(cfg.cancelWindowHours, 2);
  assert.equal(cfg.bookingWindowDays, 30);
});
