const fs = require('fs');
const http = require('http');

const CSV_PATH = __dirname + '/8月份脊柱侧弯.csv';
const API_HOST = '43.136.36.235';
const API_PORT = 3000;

// Time slot mapping: CSV column index -> slot label
const SLOT_LABELS = [
  '8:30-9:30',   // column 1
  '9:30-10:30',  // column 2
  '10:30-11:30', // column 3
  '15:00-16:00', // column 4
  '16:00-17:00', // column 5
];

// ── Phone number generation ─────────────────────────────────────────
const namePhoneMap = new Map();
let phoneCounter = 13800000000;

function getPhone(name) {
  if (!namePhoneMap.has(name)) {
    phoneCounter++;
    namePhoneMap.set(name, String(phoneCounter));
  }
  return namePhoneMap.get(name);
}

// ── Name splitting ──────────────────────────────────────────────────
// Known concatenated pairs (manually identified)
const KNOWN_CONCAT = {
  '陈其乐陈镜寰': ['陈其乐', '陈镜寰'],
  '胡崇张懿': ['胡崇张懿'], // This is actually ONE person's name (胡崇张懿 - 4 char name)
  '王思为': ['王思为'], // One person
  '郭知轩': ['郭知轩'],
  '林墨涵': ['林墨涵'],
};

function splitNames(cellText) {
  if (!cellText || !cellText.trim()) return [];

  // Check known concatenated names first
  let text = cellText.trim();

  // Handle known concatenations
  for (const [concat, parts] of Object.entries(KNOWN_CONCAT)) {
    if (text.includes(concat) && parts.length > 1) {
      // Replace the concatenated form with separated form
      text = text.replace(concat, parts.join('、'));
    }
  }

  // Split on common Chinese/English delimiters
  // 、 ， , . 。 spaces, multiple spaces
  const parts = text
    .split(/[、，,.\s。]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2); // filter out empty/single char

  return parts;
}

// ── Date parsing ────────────────────────────────────────────────────
function parseDate(dateStr) {
  // "8.10周一" -> "2026-08-10"
  const match = dateStr.match(/(\d+)\.(\d+)/);
  if (!match) return null;
  const month = parseInt(match[1]);
  const day = parseInt(match[2]);
  return `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── API call ────────────────────────────────────────────────────────
function bookAppointment(name, phone, date, timeSlot) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ name, phone, date, timeSlot });
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path: '/api/appointments',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode === 200 && json.success) {
            resolve({ success: true, name, date, timeSlot, phone });
          } else {
            resolve({ success: false, name, date, timeSlot, phone, error: json.error || `HTTP ${res.statusCode}` });
          }
        } catch (e) {
          resolve({ success: false, name, date, timeSlot, phone, error: body });
        }
      });
    });

    req.on('error', (e) => resolve({ success: false, name, date, timeSlot, phone, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, name, date, timeSlot, phone, error: 'timeout' }); });

    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = content.trim().split('\n');

  // Parse all bookings
  const bookings = [];
  const parseErrors = [];

  for (let i = 1; i < lines.length; i++) { // skip header row
    const cols = lines[i].split(',');
    const dateStr = cols[0]?.trim();
    if (!dateStr) continue;

    const date = parseDate(dateStr);
    if (!date) continue;

    // Only process from 8.10 onwards
    if (date < '2026-08-10') continue;

    // Parse each time slot column (cols 1-5)
    for (let slotIdx = 1; slotIdx <= 5; slotIdx++) {
      const cellText = cols[slotIdx] || '';
      const names = splitNames(cellText);

      for (const name of names) {
        if (name.length < 2) {
          parseErrors.push(`Short name: "${name}" in ${dateStr} ${SLOT_LABELS[slotIdx-1]}`);
          continue;
        }
        bookings.push({
          name,
          date,
          timeSlot: SLOT_LABELS[slotIdx - 1],
        });
      }
    }
  }

  console.log(`=== 解析完毕 ===`);
  console.log(`共 ${bookings.length} 条预约记录`);
  console.log(`共 ${new Set(bookings.map(b => b.name)).size} 个不同姓名`);
  console.log('');

  // Show summary by date
  const dateCount = {};
  for (const b of bookings) {
    dateCount[b.date] = (dateCount[b.date] || 0) + 1;
  }
  for (const [date, count] of Object.entries(dateCount).sort()) {
    console.log(`  ${date}: ${count} 人`);
  }
  console.log('');

  if (parseErrors.length > 0) {
    console.log('=== 解析警告 ===');
    for (const e of parseErrors) console.log(`  ⚠️ ${e}`);
    console.log('');
  }

  // Ask for confirmation
  console.log(`即将向 http://${API_HOST}:${API_PORT} 提交 ${bookings.length} 条预约...`);
  console.log('');

  // Process bookings with delay to avoid overwhelming the server
  let success = 0, fail = 0;
  const failures = [];

  for (let i = 0; i < bookings.length; i++) {
    const b = bookings[i];
    const phone = getPhone(b.name);
    const result = await bookAppointment(b.name, phone, b.date, b.timeSlot);

    if (result.success) {
      success++;
    } else {
      fail++;
      failures.push(result);
      console.log(`  ❌ [${i+1}/${bookings.length}] ${b.name} ${b.date} ${b.timeSlot}: ${result.error}`);
    }

    if ((i + 1) % 20 === 0) {
      console.log(`  ... ${i+1}/${bookings.length} (成功 ${success}, 失败 ${fail})`);
    }

    // Small delay to not hammer the server
    await sleep(50);
  }

  console.log('');
  console.log(`=== 结果 ===`);
  console.log(`✅ 成功: ${success}`);
  console.log(`❌ 失败: ${fail}`);

  if (failures.length > 0) {
    console.log('');
    console.log('=== 失败详情 ===');
    for (const f of failures) {
      console.log(`  ${f.name} | ${f.date} | ${f.timeSlot} | ${f.phone} | ${f.error}`);
    }
  }

  // Save name-phone mapping
  const mapData = {};
  for (const [name, phone] of namePhoneMap) {
    mapData[name] = phone;
  }
  fs.writeFileSync(__dirname + '/phone-mapping.json', JSON.stringify(mapData, null, 2));
  console.log('');
  console.log('手机号映射已保存到 phone-mapping.json');
}

main().catch(console.error);
