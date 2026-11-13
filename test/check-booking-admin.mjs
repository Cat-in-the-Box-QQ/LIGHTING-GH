// test/check-booking-admin.mjs
// ---------------------------------------------------------------------------
// ตรวจแผงจัดการใบจองของ admin (js/booking-admin.js + แผงใน admin.html)
//
// ที่ต้องเรนเดอร์จริงใน DOM ปลอม: แผงนี้มี "ปุ่มที่เขียนข้อมูลลงฐานข้อมูล"
// (รับของ / ปักค้างคืน / คืนครบ / ยกเลิก / แก้จำนวน) ถ้าโชว์ปุ่มผิดสถานะ
// หรือยิง payload ผิด ของจะหายหรือสต็อกจะเพี้ยนโดยไม่มีใครรู้
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(extra === undefined ? label : `${label} → ${extra}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- DOM จำลอง -------------------------------------------------------------
class El {
  constructor(id) {
    this.id = id || '';
    this.tagName = 'DIV';
    this.children = [];
    this._l = {};
    this._q = new Map();
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.className = '';
    this._html = '';
    this.textContent = '';
    this.parentNode = null;
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
    };
  }

  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  querySelector(s) { if (!this._q.has(s)) this._q.set(s, new El()); return this._q.get(s); }
  querySelectorAll(s) {
    const m = /^\[([a-zA-Z-]+)\]$/.exec(String(s).trim());
    if (!m) return [];
    const attr = m[1];
    const walk = (e) => e.children.reduce((a, c) => a.concat(c.getAttribute(attr) !== null ? [c] : [], walk(c)), []);
    return walk(this);
  }
  closest() { return null; }
  fire(t, ev) { (this._l[t] || []).forEach((f) => f(ev)); }
}

// ---- ข้อมูลปลอม -----------------------------------------------------------
const TODAY = '2026-11-13';
const MEMBERS = [
  { id: 'm1', code: 'ADMIN01', full_name: 'zombe.jpm', role: 'admin', active: true, color_hue: 0 },
  { id: 'm2', code: 'M002', full_name: 'สมชาย ใจดี', role: 'crew', active: true, color_hue: 137 },
];
const BOOKINGS = [
  { id: 'b1', member_id: 'm2', job_name: 'ถ่ายโฆษณา A', job_location: 'สตูดิโอ 2', booking_date: TODAY, status: 'reserved', group_ref: null, note: '', created_at: '', updated_at: '' },
  { id: 'b2', member_id: 'm1', job_name: 'งานแต่งงาน', job_location: 'โรงแรม X', booking_date: '2026-11-15', status: 'checked_out', group_ref: null, note: 'รับของ 18:00', created_at: '', updated_at: '' },
  { id: 'b3', member_id: 'm2', job_name: 'งานเก่าค้าง', job_location: '', booking_date: '2026-11-01', status: 'overdue', group_ref: null, note: '', created_at: '', updated_at: '' },
  { id: 'b4', member_id: 'm1', job_name: 'งานที่ยกเลิก', job_location: '', booking_date: '2026-11-20', status: 'cancelled', group_ref: null, note: '', created_at: '', updated_at: '' },
];
const ITEMS = [
  { id: 'i1', booking_id: 'b1', item_type: 'fixture', item_id: 1, quantity: 4, returned_quantity: 0, note: '' },
  { id: 'i2', booking_id: 'b1', item_type: 'accessory', item_id: 3, quantity: 2, returned_quantity: 0, note: '' },
  { id: 'i3', booking_id: 'b3', item_type: 'fixture', item_id: 2, quantity: 1, returned_quantity: 0, note: '' },
  { id: 'i4', booking_id: 's1', item_type: 'fixture', item_id: 1, quantity: 3, returned_quantity: 1, note: '' },
];
const STALE = [
  { id: 's1', booking_date: '2026-11-05', days_past: 8, status: 'reserved', job_name: 'งานเก่า', member_code: 'M002', member_name: 'สมชาย ใจดี', item_count: 1, job_location: 'ต่างจังหวัด', member_hue: 137, qty_outstanding: 2 },
];
const AHEAD = [
  { day: TODAY, booking_count: 1, overdue_count: 0, booked_items: 2, sold_out_items: 0 },
  { day: '2026-11-14', booking_count: 0, overdue_count: 0, booked_items: 0, sold_out_items: 0 },
  { day: '2026-11-15', booking_count: 1, overdue_count: 1, booked_items: 1, sold_out_items: 1 },
  { day: '2026-11-16', booking_count: 0, overdue_count: 1, booked_items: 0, sold_out_items: 0 },
  { day: '2026-11-17', booking_count: 0, overdue_count: 0, booked_items: 0, sold_out_items: 0 },
  { day: '2026-11-18', booking_count: 0, overdue_count: 0, booked_items: 0, sold_out_items: 0 },
  { day: '2026-11-19', booking_count: 0, overdue_count: 0, booked_items: 0, sold_out_items: 0 },
];
const UNKNOWN = [
  { item_type: 'accessory', item_id: 7, item_name: 'Cable ไม่ระบุจำนวน' },
  { item_type: 'fixture', item_id: 55, item_name: 'Old Fresnel' },
];

function makeSb(opts = {}) {
  const calls = [];
  const o = {
    bookings: BOOKINGS, stale: STALE, ahead: AHEAD, members: MEMBERS, items: ITEMS,
    unknown: UNKNOWN, settle: 1, fail: null, rpcFail: null, ...opts,
  };

  function settleResult(table, f) {
    calls.push({ table, ...f });
    if (o.fail && o.fail(table, f)) return { data: null, error: o.fail(table, f), count: null };

    if (f.update) return { data: f.select ? [{ id: 'x', status: 'ok' }] : null, error: null, count: null };
    if (table === 'bookings' && f.head) {
      return { data: null, error: null, count: o.bookings.filter((b) => b.status === 'overdue').length };
    }
    if (table === 'bookings') {
      let rows = o.bookings;
      if (f.gte) rows = rows.filter((b) => String(b.booking_date) >= String(f.gte[1]));
      if (f.lte) rows = rows.filter((b) => String(b.booking_date) <= String(f.lte[1]));
      if (f.lt) rows = rows.filter((b) => String(b.booking_date) < String(f.lt[1]));
      if (f.neq) rows = rows.filter((b) => String(b[f.neq[0]]) !== String(f.neq[1]));
      if (f.or) {
        // รองรับรูป "booking_date.gte.<วัน>,status.eq.overdue" ที่เว็บยิงจริง
        const parts = String(f.or).split(',').map((p) => {
          const bits = p.split('.');
          return { col: bits[0], op: bits[1], val: bits.slice(2).join('.') };
        });
        rows = rows.filter((b) => parts.some((q) => {
          const v = String(b[q.col] === undefined ? '' : b[q.col]);
          if (q.op === 'gte') return v >= String(q.val);
          if (q.op === 'lte') return v <= String(q.val);
          if (q.op === 'eq') return v === String(q.val);
          return false;
        }));
      }
      return { data: rows.map((b) => ({ ...b })), error: null, count: null };
    }
    if (table === 'v_booking_stale') return { data: o.stale.map((b) => ({ ...b })), error: null, count: null };
    if (table === 'members') return { data: o.members.map((b) => ({ ...b })), error: null, count: null };
    if (table === 'booking_items') {
      const ids = f.in ? f.in[1] : null;
      const rows = Array.isArray(ids) ? o.items.filter((it) => ids.includes(String(it.booking_id))) : o.items;
      return { data: rows.map((b) => ({ ...b })), error: null, count: null };
    }
    if (table === 'v_item_stock') return { data: o.unknown.map((b) => ({ ...b })), error: null, count: null };
    return { data: [], error: null, count: null };
  }

  function builder(table, f = {}) {
    const api = {
      select: (cols, opt) => builder(table, { ...f, cols, head: !!(opt && opt.head) }),
      gte: (c, v) => builder(table, { ...f, gte: [c, v] }),
      lte: (c, v) => builder(table, { ...f, lte: [c, v] }),
      eq: (c, v) => builder(table, { ...f, eq: [c, v] }),
      neq: (c, v) => builder(table, { ...f, neq: [c, v] }),
      or: (expr) => builder(table, { ...f, or: expr }),
      lt: (c, v) => builder(table, { ...f, lt: [c, v] }),
      in: (c, v) => builder(table, { ...f, in: [c, v] }),
      is: (c, v) => builder(table, { ...f, is: [c, v] }),
      order: () => builder(table, f),
      limit: () => builder(table, f),
      update: (patch) => builder(table, { ...f, update: patch }),
      then: (res, rej) => Promise.resolve(settleResult(table, f)).then(res, rej),
    };
    return api;
  }

  return {
    calls,
    opts: o,
    from: (t) => builder(t, {}),
    rpc: async (name, args) => {
      calls.push({ rpc: name, args });
      if (o.rpcFail && o.rpcFail(name)) return { data: null, error: o.rpcFail(name) };
      if (name === 'booking_day_flags_between') return { data: o.ahead.map((r) => ({ ...r })), error: null };
      if (name === 'settle_booking') return { data: o.settle, error: null };
      if (name === 'biz_today') return { data: TODAY, error: null };
      return { data: null, error: null };
    },
  };
}

function makeSandbox(sbOpts = {}, extra = {}) {
  const ids = {};
  ['bookingAdminPanel', 'bookingAdminBody', 'bookingAdminSummary'].forEach((k) => { ids[k] = new El(k); });
  const confirmCalls = [];
  const win = {
    sb: sbOpts === null ? undefined : makeSb(sbOpts),
    confirm: (msg) => { confirmCalls.push(msg); return extra.confirmResult === undefined ? true : extra.confirmResult; },
    BookingStore: {
      isReady: () => extra.storeReady !== false,
      get: (t, id) => ({ itemType: t, itemId: id, itemName: `${t === 'accessory' ? 'อุปกรณ์เสริม' : 'อุปกรณ์'} #${id}` }),
      unknownStockItems: () => (extra.storeUnknown === undefined
        ? [{ itemType: 'accessory', itemId: 7, itemName: 'Cable ไม่ระบุจำนวน' },
          { itemType: 'fixture', itemId: 55, itemName: 'Old Fresnel' }]
        : extra.storeUnknown).map((r) => ({ ...r })),
      load: (opt) => { (win.__storeLoads = win.__storeLoads || []).push(opt); return Promise.resolve(); },
    },
    BookingLiveProvider: { bizToday: async () => TODAY, resetCache: () => { win.__cacheReset = (win.__cacheReset || 0) + 1; } },
    BookingCalendar: { refresh: () => { win.__calRefresh = (win.__calRefresh || 0) + 1; } },
    document: {
      getElementById: (id) => (Object.prototype.hasOwnProperty.call(ids, id) ? ids[id] : null),
      createElement: () => new El(),
      body: new El('body'),
    },
    console,
    setTimeout: (fn) => { try { fn(); } catch (e) { /* ไม่ต้องรอ */ } return 0; },
  };
  win.window = win;
  win.__ids = ids;
  win.__confirmCalls = confirmCalls;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/booking-admin.js'), 'utf8'), ctx, { filename: 'booking-admin.js' });
  return win;
}

const bodyOf = (win) => win.__ids.bookingAdminBody.innerHTML;

// ===========================================================================
console.log('\n[1] ตัวช่วยบริสุทธิ์ — วันที่ไทย, ย้ายวัน, ชื่อสถานะ, แปล error');
{
  const win = makeSandbox();
  const I = win.BookingAdmin._internals;
  ok('วันที่ไทยแบบย่อ + พ.ศ. 2 หลัก', I.thDateShort('2026-11-13') === '13 พ.ย. 69', I.thDateShort('2026-11-13'));
  ok('ข้ามเดือน/ปีได้ถูกต้อง', I.thDateShort(I.shiftISO('2026-12-31', 1)) === '1 ม.ค. 70', I.shiftISO('2026-12-31', 1));
  ok('วันอธิกสุรทินไม่เพี้ยน (2024 เป็นปีอธิกสุรทิน)', I.shiftISO('2024-02-28', 1) === '2024-02-29', I.shiftISO('2024-02-28', 1));
  ok('ปีปกติ 28 ก.พ. -> 1 มี.ค.', I.shiftISO('2026-02-28', 1) === '2026-03-01', I.shiftISO('2026-02-28', 1));
  ok('แปลสถานะเป็นไทยครบ 4 สถานะ', I.statusTh('reserved') === 'จองไว้' && I.statusTh('checked_out') === 'จ่ายของแล้ว'
    && I.statusTh('overdue') === 'ค้างคืน' && I.statusTh('cancelled') === 'ยกเลิก');
  ok('สถานะที่ไม่รู้จักไม่เดา', I.statusTh('weird') === 'weird');
  ok('ตารางหาย -> ชี้ไปที่ไฟล์ migration ทั้งสอง', /migration-2026-11-13d/.test(I.describeError({ message: 'relation "public.v_booking_stale" does not exist' }))
    && /-13e-booking-admin/.test(I.describeError({ message: 'relation "x" does not exist' })));
  ok('ฟังก์ชันหาย -> ชี้ไปที่ migration', /migration/.test(I.describeError({ message: 'function settle_booking does not exist' })));
  ok('ไม่มีสิทธิ์ -> บอกว่าเป็นแผงของ admin', /admin/.test(I.describeError({ message: 'permission denied for table bookings' })));
  ok('เซสชันหมดอายุ -> บอกให้ sign in ใหม่', /sign in/.test(I.describeError({ message: 'JWT expired' })));
  ok('error อื่นโชว์ตามจริง ไม่แต่งเรื่อง', I.describeError({ message: 'network down' }) === 'network down');
}

console.log('\n[2] โหลดข้อมูล — ยิง query แยกกันและประกอบเป็นแผง');
const W = makeSandbox();
await W.BookingAdmin.init();
{
  const stt = W.BookingAdmin.status();
  ok('โหลดสำเร็จ', stt.ready === true, JSON.stringify(stt));
  ok('ได้ใบจองมาครบ (วันนี้/ล่วงหน้า + ใบที่ค้างคืนจากอดีต)', stt.bookings === 4, String(stt.bookings));
  ok('ขอบเขต "วันนี้และล่วงหน้า" รวมใบค้างคืนไว้ด้วย (ไม่งั้น admin มองไม่เห็นของที่ยังไม่กลับ)',
    /status\.eq\.overdue/.test(String((W.sb.calls.find((c) => c.table === 'bookings' && c.or) || {}).or || '')),
    String((W.sb.calls.find((c) => c.table === 'bookings') || {}).or));
  ok('ได้คิวต้องตรวจ 1 ใบ', stt.stale === 1, String(stt.stale));
  ok('นับรายการที่ยังไม่ระบุจำนวนได้', stt.unknown === 2, String(stt.unknown));
  ok('นับใบที่ค้างคืนจาก count query', stt.counts.overdue === 1, String(stt.counts.overdue));
  ok('รู้ "วันนี้" จากฐานข้อมูล ไม่ใช่จากนาฬิกาเครื่อง', W.BookingAdmin._state.todayISO === TODAY, W.BookingAdmin._state.todayISO);

  const tables = W.sb.calls.map((c) => c.table || c.rpc).filter(Boolean);
  ok('อ่านใบจองจากตาราง bookings', tables.includes('bookings'));
  ok('อ่านคิวจาก v_booking_stale', tables.includes('v_booking_stale'));
  ok('อ่านสมาชิกเพื่อเอาสีประจำตัว', tables.includes('members'));
  ok('อ่านรายการของจาก booking_items', tables.includes('booking_items'));
  ok('ยอดล่วงหน้ามาจาก booking_day_flags_between', tables.includes('booking_day_flags_between'));
  ok('ไม่เขียนอะไรเลยตอนโหลด', !W.sb.calls.some((c) => c.update), JSON.stringify(W.sb.calls.filter((c) => c.update)));

  const itemsCall = W.sb.calls.find((c) => c.table === 'booking_items');
  ok('รายการของถูกกรองด้วย id ของใบจองที่โหลดมาเท่านั้น (ไม่ดึงทั้งตาราง)',
    Array.isArray(itemsCall.in[1]) && itemsCall.in[1].includes('b1') && itemsCall.in[1].includes('s1'),
    JSON.stringify(itemsCall && itemsCall.in));
}

console.log('\n[3] เรนเดอร์ — สถิติ คิว และตารางใบจอง');
{
  const html = bodyOf(W);
  ok('มีการ์ดสถิติ 4 ใบ', (html.match(/bkad-stat /g) || []).length === 4, String((html.match(/bkad-stat /g) || []).length));
  ok('ตัวเลขในสถิติมาจากฐานข้อมูล', html.includes('รายการที่ยังไม่ระบุจำนวน = จองไม่ได้'));
  ok('มีคิวต้องตรวจ', html.includes('คิวต้องตรวจ'));
  ok('อธิบายว่าทำไมต้องมีคิวนี้', html.includes('ของไม่กลับมาจริง') && html.includes('ระบบไม่มีทางรู้เอง'));
  ok('คิวบอกเลยว่าผ่านมากี่วัน', html.includes('8 วัน'), html.slice(0, 0));
  ok('คิวบอกยอดที่ยังไม่คืน', html.includes('คงค้าง 2 ชิ้น'));
  ok('มีตารางใบจอง', html.includes('bkad-table'));
  ok('มีแท็บกรองสถานะ', html.includes('data-bkad="status"') && html.includes('ทุกสถานะ'));
  ok('มีแท็บสลับช่วงวันนี้/ย้อนหลัง', html.includes('data-bkad="scope"'));
  ok('แสดงยอด 7 วันข้างหน้า', (html.match(/bkad-ahead-cell/g) || []).length === 7, String((html.match(/bkad-ahead-cell/g) || []).length));
  ok('ไม่มี undefined/NaN หลุดออกมา', !html.includes('undefined') && !html.includes('NaN'));
}

console.log('\n[4] ปุ่มต้องโผล่ตามสถานะ — ผิดสถานะคือของหายหรือสต็อกเพี้ยน');
{
  const html = bodyOf(W);
  const rowOf = (jobName) => {
    const rows = html.split('<tr').filter((r) => r.includes(jobName));
    return rows[0] || '';
  };
  const reserved = rowOf('ถ่ายโฆษณา A');
  const out = rowOf('งานแต่งงาน');
  const overdue = rowOf('งานเก่าค้าง');
  const cancelled = rowOf('งานที่ยกเลิก');

  ok('reserved -> มีปุ่ม รับของ', reserved.includes('data-bkad="checkout"'), reserved.slice(0, 80));
  ok('reserved -> มีปุ่ม ค้างคืน', reserved.includes('data-bkad="overdue"'));
  ok('reserved -> ไม่มีปุ่ม คืนครบแล้ว (ยังไม่เคยจ่ายของ)', !reserved.includes('data-bkad="settle"'));
  ok('reserved -> ยกเลิกและแก้ไขได้', reserved.includes('data-bkad="cancel"') && reserved.includes('data-bkad="edit"'));

  ok('checked_out -> ไม่มีปุ่ม รับของ ซ้ำ', !out.includes('data-bkad="checkout"'));
  ok('checked_out -> ปักค้างคืนได้', out.includes('data-bkad="overdue"'));

  ok('overdue -> มีปุ่ม คืนครบแล้ว', overdue.includes('data-bkad="settle"'));
  ok('overdue -> ไม่มีปุ่ม ค้างคืน ซ้ำ', !overdue.includes('data-bkad="overdue"'));
  ok('overdue -> อธิบายว่าปุ่มคืนครบทำอะไร', overdue.includes('ปลดสถานะค้างคืน'));

  ok('cancelled -> ไม่มีปุ่มเขียนใด ๆ เหลือ', !cancelled.includes('data-bkad="checkout"') && !cancelled.includes('data-bkad="cancel"')
    && !cancelled.includes('data-bkad="settle"') && !cancelled.includes('data-bkad="edit"'));
  ok('cancelled -> บอกว่าของกลับเข้าคลังทั้งหมด', cancelled.includes('ยกเลิกแล้ว'));
  ok('สถานะถูกทำป้ายให้แยกออก', html.includes('bkad-status is-reserved') && html.includes('bkad-status is-overdue'));
}

console.log('\n[5] สีประจำตัวคนจองต้องมาจาก members.color_hue');
{
  const html = bodyOf(W);
  ok('จุดสีของ crew ใช้ hue 137', html.includes('background:hsl(137,62%,45%)'), (html.match(/background:hsl\([^)]*\)/g) || []).join(' '));
  ok('จุดสีของ admin ใช้ hue 0', html.includes('background:hsl(0,62%,45%)'));
  ok('แสดงชื่อคนจอง', html.includes('สมชาย ใจดี'));
}

console.log('\n[6] คิวว่าง / ใบจองว่าง ต้องบอกให้ชัด ไม่ใช่โชว์ตารางเปล่า');
{
  const W2 = makeSandbox({ stale: [], bookings: [] });
  await W2.BookingAdmin.init();
  const html = bodyOf(W2);
  ok('คิวว่าง -> บอกว่าของกลับคลังครบ', html.includes('ของทุกใบกลับคลังครบ'), html.slice(0, 120));
  ok('ไม่มีใบจอง -> บอกว่าไปสร้างได้ที่หน้าปฏิทิน', html.includes('ยังไม่มีใบจองในช่วงนี้') && html.includes('ปฏิทินจอง'));
}

console.log('\n[7] รับของ / ปักค้างคืน / ยกเลิก — ยิง payload ถูกต้อง');
{
  const W3 = makeSandbox();
  await W3.BookingAdmin.init();
  W3.sb.calls.length = 0;
  await W3.BookingAdmin.setStatus('b1', 'checked_out');
  const upd = W3.sb.calls.find((c) => c.update);
  ok('รับของ -> update bookings', !!upd && upd.table === 'bookings', JSON.stringify(W3.sb.calls.map((c) => c.table)));
  ok('payload มีแค่ status (ไม่ไปแตะคอลัมน์อื่น)', upd && eq(Object.keys(upd.update), ['status']), JSON.stringify(upd && upd.update));
  ok('status = checked_out', upd && upd.update.status === 'checked_out');
  ok('กรองด้วย id ของใบที่กด', upd && eq(upd.eq, ['id', 'b1']));
  ok('ขึ้นข้อความสำเร็จเป็นภาษาไทย', W3.BookingAdmin._state.message.kind === 'ok'
    && /จ่ายของออกจากคลัง/.test(W3.BookingAdmin._state.message.text), JSON.stringify(W3.BookingAdmin._state.message));

  // ยกเลิกต้องถามก่อนเสมอ
  W3.sb.calls.length = 0;
  W3.__confirmCalls.length = 0;
  await W3.BookingAdmin.setStatus('b2', 'cancelled');
  ok('ยกเลิก -> ถามยืนยันก่อน', W3.__confirmCalls.length === 1, String(W3.__confirmCalls.length));
  ok('คำถามบอกว่าของจะกลับเข้าคลัง', /กลับเข้าคลัง/.test(W3.__confirmCalls[0] || ''), W3.__confirmCalls[0]);

  // ปฏิเสธการยืนยัน -> ต้องไม่ยิงอะไรเลย
  const W4 = makeSandbox({}, { confirmResult: false });
  await W4.BookingAdmin.init();
  W4.sb.calls.length = 0;
  const did = await W4.BookingAdmin.setStatus('b1', 'cancelled');
  ok('กดยกเลิกแล้วยืนยัน "ไม่" -> ไม่เขียนอะไรเลย', did === false && !W4.sb.calls.some((c) => c.update), JSON.stringify(W4.sb.calls.filter((c) => c.update)));

  // ปักค้างคืนต้องถามก่อนเหมือนกัน (มีผลต่อสต็อกทุกวัน)
  const W5 = makeSandbox();
  await W5.BookingAdmin.init();
  W5.__confirmCalls.length = 0;
  await W5.BookingAdmin.setStatus('b1', 'overdue');
  ok('ปักค้างคืน -> ถามก่อน', W5.__confirmCalls.length === 1);
  ok('คำถามบอกว่าจะกินสต็อกทุกวัน', /กินสต็อกทุกวัน/.test(W5.__confirmCalls[0] || ''), W5.__confirmCalls[0]);

  // รับของไม่ต้องถาม (เป็นการยืนยันของที่จ่ายออกไปแล้ว ไม่ใช่การทำลายข้อมูล)
  const W6 = makeSandbox();
  await W6.BookingAdmin.init();
  W6.__confirmCalls.length = 0;
  await W6.BookingAdmin.setStatus('b1', 'checked_out');
  ok('รับของไม่ต้องถามยืนยัน', W6.__confirmCalls.length === 0);
}

console.log('\n[8] คืนครบแล้ว -> ต้องผ่าน settle_booking() ฝั่งฐานข้อมูล');
{
  const W7 = makeSandbox({ settle: 3 });
  await W7.BookingAdmin.init();
  W7.sb.calls.length = 0;
  await W7.BookingAdmin.settle('s1');
  const rpc = W7.sb.calls.find((c) => c.rpc === 'settle_booking');
  ok('เรียก rpc settle_booking', !!rpc, JSON.stringify(W7.sb.calls.map((c) => c.rpc || c.table)));
  ok('ส่ง id ใบจองในชื่อพารามิเตอร์ที่ SQL คาดไว้', rpc && eq(rpc.args, { p_booking_id: 's1' }), JSON.stringify(rpc && rpc.args));
  ok('ไม่ update booking_items ทีละแถวเอง (ต้องให้ SQL ทำใน transaction เดียว)',
    !W7.sb.calls.some((c) => c.table === 'booking_items' && c.update));
  ok('บอกว่าแก้กี่รายการ', /3 รายการ/.test(W7.BookingAdmin._state.message.text || ''), W7.BookingAdmin._state.message.text);

  const W8 = makeSandbox({ settle: 0 });
  await W8.BookingAdmin.init();
  await W8.BookingAdmin.settle('s1');
  ok('settle ซ้ำ (แก้ 0 แถว) -> บอกว่าบันทึกไว้อยู่แล้ว ไม่ใช่บอกว่าสำเร็จใหม่',
    /อยู่แล้ว/.test(W8.BookingAdmin._state.message.text || ''), W8.BookingAdmin._state.message.text);
}

console.log('\n[9] ทุกการเขียนต้องล้างแคชของการ์ดอุปกรณ์และปฏิทิน');
{
  const W9 = makeSandbox();
  await W9.BookingAdmin.init();
  W9.__cacheReset = 0; W9.__calRefresh = 0; W9.__storeLoads = [];
  await W9.BookingAdmin.setStatus('b1', 'checked_out');
  ok('ล้างแคชของ live provider', W9.__cacheReset === 1, String(W9.__cacheReset));
  ok('โหลด BookingStore ใหม่แบบ force', W9.__storeLoads.length === 1 && W9.__storeLoads[0].force === true, JSON.stringify(W9.__storeLoads));
  ok('ให้ปฏิทินรีเฟรชตัวเอง', W9.__calRefresh === 1, String(W9.__calRefresh));
}

console.log('\n[10] ฐานข้อมูลปฏิเสธ -> โชว์ข้อความของ trigger ตามจริง แล้วโหลดใหม่');
{
  const W10 = makeSandbox({
    fail: (table, f) => (f.update && table === 'bookings'
      ? { message: 'สิทธิ์ crew ตั้งสถานะ "checked_out" ไม่ได้ — การรับของ/ค้างคืนให้ admin เป็นผู้บันทึก' } : null),
  });
  await W10.BookingAdmin.init();
  const did = await W10.BookingAdmin.setStatus('b1', 'checked_out');
  ok('คืนค่า false เมื่อบันทึกไม่สำเร็จ', did === false);
  ok('โชว์ข้อความของฐานข้อมูลตรง ๆ ไม่แต่งใหม่', /สิทธิ์ crew ตั้งสถานะ/.test(W10.BookingAdmin._state.message.text || ''), W10.BookingAdmin._state.message.text);
  ok('ตั้งเป็นข้อความชนิด error', W10.BookingAdmin._state.message.kind === 'error');
  ok('แผงยังใช้ได้ (ไม่พังคามือ)', bodyOf(W10).includes('bkad-table'));
}

console.log('\n[11] บาง query พัง -> แผงต้องยังใช้ได้และบอกว่าส่วนไหนหายไป');
{
  const W11 = makeSandbox({ rpcFail: (n) => (n === 'booking_day_flags_between' ? { message: 'function booking_day_flags_between does not exist' } : null) });
  await W11.BookingAdmin.init();
  ok('ยัง ready อยู่ (ตารางใบจองสำคัญกว่ายอดล่วงหน้า)', W11.BookingAdmin.status().ready === true);
  ok('บอกว่าบางส่วนโหลดไม่ได้', /บางส่วนโหลดไม่ได้/.test(bodyOf(W11)), bodyOf(W11).slice(0, 160));
  ok('บอกชื่อไฟล์ migration ที่ต้องรัน', /migration/.test(W11.BookingAdmin._state.softError || ''), W11.BookingAdmin._state.softError);
  ok('ตารางใบจองยังแสดง', bodyOf(W11).includes('ถ่ายโฆษณา A'));
}

console.log('\n[12] เชื่อมต่อไม่ได้เลย -> บอกตรง ๆ ไม่โชว์แผงเปล่า');
{
  const W12 = makeSandbox(null);
  await W12.BookingAdmin.init();
  ok('ไม่ ready', W12.BookingAdmin.status().ready === false);
  ok('บอกว่าต่อ Supabase ไม่ได้และให้ดูกล่องไหน', /Supabase/.test(W12.BookingAdmin._state.error || '') && /การเชื่อมต่อ/.test(W12.BookingAdmin._state.error || ''), W12.BookingAdmin._state.error);
  ok('โชว์ error ให้เห็นในแผง', bodyOf(W12).includes('bkad-msg-err'));
}

console.log('\n[13] แก้ใบจอง — บังคับชื่องานและรูปแบบวัน แล้วส่งเฉพาะแถวที่แก้จริง');
{
  const W13 = makeSandbox();
  await W13.BookingAdmin.init();
  W13.BookingAdmin.openEditor('b1');
  const d = W13.BookingAdmin._state.editing;
  ok('เปิดแผงแก้ไขได้', !!d && d.id === 'b1');
  ok('ดึงรายการของมาด้วย 2 รายการ', d.lines.length === 2, String(d.lines.length));
  ok('รายการมีชื่อที่อ่านได้ ไม่ใช่แค่ id', d.lines[0].itemName.length > 0, d.lines[0].itemName);
  ok('จำค่าเดิมไว้เทียบว่าแก้จริงหรือไม่', d.lines[0]._quantity === 4);
  ok('แผงแก้ไขโผล่ใน HTML', bodyOf(W13).includes('bkad-editor'));

  // ชื่องานว่าง -> ต้องไม่ยิง
  W13.sb.calls.length = 0;
  d.job_name = '   ';
  const didEmpty = await W13.BookingAdmin.saveEdit();
  ok('ชื่องานว่าง -> ไม่บันทึก', didEmpty === false && !W13.sb.calls.some((c) => c.update));
  ok('บอกว่าฐานข้อมูลจะปฏิเสธด้วย', /ฐานข้อมูลจะปฏิเสธ/.test(W13.BookingAdmin._state.message.text || ''), W13.BookingAdmin._state.message.text);

  // วันผิดรูปแบบ
  d.job_name = 'ถ่ายโฆษณา A';
  d.booking_date = '13/11/2026';
  W13.sb.calls.length = 0;
  const didBadDate = await W13.BookingAdmin.saveEdit();
  ok('วันผิดรูปแบบ -> ไม่บันทึก', didBadDate === false && !W13.sb.calls.some((c) => c.update));
  ok('บอกฟอร์แมตที่ถูกต้อง', /วววว-ดด-วว/.test(W13.BookingAdmin._state.message.text || ''), W13.BookingAdmin._state.message.text);

  // แก้เฉพาะจำนวน 1 รายการ -> ต้องยิงแค่แถวนั้น
  d.booking_date = '2026-11-21';
  d.job_location = '   ';
  d.lines[0].quantity = 3;
  W13.sb.calls.length = 0;
  const didOk = await W13.BookingAdmin.saveEdit();
  ok('บันทึกผ่าน', didOk === true, JSON.stringify(W13.BookingAdmin._state.message));
  const updBookings = W13.sb.calls.find((c) => c.table === 'bookings' && c.update);
  ok('ส่งวัน/ชื่องาน/สถานที่/หมายเหตุครบ', updBookings && updBookings.update.booking_date === '2026-11-21'
    && updBookings.update.job_name === 'ถ่ายโฆษณา A', JSON.stringify(updBookings && updBookings.update));
  ok('สถานที่ว่าง -> ส่ง null ไม่ใช่ string ว่าง', updBookings && updBookings.update.job_location === null);
  const itemUpdates = W13.sb.calls.filter((c) => c.table === 'booking_items' && c.update);
  ok('ยิง update เฉพาะรายการที่จำนวนเปลี่ยนจริง', itemUpdates.length === 1, JSON.stringify(itemUpdates.map((c) => c.update)));
  ok('ส่งเฉพาะคอลัมน์ที่เปลี่ยน', itemUpdates[0] && eq(Object.keys(itemUpdates[0].update), ['quantity']), JSON.stringify(itemUpdates[0] && itemUpdates[0].update));
  ok('ปิดแผงแก้ไขหลังบันทึกสำเร็จ', W13.BookingAdmin._state.editing === null);
}

console.log('\n[14] แก้จำนวนที่คืน — ต้องไม่เกินจำนวนที่จอง (ตรงกับ check ของฐานข้อมูล)');
{
  const W14 = makeSandbox();
  await W14.BookingAdmin.init();
  W14.BookingAdmin.openEditor('b1');
  const root = W14.__ids.bookingAdminPanel;
  root.fire('input', { target: { getAttribute: (k) => ({ 'data-bkad': 'line-ret', 'data-i': '0' }[k] ?? null), value: '99' } });
  ok('คืนเกินจำนวนจอง -> ตีกลับมาที่จำนวนจอง', W14.BookingAdmin._state.editing.lines[0].returned_quantity === 4,
    String(W14.BookingAdmin._state.editing.lines[0].returned_quantity));
  root.fire('input', { target: { getAttribute: (k) => ({ 'data-bkad': 'line-qty', 'data-i': '0' }[k] ?? null), value: '0' } });
  ok('จำนวนจองต่ำกว่า 1 -> ดันกลับมาที่ 1', W14.BookingAdmin._state.editing.lines[0].quantity === 1,
    String(W14.BookingAdmin._state.editing.lines[0].quantity));
  root.fire('input', { target: { getAttribute: (k) => ({ 'data-bkad': 'f-job' }[k] ?? null), value: 'งานใหม่' } });
  ok('ช่องชื่องานผูกกับ draft', W14.BookingAdmin._state.editing.job_name === 'งานใหม่');
}

console.log('\n[15] แก้ใบจองที่ไม่ได้อยู่ในรายการที่โหลดมา -> ต้องไม่เดา');
{
  const W15 = makeSandbox();
  await W15.BookingAdmin.init();
  W15.BookingAdmin.openEditor('nope');
  ok('ไม่เปิดแผงแก้ไข', W15.BookingAdmin._state.editing === null);
  ok('บอกให้กดตรวจซ้ำก่อน', /ตรวจซ้ำ/.test(W15.BookingAdmin._state.message.text || ''), W15.BookingAdmin._state.message.text);
}

console.log('\n[16] XSS — ชื่อคน ชื่องาน สถานที่ หมายเหตุ มาจากฐานข้อมูล');
{
  const W16 = makeSandbox({
    bookings: [{
      id: 'bx', member_id: 'm2', job_name: '<img src=x onerror=alert(1)>', job_location: '"><script>bad()</script>',
      booking_date: TODAY, status: 'reserved', note: '<svg onload=x>', created_at: '', updated_at: '',
    }],
    members: [{ id: 'm2', code: 'M002', full_name: '<b>ชื่ออันตราย</b>', role: 'crew', active: true, color_hue: 137 }],
    stale: [],
  });
  await W16.BookingAdmin.init();
  const html = bodyOf(W16);
  ok('ไม่มีแท็ก img จริง', !/<img/i.test(html));
  ok('ไม่มีแท็ก script', !/<script/i.test(html));
  ok('payload ถูก escape เป็นข้อความ', html.includes('&lt;img src=x'), html.slice(0, 200));
  ok('ชื่อคนถูก escape', html.includes('&lt;b&gt;ชื่ออันตราย&lt;/b&gt;'));
  const realTags = html.match(/<[a-z][^>]*>/gi) || [];
  const onAttr = realTags.find((t) => /\son[a-z]+\s*=/i.test(t.replace(/=\s*"[^"]*"/g, '=')));
  ok('ไม่มี attribute ที่เริ่มด้วย on= ในแท็กที่แผงสร้าง', !onAttr, onAttr ? onAttr.slice(0, 150) : `ตรวจ ${realTags.length} แท็ก`);
}

console.log('\n[17] รายการที่ยังไม่ระบุจำนวน — ต้องแยกประเภทและชี้ทางไปแก้');
{
  const html = bodyOf(W);
  ok('บอกจำนวนรายการที่จองไม่ได้', html.includes('2 รายการ'));
  ok('อธิบายว่าต่างจาก "ของหมด"', html.includes('ยังไม่ระบุจำนวน — จองไม่ได้') && html.includes('ต่างจาก'));
  ok('แยกอุปกรณ์ / อุปกรณ์เสริม', html.includes('ไปเติมจำนวน') && html.includes('equipment.html') && html.includes('accessories.html'));
  ok('โชว์ชื่อรายการที่ขาด', html.includes('Cable ไม่ระบุจำนวน') && html.includes('Old Fresnel'));
}

console.log('\n[18] หน้าเว็บ — แผงต้องอยู่จริง และสคริปต์ต้องโหลดก่อน admin.js');
{
  const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  ['bookingAdminPanel', 'bookingAdminBody', 'bookingAdminSummary', 'refreshBookingsBtn'].forEach((id) => {
    ok(`admin.html มี id="${id}"`, html.includes(`id="${id}"`));
  });
  const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  ok('โหลด booking-admin.js', order.includes('js/booking-admin.js'));
  ok('booking-admin.js มาก่อน admin.js (admin.js เป็นคนเรียก init)',
    order.indexOf('js/booking-admin.js') < order.indexOf('js/admin.js'), order.join(' | '));
  ok('booking-store.js มาก่อน booking-admin.js (แผงอ่านยอดจากสโตร์)',
    order.indexOf('js/booking-store.js') < order.indexOf('js/booking-admin.js'));
  ok('แผงมีปุ่มตรวจซ้ำที่ผูก data-bkad="refresh"', /id="refreshBookingsBtn"[^>]*data-bkad="refresh"/.test(html));
  ok('แผงอธิบายว่าซ่อนจาก crew ไม่ใช่กำแพงความปลอดภัย (RLS ต่างหาก)',
    html.includes('กำแพงจริงคือ RLS') || html.includes('กำแพงความปลอดภัย'));

  const adminSrc = fs.readFileSync(path.join(ROOT, 'js/admin.js'), 'utf8');
  ok('admin.js ซ่อนแผงนี้จาก crew', /setVisible\('bookingAdminPanel', isAdminViewer\)/.test(adminSrc));
  ok('admin.js เรียก init เฉพาะ admin', /if \(isAdminViewer\)[\s\S]{0,400}BookingAdmin\.init\(\)/.test(adminSrc));
  ok('init ที่พังต้องไม่ลากหน้า admin พังตาม (มี try/catch)', /try \{\s*await window\.BookingAdmin\.init\(\);[\s\S]{0,200}console\.error/.test(adminSrc));
  ok('เลิกบอกว่าปุ่มจอง "กดได้เร็ว ๆ นี้"', !adminSrc.includes('กดได้เร็ว ๆ นี้'));
}

console.log('\n[19] แผงต้องไม่เขียนจำนวนสต็อกเอง และไม่ให้ crew เห็นปุ่มเขียน');
{
  const src = fs.readFileSync(path.join(ROOT, 'js/booking-admin.js'), 'utf8');
  ok('ไม่ update ตาราง fixtures', !/from\(\s*['"]fixtures['"]\s*\)[\s\S]{0,120}\.update\(/.test(src));
  ok('ไม่ update ตาราง accessories', !/from\(\s*['"]accessories['"]\s*\)[\s\S]{0,120}\.update\(/.test(src));
  ok('ไม่อ้างคอลัมน์ stock_count แบบเขียนค่า', !/stock_count\s*[:=]/.test(src));
  const tables = [...src.matchAll(/from\(\s*['"]([a-z_]+)['"]\s*\)/g)].map((m) => m[1]);
  ok('เขียนได้แค่ bookings / booking_items ที่เหลือเป็นอ่าน',
    [...new Set(tables)].every((t) => ['bookings', 'booking_items', 'members', 'v_booking_stale', 'v_item_stock'].includes(t)),
    [...new Set(tables)].join(','));
  ok('rpc ที่เรียกมีแค่ของฝั่งจอง', [...new Set([...src.matchAll(/rpc\(\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]))]
    .every((n) => ['settle_booking', 'booking_day_flags_between'].includes(n)));
  ok('ทุกข้อความจากฐานข้อมูลถูก esc() ก่อนลง innerHTML', (src.match(/esc\(/g) || []).length > 20, String((src.match(/esc\(/g) || []).length));
}

console.log('\n[20] ไฟล์ SQL ของรอบนี้ต้องครบและรันซ้ำได้');
{
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migration-2026-11-13e-booking-admin.sql'), 'utf8');
  ok('มี settle_booking()', sql.includes('create or replace function public.settle_booking'));
  const fnStart = sql.indexOf('create or replace function public.settle_booking');
  const fnDef = sql.slice(fnStart, sql.indexOf('$$;', fnStart));
  ok('settle_booking เป็น invoker rights (RLS + trigger ยังทำงาน)', !/^\s*security definer/im.test(fnDef), fnDef.slice(0, 160));
  ok('แต่อ้าง is_admin() ซึ่งฝั่ง SQL เป็น security definer อยู่แล้ว จึงตัดสินสิทธิ์ได้ถูก', fnDef.includes('public.is_admin()'));
  ok('เช็คว่าเป็น admin ก่อนเสมอ', sql.includes('if not public.is_admin() then'));
  ok('ปฏิเสธใบที่ยกเลิกแล้ว', sql.includes("if v_status = 'cancelled' then"));
  ok('เติม returned_quantity = quantity', sql.includes('set returned_quantity = quantity'));
  ok('ปลด overdue กลับเป็น checked_out', sql.includes("set status = 'checked_out'"));
  ok('grant execute ให้ authenticated', sql.includes('grant execute on function public.settle_booking(uuid) to authenticated'));
  ok('v_booking_stale ถูกสร้างใหม่', sql.includes('create or replace view public.v_booking_stale'));
  ok('คิวซ่อนใบที่คืนครบแล้ว', sql.includes('coalesce(o.qty_outstanding, 0) > 0'));
  ok('คิวยังล็อกด้วย is_admin()', sql.includes('and public.is_admin()'));
  ok('ใช้ biz_today() ไม่ใช่ current_date', sql.includes('public.biz_today()') && !/[^_]current_date/.test(sql.replace(/--.*$/gm, '')));
  ok('มีขั้นถอยกลับ', sql.includes('drop function if exists public.settle_booking'));
  ok('มีขั้นตรวจพร้อมเคสทดสอบ', sql.includes('settle_booking(v_bid)') && sql.includes('TEST RESULT'));
  ok('คอลัมน์เดิม 8 ตัวต้องมาก่อน แล้วค่อยเพิ่ม 3 ตัวท้าย',
    sql.indexOf('item_count,') < sql.indexOf('b.job_location,'));
}

// ---------------------------------------------------------------------------
console.log(`\nผ่าน ${pass} ข้อ`);
if (fails.length) {
  console.log(`\nไม่ผ่าน ${fails.length} ข้อ:`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('ชุดตรวจแผงจัดการใบจองผ่านหมด');
