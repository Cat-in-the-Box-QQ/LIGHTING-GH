// test/check-booking-form.mjs
// ---------------------------------------------------------------------------
// ตรวจฟอร์มสร้างใบจองจริง (js/booking-form.js)
//
// ที่ต้องตรวจด้วย DOM ปลอม ไม่ใช่แค่อ่าน source: ฟอร์มนี้มี "เพดาน" ที่ต้อง
// บังคับให้ตรงกับ trigger ฝั่ง SQL — ของที่ยังไม่ระบุจำนวน (stock = null) ต้อง
// จองไม่ได้เลย (ไม่ใช่จองได้ 0 ชิ้น), จองเกิน "เหลือวันนั้น" ไม่ได้, crew จอง
// ย้อนหลังไม่ได้ และ payload ที่ส่งเข้า create_booking() ต้องหน้าตาถูกต้อง
// บั๊กพวกนี้ node --check มองไม่เห็น ต้องเรนเดอร์จริงถึงจะเจอ
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
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this._listeners = {};
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
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  querySelector(sel) {
    if (!this._q.has(sel)) this._q.set(sel, new El('div'));
    return this._q.get(sel);
  }

  // รองรับเฉพาะ selector แบบ [data-xxx] ซึ่งพอสำหรับ bindBookLinks
  querySelectorAll(sel) {
    const m = /^\[([a-zA-Z-]+)\]$/.exec(String(sel).trim());
    if (!m) return [];
    const attr = m[1];
    const walk = (el) => el.children.reduce((acc, c) => acc.concat(c.getAttribute(attr) !== null ? [c] : [], walk(c)), []);
    return walk(this);
  }
  closest() { return null; }
  fire(type, ev) { (this._listeners[type] || []).forEach((f) => f(ev)); }
}

function makeDoc() {
  const body = new El('body');
  return {
    body,
    createElement: (t) => new El(t),
    _els: [],
  };
}

// ---- ฐานข้อมูลปลอม: 4 รายการครอบทุกเคส ------------------------------------
//   fixture 1  มี 4 ชิ้น วันนั้นถูกจองไป 2 -> เหลือ 2
//   fixture 2  มี 1 ชิ้น วันนั้นถูกจองไป 1 -> หมด (เหลือ 0) ต้องขึ้น "เต็ม" ไม่ใช่ "ไม่ระบุจำนวน"
//   accessory 7 ยังไม่ระบุจำนวน (stock = null) -> จองไม่ได้เลย
//   accessory 3 มี 10 ชิ้น ไม่มีการจอง -> เหลือ 10
const CATALOGUE = [
  { itemType: 'fixture', itemId: 1, itemName: 'Aladdin Bi-Flex 1', stock: 4 },
  { itemType: 'fixture', itemId: 2, itemName: '200W Dimmer Unit', stock: 1 },
  { itemType: 'accessory', itemId: 7, itemName: 'Cable ไม่ระบุจำนวน', stock: null },
  { itemType: 'accessory', itemId: 3, itemName: '5 m Extension Cable', stock: 10 },
];
const AVAIL = {
  'fixture:1': { itemType: 'fixture', itemId: 1, itemName: 'Aladdin Bi-Flex 1', stock: 4, booked: 2, outCount: 0, available: 2, stockUnknown: false },
  'fixture:2': { itemType: 'fixture', itemId: 2, itemName: '200W Dimmer Unit', stock: 1, booked: 1, outCount: 0, available: 0, stockUnknown: false },
  'accessory:7': { itemType: 'accessory', itemId: 7, itemName: 'Cable ไม่ระบุจำนวน', stock: null, booked: 0, outCount: 0, available: null, stockUnknown: true },
  'accessory:3': { itemType: 'accessory', itemId: 3, itemName: '5 m Extension Cable', stock: 10, booked: 0, outCount: 0, available: 10, stockUnknown: false },
};
const TODAY = '2026-11-13';

function makeSandbox({ role = 'crew', member = true, rpcError = null, availOk = true } = {}) {
  const doc = makeDoc();
  const rpcCalls = [];
  // setTimeout จริงในเบราว์เซอร์จะหน่วง 1.4 วินาทีก่อนปิดฟอร์ม
  // ถ้าให้รันทันทีในชุดตรวจ จะอ่านข้อความ "บันทึกสำเร็จ" ไม่ทัน
  const timers = [];
  const sb = {
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (rpcError) return { data: null, error: rpcError };
      return { data: '11111111-2222-3333-4444-555555555555', error: null };
    },
  };
  const provider = {
    id: 'live',
    isLive: true,
    catalogue: async () => CATALOGUE.map((c) => ({ ...c })),
    availabilityForDay: async (iso) => (availOk
      ? { ok: true, day: iso, rows: Object.values(AVAIL).map((r) => ({ ...r })) }
      : { ok: false, error: { short: 'ฐานข้อมูลยังไม่มี item_availability_between()' } }),
    bizToday: async () => TODAY,
    resetCache: () => {},
  };
  const storeLoads = [];
  const win = {
    sb,
    BookingLiveProvider: provider,
    BookingStore: { load: (o) => { storeLoads.push(o); return Promise.resolve(); } },
    AdminAuth: {
      isLoggedIn: () => true,
      getRole: () => role,
      getMember: () => (member ? { id: 'm-1', code: 'M002', full_name: 'สมชาย ใจดี', color_hue: 137 } : null),
      getMemberCode: () => (member ? 'M002' : ''),
      getMemberName: () => (member ? 'สมชาย ใจดี' : ''),
    },
    document: doc,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/booking-form.js'), 'utf8'), ctx, { filename: 'booking-form.js' });
  const flush = () => { const due = timers.splice(0, timers.length); due.forEach((fn) => { try { fn(); } catch (e) { /* ไม่สนใจ */ } }); };
  return { win, ctx, doc, rpcCalls, storeLoads, provider, flush };
}

const bodyHtmlOf = (sbx) => sbx.doc.body.children[0].querySelector('[data-bk-body]').innerHTML;
const footHtmlOf = (sbx) => sbx.doc.body.children[0].querySelector('[data-bk-foot]').innerHTML;
const switchTab = (sbx, tab) => click(sbx, 'tab', { 'data-tab': tab });

const click = (sbx, action, attrs = {}) => sbx.doc.body.children[0].fire('click', {
  preventDefault() {},
  target: { closest: (sel) => (sel === '[data-bk]' || sel === `[data-bk="${action}"]`
    ? { getAttribute: (k) => (k === 'data-bk' ? action : (attrs[k] ?? null)) }
    : null) },
});

// ===========================================================================
console.log('\n[1] แกนบริสุทธิ์ — เพดานจำนวนและข้อความสต็อก');
{
  const sbx = makeSandbox();
  const I = sbx.win.BookingForm._internals;

  ok('stock = null -> เพดาน null (จองไม่ได้เลย ไม่ใช่ 0)', I.maxQty(null, null, false) === null);
  ok('มีสต็อก 4 ยังไม่มียอดรายวัน -> เพดาน 4', I.maxQty(4, null, false) === 4);
  ok('ยอดรายวันบอกว่าเหลือ 2 -> เพดาน 2 (ไม่ใช่ 4)', I.maxQty(4, AVAIL['fixture:1'], true) === 2);
  ok('เหลือ 0 -> เพดาน 0 (หมดแล้ว)', I.maxQty(1, AVAIL['fixture:2'], true) === 0);
  ok('ยังไม่ระบุจำนวน -> เพดาน null ต่อให้มีแถวยอดรายวันมา', I.maxQty(null, AVAIL['accessory:7'], true) === null);
  ok('เพดานไม่ทะลุ MAX_QTY_PER_LINE', I.maxQty(99999, null, false) === I.MAX_QTY_PER_LINE);
  ok('ยอดติดลบในฐานข้อมูลไม่ทำให้เพดานติดลบ', I.maxQty(4, { stock: 4, booked: 9, available: -5, stockUnknown: false }, true) === 0);

  ok('ขอ 9 ชิ้นเมื่อเหลือ 2 -> ตีกลับที่ 2', I.clampQty(9, 2) === 2);
  ok('ขอ 0 -> 0 (แปลว่าเอาออกจากใบจอง)', I.clampQty(0, 5) === 0);
  ok('ขอติดลบ -> 0', I.clampQty(-3, 5) === 0);
  ok('เพดาน null -> รับไม่ได้เลย', I.clampQty(3, null) === 0);

  const unknown = I.stockText(null, null);
  ok('stock=null ใช้ข้อความ "ยังไม่ระบุจำนวน — จองไม่ได้"', unknown.text === 'ยังไม่ระบุจำนวน — จองไม่ได้', unknown.text);
  ok('stock=null มี class แยกจากของหมด', unknown.cls === 'is-unknown', unknown.cls);
  const out = I.stockText(1, AVAIL['fixture:2']);
  ok('ของหมดใช้ class is-out ไม่ใช่ is-unknown', out.cls === 'is-out', out.cls);
  ok('ของหมดบอกทั้ง "มี" และ "เหลือ"', out.text.includes('มี 1') && out.text.includes('เหลือ 0'), out.text);
  ok('ของเหลือ 2 = เคร่ง (is-tight)', I.stockText(4, AVAIL['fixture:1']).cls === 'is-tight');
  ok('ของเหลือเฟือ = is-ok', I.stockText(10, AVAIL['accessory:3']).cls === 'is-ok');
  ok('มีใบจองค้างอยู่ต้องโชว์ยอดติดจอง', I.stockText(4, AVAIL['fixture:1']).text.includes('ติดจอง 2'));
}

console.log('\n[2] อ่านรายการจาก URL (?book=) — ใช้ให้การ์ดอุปกรณ์/Set Builder ลิงก์มา');
{
  const sbx = makeSandbox();
  const F = sbx.win.BookingForm;
  ok('fixture-12 -> อุปกรณ์ id 12 จำนวน 1', eq(F.itemsFromParam('fixture-12'), [{ itemType: 'fixture', itemId: 12, quantity: 1 }]));
  ok('accessory-3*4 -> อุปกรณ์เสริม id 3 จำนวน 4', eq(F.itemsFromParam('accessory-3*4'), [{ itemType: 'accessory', itemId: 3, quantity: 4 }]));
  ok('a7 (ย่อ) -> อุปกรณ์เสริม id 7', eq(F.itemsFromParam('a7'), [{ itemType: 'accessory', itemId: 7, quantity: 1 }]));
  ok('f12 (ย่อ) -> อุปกรณ์ id 12', eq(F.itemsFromParam('f12'), [{ itemType: 'fixture', itemId: 12, quantity: 1 }]));
  ok('เลขเดี่ยว -> อุปกรณ์', eq(F.itemsFromParam('5'), [{ itemType: 'fixture', itemId: 5, quantity: 1 }]));
  ok('หลายรายการคั่นจุลภาคได้', F.itemsFromParam('fixture-1,accessory-3').length === 2);
  ok('ขยะถูกทิ้ง ไม่เดาเป็น id', eq(F.itemsFromParam('x,,fixture-'), []));
  ok('id 0 ไม่รับ (ฐานข้อมูลเริ่มที่ 1)', eq(F.itemsFromParam('fixture-0'), []));
  ok('ค่าว่างได้ array ว่าง', eq(F.itemsFromParam(''), []));
  ok('จำนวนมหาศาลถูกตัดที่เพดาน', F.itemsFromParam('fixture-1*999999')[0].quantity === F._internals.MAX_QTY_PER_LINE);
}

console.log('\n[3] เปิดฟอร์ม — เห็นใครกำลังจอง และช่องกรอกครบ');
const S3 = makeSandbox();
await S3.win.BookingForm.open({ date: '2026-11-20' });
{
  const body = bodyHtmlOf(S3);
  const foot = footHtmlOf(S3);
  ok('แผงถูกแขวนไว้กับ body', S3.doc.body.children.length === 1);
  ok('ล็อกการเลื่อนของหน้าข้างหลัง', S3.doc.body.classList.contains('bk-open'));
  ok('บอกชื่อผู้จอง', body.includes('สมชาย ใจดี'), body.slice(0, 200));
  ok('บอกรหัสสมาชิก', body.includes('M002'));
  ok('บอกสิทธิ์', body.includes('crew'));
  ok('มีจุดสีประจำตัวจาก members.color_hue', /bk-who-dot[^>]*background:hsl\(137,62%,45%\)/.test(body));
  ok('บอกชัดว่าเปลี่ยนผู้จองแทนคนอื่นไม่ได้', body.includes('ผู้จองคือคุณ'));
  ok('มีช่องชื่องาน (จำเป็น)', body.includes('data-bk="job"') && body.includes('ชื่องาน'));
  ok('มีช่องสถานที่', body.includes('data-bk="loc"'));
  ok('มีช่องวันที่', body.includes('data-bk="date"'));
  ok('มีช่องหมายเหตุ', body.includes('data-bk="note"'));
  ok('crew ห้ามเลือกวันย้อนหลัง (ใส่ min = วันนี้ของระบบ)', body.includes(`min="${TODAY}"`), TODAY);
  ok('วันที่ในฟอร์มเป็นวันที่ขอมา', /data-bk="date"[^>]*value="2026-11-20"/.test(body));
  ok('แสดงวันที่แบบไทย พ.ศ.', body.includes('20 พฤศจิกายน 2569'));
  ok('ปุ่มบันทึกกดได้', !/data-bk="submit"[^>]*disabled/.test(foot));
  ok('ยังไม่มีรายการ = บอกว่ายังไม่ได้เลือก', body.includes('ยังไม่ได้เลือกอุปกรณ์'));
  ok('แท็บอุปกรณ์แสดงอุปกรณ์ทั้ง 2 รายการ (ยังไม่รวมอุปกรณ์เสริม)', (body.match(/bk-pick-row/g) || []).length === 2, String((body.match(/bk-pick-row/g) || []).length));
  ok('แท็บอุปกรณ์ไม่ปนอุปกรณ์เสริม', !body.includes('5 m Extension Cable'));
  ok('มีปุ่มสลับไปแท็บอุปกรณ์เสริม', body.includes('data-bk="tab"') && body.includes('อุปกรณ์เสริม (2)'));
  ok('ไม่มี undefined/NaN หลุดออกมา', !body.includes('undefined') && !body.includes('NaN'));
}

console.log('\n[4] รายการที่จองไม่ได้ ต้องกดไม่ได้และบอกเหตุผล');
{
  const findRow = (name) => bodyHtmlOf(S3).split('<div class="bk-pick-row').slice(1).find((r) => r.includes(name)) || '';
  const outRow = findRow('200W Dimmer Unit');
  const okRow = findRow('Aladdin Bi-Flex 1');
  switchTab(S3, 'accessory');
  const unknownRow = findRow('Cable ไม่ระบุจำนวน');
  const freeRow = findRow('5 m Extension Cable');

  ok('ของที่ยังไม่ระบุจำนวนถูกทำเป็นแถวใช้ไม่ได้', unknownRow.includes('is-blocked'));
  ok('ปุ่ม + ของของที่ไม่ระบุจำนวนถูก disable', /bk-add[^>]*disabled/.test(unknownRow));
  ok('ขึ้นข้อความ "ยังไม่ระบุจำนวน — จองไม่ได้"', unknownRow.includes('ยังไม่ระบุจำนวน — จองไม่ได้'));
  ok('title บอกว่าต้องให้ admin เติมจำนวน', unknownRow.includes('ยังไม่ระบุจำนวนในสต็อก'));

  ok('ของที่จองเต็มแล้วใช้ is-blocked เหมือนกัน', outRow.includes('is-blocked'));
  ok('แต่ข้อความคนละแบบ — "เหลือ 0" ไม่ใช่ "ไม่ระบุจำนวน"', outRow.includes('เหลือ 0') && !outRow.includes('ยังไม่ระบุจำนวน'), outRow.slice(0, 160));
  ok('ปุ่ม + ของของที่เต็มถูก disable', /bk-add[^>]*disabled/.test(outRow));
  ok('title บอกว่าถูกจองเต็มแล้ววันนี้', outRow.includes('ถูกจองเต็มแล้ววันนี้'));

  ok('ของที่ยังเหลือกดได้', !/bk-add[^>]*disabled/.test(okRow));
  ok('ของที่เหลือ 2 จาก 4 บอกยอดติดจองด้วย', okRow.includes('ติดจอง 2') && okRow.includes('เหลือ 2'));
  ok('อุปกรณ์เสริมที่ไม่มีใบจองเลยบอกว่าเหลือครบ', freeRow.includes('มี 10') && freeRow.includes('เหลือ 10'), freeRow.slice(0, 200));
  ok('อุปกรณ์เสริมที่ว่างอยู่กดได้', !/bk-add[^>]*disabled/.test(freeRow));
  switchTab(S3, 'fixture');
}

console.log('\n[5] เพิ่มรายการ — เพดานต้องเป็น "เหลือวันนั้น" ไม่ใช่สต็อกทั้งหมด');
click(S3, 'add', { 'data-type': 'fixture', 'data-id': '1' });
click(S3, 'add', { 'data-type': 'fixture', 'data-id': '1' });
click(S3, 'add', { 'data-type': 'fixture', 'data-id': '1' });
{
  const body = bodyHtmlOf(S3);
  ok('กด + 3 ครั้ง แต่ได้แค่ 2 ชิ้น (เหลือวันนั้น 2)', /class="bk-qty" value="2"/.test(body), body.match(/class="bk-qty" value="\d+"/g)?.join(','));
  ok('บอกผู้ใช้ว่าถึงเพดานแล้ว', body.includes('จองได้สูงสุด 2 ชิ้น'), body.slice(-300));
  ok('ปุ่ม + ในใบจองถูก disable เมื่อถึงเพดาน', /data-bk="inc"[^>]*disabled/.test(body));
  ok('แถวในคลังถูกทำเครื่องหมายว่าเลือกแล้ว', body.includes('is-picked') && body.includes('ในใบจอง 2'));
  ok('ยอดรวมชิ้นนับได้ 2', body.includes('2 ชิ้น'));
}

console.log('\n[6] เพิ่มของที่ยังไม่ระบุจำนวนผ่านการกดตรง ๆ ไม่ได้');
click(S3, 'add', { 'data-type': 'accessory', 'data-id': '7' });
{
  const body = bodyHtmlOf(S3);
  ok('ไม่ถูกเพิ่มลงใบจอง', !body.includes('data-bk-line="accessory:7"'));
  ok('ขึ้นข้อความอธิบาย', body.includes('ยังไม่ระบุจำนวนในสต็อก จึงจองไม่ได้'), body.slice(-260));
}
click(S3, 'add', { 'data-type': 'fixture', 'data-id': '2' });
ok('ของที่เต็มแล้วก็เพิ่มไม่ได้ พร้อมบอกวัน', bodyHtmlOf(S3).includes('ถูกจองเต็มจำนวนแล้วในวันที่ 20 พฤศจิกายน 2569'));

console.log('\n[7] พิมพ์จำนวนเองเกินเพดาน ต้องถูกตีกลับพร้อมเหตุผล');
S3.doc.body.children[0].fire('input', {
  target: { getAttribute: (k) => ({ 'data-bk': 'qty', 'data-type': 'fixture', 'data-id': '1' }[k] ?? null), value: '99', tagName: 'INPUT' },
});
{
  const body = bodyHtmlOf(S3);
  ok('ค่าถูกตีกลับเหลือเพดาน', /class="bk-qty" value="2"/.test(body), body.match(/class="bk-qty" value="\d+"/g)?.join(','));
  ok('บอกว่าเหลือกี่ชิ้นในวันที่เท่าไร', body.includes('เหลือ 2 ชิ้นในวันที่ 20 พฤศจิกายน 2569'));
  ok('max ของช่อง input = เพดานจริง', /class="bk-qty"[^>]*max="2"/.test(body), body.match(/class="bk-qty"[^>]*/)?.[0]);
}
S3.doc.body.children[0].fire('input', {
  target: { getAttribute: (k) => ({ 'data-bk': 'qty', 'data-type': 'fixture', 'data-id': '1' }[k] ?? null), value: '0', tagName: 'INPUT' },
});
ok('ตั้งเป็น 0 = เอาออกจากใบจอง', !bodyHtmlOf(S3).includes('data-bk-line="fixture:1"'));

console.log('\n[8] บังคับกรอกชื่องานก่อนบันทึก');
click(S3, 'add', { 'data-type': 'accessory', 'data-id': '3' });
click(S3, 'submit');
{
  const body = bodyHtmlOf(S3);
  ok('ยังไม่บันทึก — ไม่มี rpc ถูกเรียก', S3.rpcCalls.length === 0, String(S3.rpcCalls.length));
  ok('บอกว่าจะต้องระบุชื่องาน', body.includes('ต้องระบุชื่องาน'), body.slice(-200));
}

console.log('\n[9] crew จองย้อนหลังไม่ได้ (admin เท่านั้น)');
S3.doc.body.children[0].fire('input', {
  target: { getAttribute: (k) => ({ 'data-bk': 'job' }[k] ?? null), value: 'ถ่ายโฆษณา A', tagName: 'INPUT' },
});
await (async () => {
  S3.doc.body.children[0].fire('change', { target: { getAttribute: (k) => (k === 'data-bk' ? 'date' : null), value: '2026-11-01' } });
  await new Promise((r) => global.setTimeout(r, 5));
})();
{
  const body = bodyHtmlOf(S3);
  ok('วันที่ถูกเด้งกลับมาเป็นวันนี้ของระบบ', /data-bk="date"[^>]*value="2026-11-13"/.test(body), body.match(/data-bk="date"[^>]*value="[^"]*"/)?.[0]);
  ok('บอกเหตุผลเป็นภาษาไทย', body.includes('จองย้อนหลังไม่ได้'), body.slice(-220));
}

console.log('\n[10] บันทึกจริง — payload ที่ส่งเข้า create_booking() ต้องถูกต้อง');
S3.doc.body.children[0].fire('change', { target: { getAttribute: (k) => (k === 'data-bk' ? 'date' : null), value: '2026-11-20' } });
await new Promise((r) => global.setTimeout(r, 5));
S3.doc.body.children[0].fire('input', {
  target: { getAttribute: (k) => ({ 'data-bk': 'loc' }[k] ?? null), value: 'สตูดิโอ 2', tagName: 'INPUT' },
});
click(S3, 'submit');
await new Promise((r) => global.setTimeout(r, 5));
{
  const call = S3.rpcCalls[0];
  ok('เรียก rpc create_booking', call && call.name === 'create_booking', call && call.name);
  ok('ส่งชื่องานที่ trim แล้ว', call.args.p_job_name === 'ถ่ายโฆษณา A', call.args.p_job_name);
  ok('ส่งสถานที่', call.args.p_job_location === 'สตูดิโอ 2');
  ok('ส่งวันที่ถูกต้อง', call.args.p_booking_date === '2026-11-20', call.args.p_booking_date);
  ok('หมายเหตุว่าง -> ส่ง null ไม่ใช่ string ว่าง', call.args.p_note === null, JSON.stringify(call.args.p_note));
  ok('ส่งรายการเป็น array', Array.isArray(call.args.p_items) && call.args.p_items.length === 1);
  const line = call.args.p_items[0];
  ok('item_type ถูก', line.item_type === 'accessory', line.item_type);
  ok('item_id เป็นเลข ไม่ใช่ string', line.item_id === 3 && typeof line.item_id === 'number', String(line.item_id));
  ok('quantity เป็นเลข >= 1', line.quantity === 1 && typeof line.quantity === 'number');
  ok('ไม่มีฟิลด์แปลกปลอมที่ฝั่ง SQL ไม่รู้จักที่ฝั่ง SQL ไม่รู้จัก', Object.keys(line).sort().join(',') === 'item_id,item_name,item_type,note,quantity', Object.keys(line).join(','));
  ok('หลังบันทึกได้ล้างแคชของ BookingStore', S3.storeLoads.length === 1 && S3.storeLoads[0].force === true);
  const body = bodyHtmlOf(S3);
  ok('ขึ้นข้อความสำเร็จเป็นภาษาไทย', body.includes('บันทึกใบจองแล้ว'), body.slice(-260));
  ok('บอกวันที่ จำนวนรายการ และจำนวนชิ้นที่บันทึก', body.includes('20 พฤศจิกายน 2569') && body.includes('1 รายการ') && body.includes('1 ชิ้น'));

  // หน่วงเวลาครบ -> ฟอร์มต้องปิดตัวเอง
  const closedPromise = S3.win.BookingForm.whenClosed();
  S3.flush();
  const closed = await closedPromise.catch(() => null);
  ok('ฟอร์มปิดตัวเองหลังบันทึกสำเร็จ', S3.doc.body.children.length === 0);
  ok('whenClosed() บอกว่าบันทึกสำเร็จ', closed && closed.saved === true, JSON.stringify(closed));
}

console.log('\n[11] ฐานข้อมูลปฏิเสธ -> ต้องโชว์ข้อความของ trigger ตามจริง ไม่แปลเอง');
{
  const sbx = makeSandbox({ rpcError: { message: 'จองเกินจำนวนที่มี — Aladdin Bi-Flex 1 มี 4 ชิ้น ถูกจองวันที่ 2026-11-20 ไปแล้ว 4 ชิ้น' } });
  await sbx.win.BookingForm.open({ date: '2026-11-20', items: [{ itemType: 'fixture', itemId: 1, quantity: 2 }] });
  sbx.doc.body.children[0].fire('input', { target: { getAttribute: (k) => ({ 'data-bk': 'job' }[k] ?? null), value: 'งานทดสอบ', tagName: 'INPUT' } });
  click(sbx, 'submit');
  await new Promise((r) => global.setTimeout(r, 5));
  const body = bodyHtmlOf(sbx);
  ok('โชว์ข้อความ error ของฐานข้อมูลตรง ๆ', body.includes('จองเกินจำนวนที่มี'), body.slice(-260));
  ok('ไม่แอบปิดฟอร์มทั้งที่บันทึกไม่สำเร็จ', sbx.doc.body.children.length === 1);
  ok('ปุ่มบันทึกกลับมาใช้ได้ (ไม่ค้างสถานะกำลังบันทึก)', !/data-bk="submit"[^>]*disabled/.test(footHtmlOf(sbx)));
}

console.log('\n[12] ยังไม่ sign in -> ไม่ให้กรอก และพาไปหน้า sign in');
{
  const sbx = makeSandbox();
  sbx.win.AdminAuth.isLoggedIn = () => false;
  await sbx.win.BookingForm.open({ date: '2026-11-20' });
  const body = bodyHtmlOf(sbx);
  const foot = footHtmlOf(sbx);
  ok('บอกว่าต้อง sign in', body.includes('ต้อง <strong>sign in</strong> ก่อนจองอุปกรณ์'));
  ok('มีลิงก์ไปหน้า sign in', body.includes('href="admin.html"'));
  ok('ปุ่มบันทึกถูก disable', /data-bk="submit"[^>]*disabled/.test(foot));
  ok('ช่องกรอกถูก disable ทั้งหมด', (body.match(/disabled>/g) || []).length >= 4, String((body.match(/disabled>/g) || []).length));
}

console.log('\n[13] sign in แล้วแต่ไม่มีแถวในตาราง members -> บอกตรง ๆ');
{
  const sbx = makeSandbox({ member: false });
  await sbx.win.BookingForm.open({ date: '2026-11-20' });
  const body = bodyHtmlOf(sbx);
  ok('บอกว่าไม่พบบัญชีในตาราง members', body.includes('ไม่พบบัญชีของคุณในตาราง members'), body.slice(0, 300));
  ok('ปุ่มบันทึกถูก disable', /data-bk="submit"[^>]*disabled/.test(footHtmlOf(sbx)));
  click(sbx, 'submit');
  ok('กดบันทึกก็ไม่มี rpc หลุดออกไป', sbx.rpcCalls.length === 0);
}

console.log('\n[14] อ่านยอดรายวันจากฐานข้อมูลไม่ได้ -> ต้องถอยอย่างปลอดภัยและบอกผู้ใช้');
{
  const sbx = makeSandbox({ availOk: false });
  await sbx.win.BookingForm.open({ date: '2026-11-20', items: [{ itemType: 'fixture', itemId: 1, quantity: 3 }] });
  const body = bodyHtmlOf(sbx);
  ok('เตือนว่าตรวจยอดคงเหลือรายวันไม่ได้', body.includes('bk-msg-info') && body.includes('item_availability_between'), body.slice(0, 400));
  ok('บอกว่าจะถอยไปใช้สต็อกทั้งคลังเป็นเพดานชั่วคราว', body.includes('ฟอร์มจะยึดจำนวนสต็อกทั้งคลังเป็นเพดานชั่วคราว'));
  ok('บอกว่าฐานข้อมูลจะตรวจซ้ำตอนบันทึก', body.includes('ฐานข้อมูลจะตรวจซ้ำอีกครั้งตอนบันทึก'));
  ok('ถอยไปใช้สต็อกทั้งคลังเป็นเพดาน (3 <= 4 จึงยังอยู่ในใบจอง)', /class="bk-qty" value="3"/.test(body), body.match(/class="bk-qty" value="\d+"/g)?.join(','));
  switchTab(sbx, 'accessory');
  ok('ของที่ไม่ระบุจำนวนก็ยังจองไม่ได้อยู่ดี', bodyHtmlOf(sbx).includes('ยังไม่ระบุจำนวน — จองไม่ได้'));
}

console.log('\n[15] ปิดฟอร์ม');
{
  const sbx = makeSandbox();
  let closedWith = null;
  await sbx.win.BookingForm.open({ date: '2026-11-20', onClose: (r) => { closedWith = r; } });
  ok('isOpen() = true ขณะเปิด', sbx.win.BookingForm.isOpen() === true);
  click(sbx, 'close');
  ok('แผงถูกเอาออกจาก body', sbx.doc.body.children.length === 0);
  ok('ปลดล็อกการเลื่อนหน้า', !sbx.doc.body.classList.contains('bk-open'));
  ok('onClose ถูกเรียกพร้อม saved=false', closedWith && closedWith.saved === false, JSON.stringify(closedWith));
  ok('isOpen() = false หลังปิด', sbx.win.BookingForm.isOpen() === false);
  sbx.win.BookingForm.close();   // ปิดซ้ำต้องไม่พัง
  ok('ปิดซ้ำไม่พัง', sbx.win.BookingForm.isOpen() === false);
}

console.log('\n[16] เปิดซ้ำ = เติมรายการต่อ (รองรับ "จองชุดนี้" หลายชุด)');
{
  const sbx = makeSandbox();
  const F = sbx.win.BookingForm;
  await F.open({ date: '2026-11-20', items: [{ itemType: 'fixture', itemId: 1, quantity: 1 }] });
  await F.open({ date: '2026-11-20', items: [{ itemType: 'accessory', itemId: 3, quantity: 2 }] });
  ok('ไม่สร้างแผงที่สอง', sbx.doc.body.children.length === 1);
  const body = bodyHtmlOf(sbx);
  ok('รายการเดิมยังอยู่', body.includes('data-bk-line="fixture:1"'));
  ok('รายการใหม่ถูกเติมเข้ามา', body.includes('data-bk-line="accessory:3"'));
  ok('นับ 2 รายการ', body.includes('2 รายการ'), body.match(/\d+ รายการ/g)?.join(','));
}

console.log('\n[17] XSS — ข้อมูลจากฐานข้อมูลต้องถูก escape ทุกจุด');
{
  const sbx = makeSandbox();
  sbx.win.BookingLiveProvider.catalogue = async () => ([
    { itemType: 'fixture', itemId: 9, itemName: '<img src=x onerror="alert(1)"> & "ชุดไฟ"', stock: 5 },
  ]);
  sbx.win.BookingLiveProvider.availabilityForDay = async (iso) => ({
    ok: true,
    day: iso,
    rows: [{ itemType: 'fixture', itemId: 9, itemName: '<img src=x onerror="alert(1)">', stock: 5, booked: 0, outCount: 0, available: 5, stockUnknown: false }],
  });
  await sbx.win.BookingForm.open({ date: '2026-11-20', jobName: '"><script>alert(2)</script>', note: '<b>หมายเหตุ</b>' });
  const body = bodyHtmlOf(sbx);
  ok('ชื่อรายการอันตรายถูก escape', !body.includes('<img src=x'), body.slice(0, 200));
  ok('payload ถูก escape เป็นข้อความ ไม่ใช่แท็กจริง', body.includes('&lt;img src=x onerror=&quot;'), body.slice(0, 240));
  ok('ไม่มีแท็ก img จริงในฟอร์ม', !/<img/i.test(body));
  // ต้องไล่ทีละ "แท็กจริง" แล้วลอกค่า attribute ออกก่อน — ถ้าสแกนทั้งก้อน
  // ข้อความที่ถูก escape แล้ว (&lt;img ... onerror=&quot;) จะทำให้ตรวจพลาดว่าเจอ
  const realTags = body.match(/<[a-z][^>]*>/gi) || [];
  const onAttr = realTags.find((t) => /\son[a-z]+\s*=/i.test(t.replace(/=\s*"[^"]*"/g, '=')));
  ok('ไม่มี attribute ที่เริ่มด้วย on= ในแท็กที่ฟอร์มสร้าง', !onAttr, onAttr ? onAttr.slice(0, 160) : `ตรวจ ${realTags.length} แท็ก`);
  ok('ไม่มีแท็ก script ถูกสร้าง', !/<script/i.test(body));
  ok('ชื่องานอันตรายถูก escape ในช่องกรอก', body.includes('&quot;&gt;&lt;script&gt;') || !body.includes('"><script>'), body.match(/data-bk="job"[^>]*value="[^"]*"/)?.[0]);
  ok('& ถูก escape', body.includes('&amp;'), body.slice(0, 240));
}

console.log('\n[18] admin จองย้อนหลังได้ (ตามกฎฝั่ง SQL)');
{
  const sbx = makeSandbox({ role: 'admin' });
  await sbx.win.BookingForm.open({ date: '2026-11-01', items: [{ itemType: 'accessory', itemId: 3, quantity: 1 }] });
  const body = bodyHtmlOf(sbx);
  ok('ช่องวันที่ไม่ใส่ min ให้ admin', !body.includes(`min="${TODAY}"`), body.match(/data-bk="date"[^>]*/)?.[0]);
  ok('บอกว่าสิทธิ์ admin จองย้อนหลังได้', body.includes('สิทธิ์ admin จองย้อนหลังได้'));
  sbx.doc.body.children[0].fire('input', { target: { getAttribute: (k) => ({ 'data-bk': 'job' }[k] ?? null), value: 'บันทึกย้อนหลัง', tagName: 'INPUT' } });
  click(sbx, 'submit');
  await new Promise((r) => global.setTimeout(r, 5));
  ok('admin บันทึกวันในอดีตได้', sbx.rpcCalls.length === 1 && sbx.rpcCalls[0].args.p_booking_date === '2026-11-01', JSON.stringify(sbx.rpcCalls[0] && sbx.rpcCalls[0].args));
}

console.log('\n[19] ฟอร์มห้ามแตะจำนวนสต็อกในคลังเด็ดขาด');
{
  const src = fs.readFileSync(path.join(ROOT, 'js/booking-form.js'), 'utf8');
  ok('ไม่มีการ update แถว fixtures/accessories', !/\.from\(\s*['"](fixtures|accessories)['"]\s*\)[\s\S]{0,120}\.update\(/.test(src));
  ok('ไม่มีการ insert เข้าตารางคลัง', !/\.from\(\s*['"](fixtures|accessories)['"]\s*\)[\s\S]{0,120}\.insert\(/.test(src));
  ok('ไม่อ้างคอลัมน์ stock_count แบบเขียนค่า', !/stock_count\s*[:=]/.test(src));
  const writes = (src.match(/sb\.rpc\(\s*['"]([a-z_]+)['"]/g) || []).map((m) => m.replace(/.*['"]([a-z_]+)['"]/g, '$1'));
  ok('rpc ที่เรียกมีแค่ create_booking', eq([...new Set(writes)], ['create_booking']), writes.join(','));
  ok('ไม่ insert เข้า bookings/booking_items ตรง ๆ (ต้องผ่าน create_booking เพื่อให้ rollback ทั้งก้อน)',
    !/\.from\(\s*['"]booking(s|_items)['"]\s*\)/.test(src));
}

console.log('\n[20] booking.html ต้องโหลดไฟล์ให้ครบและถูกลำดับ');
{
  const html = fs.readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
  const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const need = ['js/supabase-config.js', 'js/supabase-client.js', 'js/admin-auth.js', 'js/booking-store.js',
    'js/booking-demo.js', 'js/booking-live.js', 'js/booking-form.js', 'js/booking-calendar.js'];
  ok('มีสคริปต์ที่ต้องใช้ครบ', need.every((f) => order.includes(f)), order.join(' | '));
  ok('booking-form.js มาก่อน booking-calendar.js (ปฏิทินเรียกใช้ฟอร์ม)',
    order.indexOf('js/booking-form.js') < order.indexOf('js/booking-calendar.js'));
  ok('admin-auth.js มาก่อน booking-form.js (ฟอร์มถามสิทธิ์)',
    order.indexOf('js/admin-auth.js') < order.indexOf('js/booking-form.js'));
  ok('หน้า booking.html เลิกบอกว่าเป็นต้นฉบับ', !html.includes('กำลังตรวจหน้าตาปฏิทินก่อน'));
  ok('หน้า booking.html อธิบายว่าของจริงใช้ได้แล้ว', html.includes('หน้านี้ทำงานกับฐานข้อมูลจริงแล้ว'));
  ok('ยังบอกชัดว่าโหมดตัวอย่างไม่บันทึกลงฐานข้อมูล', html.includes('ไม่บันทึกลงฐานข้อมูล'));
}

console.log('\n[21] ลิงก์ "จอง" บนการ์ดอุปกรณ์ — ต้องพาไปฟอร์มพร้อมรายการ และไม่เปิด modal ไปด้วย');
{
  // โหลด js/search.js ใน context ของตัวเอง แล้วป้อน BookingStore ปลอม
  const box = { BookingStore: null };
  box.window = box;
  const sctx = vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/search.js'), 'utf8'), sctx, { filename: 'search.js' });

  const row = (over = {}) => ({
    itemType: 'fixture', itemId: 12, itemName: 'Aladdin', stock: 8, booked: 0, outCount: 0,
    available: 8, stockUnknown: false, hidden: false, ...over,
  });
  const setStore = (rows, ready = true) => {
    box.BookingStore = { isReady: () => ready, get: (t, id) => rows.find((r) => r.itemType === t && r.itemId === id) || null };
  };

  setStore([row()], false);
  ok('BookingStore ยังไม่พร้อม -> ไม่ใส่ลิงก์ (การ์ดหน้าตาเหมือนเดิม)', vm.runInContext('bookLinkHtml("fixture", 12)', sctx) === '');

  setStore([row()]);
  const link = vm.runInContext('bookLinkHtml("fixture", 12)', sctx);
  ok('พร้อมแล้ว -> มีลิงก์จอง', link.includes('<a'), link);
  ok('ลิงก์พาไปหน้าปฏิทินจอง', link.includes('href="booking.html?book=fixture-12"'), link);
  ok('ระบุรายการที่จะใส่ลงใบจองให้เลย', link.includes('book=fixture-12'));
  ok('มี data-book-link ให้ผูก stopPropagation', link.includes('data-book-link'));
  ok('บอกว่าวันนี้เหลือกี่ชิ้น', link.includes('เหลือ 8 ชิ้น'), link);

  setStore([row({ itemType: 'accessory', itemId: 3, available: 0, booked: 10, stock: 10 })]);
  const full = vm.runInContext('bookLinkHtml("accessory", 3)', sctx);
  ok('วันนี้เต็มแล้ว -> ยังใส่ลิงก์ แต่เปลี่ยนคำเป็น "ดูคิว"', full.includes('>ดูคิว<'), full);
  ok('บอกว่าเป็นการจองล่วงหน้าวันอื่น', full.includes('จองล่วงหน้า'), full);
  ok('ใช้ชนิด accessory ในลิงก์ (id ของสองตารางซ้ำกันได้)', full.includes('book=accessory-3'));

  setStore([row({ available: null, stockUnknown: true, stock: null })]);
  ok('ยังไม่ระบุจำนวน -> ไม่มีลิงก์จอง (มีข้อความบอกเหตุผลอยู่แล้ว)', vm.runInContext('bookLinkHtml("fixture", 12)', sctx) === '');

  setStore([row({ hidden: true })]);
  ok('รายการที่ถูกซ่อนไว้ -> ไม่มีลิงก์จอง', vm.runInContext('bookLinkHtml("fixture", 12)', sctx) === '');

  setStore(null, false);
  box.BookingStore = { isReady: () => true, get: () => null };
  ok('ไม่มีแถวของรายการนั้นใน view -> ไม่เดา ไม่ใส่ลิงก์', vm.runInContext('bookLinkHtml("fixture", 999)', sctx) === '');

  // bindBookLinks ต้องกัน click ไม่ให้ลอยขึ้นไปถึงการ์ด
  let cardOpened = 0;
  const root = new El('div');
  const a = new El('a');
  a.setAttribute('data-book-link', '');
  root.appendChild(a);
  root.addEventListener('click', () => { cardOpened += 1; });
  // จำลองการ bubble: เรียก handler ของลิงก์ก่อน แล้วจึง handler ของการ์ด
  const bindBookLinks = vm.runInContext('bindBookLinks', sctx);
  bindBookLinks(root);
  ok('bindBookLinks หา [data-book-link] เจอและผูก handler ให้', (a._listeners.click || []).length === 1, String((a._listeners.click || []).length));
  const ev = { stopped: false, stopPropagation() { this.stopped = true; } };
  (a._listeners.click || []).forEach((f) => f(ev));
  ok('handler ของลิงก์สั่ง stopPropagation', ev.stopped === true);
  ok('การ์ดจึงไม่ถูกเปิดตอนกดลิงก์จอง', cardOpened === 0, String(cardOpened));

  const htmlSrc = fs.readFileSync(path.join(ROOT, 'equipment.html'), 'utf8');
  const accSrc = fs.readFileSync(path.join(ROOT, 'js/accessories.js'), 'utf8');
  ok('การ์ดอุปกรณ์มีลิงก์จอง', htmlSrc.includes("bookLinkHtml('fixture', item.id)"));
  ok('การ์ดอุปกรณ์เสริม (equipment.html) มีลิงก์จอง', htmlSrc.includes("bookLinkHtml('accessory', item.id)"));
  ok('หน้า accessories.html มีลิงก์จอง', accSrc.includes("bookLinkHtml('accessory', item.id)"));
  ok('ทั้งสองหน้าผูก bindBookLinks ไว้', htmlSrc.includes('bindBookLinks(grid)') && accSrc.includes('bindBookLinks(listEl)'));
  ok('มี CSS ของลิงก์จอง', fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8').includes('.book-link'));
}

console.log('\n[22] หน้า Inventory ต้องบอกว่าตัวเองแสดงแค่วันนี้ และชี้ไปปฏิทินจอง');
{
  const inv = fs.readFileSync(path.join(ROOT, 'inventory.html'), 'utf8');
  ok('บอกว่าหน้า Inventory แสดงของวันนี้', inv.includes('ของวันนี้'));
  ok('บอกตรง ๆ ว่าไม่แสดงคิววันถัดไป', inv.includes('ไม่แสดงคิวของวันถัดไป'));
  ok('มีลิงก์ "ดูคิวล่วงหน้า" ไป booking.html', /href="booking.html"[^>]*>ดูคิวล่วงหน้า</.test(inv));
  ok('ลิงก์นั้นมี title อธิบายว่าไปทำอะไร', /title="[^"]*ปฏิทินจอง[^"]*"[^>]*>ดูคิวล่วงหน้า</.test(inv));
}

// ---------------------------------------------------------------------------
console.log(`\nผ่าน ${pass} ข้อ`);
if (fails.length) {
  console.log(`\nไม่ผ่าน ${fails.length} ข้อ:`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('ชุดตรวจฟอร์มจองผ่านหมด');
