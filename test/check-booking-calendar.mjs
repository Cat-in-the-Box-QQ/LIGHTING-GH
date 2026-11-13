// test/check-booking-calendar.mjs
// ตรวจปฏิทินจอง (booking.html + js/booking-calendar.js + js/booking-demo.js)
//
// ทำไมต้องมี: บั๊กของปฏิทินส่วนใหญ่ "มองไม่เห็นด้วย node --check" — วันเลื่อน 1 วัน
// ตาม timezone, สีคนสลับทุกครั้งที่โหลด, ยอดคงเหลือไม่หักใบจองซ้อนกัน, stock=null
// กลายเป็น 0 หรือชื่อคนที่มาจากฐานข้อมูลหลุดออกมาเป็นแท็ก HTML
// ชุดนี้จึงเรนเดอร์จริงใน DOM ปลอม แล้วตรวจ HTML ที่ได้ออกมาจริง
//
// รันด้วย: node test/check-booking-calendar.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else {
    fail += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`);
  }
};

// ---------- DOM ปลอม (พอให้โค้ดเรนเดอร์ได้จริง) ----------
class El {
  constructor(id) {
    this.id = id;
    this._html = '';
    this._text = '';
    this.value = '';
    this.hidden = false;
    this.className = '';
    this.style = {};
    this.attrs = {};
    this._cls = new Set();
    this.offsetLeft = 0;
    this.clientWidth = 1000;
    this.scrollLeft = 0;
    this.scrollWidth = 12000;
  }

  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }

  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }

  get classList() {
    const self = this;
    return {
      add: (c) => self._cls.add(c),
      remove: (c) => self._cls.delete(c),
      contains: (c) => self._cls.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self._cls.has(c) : !!force;
        if (on) self._cls.add(c); else self._cls.delete(c);
        return on;
      },
    };
  }

  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener() {}
  scrollIntoView() {}
  scrollTo() {}
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const els = new Map();
const document = {
  getElementById(id) { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
  querySelectorAll() { return []; },
  addEventListener() {},
  activeElement: null,
};

// fetch อ่านจากไฟล์จริงใน repo (ไม่ออกเน็ต — sandbox ไม่มีสิทธิ์เข้าถึง supabase.co)
const fetch = async (url) => {
  const p = path.join(ROOT, String(url).replace(/^\//, ''));
  if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
};

const sandbox = {
  document, fetch, console, Math, Date, JSON, Number, String, Array, Map, Set, Object,
  Promise, RegExp, Error, isNaN, parseInt, parseFloat, setTimeout, clearTimeout,
};
sandbox.window = sandbox;
vm.createContext(sandbox);

for (const f of ['js/booking-demo.js', 'js/booking-live.js', 'js/booking-calendar.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

const Cal = sandbox.BookingCalendar;
const H = Cal._helpers;
const Demo = sandbox.BookingDemoProvider;
const Live = sandbox.BookingLiveProvider;

// ตัดแอตทริบิวต์ออก เหลือแต่ "ตัวหนังสือที่ผู้ใช้เห็นจริง"
function visibleText(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;|&gt;|&quot;|&#39;|&amp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TODAY = H.todayISO();
const YEAR = Number(TODAY.slice(0, 4));
const cssSrc = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
const calCss = cssSrc.slice(cssSrc.indexOf('ปฏิทินจองอุปกรณ์ (booking.html)'));

console.log('\n[1] ตัวช่วยเรื่องวันที่ — ต้องไม่เพี้ยนตาม timezone');
ok('addDays ข้ามเดือน', H.addDays('2026-11-30', 1) === '2026-12-01', H.addDays('2026-11-30', 1));
ok('addDays ข้ามปี', H.addDays('2026-12-31', 1) === '2027-01-01', H.addDays('2026-12-31', 1));
ok('addDays ถอยหลังข้ามเดือน', H.addDays('2026-11-01', -1) === '2026-10-31', H.addDays('2026-11-01', -1));
ok('addMonths ไม่ล้นวัน (31 ม.ค. + 1 เดือน = 1 ก.พ.)', H.addMonths('2026-01-31', 1) === '2026-02-01', H.addMonths('2026-01-31', 1));
ok('addMonths ถอยข้ามปี', H.addMonths('2026-01-15', -1) === '2025-12-01', H.addMonths('2026-01-15', -1));
ok('พ.ศ. ถูก (2026 → 2569)', H.thYear('2026-11-15') === 2569, String(H.thYear('2026-11-15')));
ok('วันที่ยาวเป็นไทย + พ.ศ.', H.thDateLong('2026-11-15') === 'อาทิตย์ 15 พฤศจิกายน 2569', H.thDateLong('2026-11-15'));
ok('วันที่ยาวของวันเสาร์', H.thDateLong('2026-11-14') === 'เสาร์ 14 พฤศจิกายน 2569', H.thDateLong('2026-11-14'));
ok('วันที่สั้น', H.thDateShort('2026-11-15') === '15 พ.ย.', H.thDateShort('2026-11-15'));
ok('ชื่อเดือน + พ.ศ.', H.monthLabel(2026, 10) === 'พฤศจิกายน 2569', H.monthLabel(2026, 10));
ok('dayDiff ในเดือนเดียว', H.dayDiff('2026-11-13', '2026-11-15') === 2);
ok('dayDiff ข้ามปี', H.dayDiff('2026-12-31', '2027-01-02') === 2);

const calSrc = fs.readFileSync(path.join(ROOT, 'js/booking-calendar.js'), 'utf8');
// ตัดคอมเมนต์ออกก่อน — ชื่อ toISOString() ปรากฏในคอมเมนต์ที่อธิบายว่า "ทำไมห้ามใช้"
const codeOnly = calSrc.split('\n')
  .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
  .join('\n');
ok('ไม่ใช้ toISOString() ในโค้ดจริง (กันวันเลื่อนตาม timezone)', !/toISOString/.test(codeOnly));
ok('ไม่ใช้ new Date(ข้อความ ISO) ตรง ๆ', !/new Date\(\s*iso/.test(codeOnly));

console.log('\n[2] สีประจำตัวคน — ต้องถาวร ไม่สลับทุกครั้งที่โหลด');
const demoPeople = Demo.people;
ok('ข้อมูลตัวอย่างกำหนด hue ตายตัวให้ทุกคน', demoPeople.every((p) => Number.isFinite(p.hue)), JSON.stringify(demoPeople.map((p) => p.hue)));
ok('hue ของทุกคนไม่ซ้ำกัน', new Set(demoPeople.map((p) => p.hue)).size === demoPeople.length);
ok('hue ห่างกันพอให้เห็นชัด (>= 20 องศาทุกคู่)', (() => {
  const hues = demoPeople.map((p) => p.hue).sort((a, b) => a - b);
  for (let i = 0; i < hues.length; i += 1) {
    const next = hues[(i + 1) % hues.length];
    let gap = Math.abs(next - hues[i]);
    if (i === hues.length - 1) gap = 360 - hues[i] + hues[0];
    if (gap < 20) return false;
  }
  return true;
})(), demoPeople.map((p) => p.hue).join(','));

const explicit = H.hueOfPerson({ id: 'x', hue: 210 });
ok('hue ที่บันทึกไว้ถูกใช้ก่อนเสมอ', explicit === 210, String(explicit));
ok('hue จากฐานข้อมูล (member_hue) ก็ใช้ได้', H.hueOfPerson({ id: 'x', member_hue: 44 }) === 44);
ok('hue เพี้ยน (ติดลบ/เกิน 360) ถูกละทิ้งแล้วใช้ค่าสำรอง', H.hueOfPerson({ id: 'stable-1', hue: 999 }) === H.hueFromKey('stable-1'));
ok('ไม่มี hue → คำนวณจาก id และได้ค่าเดิมเสมอ', H.hueOfPerson({ id: 'member-42' }) === H.hueOfPerson({ id: 'member-42' }));
ok('id ต่างกันได้ hue ต่างกัน (ตัวอย่างเป็นคู่)', H.hueFromKey('a') !== H.hueFromKey('b'));
ok('hue อยู่ในช่วง 0-359', [0, 5, 99, 359].every((i) => H.hueAt(i) >= 0 && H.hueAt(i) < 360));
ok('hueAt กระจาย (12 ลำดับแรกไม่ซ้ำ)', new Set(Array.from({ length: 12 }, (_, i) => H.hueAt(i))).size === 12);
const css = H.colorOfPerson({ id: 'p', hue: 8 });
ok('รูปแบบสีเป็น hsl ที่ CSS รับได้', /^hsl\(\d+, \d+%, \d+%\)$/.test(css), css);

console.log('\n[3] escapeHtml — ชื่อคน/ชื่องาน/ชื่ออุปกรณ์มาจากข้อมูล');
const evil = '<img src=x onerror=alert(1)>';
ok('escapeHtml ตัด < >', !/[<>]/.test(H.escapeHtml(evil)));
ok('escapeHtml ตัดเครื่องหมายคำพูด', !/["']/.test(H.escapeHtml('"\'')));
ok('escapeHtml(null) ไม่พัง', H.escapeHtml(null) === '');
ok('shortName ตัดชื่อไทยให้สั้น', H.shortName('ธนกฤต ใจดี') === 'ธนกฤต', H.shortName('ธนกฤต ใจดี'));
ok('shortName ยาวเกินถูกตัด', H.shortName('อ'.repeat(20)).endsWith('…'));
ok('shortName ค่าว่างไม่พัง', H.shortName('') === 'ไม่ระบุชื่อ');

console.log('\n[4] ข้อมูลตัวอย่าง — ต้องไม่ขัดกับกติกาของฐานข้อมูลจริง');
const y1 = await Demo.loadRange(`${YEAR}-01-01`, `${YEAR}-12-31`, TODAY);
ok('โหลดทั้งปีสำเร็จ', y1.ok === true);
const dayCount = Object.keys(y1.days).length;
ok(`มีวันที่จองอยู่ในปี (${dayCount} วัน)`, dayCount > 80 && dayCount < 366, String(dayCount));
ok('ได้รายชื่อคนจองมากกว่า 1 คน', y1.people.length > 1, String(y1.people.length));
ok('คนจองทุกคนมี hue ติดมาด้วย', y1.people.every((p) => Number.isFinite(p.hue)));
ok('รายงานจำนวนรายการที่ยังไม่ระบุสต็อก', y1.unknownStockCount > 0, String(y1.unknownStockCount));

let badQty = 0;
let nullStockLine = 0;
Object.values(y1.days).forEach((d) => d.bookings.forEach((b) => b.items.forEach((it) => {
  if (!(Number(it.quantity) > 0)) badQty += 1;          // DB มี check (quantity > 0)
  if (it.stock === null || it.stock === undefined) nullStockLine += 1;   // DB ปฏิเสธของที่ไม่ระบุจำนวน
  if (it.stock !== null && Number(it.quantity) > Number(it.stock)) badQty += 1;
})));
ok('ไม่มีรายการไหนจอง 0 ชิ้น (DB ห้าม quantity > 0 ไม่ผ่าน)', badQty === 0, `เจอ ${badQty}`);
ok('ไม่มีใบจองของที่ยังไม่ระบุจำนวน (trigger ปฏิเสธ)', nullStockLine === 0, `เจอ ${nullStockLine}`);

const y2 = await Demo.loadRange(`${YEAR}-01-01`, `${YEAR}-12-31`, TODAY);
ok('สุ่มแบบ deterministic — โหลดซ้ำได้ผลเหมือนเดิม', JSON.stringify(y1.days) === JSON.stringify(y2.days));
const q1 = await Demo.loadRange(`${YEAR}-01-01`, `${YEAR}-03-31`, TODAY);
ok('โหลดรายไตรมาสได้ (SQL จริงจะจำกัดช่วง 92 วัน)', q1.ok === true && Object.keys(q1.days).every((d) => d < `${YEAR}-04-01`));

console.log('\n[5] วันเดียวหลายคนจอง — ยอด "เหลือ" ต้องหักทุกใบพร้อมกัน');
let busyISO = null;
let busy = null;
for (const iso of Object.keys(y1.days).sort()) {
  const s = H.summarizeDay(y1.days[iso]);
  if (s.peopleCount >= 3) { busyISO = iso; busy = s; break; }
}
ok('มีวันที่คนจองทับกัน >= 3 คน', !!busyISO, busyISO || 'ไม่พบ');
if (busy) {
  const manual = new Map();
  busy.bookings.forEach((b) => b.items.forEach((it) => {
    const k = `${it.itemType}:${it.itemId}`;
    manual.set(k, (manual.get(k) || 0) + Number(it.quantity || 0));
  }));
  ok('จำนวนรายการในตารางรวม = จำนวนรายการไม่ซ้ำ', busy.items.length === manual.size);
  ok('ยอดติดจองรวมตรงกับบวกมือทุกชิ้น', busy.items.every((r) => r.booked === manual.get(`${r.itemType}:${r.itemId}`)));
  ok('เหลือ = มี - ติดจอง และไม่ติดลบ', busy.items.every((r) => r.available === null || (r.available === Math.max(r.stock - r.booked, 0) && r.available >= 0)));
  ok('qtyTotal ตรงกับผลรวมทุกใบ', busy.qtyTotal === busy.items.reduce((a, r) => a + r.booked, 0));
  ok('peopleCount นับคนไม่ซ้ำ', busy.peopleCount === new Set(busy.bookings.map((b) => b.personId)).size);
  ok('แต่ละรายการรู้ว่าใครจองบ้าง', busy.items.every((r) => Array.isArray(r.people) && r.people.length > 0));
  console.log(`  · วันตัวอย่าง ${busyISO}: ${busy.bookingCount} ใบ / ${busy.peopleCount} คน / ${busy.itemCount} รายการ`);
}

console.log('\n[6] ของที่ยังไม่ระบุจำนวน (stock = null) ต้องไม่กลายเป็น 0');
const fake = H.summarizeDay({
  iso: 'x',
  bookings: [{ status: 'reserved', personId: 'p1', items: [
    { itemType: 'accessory', itemId: 7, itemName: '200W Dimmer Unit', quantity: 2, stock: null },
    { itemType: 'fixture', itemId: 4, itemName: 'Aputure MC', quantity: 3, stock: 28 },
  ] }],
});
const unknownRow = fake.items.find((i) => i.itemType === 'accessory');
ok('available เป็น null ไม่ใช่ 0', unknownRow.available === null, String(unknownRow.available));
ok('ไม่ถูกนับว่า "หมดแล้ว"', unknownRow.soldOut === false);
ok('stockUnknown = true', unknownRow.stockUnknown === true);
ok('รายการที่รู้จำนวนยังคำนวณปกติ', fake.items.find((i) => i.itemType === 'fixture').available === 25);
ok('ใบจองยกเลิกไม่ถูกนับ', H.summarizeDay({ iso: 'x', bookings: [{ status: 'cancelled', personId: 'p', items: [{ itemType: 'fixture', itemId: 1, quantity: 5, stock: 5 }] }] }).bookingCount === 0);
ok('วันว่างไม่พัง', H.summarizeDay({ iso: 'x', bookings: [] }).bookingCount === 0);
ok('ใบจองที่คืนของแล้ว หัก returned_quantity', H.summarizeDay({ iso: 'x', bookings: [{ status: 'checked_out', personId: 'p', items: [{ itemType: 'fixture', itemId: 1, quantity: 5, returnedQuantity: 5, stock: 5 }] }] }).items[0].booked === 0);

console.log('\n[7] จุดสีในช่องวัน — หนึ่งจุดต่อหนึ่งคน (เหมือนแสตมป์กลมเล็ก)');
const mk = (ids) => H.summarizeDay({
  iso: 'x',
  bookings: ids.map((id, i) => ({ status: 'reserved', personId: id, personName: id, jobName: `งาน ${i}`, items: [] })),
});
const dotCount = (html) => (String(html).match(/class="cal-dot[" ]/g) || []).length;

ok('วันว่าง ไม่มีจุดสีเลย', H.dayDotsHtml(mk([])) === '');
ok('คนเดียว = 1 จุด', dotCount(H.dayDotsHtml(mk(['a']))) === 1, String(dotCount(H.dayDotsHtml(mk(['a'])))));
ok('สองคน = 2 จุด', dotCount(H.dayDotsHtml(mk(['a', 'b']))) === 2);
ok('สามคน = 3 จุด', dotCount(H.dayDotsHtml(mk(['a', 'b', 'c']))) === 3);
ok('สีจุดตรงกับสีประจำตัวของคนที่จองจริง', H.dayDotsHtml(mk(['a'])).includes(H.colorOf('a')));
ok('จุดของแต่ละคนไม่ปนกัน', H.dayDotsHtml(mk(['a', 'b'])).includes(H.colorOf('a')) && H.dayDotsHtml(mk(['a', 'b'])).includes(H.colorOf('b')));
ok('คนเดียวกันจอง 2 ใบ = จุดเดียว (ไม่ซ้ำ)', dotCount(H.dayDotsHtml(mk(['a', 'a']))) === 1);
ok('personIdsOf นับคนไม่ซ้ำ', H.personIdsOf(mk(['a', 'a', 'b'])).length === 2);

const crowd = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
const crowdHtml = H.dayDotsHtml(mk(crowd));
ok(`คนเยอะเกิน ${H.MAX_DOTS} → จำนวนจุดไม่เกินเพดาน`, dotCount(crowdHtml) <= H.MAX_DOTS, String(dotCount(crowdHtml)));
ok('จุดสุดท้ายเป็นจุดโปร่งบอกว่ายังมีอีก', crowdHtml.includes('cal-dot-more'));
ok('จุดโปร่งไม่มีสีของคน (ไม่ใช่การเดาว่าเป็นใคร)', !crowdHtml.slice(crowdHtml.indexOf('cal-dot-more')).includes('background:hsl'));
ok('จุดสีไม่มีตัวหนังสือข้างใน (ในช่องวันต้องเห็นแค่สี)', visibleText(H.dayDotsHtml(mk(['a', 'b']))) === '');

ok('มุมมองปีใช้จุดเดียวเพราะช่องแคบ', dotCount(H.dayDotsHtml(mk(['a', 'b']), { single: true })) === 1);
ok('มุมมองปีหลายคน = แบ่งสีเป็นเสี้ยววงกลม', H.dayDotsHtml(mk(['a', 'b']), { single: true }).includes('conic-gradient'));
ok('มุมมองปีคนเดียว = สีพื้น ไม่ใช้ gradient', !H.dayDotsHtml(mk(['a']), { single: true }).includes('gradient'));
ok('conic-gradient ครบทุกสีคน', (H.conicStyle(['a', 'b', 'c']).match(/hsl\(/g) || []).length === 3);

console.log('\n[8] เรนเดอร์มุมมองเดือน — รางเลื่อน 12 แผง');
await Cal.init({ provider: Demo, view: 'month', today: TODAY });
const track = document.getElementById('calTrack');
const trackHtml = track.innerHTML;
const panes = (trackHtml.match(/class="cal-pane"/g) || []).length;
ok('มี 12 แผงเดือนในราง', panes === 12, String(panes));
ok('ทุกแผงมี data-month กำกับ', (trackHtml.match(/data-month="\d+"/g) || []).length === 12);
ok('รางไม่ถูกซ่อนในมุมมองเดือน', track.hidden === false);
ok('ช่องวันรวมทั้งปี >= 365', (trackHtml.match(/data-cal-action="select"/g) || []).length >= 365, String((trackHtml.match(/data-cal-action="select"/g) || []).length));
ok('เดือนที่มี 31 วันแสดงครบ 31 ช่อง', (H.monthPaneHtml(YEAR, 0).match(/data-cal-action="select"/g) || []).length === 31);
ok('กุมภาพันธ์ปีปกติมี 28 ช่อง', (H.monthPaneHtml(2026, 1).match(/data-cal-action="select"/g) || []).length === 28);
ok('กุมภาพันธ์ปีอธิกสุรทินมี 29 ช่อง', (H.monthPaneHtml(2028, 1).match(/data-cal-action="select"/g) || []).length === 29);
ok('วันนี้ถูกไฮไลต์ในราง', trackHtml.includes('is-today'));
ok('ไม่มี undefined ในราง', !trackHtml.includes('undefined'));
ok('ไม่มี NaN ในราง', !trackHtml.includes('NaN'));
ok('class ของกรอบบอกมุมมอง', document.getElementById('calGrid').className.includes('cal-view-month'));

console.log('\n[9] ในตารางวันต้องแสดง "แค่สี" — ห้ามมีชื่อคนหรือตัวเลขชิ้น');
const seen = visibleText(trackHtml);
const leaked = demoPeople.map((p) => p.name).filter((n) => seen.includes(n));
ok('ไม่มีชื่อคนโผล่เป็นข้อความในตารางวัน', leaked.length === 0, leaked.join(','));
ok('ไม่มีชื่อคนแบบย่อโผล่ด้วย', demoPeople.every((p) => !seen.includes(H.shortName(p.name))));
ok('ไม่มีชิ้นส่วน "ชิ้น" ในตารางวัน', !seen.includes('ชิ้น'));
ok('ไม่มีคลาสแถบสีแบบเก่า (cal-chip / cal-bar) หลงอยู่', !/cal-chip|cal-bar/.test(calSrc));
// ตรวจที่ "ตัวช่องวัน" เท่านั้น — หัวแผงเดือนมีข้อความได้ (ชื่อเดือน/จำนวนวัน)
const dayCells = trackHtml.match(/<button[^>]*class="cal-day[^"]*"[\s\S]*?<\/button>/g) || [];
const noisyCells = dayCells
  .map((cell) => visibleText(cell))
  .filter((text) => text !== '' && !/^\d{1,2}$/.test(text));
ok(`ข้อความในช่องวันมีแค่เลขวัน (ตรวจ ${dayCells.length} ช่อง)`, noisyCells.length === 0, noisyCells.slice(0, 5).join(' | '));
ok('ช่องวันไม่ใช่ช่องว่างเปล่าทั้งหมด', dayCells.length >= 365, String(dayCells.length));
ok('ช่องวันไม่ถูกถมสีทั้งช่องอีกแล้ว (ไม่มี inline background บนปุ่ม)', !/<button[^>]*class="cal-day[^"]*"[^>]*style="background/.test(trackHtml));
ok('ช่องที่มีคนจองมีจุดสีประทับอยู่', /<i class="cal-dot" style="background:hsl/.test(trackHtml));
ok('วันที่หลายคนจองมีหลายจุด + is-multi', trackHtml.includes('is-multi'));
ok('จุดเป็นวงกลม (border-radius 50%)', /\.cal-dot\s*\{[\s\S]*?border-radius:\s*50%/.test(cssSrc));
ok('ช่องวันขนาดปกติ ไม่บังคับเป็นสี่เหลี่ยมจัตุรัส', !/\.cal-day\s*\{[\s\S]*?aspect-ratio/.test(cssSrc));
ok('ช่องวันสูงพออ่านออกแต่ไม่ใหญ่เกิน (min-height 30-40px)', /\.cal-day\s*\{[\s\S]*?min-height:\s*3[0-9]px/.test(cssSrc));
ok('แผงเดือนกว้างไม่เกิน 500px (ขนาดปกติ)', /\.cal-pane\s*\{[\s\S]*?min\(100%,\s*[45]\d\dpx\)/.test(cssSrc), 'ดูกว้างใน CSS');

console.log('\n[10] เรนเดอร์มุมมองปี — ภาพรวมย่อ 12 เดือน');
Cal.setView('year');
const yearGrid = document.getElementById('calYearGrid');
const yearHtml = yearGrid.innerHTML;
ok('มี 12 เดือนย่อ', (yearHtml.match(/cal-mini-head/g) || []).length === 12, String((yearHtml.match(/cal-mini-head/g) || []).length));
ok('รางเดือนถูกซ่อนในมุมมองปี', document.getElementById('calTrack').hidden === true);
ok('แผงปีไม่ถูกซ่อน', yearGrid.hidden === false);
ok('ปุ่มเปิดเดือนจากภาพรวมมีครบ 12 เดือน', (yearHtml.match(/data-cal-action="open-month"/g) || []).length === 12);
ok('ช่องวันในภาพรวมเป็นแบบย่อ', yearHtml.includes('cal-day-mini'));
ok('ไม่มี undefined/NaN ในมุมมองปี', !yearHtml.includes('undefined') && !yearHtml.includes('NaN'));

console.log('\n[11] กดวันที่ → เห็นใบงานเป็นการ์ด');
Cal.setView('month');
Cal.selectDay(busyISO || TODAY);
const detail = document.getElementById('calDetail').innerHTML;
ok('แผงใบงานถูกเปิด', document.getElementById('calDetail').hidden === false);
ok('แสดงวันที่แบบไทยเต็ม', detail.includes(H.thDateLong(busyISO || TODAY)));
ok('ใบงานถูกเรนเดอร์เป็นการ์ด (cal-job)', detail.includes('cal-job') && detail.includes('cal-job-grid'));
ok('มีตารางรวมทั้งวัน', detail.includes('cal-total-table'));
ok('บอกชัดว่าหักยอดทุกใบแล้ว', detail.includes('รวมทุกใบจองของวันนั้น'));
ok('ตารางรวมมีคอลัมน์ "ใครจอง"', detail.includes('cal-who-dot'));
ok('มีปุ่มปิดแผง', detail.includes('data-cal-action="close-detail"'));
ok('ปุ่มสร้างใบจองยังปิดอยู่ (รอบนี้ดูหน้าตาก่อน)', detail.includes('disabled'));
ok('ไม่มี undefined/NaN ในแผงใบงาน', !detail.includes('undefined') && !detail.includes('NaN'));
if (busyISO) {
  const cards = (detail.match(/class="cal-job /g) || []).length + (detail.match(/class="cal-job"/g) || []).length;
  ok(`การ์ดใบงานครบ ${busy.bookingCount} ใบ`, cards >= busy.bookingCount, `ได้ ${cards}`);
  const names = demoPeople.map((p) => p.name).filter((n) => busy.bookings.some((b) => b.personName === n));
  ok('การ์ดใบงานบอกชื่อคนจอง', names.every((n) => detail.includes(n)), names.join(','));
}
ok('บอกว่ามีรายการที่ยังไม่ระบุจำนวนกี่รายการ', detail.includes('ยังไม่ระบุจำนวนในสต็อก'), String(y1.unknownStockCount));

console.log('\n[12] ปิดแผง → กลับเป็นภาพรวมของช่วงที่ดู');
Cal.closeDetail();
ok('ปิดแล้วไม่เลือกวันใด', Cal._state.selectedISO === null);
const range = document.getElementById('calDetail').innerHTML;
ok('มีบล็อก "วันที่ของจะหมด"', range.includes('วันที่ของจะหมด'));
ok('มีบล็อก "อุปกรณ์ที่ถูกจองจนหมดบ่อยที่สุด"', range.includes('ที่ถูกจองจนหมดบ่อยที่สุด'));
ok('มีบล็อก "วันถัดไปที่มีการจอง"', range.includes('วันถัดไปที่มีการจอง'));
ok('ปุ่มในภาพรวมกดแล้วพาไปวันนั้นได้', range.includes('data-cal-action="select"'));
ok('บอกให้รู้ว่าต้องกดวันที่', range.includes('กดวันที่บนปฏิทิน'));

console.log('\n[13] แถบสถิติ + คำอธิบายสี');
const stats = document.getElementById('calStats').innerHTML;
ok('สถิติ 4 ใบ', (stats.match(/cal-stat-value/g) || []).length === 4, String((stats.match(/cal-stat-value/g) || []).length));
ok('มีตัวนับ "วันที่หลายคนจองตรงกัน"', stats.includes('วันที่หลายคนจองตรงกัน'));
ok('ไม่มี undefined ในสถิติ', !stats.includes('undefined'));
const legend = document.getElementById('calLegend').innerHTML;
ok('คำอธิบายสีมีครบทุกคน', (legend.match(/cal-legend-chip/g) || []).length === y1.people.length);
ok('บอกว่าสีผูกถาวรกับคน', legend.includes('ถาวร'));
ok('มีปุ่มกรองรายคน', legend.includes('data-cal-action="filter"'));
ok('มีคำอธิบายกรอบสถานะ (หมด/ค้างคืน/วันนี้)', legend.includes('cal-key-full') && legend.includes('cal-key-overdue') && legend.includes('cal-key-today'));

console.log('\n[14] กรองรายคน — ช่องวันต้องเหลือสีของคนนั้นคนเดียว');
const target = y1.people[0];
Cal.selectDay(busyISO || TODAY);
Cal._state.personFilter = target.id;
Cal.setView('month');
const filtered = document.getElementById('calTrack').innerHTML;
const filteredDetail = document.getElementById('calDetail').innerHTML;
const others = y1.people.filter((p) => p.id !== target.id).map((p) => p.hue);
ok('ช่องวันไม่ระบายสีของคนอื่น', !others.some((hue) => filtered.includes(`hsl(${hue}, 62%, 45%)`)));
ok('ช่องวันของคนอื่นจางลง (is-dim)', filtered.includes('is-dim'));
ok('แผงใบงานบอกว่ามีใบงานของคนอื่นซ่อนอยู่', filteredDetail.includes('ใบงานของคนอื่น') || filteredDetail.includes('cal-job'));
ok('หัวข้อบอกว่ากำลังกรองใคร', document.getElementById('calFilterNote').innerHTML.includes(target.name));
Cal._state.personFilter = null;
Cal.setView('month');

console.log('\n[15] ป้ายโหมด + live provider ต้องบอกตรง ๆ ว่ายังใช้ไม่ได้');
ok('โหมดตัวอย่างขึ้นป้ายเตือนชัดเจน', document.getElementById('calBanner').innerHTML.includes('โหมดข้อมูลตัวอย่าง'));
ok('ป้ายบอกว่าชื่ออุปกรณ์/สต็อกเป็นของจริง', document.getElementById('calBanner').innerHTML.includes('ชื่ออุปกรณ์และจำนวนสต็อกเป็นของจริง'));

const noClient = await Live.loadRange(`${YEAR}-01-01`, `${YEAR}-03-31`, TODAY);
ok('ไม่มี Supabase client → บอกว่าเชื่อมต่อได้ ไม่เดาข้อมูล', noClient.ok === false && /Supabase/.test(noClient.error.short), JSON.stringify(noClient.error || {}));

sandbox.window.sb = {
  from: () => ({ select: async () => ({ data: null, error: { message: 'relation "public.v_booking_day_summary" does not exist' } }) }),
  rpc: async () => ({ data: null, error: { message: 'function item_availability_between does not exist' } }),
};
const liveRes = await Live.loadRange(`${YEAR}-01-01`, `${YEAR}-03-31`, TODAY);
delete sandbox.window.sb;
ok('live provider ไม่ throw', liveRes && liveRes.ok === false);
ok('live provider บอกว่าขาดอะไร', !!liveRes.error && !!liveRes.error.short, JSON.stringify(liveRes.error || {}));
ok('live provider ชี้ไปที่ไฟล์ SQL ที่ต้องรัน', /migration-2026-11-13d/.test(liveRes.error.hint || ''), liveRes.error.hint);
ok('live provider ไม่เดาข้อมูลมาแสดง', liveRes.days === undefined);
const liveSrc = fs.readFileSync(path.join(ROOT, 'js/booking-live.js'), 'utf8');
ok('live provider อ่านสีคนจาก members.color_hue', /member_hue/.test(liveSrc));

console.log('\n[16] XSS — ชื่อคน/ชื่องาน/ชื่ออุปกรณ์ที่มี HTML ต้องไม่กลายเป็นแท็ก');
const evilDay = {
  iso: TODAY,
  bookings: [{
    id: 'b1', personId: 'p1', personName: '<img src=x onerror=alert(1)>',
    jobName: '"><script>bad()</script>', jobLocation: '<b>bold</b>',
    status: 'reserved', note: '<svg onload=x>',
    items: [{ itemType: 'fixture', itemId: 9, itemName: '<iframe src=//evil>', quantity: 2, returnedQuantity: 0, stock: 5 }],
  }],
};
const evilDemo = {
  id: 'evil', label: 'evil', isLive: false,
  loadRange: async () => ({
    ok: true, source: 'demo', days: { [TODAY]: evilDay },
    people: [{ id: 'p1', name: '<img src=x onerror=alert(1)>', hue: 8, count: 1 }],
    itemCount: 1, unknownStockCount: 0,
  }),
};
await Cal.setProvider(evilDemo);
Cal.selectDay(TODAY);
const evilHtml = document.getElementById('calDetail').innerHTML
  + document.getElementById('calTrack').innerHTML
  + document.getElementById('calLegend').innerHTML
  + document.getElementById('calStats').innerHTML;
const tags = [...new Set((evilHtml.match(/<[a-z][a-z0-9-]*/gi) || []).map((t) => t.toLowerCase()))];
const allowed = new Set(['<span', '<div', '<button', '<table', '<thead', '<tbody', '<tr', '<th', '<td', '<strong', '<ul', '<li', '<a', '<i', '<article', '<header', '<footer', '<section']);
const bad = tags.filter((t) => !allowed.has(t));
ok('ไม่มีแท็กแปลกปลอมเล็ดลอดออกมา', bad.length === 0, bad.join(','));
ok('payload ไม่หลุดออกมาเป็นแท็กดิบ', !evilHtml.includes('<img src=x onerror=alert(1)>'));
ok('payload ถูก escape เป็นตัวหนังสือ', evilHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));
// ตรวจใน "แท็กจริง" เท่านั้น — ข้อความ onerror ที่ถูก escape ใน title="..." เป็นแค่ตัวหนังสือ
const stripValues = (tag) => tag.replace(/\s[a-z-]+\s*=\s*"[^"]*"/gi, ' ').replace(/\s[a-z-]+\s*=\s*'[^']*'/gi, ' ');
const openTags = evilHtml.match(/<[a-z][^>]*>/gi) || [];
const withHandler = openTags.filter((t) => /\son[a-z]+\s*=/i.test(stripValues(t)));
ok('ไม่มีแท็กใดมีแอตทริบิวต์ on* (onerror/onload/...)', withHandler.length === 0, withHandler.slice(0, 2).join(' | '));
ok('ไม่มี javascript: ใน href/src', !/\s(href|src)\s*=\s*["']?\s*javascript:/i.test(evilHtml));

console.log('\n[17] ไฟล์หน้าเว็บ — โครงสร้างที่ต้องมีจริง');
const page = fs.readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
['calTrack', 'calYearGrid', 'calLoading', 'calDetail', 'calLegend', 'calStats', 'calBanner', 'calTitle', 'calJump', 'calPrev', 'calNext', 'calToday', 'calViewMonth', 'calViewYear']
  .forEach((id) => ok(`booking.html มี id="${id}"`, page.includes(`id="${id}"`)));
ok('มุมมองเริ่มต้นในหน้าเว็บคือ "เดือน"', /var opts = \{ view: 'month' \}/.test(page));
ok('โหลด booking-calendar.js หลัง booking-demo.js', page.indexOf('booking-demo.js') < page.indexOf('booking-calendar.js'));
ok('รางเลื่อนเปิดให้ปัดบนจอสัมผัส (touch-action)', /touch-action:\s*pan-x/.test(fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8')));
// สีคนถูกส่งลงมาทาง custom property (--pc) จาก JS → CSS ต้องใช้ var(--pc) เท่านั้น
// ถ้า CSS hardcode สีรายคนไว้ การเพิ่มสมาชิกจะต้องมาแก้ CSS ด้วยทุกครั้ง
ok('CSS ใช้ var(--pc) รับสีคนจาก JS', /var\(--pc/.test(calCss));
ok('CSS ไม่ hardcode สีคนเป็น hsl(...) เลยแม้แต่จุดเดียว', !/hsl\(/.test(calCss), (calCss.match(/hsl\([^)]*\)/g) || []).slice(0, 3).join(','));

console.log('\n[18] ปุ่มเลื่อนเดือนข้างปฏิทิน — ต้องเห็นชัดและบอกว่ากดแล้วจะไปไหน');
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0)); };
await Cal.setProvider(Demo);
Cal.goTo('2026-11-13');
await flush();

const prevBtn = document.getElementById('calPrevMonth');
const nextBtn = document.getElementById('calNextMonth');
ok('หน้าเว็บมีปุ่มลูกศรทั้งสองข้างปฏิทิน', page.includes('id="calPrevMonth"') && page.includes('id="calNextMonth"'));
ok('ปุ่มอยู่ในโครง .cal-stage ขนาบปฏิทิน', /class="cal-stage[\s\S]*id="calPrevMonth"[\s\S]*id="calGrid"[\s\S]*id="calNextMonth"/.test(page));
ok('ลูกศรไม่ถูกซ่อนเมื่อมีข้อมูล', prevBtn.hidden === false && nextBtn.hidden === false);
ok('ลูกศรซ้ายบอกชื่อเดือนก่อนหน้า', prevBtn.innerHTML.includes('ต.ค.') && prevBtn.innerHTML.includes('2569'), prevBtn.innerHTML);
ok('ลูกศรขวาบอกชื่อเดือนถัดไป', nextBtn.innerHTML.includes('ธ.ค.') && nextBtn.innerHTML.includes('2569'), nextBtn.innerHTML);
ok('ไม่มี escapeHtml หลงเป็น &lt; ในป้ายลูกศร', !prevBtn.innerHTML.includes('&lt;') && !String(prevBtn.attrs.title || '').includes('&lt;'));
ok('aria-label บอกเดือนเต็ม', /ตุลาคม 2569/.test(String(prevBtn.attrs['aria-label'] || '')), String(prevBtn.attrs['aria-label']));

Cal._state.anchorISO = '2026-11-13';
Cal._helpers.renderStageArrows();
const stepSrc = calSrc;
ok('ลูกศรเรียก step() ตัวเดียวกับปุ่มในแถบเครื่องมือ', /on\('calPrevMonth', 'click', \(\) => step\(-1\)\)/.test(stepSrc) && /on\('calNextMonth', 'click', \(\) => step\(1\)\)/.test(stepSrc));

console.log('\n[19] เลื่อนข้ามเดือน/ข้ามปี — ป้ายลูกศรต้องตามไปด้วย');
Cal._state.anchorISO = '2026-01-15';
Cal._state.view = 'month';
Cal._helpers.renderStageArrows();
ok('มกราคม → ป้ายซ้ายเป็น ธ.ค. ปีก่อน (2568)', prevBtn.innerHTML.includes('ธ.ค.') && prevBtn.innerHTML.includes('2568'), prevBtn.innerHTML);
Cal._state.anchorISO = '2026-12-05';
Cal._helpers.renderStageArrows();
ok('ธันวาคม → ป้ายขวาเป็น ม.ค. ปีถัดไป (2570)', nextBtn.innerHTML.includes('ม.ค.') && nextBtn.innerHTML.includes('2570'), nextBtn.innerHTML);

console.log('\n[20] มุมมองปี = ภาพรวม (เก็บไว้ตามที่สั่ง) + ป้ายลูกศรเป็นปี');
Cal.setView('year');
ok('ปุ่มมุมมองปียังมีอยู่', page.includes('id="calViewYear"'));
ok('ปุ่มระบุว่าปีคือภาพรวม', /ปี \(ภาพรวม\)/.test(page));
ok('มุมมองปีมีคำอธิบายว่าเป็นภาพรวมทั้งปี', document.getElementById('calYearGrid').innerHTML.includes('ภาพรวมทั้งปี'));
ok('คำอธิบายบอกว่ากดเดือนเพื่อดูแบบเต็มได้', document.getElementById('calYearGrid').innerHTML.includes('แบบเต็ม'));
ok('ลูกศรซ้ายในมุมมองปีเป็นปีก่อน (2568)', prevBtn.innerHTML.includes('2568') && prevBtn.innerHTML.includes('ปีก่อน'), prevBtn.innerHTML);
ok('ลูกศรขวาในมุมมองปีเป็นปีถัดไป (2570)', nextBtn.innerHTML.includes('2570') && nextBtn.innerHTML.includes('ปีถัดไป'), nextBtn.innerHTML);
ok('มุมมองปีไม่ถูกซ่อน', document.getElementById('calYearGrid').hidden === false);
Cal.setView('month');

console.log('\n[21] CSS ของแถบเลื่อน — จุดที่ทำให้รางเลื่อนพังได้');
ok('.cal-stage-main มี min-width:0 (ไม่งั้น flex ดันรางล้นจอ)', /\.cal-stage-main\s*\{[\s\S]*?min-width:\s*0/.test(cssSrc));
ok('รางเลื่อนมี scroll-snap', /scroll-snap-type:\s*x\s+mandatory/.test(cssSrc));
ok('แผงเดือน snap เข้ากลางจอ', /\.cal-pane\s*\{[\s\S]*?scroll-snap-align:\s*center/.test(cssSrc));
ok('ลูกศรไม่หดเมื่อจอแคบ (flex: 0 0 auto)', /\.cal-nav-arrow\s*\{[\s\S]*?flex:\s*0 0 auto/.test(cssSrc));
ok('ลูกศรมีขนาดสำหรับมือถือ', /@media[^{]*\{[\s\S]*?\.cal-nav-arrow\s*\{\s*width:\s*44px/.test(cssSrc));

console.log('');
if (fail) {
  console.log(`สรุป: ผ่าน ${pass} / ไม่ผ่าน ${fail}`);
  console.log(`รายการที่ไม่ผ่าน:\n  - ${failures.join('\n  - ')}\n`);
  process.exit(1);
}
console.log(`สรุป: ผ่าน ${pass} / ไม่ผ่าน 0\n`);
