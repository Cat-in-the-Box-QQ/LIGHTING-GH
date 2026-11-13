#!/usr/bin/env node
// test/check-member-ui.mjs - รัน renderMembers()/openMemberModal() ของจริงใน DOM ปลอม
// ใช้: node test/check-member-ui.mjs
//
// ทำไมต้องมีชุดนี้แยกจาก harness.mjs
// ---------------------------------
// harness.mjs ตรวจ data layer (MemberStore) ได้ แต่ renderMembers() อยู่ใน IIFE ของ
// js/admin.js ซึ่งผูกกับ DOM ทั้งหมด — node --check ตรวจได้แค่ไวยากรณ์
// จึงจับ 2 อย่างนี้ไม่ได้ และทั้งคู่เคยเกิดจริงในโค้ดชุดนี้:
//
//   1. เรียก bindMemberEditor(formId, id, { onSaved }) แทน (formId, id, onSaved, opts)
//      -> typeof onSaved !== 'function' -> บันทึกสำเร็จแต่หน้าเว็บไม่ทำอะไรเงียบ ๆ
//   2. ตัวเทียบเรียงลำดับเขียนกลับด้าน -> คิวปิดใช้งานไปอยู่ท้ายตารางแทนที่จะอยู่หัว
//      (ไม่ error, ไม่พัง, แค่ผิดที่ — มองไม่เห็นถ้าไม่เรนเดอร์จริง)
//
// วิธีทำ: สกัดฟังก์ชันออกจาก IIFE ด้วยการนับวงเล็บปีกกา แล้วรันใน vm ที่มี DOM shim
// + Supabase mock แบบ chainable (supabase-js v2 เป็น PromiseLike จึงต้องมี .then)
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const adminSrc = fs.readFileSync(path.join(ROOT, 'js/admin.js'), 'utf8');

// ---------------- สกัดฟังก์ชันออกจาก IIFE ----------------
// ต้องรวบคำ async ไปด้วย — ถ้าเริ่มที่ "function" จะได้ฟังก์ชันที่ไม่ async
// แล้ว await ข้างในจะ compile ไม่ผ่าน (และทำให้เข้าใจผิดว่าโค้ดจริงพัง)
function extract(name) {
  const re = new RegExp('^(\\s*)(async\\s+)?function ' + name + '\\(', 'm');
  const mm = re.exec(adminSrc);
  if (!mm) throw new Error(`ไม่พบ function ${name} ใน js/admin.js`);
  const start = mm.index + mm[1].length;
  const i = adminSrc.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < adminSrc.length; j++) {
    if (adminSrc[j] === '{') depth++;
    else if (adminSrc[j] === '}') { depth--; if (!depth) return adminSrc.slice(start, j + 1); }
  }
  throw new Error(`วงเล็บปีกกาของ ${name} ไม่ปิด`);
}

const FUNCS = ['applyRoleVisibility', 'renderMembers', 'openMemberModal', 'refreshMembers'];
const WRAPPED = '(async () => {\n' + FUNCS.map(extract).join('\n\n')
  + '\n' + FUNCS.map((f) => `window.${f} = ${f};`).join('\n')
  + ' })()';

// ---------------- DOM shim ----------------
const byId = {};

function El(tag = 'div', id = '') {
  const e = {
    tagName: tag.toUpperCase(),
    id,
    children: [],
    textContent: '',
    className: '',
    colSpan: null,
    disabled: false,
    style: {},
    type: '',
    _html: '',
    _handlers: {},
    appendChild(child) { e.children.push(child); return child; },
    addEventListener(ev, fn) { e._handlers[ev] = fn; },
    querySelector(sel) {
      if (sel === 'tbody') { e._tbody ||= El('tbody'); return e._tbody; }
      return null;
    },
    click() { return e._handlers.click?.(); },
  };
  Object.defineProperty(e, 'innerHTML', {
    get: () => e._html,
    set: (v) => { e._html = v; e.children = []; },
  });
  return e;
}

const fakeDocument = {
  getElementById: (id) => (byId[id] ||= El('div', id)),
  createElement: (tag) => El(tag),
  addEventListener() {},
};

function clearDom() {
  for (const k of Object.keys(byId)) delete byId[k];
}

// ---------------- Supabase mock ----------------
// supabase-js v2: ทุก builder เป็น PromiseLike -> ต้องมี .then และห้ามพึ่ง .catch/.finally
// ลำดับที่ store เรียกจริง: .from(t).select('*').order() และ
//                          .from(t).update(row).eq('id', id).select().single()
// .update() มาก่อน .eq() จึงต้องจำ payload ไว้แล้วค่อยเขียนตอน settle
function mockClient(tables, opts = {}) {
  const calls = [];
  return {
    _calls: calls,
    from(table) {
      const rows = tables[table] || [];
      const q = {
        _filters: [],
        _payload: null,
        _kind: null,
        select() { return q; },
        order() { return q; },
        eq(col, val) { q._filters.push([col, val]); return q; },
        update(payload) { q._kind = 'update'; q._payload = payload; return q; },
        insert(payload) { q._kind = 'insert'; q._payload = payload; return q; },
        _matched() {
          // เทียบเป็น string: members.id เป็น uuid ซึ่ง Number() ได้ NaN
          return rows.filter((r) => q._filters.every(([c, v]) => String(r[c]) === String(v)));
        },
        _settle() {
          if (opts.error) return { data: null, error: { message: opts.error } };
          if (q._kind === 'update') {
            const hit = q._matched();
            hit.forEach((r) => Object.assign(r, q._payload));
            calls.push({ kind: 'update', table, payload: q._payload, matched: hit.length });
            return { data: hit[0] ?? null, error: hit.length ? null : { message: 'no rows updated' } };
          }
          calls.push({ kind: 'select', table });
          return { data: q._filters.length ? q._matched() : rows.slice(), error: null };
        },
        single: async () => q._settle(),
        maybeSingle: async () => {
          const r = q._settle();
          return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
        },
        then: (resolve) => resolve(q._settle()),
      };
      return q;
    },
  };
}

// ---------------- ประกอบ sandbox ----------------
function build({
  rows = [], error = null, loginEmail = 'zombe.jpm@gmail.com', role = 'admin', member = null,
} = {}) {
  const sb = {
    console, document: fakeDocument,
    String, Number, Boolean, Object, Array, JSON, RegExp, Math, Set, Map, Promise, Date, Error,
    setTimeout, clearTimeout, isNaN, parseInt, parseFloat,
    location: { reload() { sb.__reloaded = true; } },
    __status: [],
    __modalShown: false,
    __confirms: [],
  };
  // window ต้องเป็น global object ตัวเดียวกับ sandbox เหมือนเบราว์เซอร์จริง
  // ไม่งั้น window.MemberStore กับ sb.MemberStore จะคนละที่
  sb.window = sb;
  sb.self = sb;
  sb.globalThis = sb;
  sb.confirm = (msg) => { sb.__confirms.push(msg); return true; };
  sb.itemModal = {
    show() { sb.__modalShown = true; },
    hide() { sb.__modalHidden = true; },
  };
  sb.showStatus = (msg, ok = true) => sb.__status.push([ok, msg]);
  sb.refreshData = async () => {};
  // role/member ต้องตั้งได้ — หน้า sign-in ตอนนี้เรนเดอร์ต่างกันตามสิทธิ์ (admin เห็นทุกแถว,
  // crew เห็นแถวตัวเองแถวเดียว) ถ้า hardcode 'admin' ไว้จะทดสอบ crew view ไม่ได้เลย
  sb.AdminAuth = {
    getEmail: () => loginEmail,
    getRole: () => role,
    getMember: () => member,
    getMemberCode: () => member?.code || null,
  };

  vm.createContext(sb);
  for (const f of ['js/supabase-config.js', 'js/member-store.js', 'js/inline-member-editor.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  }
  sb.sb = mockClient({ members: rows.map((r) => ({ ...r })) }, { error });

  // top-level `const`/`function` ใน vm ไม่กลายเป็น property ของ global object
  // ต้อง re-export เอง (harness.mjs ทำแบบเดียวกัน)
  vm.runInContext('window.MemberStore = MemberStore;'
    + ' window.memberEditorHtml = memberEditorHtml;'
    + ' window.bindMemberEditor = bindMemberEditor;', sb);
  vm.runInContext(WRAPPED, sb);
  return sb;
}

// ---------------- ตัวช่วยอ่านตาราง ----------------
const cells = (tr) => tr.children.filter((c) => c.tagName === 'TD');
const cellTexts = (tr) => cells(tr).map((c) => c.textContent);
// ปุ่มอยู่ช่องสุดท้ายเท่านั้น — ช่องสิทธิ์/สถานะก็มี <span> เป็นลูก
// ถ้านับทุกช่องจะได้ badge ปนมาด้วย (เคยทำให้เทสต์วัดผิดตัว)
const btnTexts = (tr) => cells(tr).at(-1).children.map((b) => b.textContent);
const badgeTexts = (tr) => cells(tr).flatMap((c) => c.children.map((b) => b.textContent));
// หาแถวจากรหัสประจำตัว เพราะลำดับแสดงผลถูกจัดใหม่ (คิวปิดใช้งานขึ้นก่อน)
const rowOf = (tb, code) => tb.children.find((tr) => cellTexts(tr)[0] === code);
const tbodyOf = (el) => el._tbody || el;

// ---------------- ข้อมูลทดสอบ ----------------
// หน้าตาเหมือนแถวจริงที่ Supabase คืนมา (snake_case, id เป็น uuid)
const ROWS = [
  { id: 'u-1', auth_uid: 'a-1', code: 'ADMIN01', full_name: 'คุณเจ้าของ', email: 'zombe.jpm@gmail.com', phone: '0812345678', role: 'admin', active: true, note: null },
  { id: 'u-2', auth_uid: 'a-2', code: 'TK01', full_name: 'สมชาย ใจดี', email: 'somchai@company.com', phone: null, role: 'crew', active: true, note: 'ทีมไฟ' },
  { id: 'u-3', auth_uid: 'a-3', code: 'M001', full_name: 'somchai', email: 'newbie@company.com', phone: null, role: 'crew', active: false, note: null },
];
const LAST_ADMIN_ERROR = 'ไม่สามารถปิดการใช้งานได้ เพราะจะทำให้ไม่มีผู้ดูแลระบบ (admin) ที่ยังใช้งานเหลืออยู่ — ตั้ง admin คนอื่นก่อน แล้วค่อยลดสิทธิ์รายนี้';

let passed = 0;
let failed = 0;
function chk(label, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); }
}

console.log('=== หน้าจัดการทีมงาน (renderMembers รันจริงใน DOM ปลอม) ===');

// ---------- เคส 1: สมาชิก 3 คน ----------
console.log('\n[1] สมาชิก 3 คน — admin ตัวเอง / crew / ถูกปิดใช้งาน');
clearDom();
const sb = build({ rows: ROWS });
try {
  await sb.refreshMembers();
  chk('refreshMembers() รันจบไม่โยน error', true);
} catch (err) {
  chk('refreshMembers() รันจบไม่โยน error', false, `${err.name}: ${err.message}`);
}
const st = sb.MemberStore.status();
chk('ต่อ Supabase ได้', st.isSupabase, 'mode=' + st.mode);
const tb = tbodyOf(byId.memberList);
chk('สร้างตาราง 3 แถว', tb.children.length === 3, 'ได้ ' + tb.children.length);
chk(
  'summary นับถูก',
  /admin ใช้งาน 1 คน.*crew ใช้งาน 1 คน.*ปิดใช้งาน 1 คน.*ทั้งหมด 3 แถว/.test(byId.memberSummary.textContent),
  byId.memberSummary.textContent,
);
chk('แถบปิดใช้งานโผล่', byId.memberPendingBox.style.display === 'block', byId.memberPendingBox.textContent.slice(0, 50));
chk('แผงปัญหาซ่อน', byId.memberProblemBox.style.display === 'none', byId.memberProblemBox.textContent.slice(0, 60));
chk('แถวที่ถูกปิดใช้งานขึ้นเป็นแถวแรก', cellTexts(tb.children[0])[0] === 'M001', tb.children.map((tr) => cellTexts(tr)[0]).join(' → '));
chk(
  'admin ขึ้นก่อน crew',
  cellTexts(tb.children[1])[0] === 'ADMIN01' && cellTexts(tb.children[2])[0] === 'TK01',
  tb.children.map((tr) => cellTexts(tr)[0]).join(' → '),
);

const self = rowOf(tb, 'ADMIN01');
chk(
  'แถวตัวเองถูกไฮไลต์และมี "← คุณ"',
  self.className === 'table-light' && cellTexts(self).some((t) => t.includes('← คุณ')),
  'class=' + self.className + ' | ' + cellTexts(self).join(' / '),
);
chk('แถวตัวเองมีปุ่ม แก้ไข + ปิดใช้งาน', btnTexts(self).join(',') === 'แก้ไข,ปิดใช้งาน', btnTexts(self).join(','));
chk('badge สถานะตัวเอง = ใช้งาน', badgeTexts(self).includes('ใช้งาน'), badgeTexts(self).join(','));

const pend = rowOf(tb, 'M001');
chk('แถวที่ถูกปิดใช้งานมีปุ่ม แก้ไข + เปิดใช้งาน', btnTexts(pend).join(',') === 'แก้ไข,เปิดใช้งาน', btnTexts(pend).join(','));
chk('แถวที่ถูกปิดใช้งาน badge = ปิดใช้งาน', badgeTexts(pend).includes('ปิดใช้งาน'), badgeTexts(pend).join(','));
chk('แถว crew แสดงอีเมลจริง', cellTexts(rowOf(tb, 'TK01')).join('|').includes('somchai@company.com'), cellTexts(rowOf(tb, 'TK01')).join(' | '));
chk('badge สิทธิ์ถูก', badgeTexts(self).includes('admin') && badgeTexts(rowOf(tb, 'TK01')).includes('crew'));
chk('ทุกช่องเป็น textContent ไม่ใช่ innerHTML (กัน XSS)', tb.children.every((tr) => tr.children.every((c) => c._html === '')));

// ---------- เคส 2: เปิด modal ----------
console.log('\n[2] เปิด modal แก้ไข');
try {
  sb.openMemberModal('u-2');
  chk('openMemberModal() ไม่โยน error', true);
} catch (err) {
  chk('openMemberModal() ไม่โยน error', false, `${err.name}: ${err.message}`);
}
chk('modal ถูก show', sb.__modalShown === true);
const body = byId.adminItemModalBody;
chk(
  'ฟอร์มมีครบทุกฟิลด์',
  ['code', 'fullName', 'phone', 'role', 'active', 'note'].every((n) => body.innerHTML.includes(`name="${n}"`)),
  body.innerHTML.match(/name="[^"]+"/g)?.join(','),
);
chk('ฟอร์มเป็นของแถวที่เลือก', body.innerHTML.includes('TK01') && body.innerHTML.includes('สมชาย'));
chk('title ถูกตั้ง', byId.adminItemModalTitle.textContent.length > 0, byId.adminItemModalTitle.textContent);

// ---------- เคส 3: id ปลอม ----------
console.log('\n[3] id ที่ไม่มีอยู่');
sb.__status.length = 0;
sb.__modalShown = false;
try {
  sb.openMemberModal('id-ที่ไม่มี-อยู่');
  chk('ไม่โยน error', true);
} catch (err) {
  chk('ไม่โยน error', false, err.message);
}
chk(
  'ไม่เปิด modal และเตือนผู้ใช้',
  sb.__modalShown === false && sb.__status.some(([ok]) => ok === false),
  JSON.stringify(sb.__status.at(-1)),
);

// ---------- เคส 4: ตารางว่าง ----------
console.log('\n[4] ตาราง members ว่าง');
clearDom();
const sbEmpty = build({ rows: [] });
await sbEmpty.refreshMembers();
const tbEmpty = tbodyOf(byId.memberList);
chk('ยังนับเป็นโหมด Supabase (ไม่โชว์ข้อมูลปลอม)', sbEmpty.MemberStore.isSupabase() === true);
chk('แถบปิดใช้งานซ่อน', byId.memberPendingBox.style.display === 'none');
chk(
  'มีแถวบอกวิธีเพิ่มคน ชี้ไป Authentication',
  tbEmpty.children.length === 1 && /Authentication/.test(tbEmpty.children[0].children[0].textContent),
  tbEmpty.children[0]?.children[0]?.textContent.slice(0, 80),
);

// ---------- เคส 5: ยังไม่ได้รัน SQL ----------
console.log('\n[5] เข้าตาราง members ไม่ได้ (ยังไม่รัน migration)');
clearDom();
const sbNoTable = build({ rows: [], error: 'relation "public.members" does not exist' });
await sbNoTable.refreshMembers();
chk('ไม่โยน error ทิ้งทั้งหน้า', true);
chk(
  'แผงปัญหาโผล่และชี้ไปไฟล์ SQL ที่ต้องรัน',
  byId.memberProblemBox.style.display === 'block' && /migration-2026/.test(byId.memberProblemBox.textContent),
  byId.memberProblemBox.textContent.slice(0, 130),
);
chk('summary บอกว่าไม่ได้ต่อ Supabase', /ยังไม่เชื่อมต่อกับ Supabase/.test(byId.memberSummary.textContent), byId.memberSummary.textContent);
chk(
  'ตารางบอกว่าอยู่โหมด local',
  /โหมด local ไม่มีรายชื่อทีมงานให้จัดการ/.test(tbodyOf(byId.memberList).children[0]?.children[0]?.textContent || ''),
);

// ---------- เคส 6: ปิดใช้งานตัวเอง ----------
console.log('\n[6] ปิดใช้งานตัวเอง — ต้องเตือนก่อนแล้ว reload');
clearDom();
const sbSelf = build({ rows: [ROWS[0]] });
await sbSelf.refreshMembers();
const offBtn = cells(tbodyOf(byId.memberList).children[0]).at(-1).children.find((b) => b.textContent === 'ปิดใช้งาน');
chk('เจอปุ่มปิดใช้งานของตัวเอง', !!offBtn);
if (offBtn) {
  await offBtn.click();
  chk('ถาม confirm ก่อน', sbSelf.__confirms.length === 1, JSON.stringify((sbSelf.__confirms[0] || '').slice(0, 70)));
  chk('ข้อความระบุว่าเป็นบัญชีตัวเอง', /บัญชีของคุณเอง/.test(sbSelf.__confirms[0] || ''), sbSelf.__confirms[0]?.slice(0, 60));
  chk('reload หลังปิดตัวเอง (สิทธิ์หายแล้วต้องอ่านหน้าใหม่)', sbSelf.__reloaded === true);
} else {
  chk('ถาม confirm ก่อน', false);
  chk('ข้อความระบุว่าเป็นบัญชีตัวเอง', false);
  chk('reload หลังปิดตัวเอง', false);
}

// ---------- เคส 7: trigger ปฏิเสธ ----------
console.log('\n[7] ฐานข้อมูลปฏิเสธ (admin คนสุดท้าย) — ต้องโชว์ข้อความไทย ไม่ reload');
clearDom();
const sbBlocked = build({ rows: [ROWS[0]] });
await sbBlocked.refreshMembers();
// จำลอง trigger protect_last_admin ปฏิเสธตอนกดปิดใช้งาน
sbBlocked.sb = mockClient({ members: [{ ...ROWS[0] }] }, { error: LAST_ADMIN_ERROR });
const blockedBtn = cells(tbodyOf(byId.memberList).children[0]).at(-1).children.find((b) => b.textContent === 'ปิดใช้งาน');
sbBlocked.__status.length = 0;
const errSpy = [];
const realError = console.error;
console.error = (...a) => errSpy.push(a);
await blockedBtn.click();
console.error = realError;
chk('ไม่ reload (ยังเป็นผู้ดูแลอยู่)', sbBlocked.__reloaded !== true);
chk(
  'โชว์ข้อความจาก trigger ให้ผู้ใช้เห็น',
  sbBlocked.__status.some(([ok, m]) => ok === false && /ผู้ดูแลระบบ/.test(m)),
  JSON.stringify(sbBlocked.__status.at(-1)?.[1]?.slice(0, 80)),
);
chk('ปุ่มกลับมาใช้งานได้อีก (ไม่ค้าง disabled)', blockedBtn.disabled === false);
chk('ไม่ reload และไม่มี error หลุดไปหาผู้ใช้', errSpy.length === 1, 'console.error ถูกเรียก ' + errSpy.length + ' ครั้ง (คาด 1 = log ไว้ตรวจ)');

// ---------- เคส 8: ปุ่มจอง ----------
console.log('\n[8] ปุ่มจองท้ายแถวตัวเอง — ต้องปิดอยู่จนกว่าหน้าจองจะพร้อม');
clearDom();
const sbBook = build({ rows: ROWS });
await sbBook.refreshMembers();
const tbBook = tbodyOf(byId.memberList);
const selfRow = rowOf(tbBook, 'ADMIN01');
const bookBtn = cells(selfRow).at(-2).children[0];
chk('แถวตัวเองมีปุ่มจอง', !!bookBtn && /จอง/.test(bookBtn.textContent), bookBtn?.textContent);
chk(
  'ปุ่มจองปิดอยู่ (หน้า booking.html ยังไม่มี — ห้ามให้กดแล้วเจอ 404)',
  bookBtn?.disabled === true && /เร็ว ๆ นี้/.test(bookBtn?.textContent || ''),
  `disabled=${bookBtn?.disabled} text=${bookBtn?.textContent}`,
);
chk('ปุ่มจองมี title บอกว่าทำไมกดไม่ได้', (bookBtn?.title || '').length > 0, bookBtn?.title);
chk(
  'แถวคนอื่นไม่มีปุ่มจองให้กดแทน',
  cells(rowOf(tbBook, 'TK01')).at(-2).children.length === 0
    && cellTexts(rowOf(tbBook, 'TK01')).at(-2) === '—',
  cellTexts(rowOf(tbBook, 'TK01')).join(' | '),
);
chk('admin เห็น 7 คอลัมน์ (รวม สถานะ + จอง + จัดการ)', cells(selfRow).length === 7, 'ได้ ' + cells(selfRow).length);

// ---------- เคส 9: crew login เข้ามา ----------
console.log('\n[9] crew — เห็นแค่แถวของตัวเอง และไม่มีปุ่มแก้ไขของ admin');
clearDom();
const sbCrew = build({
  rows: ROWS,                              // store มี 3 แถว (จำลองโหมด local ที่ RLS ไม่กรอง)
  loginEmail: 'somchai@company.com',
  role: 'crew',
  member: { id: 'u-2', code: 'TK01', full_name: 'สมชาย ใจดี', role: 'crew', active: true },
});
await sbCrew.refreshMembers();
const tbCrew = tbodyOf(byId.memberList);
chk('เห็นแถวเดียว', tbCrew.children.length === 1, 'ได้ ' + tbCrew.children.length + ' แถว');
chk(
  'แถวนั้นคือของตัวเอง (ไม่ใช่ admin)',
  cellTexts(tbCrew.children[0])[0] === 'TK01' && /← คุณ/.test(cellTexts(tbCrew.children[0]).join('|')),
  cellTexts(tbCrew.children[0] || {}).join(' | '),
);
chk('crew เห็น 5 คอลัมน์ (ไม่มี สถานะ + จัดการ)', cells(tbCrew.children[0]).length === 5, 'ได้ ' + cells(tbCrew.children[0]).length);
chk(
  'ไม่มีปุ่ม แก้ไข / ปิดใช้งาน ให้ crew',
  !cellTexts(tbCrew.children[0]).includes('แก้ไข')
    && tbCrew.children[0].children.every((c) => !c.children.some((b) => b.textContent === 'แก้ไข' || b.textContent === 'ปิดใช้งาน')),
  tbCrew.children[0].children.flatMap((c) => c.children.map((b) => b.textContent)).join(','),
);
chk('crew มีปุ่มจองของตัวเอง', /จอง/.test(cells(tbCrew.children[0]).at(-1).children[0]?.textContent || ''), cells(tbCrew.children[0]).at(-1).children[0]?.textContent);
chk(
  'summary ไม่เผยจำนวนทีมงานคนอื่น',
  !/ทั้งหมด \d+ แถว/.test(byId.memberSummary.textContent) && /บัญชีของคุณ/.test(byId.memberSummary.textContent),
  byId.memberSummary.textContent,
);
chk('แถบปิดใช้งานซ่อน (เป็นเรื่องของ admin)', byId.memberPendingBox.style.display === 'none');

// crew เรียก openMemberModal ตรง ๆ (เช่นจาก console) ต้องไม่เปิดฟอร์ม
console.log('\n[10] crew เรียก openMemberModal() ตรง ๆ — ต้องปฏิเสธ');
sbCrew.__status.length = 0;
sbCrew.__modalShown = false;
sbCrew.openMemberModal('u-2');
chk(
  'ไม่เปิด modal และบอกให้ติดต่อ admin',
  sbCrew.__modalShown === false && sbCrew.__status.some(([ok, m]) => ok === false && /crew/.test(m)),
  JSON.stringify(sbCrew.__status.at(-1)),
);

// ---------- เคส 11: ซ่อนแผงตามสิทธิ์ ----------
console.log('\n[11] applyRoleVisibility() — crew ต้องไม่เห็นแผงเครื่องมือ admin');
clearDom();
const sbVis = build({ rows: ROWS, role: 'crew' });
const ADMIN_PANELS = ['connectionPanel', 'verifyPanel', 'tipsPanel', 'dataPanel', 'memberAdminHint', 'refreshMembersBtn'];
sbVis.applyRoleVisibility(false);
chk(
  'crew: ซ่อนแผง admin ครบทุกแผง',
  ADMIN_PANELS.every((id) => byId[id].style.display === 'none'),
  ADMIN_PANELS.filter((id) => byId[id].style.display !== 'none').join(','),
);
chk('crew: โชว์คำอธิบายฝั่ง crew', byId.memberCrewHint.style.display === '');
// memberPanel ไม่ได้ถูก applyRoleVisibility แตะ (ต้องโชว์เสมอสำหรับทุกสิทธิ์)
// จึงต้องขอ element ผ่าน fakeDocument ก่อน — byId สร้างตอนถูก getElementById เท่านั้น
chk(
  'crew: แผงทีมงานยังโชว์ (เป็นแผงเดียวที่เขาเห็น)',
  (fakeDocument.getElementById('memberPanel').style.display ?? '') === '',
  'display=' + fakeDocument.getElementById('memberPanel').style.display,
);
sbVis.applyRoleVisibility(true);
chk(
  'admin: กลับมาเห็นทุกแผง',
  ADMIN_PANELS.every((id) => byId[id].style.display === ''),
  ADMIN_PANELS.filter((id) => byId[id].style.display !== '').join(','),
);
chk('admin: ซ่อนคำอธิบายฝั่ง crew', byId.memberCrewHint.style.display === 'none');

console.log(`\nสรุป: ผ่าน ${passed} / ไม่ผ่าน ${failed}\n`);
process.exit(failed ? 1 : 0);
