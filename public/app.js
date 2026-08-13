/* ═══════════════════════════════════════════════════════════════════════════
   SPINE CLINIC BOOKING — Client Application
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Constants ────────────────────────────────────────────────────────────────
// P4: fallback slots — overwritten by GET /api/config at startup
let TIME_SLOTS = [
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
  config: null,         // loaded from /api/config (P4)
  calNavDir: 0,         // V4: -1 prev / +1 next month animation
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
  // Attach admin token for admin routes
  if (path.startsWith('/api/admin/') && path !== '/api/admin/verify') {
    const token = sessionStorage.getItem('admin_token');
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw new Error('网络连接失败，请检查网络后重试');
  }
  // Try to parse JSON — if fail, give a clear error
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`服务器返回异常 (${res.status})，请刷新页面后重试`);
  }
  // M4: admin session expired — clear token and return to login gate
  if (!res.ok && res.status === 401 && path.startsWith('/api/admin/') && path !== '/api/admin/verify') {
    sessionStorage.removeItem('admin_token');
    if (typeof updateAdminUI === 'function') updateAdminUI();
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

/** Escape HTML to prevent XSS when injecting user data */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  document.getElementById('lookup-name').value = u.name;
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
      if (info.blocked && !info.available) {
        cell.innerHTML += '<span class="cal-badge blocked">屏蔽</span>';
      } else if (info.available) {
        cell.innerHTML += `<span class="cal-badge avail">剩${info.totalRemaining}</span>`;
      } else {
        cell.innerHTML += '<span class="cal-badge full">满</span>';
      }
    }

    grid.appendChild(cell);
  }

  // V4: month-flip slide animation
  if (state.calNavDir !== 0) {
    const dir = state.calNavDir;
    state.calNavDir = 0;
    grid.style.transition = 'none';
    grid.style.transform = `translateX(${dir * 24}px)`;
    grid.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      grid.style.transition = 'transform .15s ease-out, opacity .15s ease-out';
      grid.style.transform = 'translateX(0)';
      grid.style.opacity = '1';
    }));
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

    if (slot.blocked) {
      div.className = 'slot-item blocked';
      div.innerHTML = `
        <span class="slot-time">${slot.label}</span>
        <span class="slot-remaining">🚫 <span class="num">已屏蔽</span></span>
      `;
    } else if (slot.full) {
      div.className = 'slot-item full';
      div.innerHTML = `
        <span class="slot-time">${slot.label}</span>
        <span class="slot-remaining">剩余 <span class="num">${slot.remaining}</span> 人</span>
      `;
    } else {
      div.className = 'slot-item available';
      div.innerHTML = `
        <span class="slot-time">${slot.label}</span>
        <span class="slot-remaining">剩余 <span class="num">${slot.remaining}</span> 人</span>
      `;
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

// Success card close
document.getElementById('success-close').addEventListener('click', () => {
  document.getElementById('success-overlay').style.display = 'none';
});
document.getElementById('success-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('success-overlay').style.display = 'none';
  }
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

    // Show success confirm card
    document.getElementById('form-overlay').style.display = 'none';
    document.getElementById('success-date').textContent = state.selectedDate;
    document.getElementById('success-slot').textContent = state.selectedSlot;
    document.getElementById('success-name').textContent = name;
    document.getElementById('success-phone').textContent = phone;
    document.getElementById('success-id').textContent = data.appointment ? data.appointment.id : '-';
    document.getElementById('success-overlay').style.display = 'flex';

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
  state.calNavDir = -1; // V4: slide from left
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
  state.calNavDir = 1; // V4: slide from right
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
  const u = getSavedUser();
  const list = document.getElementById('myappt-list');
  if (!u.phone || !u.name) {
    list.innerHTML = '<div class="appt-item" style="text-align:center;color:var(--gray-600);">请先输入姓名和手机号，然后点击"查询预约"</div>';
    return;
  }
  document.getElementById('lookup-name').value = u.name;
  document.getElementById('lookup-phone').value = u.phone;
  list.innerHTML = '<p style="text-align:center;color:var(--gray-600);padding:20px;">查询中...</p>';
  try {
    const data = await api('GET', `/api/appointments?phone=${encodeURIComponent(u.phone)}&name=${encodeURIComponent(u.name)}`);
    renderMyAppointments(data.appointments);
  } catch (e) {
    toast(e.message, 'error');
    list.innerHTML = '';
  }
}

document.getElementById('btn-lookup').addEventListener('click', async () => {
  const name = document.getElementById('lookup-name').value.trim();
  const phone = document.getElementById('lookup-phone').value.trim();
  if (!name || name.length < 2) return toast('请输入姓名', 'error');
  if (!phone || !/^1\d{10}$/.test(phone)) return toast('请输入有效的11位手机号', 'error');

  saveUser(name, phone);

  const list = document.getElementById('myappt-list');
  list.innerHTML = '<p style="text-align:center;color:var(--gray-600);padding:20px;">查询中...</p>';

  try {
    const data = await api('GET', `/api/appointments?phone=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}`);
    renderMyAppointments(data.appointments);
  } catch (e) {
    toast(e.message, 'error');
    list.innerHTML = '';
  }
});

function renderMyAppointments(appts) {
  const list = document.getElementById('myappt-list');
  if (!appts.length) {
    list.innerHTML = '<div class="appt-item" style="text-align:center;color:var(--gray-600);">暂无预约记录</div>';
    return;
  }

  list.innerHTML = appts.map((a) => {
    const statusClass = a.isPast ? 'past' : '';
    const actionsHTML = a.isPast ? '' : `
      <div class="appt-actions">
        ${a.canModify ? `<button class="btn-sm edit" data-id="${a.id}" data-action="modify">✏️ 修改</button>` : ''}
        ${a.canModify ? `<button class="btn-sm cancel" data-id="${a.id}" data-phone="${escapeHtml(a.phone)}" data-action="cancel">🗑 取消</button>` : ''}
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
          <span class="appt-name">👤 ${escapeHtml(a.name)}</span>
          <span class="appt-name">📱 ${escapeHtml(a.phone)}</span>
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
    btn.addEventListener('click', () => cancelAppointment(btn.dataset.id, btn.dataset.phone));
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

async function cancelAppointment(id, phone) {
  if (!confirm('确定要取消此预约吗？取消后不可恢复。')) return;

  try {
    await api('DELETE', `/api/appointments/${id}`, { phone });
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
let adminCalNavDir = 0; // V4: popup calendar flip direction

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
    if (dateStr === document.getElementById(calPopupTarget).value) cell.classList.add('selected');

    cell.innerHTML = `<span class="cal-day-num">${d}</span>`;
    cell.addEventListener('click', () => {
      document.getElementById(calPopupTarget).value = dateStr;
      document.getElementById('admin-cal-overlay').style.display = 'none';
      // Auto query only for the main date picker
      if (calPopupTarget === 'admin-date') {
        document.getElementById('btn-admin-query').click();
      }
    });

    grid.appendChild(cell);
  }

  // V4: popup month-flip animation
  if (adminCalNavDir !== 0) {
    const dir = adminCalNavDir;
    adminCalNavDir = 0;
    grid.style.transition = 'none';
    grid.style.transform = `translateX(${dir * 24}px)`;
    grid.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      grid.style.transition = 'transform .15s ease-out, opacity .15s ease-out';
      grid.style.transform = 'translateX(0)';
      grid.style.opacity = '1';
    }));
  }
}

// U5: shared calendar popup — fills whichever input requested it
let calPopupTarget = 'admin-date';

function openAdminCalendarFor(targetId) {
  calPopupTarget = targetId;
  const cur = document.getElementById(targetId).value;
  if (cur && /^\d{4}-\d{2}-\d{2}$/.test(cur)) {
    const [y, m] = cur.split('-').map(Number);
    adminCal.year = y;
    adminCal.month = m;
  }
  renderAdminCalendar();
  document.getElementById('admin-cal-overlay').style.display = 'flex';
}

document.getElementById('btn-admin-cal').addEventListener('click', () => openAdminCalendarFor('admin-date'));
document.querySelectorAll('.cal-popup-btn').forEach((btn) => {
  btn.addEventListener('click', () => openAdminCalendarFor(btn.dataset.target));
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
  adminCalNavDir = -1; // V4
  renderAdminCalendar();
});

document.getElementById('admin-cal-next').addEventListener('click', () => {
  if (adminCal.month === 12) { adminCal.year++; adminCal.month = 1; }
  else { adminCal.month++; }
  adminCalNavDir = 1; // V4
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
    await loadAdminData(todayStr());
    await loadBlockedDates();
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
    await loadAdminData(todayStr());
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

// Blocked dates management
document.getElementById('btn-add-block').addEventListener('click', addBlockedDate);
document.getElementById('block-date').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addBlockedDate();
});
document.getElementById('block-session').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addBlockedDate();
});

// Export to Excel
document.getElementById('btn-admin-export').addEventListener('click', async () => {
  const btn = document.getElementById('btn-admin-export');
  btn.disabled = true;
  btn.textContent = '导出中...';

  try {
    const data = await api('GET', '/api/admin/appointments');
    if (!data.appointments.length) { toast('暂无预约记录可导出', 'error'); return; }

    const BOM = '﻿';
    const header = '日期,时间段,姓名,手机号,完成状态,创建时间';
    const rows = data.appointments.map(a =>
      `${a.appt_date},${a.time_slot},${a.name},${a.phone},${a.status || '已完成'},${a.created_at}`
    );
    const csv = BOM + header + '\n' + rows.join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    a.download = `预约记录_${ym}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    toast('✅ 导出成功', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📥 导出本月Excel';
  }
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

// Admin date quick navigation
function shiftAdminDate(days) {
  const input = document.getElementById('admin-date');
  const cur = new Date(input.value + 'T00:00:00');
  cur.setDate(cur.getDate() + days);
  const y = cur.getFullYear();
  const m = String(cur.getMonth() + 1).padStart(2, '0');
  const d = String(cur.getDate()).padStart(2, '0');
  input.value = `${y}-${m}-${d}`;
  loadAdminData(input.value);
}
document.getElementById('btn-admin-prev').addEventListener('click', () => shiftAdminDate(-1));
document.getElementById('btn-admin-next').addEventListener('click', () => shiftAdminDate(1));

document.getElementById('btn-admin-all').addEventListener('click', async () => {
  await loadAdminData(null);
});

// S4: month view with prev/next arrows
const adminMonth = {
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
};

function renderAdminMonthLabel() {
  document.getElementById('admin-month-label').textContent =
    `${adminMonth.year}年 ${adminMonth.month}月`;
}

function adminMonthValue() {
  return `${adminMonth.year}-${String(adminMonth.month).padStart(2, '0')}`;
}

document.getElementById('btn-admin-month-prev').addEventListener('click', () => {
  if (adminMonth.month === 1) { adminMonth.year--; adminMonth.month = 12; }
  else { adminMonth.month--; }
  renderAdminMonthLabel();
});

document.getElementById('btn-admin-month-next').addEventListener('click', () => {
  if (adminMonth.month === 12) { adminMonth.year++; adminMonth.month = 1; }
  else { adminMonth.month++; }
  renderAdminMonthLabel();
});

document.getElementById('btn-admin-month').addEventListener('click', async () => {
  await loadAdminData(null, adminMonthValue());
});

renderAdminMonthLabel();

const SLOT_ORDER = ['8:30-9:30', '9:30-10:30', '10:30-11:30', '15:00-16:00', '16:00-17:00'];

// P5: shared slot-group renderer (used by single-date view and 查看全部)
function renderSlotGroupsHtml(listBySlot) {
  let html = '';
  for (const slot of SLOT_ORDER) {
    const list = listBySlot[slot] || [];
    html += `<div class="slot-group">`;
    html += `<div class="slot-group-header">🕐 <strong>${slot}</strong> · ${list.length}人</div>`;
    if (list.length > 0) {
      html += `<table class="admin-table slot-table">
        <thead><tr><th>#</th><th>姓名</th><th>手机号</th><th>完成状态</th><th>操作</th></tr></thead>
        <tbody>`;
      html += list.map((a, i) => `
        <tr class="${a.status === '未到场' ? 'row-noshow' : ''}">
          <td>${i + 1}</td><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.phone)}</td>
          <td><button class="btn-status ${a.status === '未到场' ? 'noshow' : 'done'}" data-id="${a.id}" data-status="${a.status || '已完成'}">${a.status || '已完成'}</button></td>
          <td><button class="btn-admin-del" data-id="${a.id}" data-name="${escapeHtml(a.name)}" data-date="${a.appt_date}" data-slot="${a.time_slot}">🗑</button></td>
        </tr>`).join('');
      html += `</tbody></table>`;
    } else {
      html += `<div class="slot-empty">暂无预约</div>`;
    }
    html += `</div>`;
  }
  return html;
}

async function loadAdminData(date, month) {
  const wrap = document.getElementById('admin-table-wrap');
  wrap.innerHTML = '<p style="text-align:center;color:var(--gray-600);padding:20px;">查询中...</p>';

  try {
    let url = '/api/admin/appointments';
    if (date) url = `/api/admin/appointments?date=${date}`;
    else if (month) url = `/api/admin/appointments?month=${month}`;
    const data = await api('GET', url);

    if (!data.appointments.length) {
      wrap.innerHTML = `
        <div class="admin-table">
          <div class="no-data">${date ? `${date} 暂无预约记录` : (month ? `${month} 暂无预约记录` : '暂无预约记录')}</div>
        </div>`;
      return;
    }

    // ── Month view (P2): compact per-day summary list ──
    if (month) {
      const dayMap = {};
      for (const a of data.appointments) {
        if (!dayMap[a.appt_date]) dayMap[a.appt_date] = { total: 0, attended: 0, noshow: 0 };
        dayMap[a.appt_date].total++;
        if (a.status === '未到场') dayMap[a.appt_date].noshow++;
        else dayMap[a.appt_date].attended++;
      }
      const dates = Object.keys(dayMap).sort().reverse();
      const total = data.appointments.length;

      let html = `<div class="month-summary">
        📊 <strong>${month}月</strong> · 共 <strong>${total}</strong> 人预约
        </div>`;

      html += dates.map((d) => {
        const s = dayMap[d];
        return `
          <div class="month-day-row">
            <div class="month-day-info">
              <strong>${d}</strong>
              <span class="month-day-stat">共${s.total}人 · ✅${s.attended} · ❌${s.noshow}</span>
            </div>
            <button class="btn-day-detail" data-date="${d}">查看</button>
          </div>`;
      }).join('');

      wrap.innerHTML = html;
      return;
    }

    // ── All view: per-date slot breakdown with monthly summary ──
    if (!date) {
      const groups = {};
      let monthTotal = 0;
      const now = new Date();
      // P1: count against the CURRENT month for 查看全部 (summary = this month)
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      for (const a of data.appointments) {
        if (!groups[a.appt_date]) groups[a.appt_date] = [];
        groups[a.appt_date].push(a);
        if (a.appt_date.startsWith(currentMonth)) monthTotal++;
      }
      const dates = Object.keys(groups).sort().reverse();

      wrap.innerHTML = `<div class="month-summary">
        📊 <strong>${currentMonth}月</strong> · 共 <strong>${monthTotal}</strong> 人预约
        </div>`;

      wrap.innerHTML += dates.map((d) => {
        const slotGroups = {};
        for (const a of groups[d]) {
          if (!slotGroups[a.time_slot]) slotGroups[a.time_slot] = [];
          slotGroups[a.time_slot].push(a);
        }
        return `<div class="admin-summary">📅 <strong>${d}</strong> · 共 ${groups[d].length} 人预约</div>` +
          renderSlotGroupsHtml(slotGroups) + '<div style="height:12px;"></div>';
      }).join('');
      return;
    }

    // ── Single-date view ──
    const slotGroups = {};
    for (const a of data.appointments) {
      if (!slotGroups[a.time_slot]) slotGroups[a.time_slot] = [];
      slotGroups[a.time_slot].push(a);
    }

    wrap.innerHTML =
      `<div class="admin-summary">📅 <strong>${date}</strong> · 共 ${data.appointments.length} 人预约</div>` +
      renderSlotGroupsHtml(slotGroups);
  } catch (e) {
    toast(e.message, 'error');
    wrap.innerHTML = '';
  }
}

// ── Status Toggle ──────────────────────────────────────────────────────────

// Event delegation for status toggle + admin delete + day detail (dynamically rendered)
document.getElementById('admin-table-wrap').addEventListener('click', async (e) => {
  const target = e.target;

  // Month view → jump to single-day detail (P2)
  if (target.classList.contains('btn-day-detail')) {
    document.getElementById('admin-date').value = target.dataset.date;
    await loadAdminData(target.dataset.date);
    return;
  }

  // Admin delete button (R3)
  if (target.classList.contains('btn-admin-del')) {
    const id = target.dataset.id;
    const name = target.dataset.name;
    const date = target.dataset.date;
    const slot = target.dataset.slot;
    if (!confirm(`确定删除预约吗？\n${name} | ${date} ${slot}\n删除后不可恢复！`)) return;

    target.disabled = true;
    try {
      const data = await api('DELETE', `/api/admin/appointments/${id}`);
      toast(`✅ ${data.message}`, 'success');
      // Refresh current admin view
      const curDate = document.getElementById('admin-date').value;
      await loadAdminData(curDate);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      target.disabled = false;
    }
    return;
  }

  // Status toggle
  if (!target.classList.contains('btn-status')) return;
  const btn = target;
  const id = btn.dataset.id;
  const currentStatus = btn.dataset.status;
  const newStatus = currentStatus === '未到场' ? '已完成' : '未到场';

  btn.disabled = true;
  btn.textContent = '...';

  try {
    const data = await api('PUT', `/api/admin/appointments/${id}/status`, { status: newStatus });
    btn.dataset.status = newStatus;
    btn.textContent = newStatus;
    btn.className = `btn-status ${newStatus === '未到场' ? 'noshow' : 'done'}`;

    // Update row styling
    const row = btn.closest('tr');
    if (newStatus === '未到场') {
      row.classList.add('row-noshow');
    } else {
      row.classList.remove('row-noshow');
    }

    toast(data.success ? `✅ ${data.message}` : data.message, data.success ? 'success' : 'error');

    // Refresh calendar if on booking tab (slot counts may change)
    if (state.currentTab === 'booking') await renderCalendar();
  } catch (err) {
    toast(err.message, 'error');
    btn.textContent = currentStatus;
  } finally {
    btn.disabled = false;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PATIENT STATS (Admin)
// ═══════════════════════════════════════════════════════════════════════════

// Set default date range to current month
(function() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const days = new Date(y, now.getMonth() + 1, 0).getDate();
  const startEl = document.getElementById('stat-start');
  const endEl = document.getElementById('stat-end');
  if (startEl) startEl.value = `${y}-${m}-01`;
  if (endEl) endEl.value = `${y}-${m}-${String(days).padStart(2, '0')}`;
})();

document.getElementById('btn-stat-query').addEventListener('click', async () => {
  const name = document.getElementById('stat-name').value.trim();
  const start = document.getElementById('stat-start').value;
  const end = document.getElementById('stat-end').value;
  const result = document.getElementById('stat-result');

  if (!name) return toast('请输入患者姓名', 'error');
  if (!start || !end) return toast('请选择日期范围', 'error');

  result.innerHTML = '<p style="text-align:center;color:var(--gray-600);padding:12px;">查询中...</p>';

  try {
    const data = await api('GET', `/api/admin/patient-stats?name=${encodeURIComponent(name)}&start=${start}&end=${end}`);

    if (!data.appointments.length) {
      result.innerHTML = `<div class="stat-empty">未找到"${name}"在 ${start} ~ ${end} 期间的预约记录</div>`;
      return;
    }

    const multiName = data.byName.length > 1;

    let html = `<div class="stat-summary-row">
      <div class="stat-card"><div class="stat-num">${data.total}</div><div class="stat-label">总预约</div></div>
      <div class="stat-card attended"><div class="stat-num">${data.attended}</div><div class="stat-label">已完成</div></div>
      <div class="stat-card noshow"><div class="stat-num">${data.noshow}</div><div class="stat-label">未到场</div></div>
    </div>`;

    // Per-name breakdown when fuzzy search matched multiple people
    if (multiName) {
      html += `<div class="admin-summary" style="margin-top:12px;">👥 共 ${data.byName.length} 名患者，按人次排序</div>`;
      html += `<table class="admin-table">
        <thead><tr><th>姓名</th><th>总预约</th><th>已完成</th><th>未到场</th></tr></thead>
        <tbody>`;
      html += data.byName.map(b => `
        <tr>
          <td>${escapeHtml(b.name)}</td>
          <td>${b.total}</td>
          <td style="color:var(--green);font-weight:600;">${b.attended}</td>
          <td style="color:var(--red);font-weight:600;">${b.noshow}</td>
        </tr>`).join('');
      html += `</tbody></table>`;
    }

    // Detail table (name column only needed for multi-name results)
    html += `<table class="admin-table" style="margin-top:12px;">
      <thead><tr>${multiName ? '<th>姓名</th>' : ''}<th>日期</th><th>时间段</th><th>状态</th></tr></thead>
      <tbody>`;
    html += data.appointments.map(a => `
      <tr class="${a.status === '未到场' ? 'row-noshow' : ''}">
        ${multiName ? `<td>${escapeHtml(a.name)}</td>` : ''}
        <td>${a.appt_date}</td>
        <td>${a.time_slot}</td>
        <td><span class="stat-status ${a.status === '未到场' ? 'noshow' : 'done'}">${a.status || '已完成'}</span></td>
      </tr>`).join('');
    html += `</tbody></table>`;

    result.innerHTML = html;
  } catch (e) {
    toast(e.message, 'error');
    result.innerHTML = '';
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKED DATES MANAGEMENT (Admin)
// ═══════════════════════════════════════════════════════════════════════════

async function loadBlockedDates() {
  const list = document.getElementById('blocked-list');
  try {
    const data = await api('GET', '/api/admin/blocked-dates');
    if (!data.blockedDates.length) {
      list.innerHTML = '<div style="text-align:center;color:var(--gray-600);padding:12px;font-size:14px;">暂无屏蔽日期</div>';
      return;
    }

    const sessionLabels = { morning: '上午', afternoon: '下午', all_day: '全天' };

    list.innerHTML = data.blockedDates.map(b => `
      <div class="blocked-item">
        <div class="blocked-info">
          <span class="blocked-date">📅 ${b.block_date}</span>
          <span class="blocked-session-tag">${sessionLabels[b.session] || b.session}</span>
        </div>
        <button class="btn-sm cancel" onclick="removeBlockedDate(${b.id})">移除</button>
      </div>
    `).join('');
  } catch (e) {
    toast(e.message, 'error');
    list.innerHTML = '';
  }
}

async function addBlockedDate() {
  const date = document.getElementById('block-date').value;
  const session = document.getElementById('block-session').value;
  if (!date) return toast('请选择屏蔽日期', 'error');

  const btn = document.getElementById('btn-add-block');
  btn.disabled = true;
  btn.textContent = '添加中...';

  try {
    await api('POST', '/api/admin/blocked-dates', { date, session });
    toast('✅ 屏蔽设置成功', 'success');
    document.getElementById('block-date').value = todayStr();
    await loadBlockedDates();
    if (state.currentTab === 'booking') await renderCalendar();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '添加屏蔽';
  }
}

async function removeBlockedDate(id) {
  if (!confirm('确定要移除此屏蔽吗？')) return;
  try {
    await api('DELETE', `/api/admin/blocked-dates/${id}`);
    toast('✅ 已取消屏蔽', 'success');
    await loadBlockedDates();
    if (state.currentTab === 'booking') await renderCalendar();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

async function init() {
  // P4: load booking rules config from server (single source of truth)
  try {
    const cfg = await api('GET', '/api/config');
    state.config = cfg;
    TIME_SLOTS = cfg.slots.map(s => ({ label: s.label, value: s.label }));
  } catch (e) { /* keep fallback slots */ }

  prefillUser();
  renderCalendar();
  // Set block-date defaults for admin panel
  const blockDateInput = document.getElementById('block-date');
  if (blockDateInput) {
    blockDateInput.value = todayStr();
  }
  // Admin collapsible sections
  document.querySelectorAll('.admin-collapse-header').forEach(header => {
    header.addEventListener('click', () => {
      header.classList.toggle('open');
    });
  });
}

init();
