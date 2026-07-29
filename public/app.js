/* ═══════════════════════════════════════════════════════════════════════════
   SPINE CLINIC BOOKING — Client Application
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Constants ────────────────────────────────────────────────────────────────
const TIME_SLOTS = [
  { label: '8:30-9:30',   value: '8:30-9:30' },
  { label: '9:30-10:30',  value: '9:30-10:30' },
  { label: '10:30-11:30', value: '10:30-11:30' },
  { label: '15:00-16:00', value: '15:00-16:00' },
  { label: '16:00-17:00', value: '16:00-17:00' },
];

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  calYear:  new Date().getFullYear(),
  calMonth: new Date().getMonth() + 1,  // 1-indexed
  selectedDate: null,   // 'YYYY-MM-DD'
  selectedSlot: null,   // slot label like '8:30-9:30'
  currentTab: 'booking',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format Date → 'YYYY-MM-DD' */
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's date string */
function todayStr() { return ymd(new Date()); }

/** API helper */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

/** Show toast message */
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, 2500);
}

/** Get user info from localStorage */
function getSavedUser() {
  try {
    const d = JSON.parse(localStorage.getItem('spine_user') || '{}');
    return { name: d.name || '', phone: d.phone || '' };
  } catch { return { name: '', phone: '' }; }
}

/** Save user info to localStorage */
function saveUser(name, phone) {
  localStorage.setItem('spine_user', JSON.stringify({ name, phone }));
}

/** Pre-fill name/phone inputs */
function prefillUser() {
  const u = getSavedUser();
  document.getElementById('input-name').value = u.name;
  document.getElementById('input-phone').value = u.phone;
  document.getElementById('lookup-phone').value = u.phone;
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════════════════════════════

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    state.currentTab = tab;

    if (tab === 'booking') renderCalendar();
    if (tab === 'myappt') autoLoadMyAppointments();
    if (tab === 'admin')  autoLoadAdmin();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════════════════════════════════════

async function renderCalendar() {
  const { calYear, calMonth } = state;
  document.getElementById('cal-title').textContent = `${calYear}年 ${calMonth}月`;

  // Fetch month availability
  let monthData;
  try {
    monthData = await api('GET', `/api/availability/month?year=${calYear}&month=${calMonth}`);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  // First day of month (0=Sun)
  const firstDay = new Date(calYear, calMonth - 1, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();

  // Create day→data map
  const dayMap = {};
  for (const d of monthData.days) {
    const dayNum = parseInt(d.date.split('-')[2], 10);
    dayMap[dayNum] = d;
  }

  const today = todayStr();

  // Empty cells before 1st
  for (let i = 0; i < firstDay; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day empty';
    grid.appendChild(cell);
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const info = dayMap[d];
    const cell = document.createElement('div');
    cell.className = 'cal-day';

    if (!info || !info.inRange) {
      cell.classList.add('out-of-range');
    } else {
      cell.classList.add('in-range');
      cell.addEventListener('click', () => selectDate(dateStr));
    }

    if (dateStr === today) cell.classList.add('today');
    if (dateStr === state.selectedDate) cell.classList.add('selected');

    cell.innerHTML = `<span class="cal-day-num">${d}</span>`;

    if (info && info.inRange) {
      const dotClass = info.available ? 'avail' : 'full';
      cell.innerHTML += `<span class="cal-dot ${dotClass}"></span>`;
    }

    grid.appendChild(cell);
  }

  // Re-render slots if a date is selected
  if (state.selectedDate) await renderSlots(state.selectedDate);
}

async function selectDate(dateStr) {
  state.selectedDate = dateStr;
  state.selectedSlot = null;
  await renderCalendar();  // re-render to highlight
  await renderSlots(dateStr);
}

async function renderSlots(dateStr) {
  const card = document.getElementById('slots-card');
  const title = document.getElementById('slots-date-title');
  const list = document.getElementById('slots-list');

  title.textContent = `${dateStr} 时间段`;

  let data;
  try {
    data = await api('GET', `/api/availability?date=${dateStr}`);
  } catch (e) {
    toast(e.message, 'error');
    card.style.display = 'none';
    return;
  }

  if (data.outOfRange) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  list.innerHTML = '';

  for (const slot of data.slots) {
    const div = document.createElement('div');
    div.className = `slot-item ${slot.full ? 'full' : 'available'}`;
    div.innerHTML = `
      <span class="slot-time">${slot.label}</span>
      <span class="slot-remaining">剩余 <span class="num">${slot.remaining}</span> 人</span>
    `;
    if (!slot.full) {
      div.addEventListener('click', () => openBookingForm(dateStr, slot));
    }
    list.appendChild(div);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOKING FORM
// ═══════════════════════════════════════════════════════════════════════════

function openBookingForm(dateStr, slot) {
  state.selectedSlot = slot.label;
  document.getElementById('confirm-date').textContent = dateStr;
  document.getElementById('confirm-slot').textContent = slot.label;
  prefillUser();
  document.getElementById('form-overlay').style.display = 'flex';
}

document.getElementById('form-close').addEventListener('click', () => {
  document.getElementById('form-overlay').style.display = 'none';
  state.selectedSlot = null;
});

document.getElementById('form-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('form-overlay').style.display = 'none';
    state.selectedSlot = null;
  }
});

document.getElementById('btn-submit').addEventListener('click', async () => {
  const name = document.getElementById('input-name').value.trim();
  const phone = document.getElementById('input-phone').value.trim();

  if (!name) return toast('请输入姓名', 'error');
  if (!phone || !/^1\d{10}$/.test(phone)) return toast('请输入有效的11位手机号', 'error');

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = '提交中...';

  try {
    await api('POST', '/api/appointments', {
      name,
      phone,
      date: state.selectedDate,
      timeSlot: state.selectedSlot,
    });

    saveUser(name, phone);
    toast('✅ 预约成功！', 'success');

    document.getElementById('form-overlay').style.display = 'none';
    state.selectedSlot = null;
    await renderSlots(state.selectedDate);
    await renderCalendar();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '确认预约';
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CALENDAR NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════

document.getElementById('cal-prev').addEventListener('click', () => {
  if (state.calMonth === 1) {
    state.calYear--;
    state.calMonth = 12;
  } else {
    state.calMonth--;
  }
  state.selectedDate = null;
  state.selectedSlot = null;
  document.getElementById('slots-card').style.display = 'none';
  renderCalendar();
});

document.getElementById('cal-next').addEventListener('click', () => {
  if (state.calMonth === 12) {
    state.calYear++;
    state.calMonth = 1;
  } else {
    state.calMonth++;
  }
  state.selectedDate = null;
  state.selectedSlot = null;
  document.getElementById('slots-card').style.display = 'none';
  renderCalendar();
});

// ═══════════════════════════════════════════════════════════════════════════
// MY APPOINTMENTS
// ═══════════════════════════════════════════════════════════════════════════

/** Auto-load appointments when switching to My Appointments tab */
async function autoLoadMyAppointments() {
  const phone = getSavedUser().phone;
  const list = document.getElementById('myappt-list');
  if (!phone) {
    list.innerHTML = '<div class="appt-item" style="text-align:center;color:var(--gray-400);">请先输入手机号，然后点击"查询预约"</div>';
    return;
  }
  document.getElementById('lookup-phone').value = phone;
  list.innerHTML = '<p style="text-align:center;color:var(--gray-400);padding:20px;">查询中...</p>';
  try {
    const data = await api('GET', `/api/appointments?phone=${phone}`);
    renderMyAppointments(data.appointments);
  } catch (e) {
    toast(e.message, 'error');
    list.innerHTML = '';
  }
}

document.getElementById('btn-lookup').addEventListener('click', async () => {
  const phone = document.getElementById('lookup-phone').value.trim();
  if (!phone || !/^1\d{10}$/.test(phone)) return toast('请输入有效的11位手机号', 'error');

  saveUser(getSavedUser().name, phone);

  const list = document.getElementById('myappt-list');
  list.innerHTML = '<p style="text-align:center;color:var(--gray-400);padding:20px;">查询中...</p>';

  try {
    const data = await api('GET', `/api/appointments?phone=${phone}`);
    renderMyAppointments(data.appointments);
  } catch (e) {
    toast(e.message, 'error');
    list.innerHTML = '';
  }
});

function renderMyAppointments(appts) {
  const list = document.getElementById('myappt-list');
  if (!appts.length) {
    list.innerHTML = '<div class="appt-item" style="text-align:center;color:var(--gray-400);">暂无预约记录</div>';
    return;
  }

  list.innerHTML = appts.map((a) => {
    const statusClass = a.isPast ? 'past' : '';
    const actionsHTML = a.isPast ? '' : `
      <div class="appt-actions">
        ${a.canModify ? `<button class="btn-sm edit" data-id="${a.id}" data-action="modify">✏️ 修改</button>` : ''}
        ${a.canModify ? `<button class="btn-sm cancel" data-id="${a.id}" data-action="cancel">🗑 取消</button>` : ''}
      </div>
      ${!a.canModify && !a.isPast ? '<div class="appt-deadline">⏰ 距预约不足2小时，无法修改/取消</div>' : ''}
    `;
    return `
      <div class="appt-item ${statusClass}">
        <div class="appt-row">
          <span class="appt-date">📅 ${a.appt_date}</span>
          <span class="appt-slot">${a.time_slot}</span>
        </div>
        <div class="appt-row">
          <span class="appt-name">👤 ${a.name}</span>
          <span class="appt-name">📱 ${a.phone}</span>
        </div>
        ${actionsHTML}
      </div>
    `;
  }).join('');

  // Attach event listeners
  list.querySelectorAll('[data-action="modify"]').forEach((btn) => {
    btn.addEventListener('click', () => openModifyModal(btn.dataset.id, appts));
  });
  list.querySelectorAll('[data-action="cancel"]').forEach((btn) => {
    btn.addEventListener('click', () => cancelAppointment(btn.dataset.id));
  });
}

// ── Modify Appointment ────────────────────────────────────────────────────

function openModifyModal(id, appts) {
  const a = appts.find((x) => x.id === parseInt(id));
  if (!a) return;

  document.getElementById('modify-id').value = a.id;
  document.getElementById('modify-date').value = a.appt_date;
  document.getElementById('modify-name').value = a.name;
  document.getElementById('modify-phone').value = a.phone;

  const select = document.getElementById('modify-slot');
  select.innerHTML = TIME_SLOTS.map((s) =>
    `<option value="${s.value}" ${s.value === a.time_slot ? 'selected' : ''}>${s.label}</option>`
  ).join('');

  // Set min date to today for the date picker
  document.getElementById('modify-date').setAttribute('min', todayStr());

  document.getElementById('modify-overlay').style.display = 'flex';
}

document.getElementById('modify-close').addEventListener('click', () => {
  document.getElementById('modify-overlay').style.display = 'none';
});

document.getElementById('modify-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('modify-overlay').style.display = 'none';
  }
});

document.getElementById('btn-modify-confirm').addEventListener('click', async () => {
  const id = document.getElementById('modify-id').value;
  const date = document.getElementById('modify-date').value;
  const timeSlot = document.getElementById('modify-slot').value;
  const name = document.getElementById('modify-name').value.trim();
  const phone = document.getElementById('modify-phone').value.trim();

  if (!name) return toast('请输入姓名', 'error');
  if (!phone || !/^1\d{10}$/.test(phone)) return toast('请输入有效的11位手机号', 'error');

  const btn = document.getElementById('btn-modify-confirm');
  btn.disabled = true;
  btn.textContent = '提交中...';

  try {
    await api('PUT', `/api/appointments/${id}`, { date, timeSlot, name, phone });
    saveUser(name, phone);
    toast('✅ 预约信息已更新', 'success');
    document.getElementById('modify-overlay').style.display = 'none';

    // Refresh list
    document.getElementById('btn-lookup').click();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '确认修改';
  }
});

// ── Cancel Appointment ─────────────────────────────────────────────────────

async function cancelAppointment(id) {
  if (!confirm('确定要取消此预约吗？取消后不可恢复。')) return;

  try {
    await api('DELETE', `/api/appointments/${id}`);
    toast('✅ 预约已取消', 'success');
    // Refresh list
    document.getElementById('btn-lookup').click();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════════════

// Default admin date to today
document.getElementById('admin-date').value = todayStr();

// ── Admin calendar popup ──────────────────────────────────────────────────
const adminCal = {
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
};

function renderAdminCalendar() {
  const { year, month } = adminCal;
  document.getElementById('admin-cal-title').textContent = `${year}年 ${month}月`;

  const grid = document.getElementById('admin-cal-grid');
  grid.innerHTML = '';
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = todayStr();

  for (let i = 0; i < firstDay; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day empty';
    grid.appendChild(cell);
  }

  const { min, max } = { min: '2000-01-01', max: '2099-12-31' }; // Admin can see any date

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'cal-day';

    if (dateStr === today) cell.classList.add('today');
    if (dateStr === document.getElementById('admin-date').value) cell.classList.add('selected');

    cell.innerHTML = `<span class="cal-day-num">${d}</span>`;
    cell.addEventListener('click', () => {
      document.getElementById('admin-date').value = dateStr;
      document.getElementById('admin-cal-overlay').style.display = 'none';
      // Auto query
      document.getElementById('btn-admin-query').click();
    });

    grid.appendChild(cell);
  }
}

document.getElementById('btn-admin-cal').addEventListener('click', () => {
  // Sync calendar to admin date
  const cur = document.getElementById('admin-date').value;
  if (cur) {
    const [y, m] = cur.split('-').map(Number);
    adminCal.year = y;
    adminCal.month = m;
  }
  renderAdminCalendar();
  document.getElementById('admin-cal-overlay').style.display = 'flex';
});

document.getElementById('admin-cal-close').addEventListener('click', () => {
  document.getElementById('admin-cal-overlay').style.display = 'none';
});

document.getElementById('admin-cal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) document.getElementById('admin-cal-overlay').style.display = 'none';
});

document.getElementById('admin-cal-prev').addEventListener('click', () => {
  if (adminCal.month === 1) { adminCal.year--; adminCal.month = 12; }
  else { adminCal.month--; }
  renderAdminCalendar();
});

document.getElementById('admin-cal-next').addEventListener('click', () => {
  if (adminCal.month === 12) { adminCal.year++; adminCal.month = 1; }
  else { adminCal.month++; }
  renderAdminCalendar();
});

/** Check if admin is already verified this session */
function isAdminVerified() {
  return !!sessionStorage.getItem('admin_token');
}

/** Show/hide admin gate vs content */
function updateAdminUI() {
  const gate = document.getElementById('admin-gate');
  const content = document.getElementById('admin-content');
  if (isAdminVerified()) {
    gate.style.display = 'none';
    content.style.display = 'block';
  } else {
    gate.style.display = 'block';
    content.style.display = 'none';
  }
}

/** Auto-load when switching to Admin tab */
async function autoLoadAdmin() {
  updateAdminUI();
  if (isAdminVerified()) {
    await loadAdminData(null);
  }
}

// Password verification
document.getElementById('btn-admin-verify').addEventListener('click', async () => {
  const password = document.getElementById('admin-password').value.trim();
  const errEl = document.getElementById('admin-error');

  if (!password) {
    errEl.textContent = '请输入密码';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btn-admin-verify');
  btn.disabled = true;
  btn.textContent = '验证中...';
  errEl.style.display = 'none';

  try {
    const data = await api('POST', '/api/admin/verify', { password });
    sessionStorage.setItem('admin_token', data.token);
    updateAdminUI();
    await loadAdminData(null);
    document.getElementById('admin-password').value = '';
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = '验证进入';
  }
});

// Enter key triggers verify
document.getElementById('admin-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-admin-verify').click();
});

// Logout
document.getElementById('btn-admin-logout').addEventListener('click', () => {
  sessionStorage.removeItem('admin_token');
  document.getElementById('admin-table-wrap').innerHTML = '';
  updateAdminUI();
  toast('已退出管理', 'info');
});

document.getElementById('btn-admin-query').addEventListener('click', async () => {
  const date = document.getElementById('admin-date').value;
  if (!date) return toast('请选择日期', 'error');
  await loadAdminData(date);
});

document.getElementById('btn-admin-all').addEventListener('click', async () => {
  await loadAdminData(null);
});

async function loadAdminData(date) {
  const wrap = document.getElementById('admin-table-wrap');
  wrap.innerHTML = '<p style="text-align:center;color:var(--gray-400);padding:20px;">查询中...</p>';

  try {
    const url = date ? `/api/admin/appointments?date=${date}` : '/api/admin/appointments';
    const data = await api('GET', url);

    if (!data.appointments.length) {
      wrap.innerHTML = `
        <div class="admin-table">
          <div class="no-data">${date ? `${date} 暂无预约记录` : '暂无预约记录'}</div>
        </div>`;
      return;
    }

    // Group by date if showing all
    if (!date) {
      const groups = {};
      for (const a of data.appointments) {
        if (!groups[a.appt_date]) groups[a.appt_date] = [];
        groups[a.appt_date].push(a);
      }
      const dates = Object.keys(groups).sort().reverse();

      wrap.innerHTML = dates.map((d) => {
        const rows = groups[d].map((a, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${a.time_slot}</td>
            <td>${a.name}</td>
            <td>${a.phone}</td>
          </tr>`).join('');
        return `
          <div class="admin-summary">📅 <strong>${d}</strong> · 共 ${groups[d].length} 人预约</div>
          <table class="admin-table">
            <thead><tr><th>#</th><th>时间段</th><th>姓名</th><th>手机号</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="height:12px;"></div>`;
      }).join('');
    } else {
      const rows = data.appointments.map((a, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${a.time_slot}</td>
          <td>${a.name}</td>
          <td>${a.phone}</td>
        </tr>`).join('');

      wrap.innerHTML = `
        <div class="admin-summary">📅 <strong>${date}</strong> · 共 ${data.appointments.length} 人预约</div>
        <table class="admin-table">
          <thead><tr><th>#</th><th>时间段</th><th>姓名</th><th>手机号</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }
  } catch (e) {
    toast(e.message, 'error');
    wrap.innerHTML = '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

function init() {
  prefillUser();
  renderCalendar();
}

init();
