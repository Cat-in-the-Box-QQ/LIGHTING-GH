// test/harness.mjs - รัน data layer + auth ของเว็บใน Node โดยไม่ต้องมีเบราว์เซอร์
// จำลอง window / localStorage / fetch / supabase-js เพื่อทดสอบว่า:
//   1) โหมด Supabase ทำงาน (อ่าน/เขียน)
//   2) ถ้า Supabase พัง ระบบถอยกลับมาใช้ data/*.json + localStorage จริง
//   3) AdminAuth.signIn ผูกกับ Supabase auth ถูกต้อง
//
// รันด้วย: node test/harness.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const ROOT = path.resolve(import.meta.dirname, '..');

// ---------------- shims ----------------
function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    _dump: () => Object.fromEntries(store),
  };
}

function makeFetch() {
  return async (url) => {
    const rel = String(url).split('?')[0];
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) {
      return { ok: false, status: 404, json: async () => { throw new Error('404'); } };
    }
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(fs.readFileSync(file, 'utf8')),
      text: async () => fs.readFileSync(file, 'utf8'),
    };
  };
}

// ---------------- mock Supabase ----------------
// mode: 'ok' | 'no-table' | 'no-members' | 'network' | 'empty' | 'rls-block-write'
function makeMockSupabase(mode, seed) {
  // uid จำลอง — deterministic จากอีเมล เพื่อให้เทสต์ผูกแถว members กับบัญชีได้
  const uidFor = (email) => 'uid-' + String(email || '').toLowerCase().replace(/[^a-z0-9]/g, '_');

  const defaultMembers = [{
    id: 'm-admin',
    auth_uid: uidFor('admin@test.com'),
    code: 'ADMIN01',
    full_name: 'ผู้ดูแลระบบ ทดสอบ',
    phone: null,
    role: 'admin',
    active: true,
  }];

  const tables = {
    fixtures: seed?.fixtures ? seed.fixtures.map((r) => ({ ...r })) : [],
    accessories: seed?.accessories ? seed.accessories.map((r) => ({ ...r })) : [],
    // ค่าเริ่มต้น = สภาวะ "รัน migration แล้ว" (มี admin 1 คน)
    // ถ้าเทสต์อยากได้สภาวะอื่น ให้ส่ง seed.members มาเอง ([] = ยังไม่ได้รัน migration)
    members: (seed?.members || defaultMembers).map((r) => ({ ...r })),
  };
  // view ของระบบจองใส่ก็ต่อเมื่อเทสต์ seed มา — ถ้าไม่ใส่ คีย์จะไม่มีอยู่
  // ทำให้ query คืน "relation does not exist" เหมือนฐานข้อมูลที่ยังไม่ได้รัน migration
  // (จงใจ: ต้องทดสอบได้ว่าการ์ดไม่พังเมื่อระบบจองยังไม่พร้อม)
  if (seed?.availability) {
    tables.v_item_availability = seed.availability.map((r) => ({ ...r }));
  }
  const calls = [];
  let authed = !!seed?.authed;
  let authUser = seed?.authed ? { id: uidFor('admin@test.com'), email: 'admin@test.com' } : null;

  // session.user ของ supabase-js จริงต้องมี id เสมอ — flag นี้มีไว้เทสต์ว่า
  // ถ้า id หายไป (library เพี้ยน/เวอร์ชันเก่า) เว็บต้องไม่เดาสิทธิ์มั่ว
  const noUserId = !!seed?.noUserId;
  const sessionUser = (email) => (noUserId ? { email } : { id: uidFor(email), email });

  function errorFor(table, kind) {
    if (kind === 'no-table') return { message: `relation "public.${table}" does not exist`, code: '42P01' };
    if (kind === 'network') return { message: 'Failed to fetch' };
    if (kind === 'rls') return { message: 'new row violates row-level security policy', code: '42501' };
    return null;
  }

  // kind = 'select' | 'insert' | 'update' | 'upsert' | 'delete'
  function builder(table, kind, payload) {
    const state = { filters: [], limit: null, single: false };
    let pending = null;

    async function exec() {
      calls.push({ table, kind, payload, filters: state.filters.slice() });

      if (!tables[table]) return { data: null, error: errorFor(table, 'no-table') };
      if (mode === 'no-table' && table === 'fixtures') return { data: null, error: errorFor(table, 'no-table') };
      if (mode === 'no-members' && table === 'members') return { data: null, error: errorFor(table, 'no-table') };
      if (mode === 'network') return { data: null, error: errorFor(table, 'network') };

      if (kind === 'select') {
        if (mode === 'empty' && table === 'fixtures') return { data: [], error: null };
        let rows = tables[table];
        // ต้องกรองตาม .eq() ด้วย — ไม่งั้นเทสต์ที่ query แถวของตัวเองจากตาราง members
        // จะได้ทุกแถวกลับมา แล้วสรุปผิดว่าบัญชีนี้เป็น admin
        for (const [k, v] of state.filters) {
          rows = rows.filter((r) => String(r[k]) === String(v));
        }
        if (state.limit) rows = rows.slice(0, state.limit);
        // ของจริง .single() / .maybeSingle() คืน object เดียวหรือ null ไม่ใช่ array
        if (state.single) {
          if (rows.length > 1) {
            return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
          }
          return { data: rows.length ? { ...rows[0] } : null, error: null };
        }
        return { data: rows.map((r) => ({ ...r })), error: null };
      }

      if (mode === 'rls-block-write' && !authed) return { data: null, error: errorFor(table, 'rls') };

      const incoming = Array.isArray(payload) ? payload : [payload];
      const out = [];

      for (const row of incoming) {
        const id = state.filters.length ? state.filters[0][1] : row?.id;
        // เทียบเป็น string เพราะตาราง members ใช้ uuid เป็น id
        // Number('9f1c…') ได้ NaN และ NaN === NaN เป็น false จึงหาแถวไม่เจอเงียบ ๆ
        // (fixtures/accessories ใช้ id เป็นเลข ซึ่ง String() เทียบได้ผลเหมือนกัน)
        const idx = tables[table].findIndex((r) => String(r.id) === String(id));

        if (kind === 'delete') {
          if (idx !== -1) tables[table].splice(idx, 1);
          continue;
        }

        if (kind === 'insert' || (kind === 'upsert' && idx === -1)) {
          const newId = row.id ?? (tables[table].reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1);
          const created = { ...row, id: Number(newId) };
          tables[table].push(created);
          out.push({ ...created });
        } else {
          // update หรือ upsert ที่เจอแถวเดิมแล้ว
          if (idx === -1) continue;
          tables[table][idx] = { ...tables[table][idx], ...row };
          out.push({ ...tables[table][idx] });
        }
      }

      if (state.single) {
        return out.length
          ? { data: out[0], error: null }
          : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
      }
      return { data: out, error: null };
    }

    // supabase-js builder เป็น thenable: ทำงานตอนถูก await / .then ครั้งแรก
    const chain = {
      select: () => chain,
      insert: (v) => builder(table, 'insert', v),
      update: (v) => builder(table, 'update', v),
      upsert: (v) => builder(table, 'upsert', v),
      delete: () => builder(table, 'delete', null),
      eq: (k, v) => { state.filters.push([k, v]); return chain; },
      order: () => chain,
      limit: (n) => { state.limit = n; return chain; },
      single: () => { state.single = true; return chain; },
      maybeSingle: () => { state.single = true; return chain; },
      // จงใจมีแค่ .then() — supabase-js PostgrestBuilder เป็น PromiseLike ไม่ใช่ Promise
      // จึง "ไม่มี" .catch() / .finally() ถ้าใส่ไว้ใน mock จะเก่งกว่าของจริง
      // และปิดบังบั๊กที่เคยทำให้หน้า admin ถอยไปโหมด local (mock fidelity matters)
      then: (onF, onR) => { pending = pending || exec(); return pending.then(onF, onR); },
    };
    return chain;
  }

  return {
    _calls: calls,
    _tables: tables,
    _setAuthed: (v, u) => { authed = v; authUser = u || null; },
    from(table) {
      return {
        select: () => builder(table, 'select', null),
        insert: (v) => builder(table, 'insert', v),
        update: (v) => builder(table, 'update', v),
        upsert: (v) => builder(table, 'upsert', v),
        delete: () => builder(table, 'delete', null),
      };
    },
    auth: {
      getSession: async () => (authed
        ? { data: { session: { user: sessionUser(authUser?.email || 'admin@test.com') } }, error: null }
        : { data: { session: null }, error: null }),
      signInWithPassword: async ({ email, password }) => {
        if (mode === 'network') return { data: null, error: { message: 'Failed to fetch' } };
        // mock ยอมทุกบัญชี *@test.com ที่ใช้รหัส 'secret123'
        // เพื่อให้เทสต์สร้างทีมงาน (crew) หลายคนที่อีเมลต่างกัน แล้วผูกกับแถว members ได้
        const clean = String(email || '').trim().toLowerCase();
        if (clean.endsWith('@test.com') && password === 'secret123') {
          authed = true;
          authUser = { id: uidFor(clean), email: clean };
          return { data: { session: { user: sessionUser(clean) } }, error: null };
        }
        return { data: null, error: { message: 'Invalid login credentials' } };
      },
      signOut: async () => { authed = false; authUser = null; return { error: null }; },
    },
  };
}

// ---------------- สร้าง sandbox ----------------
function makeContext({ supabaseMode = 'ok', seed = null, supabaseLibPresent = true }) {
  const localStorage = makeLocalStorage();
  const mockSb = supabaseLibPresent ? makeMockSupabase(supabaseMode, seed) : null;

  const sandbox = {
    console,
    localStorage,
    fetch: makeFetch(),
    URLSearchParams,
    Promise,
    setTimeout,
    clearTimeout,
    Math,
    Number,
    String,
    Array,
    Object,
    JSON,
    Map,
    Set,
    Boolean,
    RegExp,
    Error,
    Date,
    isNaN,
    parseInt,
    parseFloat,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  if (mockSb) {
    sandbox.supabase = { createClient: () => mockSb };
  }
  sandbox.__mockSb = mockSb;

  const ctx = vm.createContext(sandbox);

  const files = [
    'js/supabase-config.js',
    'js/supabase-client.js',
    'js/search.js',
    'js/power.js',
    'js/database.js',
    'js/accessory-store.js',
    'js/member-store.js',
    'js/booking-store.js',
    'js/inline-member-editor.js',
    'js/admin-auth.js',
  ];
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }

  // `const DB = ...` ระดับ top-level ของ classic script จะอยู่ใน global lexical
  // scope ไม่ใช่ property ของ global object จึงต้อง export ออกมาเอง
  // (ในเบราว์เซอร์จริง script ทุกตัวแชร์ scope นี้อยู่แล้ว จึงไม่ต้องทำขั้นนี้)
  vm.runInContext(
    'window.DB = DB; window.AccessoryStore = AccessoryStore; window.AdminAuth = AdminAuth;'
    + ' window.MemberStore = MemberStore;'
    + ' window.getBatteryWh = getBatteryWh; window.isPowerSource = isPowerSource;'
    + ' window.getPowerDraw = getPowerDraw; window.hasBuiltInBattery = hasBuiltInBattery;'
    + ' window.totalPower = totalPower; window.totalBatteryWh = totalBatteryWh;'
    + ' window.countPowerSources = countPowerSources; window.estimateRuntimeHours = estimateRuntimeHours;'
    + ' window.formatWh = formatWh; window.formatHours = formatHours;'
    + ' window.powerSpecText = powerSpecText; window.powerCardText = powerCardText;'
    + ' window.currentAt220 = currentAt220; window.filterFixtures = filterFixtures;'
    + ' window.shortTagText = shortTagText;'
    + ' window.shortBadgeHtml = shortBadgeHtml;'
    + ' window.tagDetailHtml = tagDetailHtml; window.escapeAttrText = escapeAttrText;'
    + ' window.badgesHtmlFromCommaList = badgesHtmlFromCommaList;'
    + ' window.getStockCount = getStockCount; window.stockPillHtml = stockPillHtml;'
    + ' window.bookingLineHtml = bookingLineHtml;'
    + ' window.BookingStore = BookingStore;'
    + ' window.memberEditorHtml = memberEditorHtml;',
    ctx,
    { filename: 'test-export.js' }
  );

  return { ctx, sandbox, mockSb, localStorage };
}

// ---------------- tests ----------------
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
    failed++;
  }
}

function sbRowFromFixture(f) {
  return {
    id: f.id, brand: f.brand, model: f.model, category: f.category, type: f.type,
    power: f.power, power_raw: f.powerRaw, weight: f.weight, weight_raw: f.weightRaw,
    lux: f.lux, lumens: f.lumens, beam: f.beam, wireless: f.wireless,
    white_light: f.whiteLight, color: f.color, ip: f.ip, battery: f.battery,
    stock: f.stock, stock_count: f.stockCount, stock_note: f.stockNote,
    units_per_set: f.unitsPerSet, set_count_in_stock: f.setCountInStock,
    dimensions: f.dimensions, image: f.image, pdf_page: f.pdfPage,
    accessories: f.accessories || [], compatible_text: f.compatibleText || '',
    hidden: !!f.hidden, reserved: f.reserved || 0, in_use: f.inUse || 0,
    remaining: f.remaining || 0,
  };
}

function sbRowFromAccessory(a) {
  return {
    id: a.id, name: a.name, brand: a.brand, category: a.category, stock: a.stock,
    image: a.image, pdf_page: a.pdfPage, compatible_with: a.compatibleWith || [],
    hidden: !!a.hidden,
  };
}

const localFixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/fixtures.json'), 'utf8'));
const localAccessories = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/accessories.json'), 'utf8'));

console.log('\n=== โหมด Supabase ทำงานปกติ ===');

await test('DB.load() ดึงข้อมูลจาก Supabase และได้ mode = supabase', async () => {
  const seed = {
    fixtures: localFixtures.slice(0, 5).map(sbRowFromFixture),
    accessories: localAccessories.slice(0, 3).map(sbRowFromAccessory),
  };
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed });
  const rows = await sandbox.DB.load();
  assert.strictEqual(sandbox.DB.status().mode, 'supabase');
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(sandbox.DB.getById(1).brand, 'Aladdin');
});

await test('snake_case -> camelCase แปลงถูกต้อง + accessories เป็น array', async () => {
  const seed = {
    fixtures: [sbRowFromFixture({ ...localFixtures[0], powerRaw: 'X', stockCount: 9, inUse: 2, reserved: 1 })],
    accessories: [],
  };
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed });
  await sandbox.DB.load();
  const f = sandbox.DB.getById(1);
  assert.strictEqual(f.powerRaw, 'X');
  assert.strictEqual(f.stockCount, 9);
  assert.strictEqual(f.inUse, 2);
  assert.strictEqual(f.remaining, 6, 'remaining = stockCount - reserved - inUse');
  assert.ok(Array.isArray(f.accessories));
});

await test('compatible_with จากตาราง accessories ถูกรวมเข้า fixture.accessories', async () => {
  const seed = {
    fixtures: [sbRowFromFixture({ ...localFixtures[0], accessories: [] })],
    accessories: [sbRowFromAccessory({ id: 99, name: 'Test Diffuser', compatibleWith: [1] })],
  };
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed });
  await sandbox.DB.load();
  const f = sandbox.DB.getById(1);
  assert.ok(f.accessories.includes('Test Diffuser'), `ได้: ${JSON.stringify(f.accessories)}`);
  assert.ok(f.compatibleText.includes('Test Diffuser'));
});

await test('DB.update() เขียนลง Supabase จริง', async () => {
  const seed = { fixtures: [sbRowFromFixture(localFixtures[0])], accessories: [] };
  const { sandbox, mockSb } = makeContext({ supabaseMode: 'ok', seed });
  await sandbox.DB.load();
  await sandbox.DB.update(1, { model: 'Bi-Flex 1 (แก้ไขแล้ว)', stockCount: 7 });
  assert.strictEqual(mockSb._tables.fixtures[0].model, 'Bi-Flex 1 (แก้ไขแล้ว)');
  assert.strictEqual(Number(mockSb._tables.fixtures[0].stock_count), 7);
  assert.strictEqual(sandbox.DB.getById(1).model, 'Bi-Flex 1 (แก้ไขแล้ว)');
});

await test('DB.create() insert แล้วได้ id กลับมา (ไม่ใช่ Promise ค้าง)', async () => {
  const seed = { fixtures: [sbRowFromFixture(localFixtures[0])], accessories: [] };
  const { sandbox, mockSb } = makeContext({ supabaseMode: 'ok', seed });
  await sandbox.DB.load();
  const created = await sandbox.DB.create({ brand: 'Test', model: 'New Fixture', stockCount: 3 });
  assert.ok(created && typeof created === 'object' && Number.isFinite(Number(created.id)), 'create ต้องคืน object ที่มี id');
  assert.strictEqual(mockSb._tables.fixtures.length, 2);
  assert.strictEqual(sandbox.DB.getById(created.id).model, 'New Fixture');
});

await test('DB.remove() ลบออกจาก Supabase', async () => {
  const seed = { fixtures: localFixtures.slice(0, 3).map(sbRowFromFixture), accessories: [] };
  const { sandbox, mockSb } = makeContext({ supabaseMode: 'ok', seed });
  await sandbox.DB.load();
  await sandbox.DB.remove(2);
  assert.strictEqual(mockSb._tables.fixtures.length, 2);
  assert.strictEqual(sandbox.DB.getById(2), null);
});

await test('AccessoryStore โหมด supabase: อ่าน/update/create/remove', async () => {
  const seed = { fixtures: [], accessories: localAccessories.slice(0, 3).map(sbRowFromAccessory) };
  const { sandbox, mockSb } = makeContext({ supabaseMode: 'ok', seed });
  await sandbox.AccessoryStore.load();
  assert.strictEqual(sandbox.AccessoryStore.status().mode, 'supabase');
  assert.strictEqual(sandbox.AccessoryStore.getAll().length, 3);

  await sandbox.AccessoryStore.update(1, { hidden: true });
  assert.strictEqual(mockSb._tables.accessories[0].hidden, true);

  const created = await sandbox.AccessoryStore.create({ name: 'Test Acc', compatibleWith: [1, 2] });
  assert.ok(Number.isFinite(Number(created.id)));
  assert.deepStrictEqual(mockSb._tables.accessories.find((a) => a.id === created.id).compatible_with, [1, 2]);

  await sandbox.AccessoryStore.remove(created.id);
  assert.strictEqual(sandbox.AccessoryStore.getById(created.id), null);
});

console.log('\n=== fallback เมื่อ Supabase มีปัญหา ===');

await test('ตาราง fixtures ไม่มีอยู่ -> ถอยกลับมาใช้ data/fixtures.json', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'no-table', seed: { fixtures: [], accessories: [] } });
  const rows = await sandbox.DB.load();
  assert.strictEqual(sandbox.DB.status().mode, 'local');
  assert.strictEqual(rows.length, localFixtures.length, 'ต้องได้ข้อมูล local ครบ');
  assert.ok(sandbox.DB.status().error.includes('ไม่พบตาราง'), `error ควรอ่านรู้เรื่อง ได้: ${sandbox.DB.status().error}`);
});

await test('เน็ตหลุด (Failed to fetch) -> ถอยกลับมาใช้ local', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'network' });
  const rows = await sandbox.DB.load();
  assert.strictEqual(sandbox.DB.status().mode, 'local');
  assert.strictEqual(rows.length, localFixtures.length);
  assert.ok(sandbox.DB.status().error.includes('เชื่อมต่อ Supabase ไม่ได้'));
});

await test('ตารางว่างเปล่า -> ถอยกลับมาใช้ local + บอกเหตุผล', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'empty', seed: { fixtures: [], accessories: [] } });
  const rows = await sandbox.DB.load();
  assert.strictEqual(sandbox.DB.status().mode, 'local');
  assert.strictEqual(rows.length, localFixtures.length);
  assert.ok(sandbox.DB.status().error.includes('ว่างเปล่า'));
});

await test('ไม่มี supabase-js (CDN หลุด) -> window.sb เป็น null แต่ไม่ throw, ใช้ local ได้', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  assert.strictEqual(sandbox.sb, null);
  assert.ok(sandbox.SB_DIAG.error, 'ต้องมีข้อความบอกเหตุผล');
  const rows = await sandbox.DB.load();
  assert.strictEqual(sandbox.DB.status().mode, 'local');
  assert.strictEqual(rows.length, localFixtures.length);
  assert.strictEqual(sandbox.SB_DIAG.libLoaded, false);
});

await test('โหมด local: แก้ไขแล้วเก็บใน localStorage + reload ยังอยู่', async () => {
  const { sandbox, localStorage } = makeContext({ supabaseMode: 'no-table' });
  await sandbox.DB.load();
  await sandbox.DB.update(1, { model: 'Local Edit' });
  assert.ok(localStorage.getItem('lighting_db_fixtures_v6'), 'ต้องเขียนลง localStorage');
  assert.strictEqual(sandbox.DB.getById(1).model, 'Local Edit');
});

await test('SUPABASE_ALLOW_LOCAL_FALLBACK = false -> โยน error แทนการถอยกลับมาเงียบ ๆ', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'no-table' });
  sandbox.SUPABASE_ALLOW_LOCAL_FALLBACK = false;
  await assert.rejects(() => sandbox.DB.load(), /ไม่พบตาราง/);
});

await test('DB.importLocalToSupabase() seed ข้อมูล local ขึ้นตารางที่ว่างได้', async () => {
  const { sandbox, mockSb } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [], accessories: [] } });
  const n = await sandbox.DB.importLocalToSupabase();
  assert.strictEqual(n, localFixtures.length);
  assert.strictEqual(mockSb._tables.fixtures.length, localFixtures.length);
  const m = await sandbox.AccessoryStore.importLocalToSupabase();
  assert.strictEqual(m, localAccessories.length);
  assert.strictEqual(mockSb._tables.accessories.length, localAccessories.length);
});

console.log('\n=== AdminAuth (Supabase email + password) ===');

await test('signIn ด้วย credential ถูก -> unlocked + ได้ email', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [sbRowFromFixture(localFixtures[0])], accessories: [] } });
  await sandbox.AdminAuth.ready;
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), false, 'ตอนแรกต้องยังไม่ปลดล็อก');
  const res = await sandbox.AdminAuth.signIn('admin@test.com', 'secret123');
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), true);
  assert.strictEqual(sandbox.AdminAuth.getEmail(), 'admin@test.com');
});

await test('signIn ด้วย credential ผิด -> ไม่ unlocked + ได้ข้อความไทยอ่านรู้เรื่อง', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [sbRowFromFixture(localFixtures[0])], accessories: [] } });
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('admin@test.com', 'wrongpass');
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.includes('Email หรือรหัสผ่านไม่ถูกต้อง'), `ได้: ${res.error}`);
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), false);
});

await test('signIn โดยเว้นช่องว่าง -> แจ้งให้กรอกให้ครบ', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [sbRowFromFixture(localFixtures[0])], accessories: [] } });
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('', '');
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.includes('กรุณากรอก'));
});

await test('session เดิมถูกกู้กลับมาตอนเปิดหน้า (ready)', async () => {
  // ต้องตั้ง authed "ก่อน" สร้าง context เพราะ AdminAuth.ready เรียก getSession ทันทีที่โหลดสคริปต์
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: { fixtures: [sbRowFromFixture(localFixtures[0])], accessories: [], authed: true },
  });
  await sandbox.AdminAuth.ready;
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), true, 'ต้องกู้ session เดิมได้');
  assert.strictEqual(sandbox.AdminAuth.getEmail(), 'admin@test.com');
});

await test('signOut -> กลับมาล็อก', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [sbRowFromFixture(localFixtures[0])], accessories: [] } });
  await sandbox.AdminAuth.ready;
  await sandbox.AdminAuth.signIn('admin@test.com', 'secret123');
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), true);
  await sandbox.AdminAuth.signOut();
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), false);
});

// uid จำลองต้องตรงกับสูตรใน mock: 'uid-' + email ที่แทนอักขระพิเศษด้วย _
const uidFor = (email) => 'uid-' + String(email).toLowerCase().replace(/[^a-z0-9]/g, '_');

console.log('\n=== สิทธิ์ตามตาราง members (ไม่ใช่แค่ login ผ่าน) ===');

await test('SUPABASE_ADMIN_EMAILS ไม่ใช้ตัดสินสิทธิ์อีกแล้ว — ตาราง members ต่างหากที่ตัดสิน', async () => {
  // ของเดิม: allowlist ไม่ว่าง = บัญชีนอกรายชื่อเข้าไม่ได้
  // ตอนนี้: allowlist เป็นแค่ทางออกฉุกเฉินตอนอ่านตาราง members ไม่ได้
  // ถ้าอ่านได้ คำตอบจากตารางเท่านั้นที่เป็นจริง
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [], accessories: [] } });
  sandbox.SUPABASE_ADMIN_EMAILS = ['boss@company.com'];
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('admin@test.com', 'secret123');
  assert.strictEqual(res.ok, true, 'มีแถว role=admin ใน members ต้องเข้าได้ แม้ไม่อยู่ใน allowlist');
  assert.strictEqual(sandbox.AdminAuth.getRole(), 'admin');
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), true);
});

await test('crew: login ผ่าน แต่ต้องไม่ได้โหมด admin', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      members: [{ id: 'm-crew', auth_uid: uidFor('crew@test.com'), code: 'TK01', full_name: 'ช่างไฟ ทดสอบ', role: 'crew', active: true }],
    },
  });
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('crew@test.com', 'secret123');
  assert.strictEqual(res.ok, false, 'crew ต้องไม่ถูกปลดล็อกเป็น admin');
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), false);
  // แต่ยัง login ค้างไว้ — ระบบจองต้องใช้ session นี้
  assert.strictEqual(sandbox.AdminAuth.isLoggedIn(), true, 'crew ต้องยัง login อยู่');
  assert.strictEqual(sandbox.AdminAuth.getRole(), 'crew');
  assert.strictEqual(sandbox.AdminAuth.getMemberCode(), 'TK01');
  assert.ok(res.error.includes('crew'), `ข้อความต้องบอกสิทธิ์จริง: ${res.error}`);
});

await test('login ผ่านแต่ไม่มีแถวใน members -> ไม่ได้ admin + session ยังอยู่', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [], accessories: [], members: [] } });
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('stranger@test.com', 'secret123');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), false);
  assert.strictEqual(sandbox.AdminAuth.isLoggedIn(), true, 'ต้องไม่ signOut ทิ้ง — เผื่อใช้จองของ');
  assert.ok(res.error.includes('ไม่พบบัญชี'), `ได้: ${res.error}`);
  assert.ok(res.error.includes('members'), `ต้องบอกชื่อตาราง: ${res.error}`);
});

await test('สมาชิกที่ถูกปิด (active=false) ต้องไม่ได้สิทธิ์แม้ role เป็น admin', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      members: [{ id: 'm-off', auth_uid: uidFor('off@test.com'), code: 'XX99', full_name: 'ปิดใช้งาน', role: 'admin', active: false }],
    },
  });
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('off@test.com', 'secret123');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), false);
  assert.ok(res.error.includes('ปิดใช้งาน'), `ได้: ${res.error}`);
});

await test('ตาราง members หาย + allowlist ว่าง -> ปิดตาย (fail closed) พร้อมบอกวิธีแก้', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'no-members', seed: { fixtures: [], accessories: [] } });
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('admin@test.com', 'secret123');
  assert.strictEqual(res.ok, false, 'อ่านสิทธิ์ไม่ได้ต้องไม่เดาว่าเป็น admin');
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), false);
  assert.ok(res.error.includes('migration-2026-10-22-members.sql'), `ต้องชี้ไปไฟล์ SQL: ${res.error}`);
});

await test('ตาราง members หาย + อีเมลอยู่ใน allowlist -> เข้าได้ชั่วคราว (ทางออกช่วงเปลี่ยนผ่าน)', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'no-members', seed: { fixtures: [], accessories: [] } });
  sandbox.SUPABASE_ADMIN_EMAILS = ['admin@test.com'];
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('admin@test.com', 'secret123');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(sandbox.AdminAuth.getRole(), 'admin');
  assert.ok(sandbox.AdminAuth.getRoleError().includes('ชั่วคราว'), `ต้องบอกว่าเป็นทางออกชั่วคราว: ${sandbox.AdminAuth.getRoleError()}`);
  assert.strictEqual(sandbox.AdminAuth.getLastError(), null, 'login สำเร็จต้องไม่ค้างข้อความ error');
  assert.ok(sandbox.AdminAuth.status().roleError, 'status() ต้องเปิดเผยสถานะชั่วคราวให้หน้าเว็บโชว์ได้');
});

await test('อ่านตาราง members ได้แต่ไม่มีแถว -> allowlist ต้องพลิกคำตัดสินไม่ได้', async () => {
  // แยกให้ออกระหว่าง "อ่านไม่ได้" (ใช้ทางออกฉุกเฉินได้) กับ "อ่านได้แต่ไม่มีสิทธิ์" (ปฏิเสธสถานเดียว)
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [], accessories: [], members: [] } });
  sandbox.SUPABASE_ADMIN_EMAILS = ['admin@test.com'];
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('admin@test.com', 'secret123');
  assert.strictEqual(res.ok, false, 'ตารางอ่านได้และบอกว่าไม่มีแถว = ไม่มีสิทธิ์จริง');
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), false);
  assert.ok(res.error.includes('ไม่พบบัญชี'), `ได้: ${res.error}`);
});

await test('session ไม่มี user id -> ไม่ยิง query ทิ้ง และไม่เดาสิทธิ์มั่ว', async () => {
  const { sandbox, mockSb } = makeContext({
    supabaseMode: 'ok',
    seed: { fixtures: [], accessories: [], noUserId: true },
  });
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('admin@test.com', 'secret123');
  assert.strictEqual(res.ok, false, 'ไม่มี uid ต้องไม่ถือเป็น admin');
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), false);
  assert.strictEqual(
    mockSb._calls.filter((c) => c.table === 'members').length, 0,
    'ไม่มี uid จะกรองแถวไม่ได้ ต้องไม่ยิง query ที่ให้คำตอบผิด'
  );
  assert.ok(sandbox.AdminAuth.getRoleError().includes('user id'), `ต้องบอกสาเหตุจริง: ${sandbox.AdminAuth.getRoleError()}`);
});

await test('session ไม่มี user id + allowlist -> ยังใช้ทางออกฉุกเฉินได้', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: { fixtures: [], accessories: [], noUserId: true },
  });
  sandbox.SUPABASE_ADMIN_EMAILS = ['admin@test.com'];
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('admin@test.com', 'secret123');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(sandbox.AdminAuth.getRole(), 'admin');
});

await test('query หาแถวของตัวเองต้องกรองด้วย auth_uid (ไม่เหมาแถวคนอื่น)', async () => {
  // ถ้า mock/โค้ดไม่กรอง .eq() จะเห็นแถว admin ของคนอื่นแล้วสรุปว่าตัวเองเป็น admin
  const { sandbox, mockSb } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      members: [
        { id: 'm-admin', auth_uid: uidFor('admin@test.com'), code: 'ADMIN01', full_name: 'แอดมิน', role: 'admin', active: true },
        { id: 'm-crew', auth_uid: uidFor('crew@test.com'), code: 'TK01', full_name: 'ช่างไฟ', role: 'crew', active: true },
      ],
    },
  });
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('crew@test.com', 'secret123');
  assert.strictEqual(res.ok, false, 'มีแถว admin ของคนอื่นอยู่ในตาราง แต่ต้องไม่เอามาเป็นของตัวเอง');
  assert.strictEqual(sandbox.AdminAuth.getMemberCode(), 'TK01');
  const memberCalls = mockSb._calls.filter((c) => c.table === 'members');
  assert.ok(memberCalls.length >= 1, 'ต้องมีการ query ตาราง members');
  assert.deepStrictEqual(
    memberCalls[memberCalls.length - 1].filters,
    [['auth_uid', uidFor('crew@test.com')]],
    'ต้องกรองด้วย auth_uid ของตัวเองเท่านั้น'
  );
});

await test('เน็ตหลุดตอน login -> ได้ข้อความอธิบาย ไม่ใช่ crash', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'network' });
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('admin@test.com', 'secret123');
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.includes('เชื่อมต่อ Supabase ไม่ได้'), `ได้: ${res.error}`);
});

await test('ไม่มี supabase-js -> signIn คืน error แทนการ throw', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('admin@test.com', 'secret123');
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.length > 0);
});

console.log('\n=== กันบั๊ก .catch() บน Supabase builder เกิดซ้ำ ===');

await test('mock builder ซื่อตรงกับ supabase-js: มี .then() แต่ไม่มี .catch()/.finally()', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [], accessories: [] } });
  const b = sandbox.sb.from('fixtures').select('*');
  assert.strictEqual(typeof b.then, 'function', 'builder ต้องเป็น PromiseLike (มี .then)');
  assert.strictEqual(b.catch, undefined, 'mock ต้องไม่มี .catch() เหมือน supabase-js จริง');
  assert.strictEqual(b.finally, undefined, 'mock ต้องไม่มี .finally() เหมือน supabase-js จริง');
});

await test('โค้ดใน js/ ไม่ต่อ .catch()/.finally() ท้าย query builder ของ Supabase', async () => {
  // นี่คือ static scan: บั๊กเดิมคือ
  //   window.sb.from(...).select(...).catch(() => null)
  // ซึ่งโยน TypeError ก่อนยิง query จริง ทำให้ถอยไปโหมด local โดยไม่รู้สาเหตุ
  //
  // ไล่ chain ย้อนกลับจากจุดที่เรียก .catch/.finally แล้วดูว่า receiver จริงคือใคร
  // (ใช้ regex ง่าย ๆ จะ false positive กับ fetch(...).catch(...) ซึ่งถูกเพราะ fetch คืน Promise จริง)
  function receiverChain(code, dotIdx) {
    let i = dotIdx - 1;
    let depth = 0;
    while (i >= 0) {
      const c = code[i];
      if (c === ')' || c === ']' || c === '}') { depth++; i--; continue; }
      if (c === '(' || c === '[' || c === '{') {
        if (depth === 0) break;      // เจอวงเล็บเปิดของ call ที่ครอบอยู่ = chain เริ่มหลังมัน
        depth--; i--; continue;
      }
      if (depth === 0 && !/[A-Za-z0-9_$.\s]/.test(c)) break;  // terminator เช่น ; , = +
      i--;
    }
    return code.slice(i + 1, dotIdx);
  }

  const jsDir = path.join(ROOT, 'js');
  const offenders = [];
  for (const f of fs.readdirSync(jsDir).filter((x) => x.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(jsDir, f), 'utf8');
    const re = /\.(catch|finally)\s*\(/g;
    let m;
    while ((m = re.exec(code))) {
      const chain = receiverChain(code, m.index);
      if (!/window\.sb\b/.test(chain)) continue;   // ไม่ใช่ builder ของ Supabase -> ข้าม
      const line = code.slice(0, m.index).split('\n').length;
      offenders.push(`${f}:${line} -> ${chain.trim().slice(-70)}.${m[1]}()`);
    }
  }
  assert.deepStrictEqual(offenders, [], `พบการต่อ .catch()/.finally() บน Supabase builder:\n  ${offenders.join('\n  ')}`);
});

await test('ตาราง accessories พัง ต้องไม่ล้มการโหลด fixtures', async () => {
  // เดิมใช้ .catch() กลบ error ของ accessories — ตอนนี้เป็น safeQuery แล้ว
  // ต้องยังอ่าน fixtures ได้ปกติแม้ accessories จะ error
  const { sandbox, mockSb } = makeContext({ supabaseMode: 'ok', seed: { fixtures: localFixtures.slice(0, 4).map(sbRowFromFixture), accessories: [] } });
  const realFrom = mockSb.from.bind(mockSb);
  mockSb.from = (t) => (t === 'accessories'
    ? { select: () => Promise.resolve({ data: null, error: { message: 'permission denied for table accessories' } }) }
    : realFrom(t));
  const rows = await sandbox.DB.load();
  assert.strictEqual(sandbox.DB.status().mode, 'supabase', 'fixtures ต้องยังเชื่อม Supabase ได้');
  assert.strictEqual(rows.length, 4);
});

console.log('\n=== แบตเตอรี่: ความจุ Wh แทนวัตต์ที่กิน ===');

await test('แยกแหล่งจ่ายไฟออกจากตัวกินไฟได้ถูกต้อง', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  assert.strictEqual(sandbox.isPowerSource({ type: 'power', category: 'Battery', brand: 'FXLION' }), true);
  assert.strictEqual(sandbox.isPowerSource({ type: 'power', category: 'Power Station', brand: 'EcoFlow' }), true);
  assert.strictEqual(sandbox.isPowerSource({ brand: 'Battery', category: 'x' }), true);
  // ไฟที่มีแบตในตัว ยังเป็นตัว "กินไฟ" ไม่ใช่แหล่งจ่าย
  assert.strictEqual(sandbox.isPowerSource({ type: 'fixture', category: 'Battery Par', brand: 'Astera' }), false);
  assert.strictEqual(sandbox.isPowerSource({ type: 'fixture', category: 'Panel', brand: 'Arri' }), false);
});

await test('getPowerDraw: แหล่งจ่ายไฟ = 0 วัตต์', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  assert.strictEqual(sandbox.getPowerDraw({ type: 'power', power: 3600 }), 0, 'แบตเตอรี่ต้องไม่ถูกนับเป็นโหลด');
  assert.strictEqual(sandbox.getPowerDraw({ type: 'fixture', power: 200 }), 200);
  assert.strictEqual(sandbox.getPowerDraw({ type: 'fixture', power: null }), 0);
});

await test('getBatteryWh อ่านค่าที่ระบุไว้ตรง ๆ', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  assert.strictEqual(sandbox.getBatteryWh({ batteryWh: 99 }), 99);
  assert.strictEqual(sandbox.getBatteryWh({ batteryWh: 150.5 }), 150.5);
});

await test('getBatteryWh แปลง kWh -> Wh', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  // EcoFlow DELTA Pro ของจริง: battery = '3.6kWh LFP power station'
  assert.strictEqual(sandbox.getBatteryWh({ type: 'power', battery: '3.6kWh LFP power station' }), 3600);
  assert.strictEqual(sandbox.getBatteryWh({ battery: '1.5 kWh' }), 1500);
});

await test('getBatteryWh อ่าน Wh จาก powerRaw', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  assert.strictEqual(
    sandbox.getBatteryWh({ type: 'power', powerRaw: '3600W AC output / 7200W surge / 3600Wh capacity' }),
    3600,
    'ต้องจับ 3600Wh capacity ไม่ใช่ 3600W output'
  );
  assert.strictEqual(sandbox.getBatteryWh({ powerRaw: '99Wh V-Mount' }), 99);
});

await test('getBatteryWh คำนวณจาก "วัตต์ x ชั่วโมง" ใน powerRaw', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  // Astera Ax3: powerRaw '15 W (20 H.)' -> 15 x 20 = 300 Wh
  assert.strictEqual(sandbox.getBatteryWh({ power: 15, powerRaw: '15 W (20 H.)', battery: 'Built-in battery' }), 300);
  assert.strictEqual(sandbox.getBatteryWh({ power: 45, powerRaw: '45 W ( 20 H.)' }), 900);
  assert.strictEqual(sandbox.getBatteryWh({ power: 14, powerRaw: '14 W (3 H.)' }), 42);
  assert.strictEqual(sandbox.getBatteryWh({ power: 70, powerRaw: '70 W (20 hrs)' }), 1400);
});

await test('getBatteryWh คืน null เมื่อเดาไม่ได้ (ห้ามมั่วสเปก)', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  // FXLION V-Mount ยังไม่รู้ความจุจริง -> ต้องเว้นว่าง ไม่เดา
  assert.strictEqual(sandbox.getBatteryWh({ type: 'power', brand: 'FXLION', model: 'V-Mount 14.8V', power: null, battery: '14.8V V-Mount battery' }), null);
  assert.strictEqual(sandbox.getBatteryWh({ type: 'fixture', power: 200, category: 'Panel' }), null);
});

await test('totalPower ไม่รวมแหล่งจ่ายไฟเป็นโหลด', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const items = [
    { fixture: { type: 'fixture', power: 200 }, qty: 2 },        // 400 W
    { fixture: { type: 'fixture', power: 100 }, qty: 1 },        // 100 W
    { fixture: { type: 'power', category: 'Power Station', power: 3600, battery: '3.6kWh' }, qty: 1 }, // ไม่ใช่โหลด
  ];
  assert.strictEqual(sandbox.totalPower(items), 500, 'เดิมจะบวกเป็น 4100 W ซึ่งผิด');
});

await test('totalBatteryWh รวมความจุทุกก้อนในชุด', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const items = [
    { fixture: { type: 'fixture', power: 200 }, qty: 2 },
    { fixture: { type: 'power', category: 'Power Station', battery: '3.6kWh LFP' }, qty: 1 },
    { fixture: { type: 'power', category: 'Battery', batteryWh: 99 }, qty: 4 },
  ];
  assert.strictEqual(sandbox.totalBatteryWh(items), 3600 + 396);
  assert.strictEqual(sandbox.countPowerSources(items), 5);
});

await test('estimateRuntimeHours คำนวณ runtime จากความจุ / โหลด', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  assert.strictEqual(sandbox.estimateRuntimeHours(3600, 600), 6);
  assert.strictEqual(sandbox.estimateRuntimeHours(0, 600), null, 'ไม่มีความจุ -> บอกไม่ได้');
  assert.strictEqual(sandbox.estimateRuntimeHours(3600, 0), null, 'ไม่มีโหลด -> บอกไม่ได้');
  assert.strictEqual(sandbox.estimateRuntimeHours(null, null), null);
});

await test('formatWh / formatHours แสดงผลอ่านง่าย', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  assert.strictEqual(sandbox.formatWh(99), '99 Wh');
  assert.strictEqual(sandbox.formatWh(3600), '3.6 kWh');
  assert.strictEqual(sandbox.formatWh(null), '-');
  assert.strictEqual(sandbox.formatHours(6), '6 ชม.');
  assert.strictEqual(sandbox.formatHours(1.5), '1 ชม. 30 นาที');
  assert.strictEqual(sandbox.formatHours(0.5), '30 นาที');
  assert.strictEqual(sandbox.formatHours(null), '-');
});

await test('powerSpecText: แบตเตอรี่โชว์ Wh, ไฟปกติโชว์ W', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const delta = { type: 'power', category: 'Power Station', power: 3600, powerRaw: '3600W AC output / 7200W surge / 3600Wh capacity', battery: '3.6kWh LFP power station' };
  const text = sandbox.powerSpecText(delta);
  assert.ok(text.includes('3.6 kWh'), `ต้องโชว์ความจุ ไม่ใช่ 3600 W ได้: ${text}`);
  assert.ok(!/^3600 W/.test(text), 'ต้องไม่ขึ้นต้นด้วยวัตต์ที่กิน');

  const vmount = { type: 'power', category: 'Battery', brand: 'FXLION', model: 'V-Mount 14.8V', power: null, battery: '14.8V V-Mount battery' };
  assert.strictEqual(sandbox.powerSpecText(vmount), 'ไม่ระบุความจุ (Wh)');

  const arri = { type: 'fixture', category: 'Panel', power: 200, powerRaw: '48 VDC <200 W Maximum>' };
  assert.strictEqual(sandbox.powerSpecText(arri), '48 VDC <200 W Maximum>');
});

await test('powerSpecText: ไฟที่มีแบตในตัว บอกความจุต่อท้าย', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const ax3 = { type: 'fixture', category: 'Battery Par', power: 15, powerRaw: '15 W (20 H.)', battery: 'Built-in battery' };
  const text = sandbox.powerSpecText(ax3);
  assert.ok(text.includes('15 W (20 H.)'), `ต้องคงกำลังไฟที่กินไว้ ได้: ${text}`);
  assert.ok(text.includes('แบต 300 Wh'), `ต้องบอกความจุที่คำนวณได้ ได้: ${text}`);
});

await test('currentAt220: แหล่งจ่ายไฟไม่คำนวณกระแส', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  assert.strictEqual(sandbox.currentAt220({ type: 'power', power: 3600 }), '-');
  assert.strictEqual(sandbox.currentAt220({ type: 'fixture', power: 220 }), '1.00');
  assert.strictEqual(sandbox.currentAt220({ type: 'fixture', power: null }), '-');
});

await test('ข้อมูลจริงใน data/fixtures.json: EcoFlow + Astera + FXLION', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const byId = new Map(localFixtures.map((f) => [f.id, f]));

  const delta = byId.get(63);
  assert.ok(delta, 'ต้องมี EcoFlow DELTA Pro id=63');
  assert.strictEqual(sandbox.isPowerSource(delta), true);
  assert.strictEqual(sandbox.getPowerDraw(delta), 0, 'DELTA Pro ต้องไม่ถูกนับเป็นโหลด 3600W');
  assert.strictEqual(sandbox.getBatteryWh(delta), 3600, 'ความจุต้องเป็น 3600 Wh');

  const ax3 = byId.get(24);
  assert.ok(ax3, 'ต้องมี Astera Ax3 id=24');
  assert.strictEqual(sandbox.isPowerSource(ax3), false, 'Ax3 เป็นไฟ ไม่ใช่แหล่งจ่าย');
  assert.strictEqual(sandbox.getPowerDraw(ax3), 15, 'Ax3 กิน 15 W ต้องคงไว้');
  assert.strictEqual(sandbox.getBatteryWh(ax3), 300, '15 W x 20 H. = 300 Wh');

  const vmount = byId.get(61);
  assert.ok(vmount, 'ต้องมี FXLION V-Mount id=61');
  assert.strictEqual(sandbox.isPowerSource(vmount), true);
  assert.strictEqual(sandbox.getBatteryWh(vmount), null, 'ยังไม่รู้ความจุจริง ต้องไม่เดา');
});

await test('ตัวกรอง maxPower ไม่กรองแหล่งจ่ายไฟทิ้ง', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const items = [
    { id: 1, type: 'fixture', category: 'Panel', power: 200 },
    { id: 2, type: 'fixture', category: 'Panel', power: 1200 },
    { id: 63, type: 'power', category: 'Power Station', power: 3600, battery: '3.6kWh LFP power station' },
  ];
  const out = sandbox.filterFixtures(items, { maxPower: '500' });
  const ids = out.map((x) => x.id).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [1, 63],
    'เดิมจะได้แค่ [1] เพราะ DELTA Pro power=3600 โดนกรองทิ้ง ทั้งที่เป็นแหล่งจ่ายไฟไม่ใช่โหลด');
});

await test('getBatteryWh ต้องไม่อ่าน Hz (ความถี่ไฟบ้าน) เป็นชั่วโมง', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  // บั๊กจริงที่เคยเจอ: regex จับ '60Hz' เป็น '60 ชั่วโมง' แล้วคูณกับวัตต์
  // ทำให้ Avolites Tiger Touch II (DMX console กินไฟ AC) ถูกเดาเป็น 4800 Wh
  assert.strictEqual(sandbox.getBatteryWh({ power: 80, powerRaw: '80 W / 110-240V AC 50-60Hz' }), null);
  assert.strictEqual(sandbox.getBatteryWh({ power: 12, powerRaw: '12 W / 100-240VAC 47-70Hz / 0.12A' }), null);
  assert.strictEqual(sandbox.getBatteryWh({ power: 15, powerRaw: '15 W / 100-240V AC 50-60Hz' }), null);
});

await test('getBatteryWh ยังอ่านชั่วโมงได้จริงเมื่อเป็น runtime ไม่ใช่ Hz', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  assert.strictEqual(sandbox.getBatteryWh({ power: 70, powerRaw: '70 W (20 hrs)' }), 1400);
  assert.strictEqual(sandbox.getBatteryWh({ power: 17, powerRaw: '17 W (20 hours)' }), 340);
  assert.strictEqual(sandbox.getBatteryWh({ power: 15, powerRaw: '15 W (20 H.)' }), 300);
});

await test('อุปกรณ์กินไฟ AC ต้องไม่ถูกเดาว่ามีความจุแบตเตอรี่', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  // ข้อมูลจริงใน data/fixtures.json
  const byId = new Map(localFixtures.map((f) => [f.id, f]));
  const avolites = byId.get(54);
  assert.ok(avolites, 'ต้องมี Avolites Tiger Touch II id=54');
  assert.strictEqual(sandbox.getBatteryWh(avolites), null,
    'DMX console กินไฟ AC ไม่มีแบต ต้องไม่เดาความจุ');
  const lumenradio = byId.get(60);
  assert.ok(lumenradio, 'ต้องมี LumenRadio CRMX Nova TX2 id=60');
  assert.strictEqual(sandbox.getBatteryWh(lumenradio), null);
  // แต่ Gaffer's Control มีแบตจริง 70Wh ในฟิลด์ battery
  const gaffers = byId.get(55);
  assert.ok(gaffers, "ต้องมี Gaffer's Control id=55");
  assert.strictEqual(sandbox.getBatteryWh(gaffers), 70, 'ต้องอ่าน 70Wh จากฟิลด์ battery ได้');
});

// ---------------- ย่อ tag บนการ์ด: ตัดส่วนในวงเล็บ ----------------
console.log('\n[ ย่อ tag บนการ์ด ]');

await test('shortTagText ตัดส่วนในวงเล็บออก เหลือแค่หัว tag', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  assert.strictEqual(
    sandbox.shortTagText('IP65 (ทั้งหัวไฟ, Control Box และสายเคเบิล)'), 'IP65');
  assert.strictEqual(sandbox.shortTagText('IP65 [head only]'), 'IP65');
});

await test('shortTagText ต้องไม่เปลี่ยนค่าเดิมที่ไม่มีวงเล็บ (ไม่กระทบข้อมูลเก่า)', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  // ค่า ip จริงทั้งหมดใน data/fixtures.json ไม่มีวงเล็บ ต้องได้ค่าเดิมทุกตัว
  for (const ip of ['IP32', 'IP54', 'IP65', 'IP66', 'IP20', 'IP44', 'IPX5']) {
    assert.strictEqual(sandbox.shortTagText(ip), ip);
  }
  assert.strictEqual(sandbox.shortTagText(''), '');
  assert.strictEqual(sandbox.shortTagText(null), '');
  assert.strictEqual(sandbox.shortTagText(undefined), '');
});

await test('shortTagText ต้องไม่คืนค่าว่างจน badge หาย', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  // ขึ้นต้นด้วยวงเล็บเลย — ถ้าตัดแล้วได้ '' badge จะว่างเปล่า จึงต้องคืนค่าเดิม
  assert.strictEqual(sandbox.shortTagText('(เริ่มด้วยวงเล็บ)'), '(เริ่มด้วยวงเล็บ)');
  assert.strictEqual(sandbox.shortTagText('   IP65   '), 'IP65');
});

await test('shortBadgeHtml ใส่ title ให้ hover ดูค่าเต็มได้', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const full = 'IP65 (ทั้งหัวไฟ, Control Box และสายเคเบิล)';
  const html = sandbox.shortBadgeHtml(full);

  // แยก "ข้อความที่มองเห็น" ออกจาก attribute — คนละเรื่องกัน
  // (ข้อความเต็มต้องอยู่ใน title แต่ต้องไม่หลุดออกมาเป็น label)
  const label = html.match(/>([^<]*)<\/span>$/)?.[1];
  const title = html.match(/title="([^"]*)"/)?.[1];

  assert.strictEqual(label, 'IP65', 'ข้อความบน badge ต้องเหลือแค่หัว tag');
  assert.strictEqual(title, full, 'title ต้องเก็บค่าเต็มไว้ให้ hover ดู');

  // ไม่มีวงเล็บ -> ไม่มี title เกินมา
  assert.strictEqual(sandbox.shortBadgeHtml('IP65'), '<span class="badge bg-secondary">IP65</span>');
  assert.strictEqual(sandbox.shortBadgeHtml(''), '');
});

await test('shortBadgeHtml ต้อง escape ค่าที่ผู้ใช้กรอก (กันพัง attribute)', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const html = sandbox.shortBadgeHtml('IP65 (มี "quote" และ <tag>)');
  assert.ok(!html.includes('"quote"'), 'ต้อง escape " ใน title ไม่งั้น attribute พัง');
  assert.ok(html.includes('&quot;quote&quot;'));
  assert.ok(html.includes('&lt;tag&gt;'));
});

await test('tagDetailHtml แสดงหัว tag + ส่วนขยายในวงเล็บ (หน้ารายละเอียด)', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const html = sandbox.tagDetailHtml('IP65 (ทั้งหัวไฟ, Control Box และสายเคเบิล)');
  assert.ok(html.startsWith('IP65 '), 'ต้องขึ้นด้วยหัว tag');
  assert.ok(html.includes('(ทั้งหัวไฟ, Control Box และสายเคเบิล)'), 'ต้องมีส่วนขยาย');
  assert.ok(html.includes('text-muted'), 'ส่วนขยายต้องเป็น muted');
  assert.strictEqual(sandbox.tagDetailHtml('IP65'), 'IP65');
  assert.strictEqual(sandbox.tagDetailHtml(''), '-');   // ตรงกับรูปแบบ spec-row เดิม
  assert.strictEqual(sandbox.tagDetailHtml(null), '-');
});

await test('badgesHtmlFromCommaList: short=true ย่อทุก tag, ค่า default ยังแสดงเต็ม', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const short = sandbox.badgesHtmlFromCommaList('LED, IP65 (ทั้งหัวไฟ)', 'bg-dark', { short: true });
  assert.ok(short.includes('>LED</span>'));
  assert.ok(short.includes('>IP65</span>'), 'ต้องย่อเหลือ IP65');
  assert.ok(!short.includes('ทั้งหัวไฟ</span>'), 'ห้ามโชว์ส่วนขยายเป็นข้อความ badge');
  const full = sandbox.badgesHtmlFromCommaList('LED, IP65 (ทั้งหัวไฟ)', 'bg-dark');
  assert.ok(full.includes('IP65 (ทั้งหัวไฟ)'), 'ค่า default ต้องแสดงเต็มเหมือนเดิม');
});

await test('tagDetailHtml ต้องไม่ทำข้อมูลหายเมื่อมีหลายวงเล็บ', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  // ค่า beam จริงใน data/fixtures.json มี 16 รายการที่เป็นรูปแบบนี้
  // ถ้าประกอบใหม่จาก "หัว tag + วงเล็บแรก" จะได้แค่ '62° (Hyper-Reflector)'
  // คือหายทั้ง '/ 93° (No Reflector)'
  const beam = '62° (Hyper-Reflector) / 93° (No Reflector)';
  const html = sandbox.tagDetailHtml(beam);
  assert.strictEqual(html.replace(/<[^>]*>/g, ''), beam,
    'ถอด tag HTML แล้วต้องได้ข้อความเดิมครบทุกตัวอักษร');
  assert.ok(html.includes('93°'), 'ต้องมีค่าที่สอง');
  assert.ok(html.includes('No Reflector'), 'ต้องมีคำอธิบายวงเล็บที่สอง');

  const multi = 'IP65 (หัวไฟ) / IP54 (Control Box)';
  assert.strictEqual(sandbox.tagDetailHtml(multi).replace(/<[^>]*>/g, ''), multi);
});

await test('splitTagParts ต้องไม่แยก comma ที่อยู่ข้างในวงเล็บ', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  // คำอธิบายในวงเล็บมี comma ได้ — ต้องนับเป็น tag เดียว
  assert.deepStrictEqual(
    [...sandbox.splitTagParts('LED (หัวไฟ, Control Box และสายเคเบิล)')],
    ['LED (หัวไฟ, Control Box และสายเคเบิล)']);
  // แต่ comma นอกวงเล็บยังแยกตามเดิม
  assert.deepStrictEqual([...sandbox.splitTagParts('LED (หัวไฟ), Fresnel')], ['LED (หัวไฟ)', 'Fresnel']);
  assert.deepStrictEqual([...sandbox.splitTagParts('LED, Fresnel, DMX')], ['LED', 'Fresnel', 'DMX']);
  // รองรับ [ ] ด้วย
  assert.deepStrictEqual([...sandbox.splitTagParts('LED [a, b], HMI')], ['LED [a, b]', 'HMI']);
});

await test('splitTagParts วงเล็บปิดไม่ครบต้องไม่ทำให้ tag ที่เหลือหาย', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  // ข้อมูลกรอกมือ — วงเล็บอาจปิดไม่ครบ ถ้า depth ติดลบแล้วค้าง จะกลืน tag ถัดไปหมด
  assert.deepStrictEqual([...sandbox.splitTagParts('LED (หัวไฟ, Fresnel')], ['LED (หัวไฟ', 'Fresnel'],
    'วงเล็บไม่ปิด ต้องถอยกลับมาแยก comma ตามเดิม');
  assert.deepStrictEqual([...sandbox.splitTagParts('LED), Fresnel')], ['LED)', 'Fresnel']);
});

await test('badgesHtmlFromCommaList(short) ไม่แตก tag เดียวที่มี comma ในวงเล็บ', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const html = sandbox.badgesHtmlFromCommaList('LED (หัวไฟ, Control Box และสายเคเบิล)', 'bg-dark', { short: true });
  assert.strictEqual(html.match(/<span/g).length, 1, 'ต้องได้ badge เดียว ไม่ใช่สอง');
  assert.ok(html.includes('>LED</span>'));
  assert.ok(html.includes('title="LED (หัวไฟ, Control Box และสายเคเบิล)"'), 'ค่าเต็มต้องอยู่ใน title');
});

await test('ตัวกรอง IP จับคู่ด้วยหัว tag จึงรวมกลุ่มที่มีคำขยายต่างกัน', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const rows = [
    { id: 1, brand: 'A', model: 'x', ip: 'IP65 (ทั้งหัวไฟ, Control Box และสายเคเบิล)' },
    { id: 2, brand: 'B', model: 'y', ip: 'IP65' },
    { id: 3, brand: 'C', model: 'z', ip: 'IP54' },
  ];
  const hit = sandbox.filterFixtures(rows, { ip: 'IP65' });
  assert.deepStrictEqual(hit.map((f) => f.id).sort(), [1, 2],
    'เลือก IP65 ต้องได้ทั้งตัวที่มีคำขยายและตัวที่ไม่มี');
  assert.deepStrictEqual(sandbox.filterFixtures(rows, { ip: 'IP54' }).map((f) => f.id), [3]);
  assert.strictEqual(sandbox.filterFixtures(rows, {}).length, 3, 'ไม่กรองต้องได้ครบ');
});

console.log('\n[ จำนวน stock มุมขวาล่างของการ์ด ]');

await test('stockPillHtml โชว์ตัวเลข และเก็บข้อความ stock ดิบไว้ใน title', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const html = sandbox.stockPillHtml({ stock: '28 Pieces (7 sets of 4)', stockCount: 28 });
  assert.ok(html.includes('class="stock-pill"'), html);
  assert.ok(html.includes('<strong>28</strong>'), 'ต้องโชว์ตัวเลขเด่น ๆ: ' + html);
  assert.ok(html.includes('ชิ้น'), 'ต้องมีหน่วยกำกับให้อ่านรู้เรื่อง');
  assert.ok(html.includes('7 sets of 4'), 'ส่วนขยายต้องไม่หาย — เก็บไว้ใน title ให้ hover อ่าน');
});

await test('stockPillHtml ใช้ stockCount ก่อน parse ข้อความ (ข้อมูลจาก Supabase)', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const html = sandbox.stockPillHtml({ stock: '99 Pieces', stockCount: 4 });
  assert.ok(html.includes('<strong>4</strong>'), 'stockCount คือค่าที่แก้ผ่านหน้า Admin ต้องชนะ: ' + html);
  assert.ok(!html.includes('<strong>99</strong>'));
});

await test('stockPillHtml คืนค่าว่างเมื่อไม่รู้จำนวน (ห้ามเดา 0 หลอก ๆ)', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const cases = [
    ['stock null', { stock: null }],
    ['stock ว่าง', { stock: '' }],
    ['ไม่มีฟิลด์เลย', {}],
    ['null/undefined', null],
    ['ข้อความที่ parse ไม่ได้', { stock: 'ไม่ระบุ' }],
    ['0 ชิ้น', { stock: '0 Pieces' }],
    ['stockCount เป็น 0', { stockCount: 0 }],
  ];
  for (const [name, item] of cases) {
    assert.strictEqual(sandbox.stockPillHtml(item), '', `${name} ต้องไม่แสดง pill`);
  }
});

await test('stockPillHtml ต้อง escape ข้อความ stock ก่อนใส่ใน title', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const html = sandbox.stockPillHtml({ stock: '4 Pieces "พิเศษ" <b>', stockCount: 4 });
  assert.ok(!html.includes('"พิเศษ"'), 'ฟันหนูดิบจะทำ attribute พัง: ' + html);
  assert.ok(html.includes('&quot;พิเศษ&quot;'), 'ต้อง escape เป็น entity');
  assert.ok(!html.includes('<b>'), 'ต้องไม่ให้ HTML จากช่อง Admin หลุดเข้ามา');
});

await test('stockPillHtml ถูกเรียกใช้จริงในการ์ดทั้ง 2 ชนิด (ไม่ใช่เขียนแล้วทิ้งไว้)', async () => {
  // กันบั๊กแบบที่เคยเจอ: ประกาศตัวแปร/ฟังก์ชันไว้แต่ไม่เสียบเข้า template จึงไม่แสดงผลเลย
  const equip = fs.readFileSync(path.join(ROOT, 'equipment.html'), 'utf8');
  const acc = fs.readFileSync(path.join(ROOT, 'js/accessories.js'), 'utf8');
  assert.ok(equip.includes('stockPillHtml(item)'), 'การ์ดใน equipment.html ต้องเรียกใช้');
  assert.ok(acc.includes('stockPillHtml(item)'), 'การ์ดใน js/accessories.js ต้องเรียกใช้');
  assert.strictEqual(equip.split('stockPillHtml(').length - 1, 2,
    'equipment.html มีการ์ด 2 ชนิด (fixture + accessory) ต้องเรียกทั้งคู่');
});

await test('การ์ด fixture เลิกแสดง "· Stock" กลางการ์ด (ไม่ซ้ำกับมุมขวาล่าง)', async () => {
  const equip = fs.readFileSync(path.join(ROOT, 'equipment.html'), 'utf8');
  assert.ok(!equip.includes('· Stock ${stockCount}'), 'ต้องเอาตัวเลขกลางการ์ดออกแล้ว');
  assert.ok(equip.includes('<div><strong>${typeLabel}</strong></div>'), 'บรรทัดกลางต้องเหลือแค่ประเภท');
  // หน้ารายละเอียดยังต้องโชว์ Stock ครบ (ตั้งใจให้เต็มที่ไม่ได้ย่อ)
  assert.ok(equip.includes('<span>Stock</span>'), 'spec-row ในหน้ารายละเอียดต้องยังอยู่');
});

await test('CSS มี .stock-pill และดันไปชิดขวาด้วย margin-left:auto', async () => {
  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  const block = css.slice(css.indexOf('.stock-pill {'));
  assert.ok(block.startsWith('.stock-pill {'), 'ต้องมีคลาส .stock-pill');
  const rule = block.slice(0, block.indexOf('}'));
  assert.ok(/margin-left:\s*auto/.test(rule), 'ต้องมี margin-left:auto ไม่งั้นไม่ไปมุมขวาล่าง: ' + rule);
  assert.ok(/var\(--brand-accent\)/.test(rule), 'ควรใช้สี accent ของแบรนด์เพื่อให้เด่น');
  assert.ok(css.includes('.card-stock-row'), 'การ์ดอุปกรณ์เสริมไม่มี .card-add-row ต้องมีแถวของตัวเอง');
});

await test('ข้อมูลจริง: fixtures ทั้ง 64 ใบต้องได้ pill และตัวเลขตรง stockCount', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  let shown = 0;
  for (const f of localFixtures) {
    const html = sandbox.stockPillHtml(f);
    assert.notStrictEqual(html, '', `fixture id ${f.id} (${f.model}) ต้องมี pill`);
    assert.ok(html.includes(`<strong>${f.stockCount}</strong>`),
      `id ${f.id}: คาดหวัง ${f.stockCount} แต่ได้ ${html}`);
    shown++;
  }
  assert.strictEqual(shown, localFixtures.length);
});

await test('ข้อมูลจริง: อุปกรณ์เสริมที่ไม่มี stock ต้องไม่แสดง pill (70 จาก 72 รายการ)', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const withStock = localAccessories.filter((a) => a.stock && String(a.stock).trim());
  const without = localAccessories.filter((a) => !(a.stock && String(a.stock).trim()));
  assert.ok(withStock.length >= 1, 'ต้องมีบางรายการที่มี stock ไม่งั้นเทสต์นี้ไม่มีความหมาย');
  for (const a of withStock) {
    assert.notStrictEqual(sandbox.stockPillHtml(a), '', `${a.name} มี stock ต้องได้ pill`);
  }
  for (const a of without) {
    assert.strictEqual(sandbox.stockPillHtml(a), '', `${a.name} ไม่มี stock ต้องซ่อน pill`);
  }
  assert.strictEqual(without.length, localAccessories.length - withStock.length);
});

console.log('\n=== MemberStore (ทีมงานและสิทธิ์) ===');

// แถวสมาชิกหน้าตาแบบที่ Supabase คืนมา (snake_case, id เป็น uuid)
const sbMemberRow = (over = {}) => ({
  id: 'aaaa-1111', auth_uid: uidFor('admin@test.com'), code: 'ADMIN01',
  full_name: 'ผู้ดูแล ระบบ', email: 'admin@test.com', phone: null,
  role: 'admin', active: true, note: null, ...over,
});

await test('load() อ่านตาราง members และแปลง snake_case -> camelCase ครบ', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      members: [sbMemberRow(), sbMemberRow({ id: 'bbbb-2222', auth_uid: uidFor('crew@test.com'), code: 'TK01', full_name: 'ช่างไฟ', email: 'crew@test.com', role: 'crew', active: false })],
    },
  });
  await sandbox.MemberStore.load();
  const st = sandbox.MemberStore.status();
  assert.strictEqual(st.isSupabase, true, 'ต้องเชื่อมต่อ Supabase ได้: ' + JSON.stringify(st));
  assert.strictEqual(st.count, 2);
  const [a, b] = sandbox.MemberStore.getAll().sort((x, y) => String(x.code).localeCompare(String(y.code)));
  assert.strictEqual(a.code, 'ADMIN01');
  assert.strictEqual(a.fullName, 'ผู้ดูแล ระบบ', 'full_name ต้องถูก map เป็น fullName');
  assert.strictEqual(a.authUid, uidFor('admin@test.com'), 'auth_uid ต้องถูก map เป็น authUid');
  assert.strictEqual(a.active, true);
  assert.strictEqual(b.role, 'crew');
  assert.strictEqual(b.active, false);
});

await test('ตาราง members ว่างต้องนับเป็นโหมด Supabase (ไม่ถอยไป local จนโชว์ข้อมูลปลอม)', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [], accessories: [], members: [] } });
  await sandbox.MemberStore.load();
  assert.strictEqual(sandbox.MemberStore.isSupabase(), true, 'ต่างจาก store อื่นโดยจงใจ');
  assert.strictEqual(sandbox.MemberStore.getAll().length, 0);
});

await test('toRow() ห้ามส่ง auth_uid และ email กลับไป (กันเขียนทับสิทธิ์)', async () => {
  const { sandbox, mockSb } = makeContext({
    supabaseMode: 'ok',
    seed: { fixtures: [], accessories: [], members: [sbMemberRow()] },
  });
  await sandbox.MemberStore.load();
  // พยายามเขียนทับทั้งสองฟิลด์ที่ห้ามเขียน พร้อมแก้สิทธิ์ไปด้วยในคำขอเดียว
  await sandbox.MemberStore.update('aaaa-1111', {
    code: 'ADMIN02', role: 'crew', active: false,
    authUid: 'someone-else-uid', email: 'hacker@evil.com',
  });
  const calls = mockSb._calls.filter((c) => c.table === 'members' && c.kind === 'update');
  assert.ok(calls.length >= 1, 'ต้องมีการ update');
  const payload = calls[calls.length - 1].payload;
  assert.ok(!('auth_uid' in payload), 'ห้ามส่ง auth_uid: ' + JSON.stringify(payload));
  assert.ok(!('email' in payload), 'ห้ามส่ง email: ' + JSON.stringify(payload));
  assert.strictEqual(payload.code, 'ADMIN02');
  assert.strictEqual(payload.role, 'crew');
  assert.strictEqual(payload.active, false);
});

await test('update() หาแถวด้วย uuid ได้จริง (ไม่พังเพราะ Number() ได้ NaN)', async () => {
  const { sandbox, mockSb } = makeContext({
    supabaseMode: 'ok',
    seed: { fixtures: [], accessories: [], members: [sbMemberRow()] },
  });
  await sandbox.MemberStore.load();
  const saved = await sandbox.MemberStore.update('aaaa-1111', { fullName: 'ชื่อใหม่' });
  assert.ok(saved, 'ต้องคืนแถวที่บันทึกแล้ว');
  assert.strictEqual(saved.fullName, 'ชื่อใหม่');
  assert.strictEqual(mockSb._tables.members[0].full_name, 'ชื่อใหม่', 'ต้องลงถึงตารางใน mock');
  assert.strictEqual(sandbox.MemberStore.getById('aaaa-1111').fullName, 'ชื่อใหม่');
});

await test('setActive / setRole เปลี่ยนค่าได้ และ normalize เป็น boolean/role ที่ถูกต้อง', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: { fixtures: [], accessories: [], members: [sbMemberRow({ active: false, role: 'crew' })] },
  });
  await sandbox.MemberStore.load();
  await sandbox.MemberStore.setActive('aaaa-1111', true);
  assert.strictEqual(sandbox.MemberStore.getById('aaaa-1111').active, true);
  await sandbox.MemberStore.setRole('aaaa-1111', 'ADMIN');
  assert.strictEqual(sandbox.MemberStore.getById('aaaa-1111').role, 'admin', 'ต้อง normalize ตัวพิมพ์');
  await sandbox.MemberStore.setRole('aaaa-1111', 'superuser');
  assert.strictEqual(sandbox.MemberStore.getById('aaaa-1111').role, 'crew', 'role ที่ไม่รู้จักต้อง fail safe เป็น crew');
});

await test('API ต้องไม่มี create และไม่มี remove (ล็อกการตัดสินใจไว้)', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [], accessories: [], members: [] } });
  // สร้างบัญชีไม่ได้จากเบราว์เซอร์ (ต้องมี service_role) และนำคนออกใช้ปิดใช้งานแทนการลบ
  assert.strictEqual(typeof sandbox.MemberStore.create, 'undefined', 'ต้องมี create');
  assert.strictEqual(typeof sandbox.MemberStore.remove, 'undefined', 'ต้องมี remove');
  assert.strictEqual(typeof sandbox.MemberStore.setActive, 'function', 'ต้องมี setActive ไว้ใช้แทน remove');
});

await test('inactive() / activeAdmins() / counts() แยกสถานะได้ถูก', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      members: [
        sbMemberRow({ id: 'm1', code: 'ADMIN01', role: 'admin', active: true }),
        sbMemberRow({ id: 'm2', code: 'TK01', role: 'crew', active: true }),
        sbMemberRow({ id: 'm3', code: 'TK02', role: 'crew', active: false }),
        sbMemberRow({ id: 'm4', code: 'TK03', role: 'admin', active: false }),
      ],
    },
  });
  await sandbox.MemberStore.load();
  assert.deepStrictEqual([...sandbox.MemberStore.inactive()].map((m) => m.code), ['TK02', 'TK03']);
  assert.deepStrictEqual([...sandbox.MemberStore.activeAdmins()].map((m) => m.code), ['ADMIN01']);
  const c = sandbox.MemberStore.counts();
  assert.strictEqual(c.admin, 1, 'admin ที่ active เท่านั้น');
  assert.strictEqual(c.crew, 1);
  assert.strictEqual(c.inactive, 2, 'นับจาก active=false — ตอนนี้แปลว่าถูกปิดใช้งาน ไม่ใช่รออนุมัติ');
  assert.strictEqual(c.total, 4);
  // ชื่อเก่าต้องหายไปจริง ๆ ไม่งั้นโค้ดที่เรียก pending() จะพังเงียบ ๆ (undefined is not a function)
  assert.strictEqual(sandbox.MemberStore.pending, undefined, 'pending() ถูกเปลี่ยนชื่อเป็น inactive() แล้ว');
  assert.strictEqual(c.pending, undefined, 'counts().pending ถูกเปลี่ยนชื่อเป็น counts().inactive แล้ว');
});

await test('findByEmail() ไม่สนตัวพิมพ์ และคืน null เมื่อไม่เจอ', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: { fixtures: [], accessories: [], members: [sbMemberRow()] },
  });
  await sandbox.MemberStore.load();
  assert.strictEqual(sandbox.MemberStore.findByEmail('ADMIN@Test.com').code, 'ADMIN01');
  assert.strictEqual(sandbox.MemberStore.findByEmail('nobody@test.com'), null);
  assert.strictEqual(sandbox.MemberStore.findByEmail(''), null);
});

await test('ตาราง members เข้าไม่ได้ -> fallback local + status บอกเหตุผล', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'no-members', seed: { fixtures: [], accessories: [] } });
  await sandbox.MemberStore.load();
  const st = sandbox.MemberStore.status();
  assert.strictEqual(st.isSupabase, false);
  assert.strictEqual(st.mode, 'local');
  assert.ok(st.error.includes('members'), 'ต้องบอกชื่อตาราง: ' + st.error);
  assert.ok(st.error.includes('migration-2026-10-22-members.sql'), 'ต้องชี้ไปไฟล์ SQL ที่ต้องรัน: ' + st.error);
});

await test('missingColumns() รายงานคอลัมน์ที่ยังไม่ได้เพิ่ม (เช่นยังไม่ได้รัน migration ตัวใหม่)', async () => {
  const row = sbMemberRow();
  delete row.email;   // จำลองตารางที่ยังไม่มีคอลัมน์ email
  delete row.note;
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [], accessories: [], members: [row] } });
  await sandbox.MemberStore.load();
  const missing = [...sandbox.MemberStore.missingColumns()].map((m) => m.column).sort();
  assert.deepStrictEqual(missing, ['email', 'note']);
  assert.ok(sandbox.MemberStore.status().missingColumns.length === 2);
});

await test('missingColumns() คืน [] เมื่อไม่รู้จริง ๆ (โหมด local / ตารางว่าง)', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'no-members', seed: { fixtures: [], accessories: [] } });
  await sandbox.MemberStore.load();
  assert.deepStrictEqual([...sandbox.MemberStore.missingColumns()], []);

  const empty = makeContext({ supabaseMode: 'ok', seed: { fixtures: [], accessories: [], members: [] } });
  await empty.sandbox.MemberStore.load();
  assert.deepStrictEqual([...empty.sandbox.MemberStore.missingColumns()], [], 'ตารางว่าง probe ไม่เห็นคอลัมน์ ต้องไม่เดา');
});

console.log('\n=== ฟอร์มแก้ไขทีมงาน (memberEditorHtml) ===');

// แท็กที่ฟอร์มนี้ควรมี — เจอแท็กอื่นแปลว่ามีค่าจากผู้ใช้หลุดมาเป็น HTML จริง
const FORM_WHITELIST = new Set(['div', 'form', 'label', 'input', 'select', 'option', 'button', 'span', 'strong', 'em', 'h5', 'br']);

function realTagNames(h) {
  const out = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b/g;
  let m;
  while ((m = re.exec(h))) out.push(m[1].toLowerCase());
  return out;
}

await test('ค่าที่ผู้ใช้กรอกต้องไม่กลายเป็น HTML (กัน XSS จากตาราง members)', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const payloads = [
    { code: '"><script>alert(1)</script>', fullName: '<img src=x onerror="alert(2)">', email: 'a@b.com"><b>x</b>', note: '">&lt;script&gt;' },
    { code: "' OR 1=1 --", fullName: '"><svg/onload=alert(3)>', email: null, note: 'javascript:alert(4)' },
    { code: 'ปกติ', fullName: 'สมชาย ใจดี', email: 'somchai@company.com', note: 'ทีมไฟ' },
  ];
  for (const p of payloads) {
    const h = sandbox.memberEditorHtml({ id: 'x', phone: null, authUid: null, role: 'crew', active: true, ...p }, 'f1', {});
    const alien = [...new Set(realTagNames(h).filter((t) => !FORM_WHITELIST.has(t)))];
    assert.deepStrictEqual(alien, [], `code=${JSON.stringify(p.code)} มีแท็กแปลกปลอมหลุดออกมา`);
    // attribute ต้องไม่แตก — ฟันหนูในแต่ละ <input> ต้องเป็นคู่
    for (const m of h.matchAll(/<input\b[^>]*>/g)) {
      const quotes = (m[0].match(/"/g) || []).length;
      assert.strictEqual(quotes % 2, 0, 'ฟันหนูคี่ แปลว่าค่าหลุดออกจาก attribute: ' + m[0].slice(0, 90));
    }
  }
});

await test('ช่องอีเมลต้อง readonly (แก้ของจริงได้เฉพาะใน Supabase Authentication)', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const h = sandbox.memberEditorHtml({ id: 'x', code: 'TK01', fullName: 'สมชาย', email: 'somchai@company.com', role: 'crew', active: true }, 'f1', {});
  const emailInput = [...h.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes('somchai@company.com'));
  assert.ok(emailInput, 'ต้องมีช่องอีเมล');
  assert.ok(/\breadonly\b/.test(emailInput), 'ต้อง readonly: ' + emailInput);
  assert.ok(!/name="/.test(emailInput), 'ห้ามมี name — จะได้ไม่ถูกส่งกลับไปบันทึก');
  assert.ok(h.includes('Authentication'), 'ต้องบอกว่าไปแก้จริงที่ไหน');
});

await test('ฟอร์มสะท้อนสิทธิ์และสถานะปัจจุบัน (select/checkbox ถูกติ๊ก)', async () => {
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const admin = sandbox.memberEditorHtml({ id: '1', code: 'A1', fullName: 'x', email: 'a@b.com', role: 'admin', active: true }, 'f1', {});
  assert.ok(/value="admin"[^>]*\sselected/.test(admin), 'admin ต้องถูกเลือก: ');
  assert.ok(/name="active"[^>]*\schecked/.test(admin), 'active ต้องถูกติ๊ก');

  const pending = sandbox.memberEditorHtml({ id: '2', code: 'M001', fullName: 'y', email: 'y@b.com', role: 'crew', active: false }, 'f1', {});
  assert.ok(/value="crew"[^>]*\sselected/.test(pending), 'crew ต้องถูกเลือก');
  assert.ok(!/name="active"[^>]*\schecked/.test(pending), 'รอยืนยันต้องไม่ติ๊ก approved');
});

await test('ชื่อช่องในฟอร์มต้องตรงกับที่ bindMemberEditor อ่าน (กันบั๊กแบบ adminPinInput)', async () => {
  // บั๊กที่ทำให้หน้า admin พังรอบแรกคือ HTML กับ JS เรียกชื่อคนละตัว
  // จึงตรวจสองทาง: ทุก form.elements.X ที่โค้ดอ่าน ต้องมี name="X" ในฟอร์มจริง
  const { sandbox } = makeContext({ supabaseLibPresent: false });
  const src = fs.readFileSync(path.join(ROOT, 'js/inline-member-editor.js'), 'utf8');
  const readNames = [...new Set([...src.matchAll(/form\.elements\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
  assert.ok(readNames.length >= 5, 'ต้องอ่านหลายฟิลด์: ' + readNames.join(','));

  const h = sandbox.memberEditorHtml({ id: 'x', code: 'TK01', fullName: 'สมชาย', email: 'e@x.com', phone: '081', note: 'n', role: 'admin', active: true }, 'f1', {});
  const formNames = [...h.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]);
  for (const n of readNames) {
    assert.ok(formNames.includes(n), `โค้ดอ่าน form.elements.${n} แต่ในฟอร์มไม่มี name="${n}" (มี: ${formNames.join(',')})`);
  }
  // และปุ่ม cancel/status ที่ bind ผ่าน getElementById ต้องมี id ตรง pattern
  assert.ok(h.includes('id="f1-cancel"'), 'ต้องมีปุ่มปิด');
  assert.ok(h.includes('id="f1-status"'), 'ต้องมีที่โชว์สถานะ');
});

console.log('\n=== SQL: ชื่อคอลัมน์ต้องมีจริง (กันเดาชื่อ) ===');

// ใน sandbox ไม่มี Postgres ให้รันจริง จึงตรวจกับเซิร์ฟเวอร์ไม่ได้
// บั๊กชนิด "เดาชื่อคอลัมน์" จึงหลุดไปถึงมือผู้ใช้ได้ — เคยเกิดจริง:
// query ตรวจ trigger ไปอ้าง tgisbefore/tgisafter/tgisinsert ซึ่งไม่มีอยู่
// (pg_trigger เก็บจังหวะเป็น bitmask ใน tgtype) ทำให้ error 42703 ทั้งไฟล์
// และเพราะ SQL Editor รันเป็น transaction เดียว ขั้นที่ 1-4 ถูก rollback ไปด้วย
//
// เทสต์นี้ล็อกชื่อคอลัมน์จริงไว้ ถ้าใครอ้างชื่อที่ไม่มีจริงจะแดงทันที

// ตัดคอมเมนต์ออกก่อน — คอมเมนต์อ้างชื่อปลอมไว้เป็นคำเตือนได้อย่างจงใจ
function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, '');
}

// คอลัมน์จริงของ pg_trigger (PostgreSQL 12+)
const PG_TRIGGER_COLUMNS = new Set([
  'oid', 'tgrelid', 'tgparentid', 'tgname', 'tgfoid', 'tgtype', 'tgenabled',
  'tgisinternal', 'tgconstrrelid', 'tgconstrindid', 'tgconstraint',
  'tgdeferrable', 'tginitdeferred', 'tgnargs', 'tgattr', 'tgargs', 'tgqual',
  'tgoldtable', 'tgnewtable',
]);

// ตัวแปรพิเศษของ PL/pgSQL ใน trigger function — ขึ้นต้นด้วย tg_ เหมือนกัน
// แต่ "ไม่ใช่" คอลัมน์ของ pg_trigger และเป็นของจริงที่ใช้ได้
// (ถ้าไม่ยกเว้นไว้จะได้ false positive จาก protect_last_admin ที่ใช้ tg_op)
const PLPGSQL_TRIGGER_VARS = new Set([
  'tg_op', 'tg_when', 'tg_level', 'tg_table_name', 'tg_table_schema', 'tg_relid',
]);

const sqlFiles = fs.readdirSync(path.join(ROOT, 'supabase'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => path.join('supabase', f));

await test('statement ที่ query pg_trigger ต้องอ้างเฉพาะคอลัมน์ที่มีจริง', async () => {
  for (const rel of sqlFiles) {
    const body = stripSqlComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    // จำกัดขอบเขตเป็นราย statement ที่แตะ pg_trigger จริง
    // เพราะในไฟล์เดียวกันมี PL/pgSQL function body ที่ใช้ตัวแปร tg_op ปนอยู่
    const statements = body.split(';').filter((s) => /\bfrom\s+pg_trigger\b/i.test(s));
    for (const stmt of statements) {
      const used = new Set([...stmt.matchAll(/\b(tg[a-z_]+)\b/g)].map((m) => m[1]));
      if (/\bpg_get_triggerdef\s*\(\s*oid\s*\)/.test(stmt)) used.add('oid');
      const fake = [...used].filter((c) => !PG_TRIGGER_COLUMNS.has(c) && !PLPGSQL_TRIGGER_VARS.has(c));
      assert.deepStrictEqual(
        fake, [],
        `${rel} อ้างคอลัมน์ pg_trigger ที่ไม่มีจริง: ${fake.join(', ')}`
        + `\n  statement: ${stmt.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
      );
    }
  }
});

await test('query ตรวจ trigger ใช้ pg_get_triggerdef() แทนการถอด bitmask เอง', async () => {
  const rel = 'supabase/migration-2026-11-13-member-admin.sql';
  const body = stripSqlComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  // tgtype เป็น bitmask ที่ถอดมือแล้วพลาดง่าย จึงให้ดึง CREATE TRIGGER ตัวจริงมาโชว์
  assert.ok(
    /pg_get_triggerdef\s*\(\s*oid\s*\)/.test(body),
    'ต้องโชว์นิยาม trigger ด้วย pg_get_triggerdef() — อย่าถอด tgtype เอง',
  );
  assert.ok(!/\btgtype\b/.test(body), 'ไม่ควรอ้าง tgtype ตรง ๆ (ถอด bitmask เองพลาดง่าย)');
});

// คอลัมน์จริงของตาราง members จาก DDL (schema.sql คือแหล่งอ้างอิง)
const schemaSql = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
const membersDdl = /create table if not exists public\.members\s*\(([\s\S]*?)\n\);/.exec(schemaSql);
assert.ok(membersDdl, 'หา DDL ของ public.members ใน schema.sql ไม่เจอ');
const MEMBERS_COLUMNS = new Set(
  [...membersDdl[1].matchAll(/^\s{2}([a-z_]+)\s/gm)].map((m) => m[1]),
);

await test('DDL ของ members มีคอลัมน์ครบตามที่โค้ดฝั่งเว็บใช้', async () => {
  for (const col of ['id', 'auth_uid', 'code', 'full_name', 'email', 'phone', 'role', 'active', 'note']) {
    assert.ok(MEMBERS_COLUMNS.has(col), `ตาราง members ขาดคอลัมน์ ${col} (มี: ${[...MEMBERS_COLUMNS].join(', ')})`);
  }
});

await test('ทุก INSERT INTO public.members ใช้คอลัมน์ที่มีจริง', async () => {
  for (const rel of sqlFiles) {
    const body = stripSqlComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const m of body.matchAll(/insert into public\.members\s*\(([^)]*)\)/g)) {
      const cols = m[1].split(',').map((c) => c.trim()).filter(Boolean);
      const fake = cols.filter((c) => !MEMBERS_COLUMNS.has(c));
      assert.deepStrictEqual(fake, [], `${rel} insert คอลัมน์ที่ไม่มีจริง: ${fake.join(', ')}`);
    }
  }
});

await test('ทุก trigger function ใน schema.sql ต้องปัก search_path', async () => {
  // ตรวจเจอจากฐานข้อมูลจริงว่า members_fill_code มี proconfig เป็น null
  // ทั้งที่อีก 3 ฟังก์ชันปักไว้ครบ — Supabase Security Advisor จะเตือนเป็น
  // function_search_path_mutable จึงล็อกไว้ไม่ให้ฟังก์ชันใหม่หลุดเกณฑ์อีก
  const src = stripSqlComments(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  const blocks = [...src.matchAll(
    /create or replace function public\.([a-z_]+)\s*\(([\s\S]*?)\n\$\$;/g,
  )];
  assert.ok(blocks.length >= 4, `ควรเจอฟังก์ชันอย่างน้อย 4 ตัว แต่เจอ ${blocks.length}`);
  for (const m of blocks) {
    const [, name, header] = m;
    assert.ok(
      /set search_path\s*=\s*public,\s*pg_temp/.test(header),
      `public.${name}() ไม่ได้ปัก search_path = public, pg_temp`
      + '\n  header: ' + header.replace(/\s+/g, ' ').trim(),
    );
  }
});

await test('migration 2026-11-13 ต้องมี alter function ปัก search_path ให้ของเดิม', async () => {
  // ฐานข้อมูลของผู้ใช้รัน migration-2026-10-22 ไปแล้ว จึงแก้ schema.sql อย่างเดียวไม่พอ
  // ต้องมีคำสั่ง alter สำหรับฐานข้อมูลที่ติดตั้งไปแล้วด้วย
  const mig = stripSqlComments(fs.readFileSync(
    path.join(ROOT, 'supabase/migration-2026-11-13-member-admin.sql'), 'utf8',
  ));
  assert.ok(
    /alter function public\.members_fill_code\(\)\s+set search_path\s*=\s*public,\s*pg_temp/i.test(mig),
    'ต้องมี alter function ... set search_path สำหรับฐานข้อมูลที่ติดตั้งไปแล้ว',
  );
  // จงใจไม่ทำให้เป็น security definer — trigger เติม new.code ไม่ควรได้สิทธิ์เกินคนเรียก
  const fillCode = /create or replace function public\.members_fill_code\(([\s\S]*?)\n\$\$;/.exec(
    fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'),
  );
  assert.ok(fillCode, 'หา members_fill_code ใน schema.sql ไม่เจอ');
  assert.ok(
    !/security definer/i.test(fillCode[1]),
    'members_fill_code ต้องไม่เป็น security definer (ไม่จำเป็น = ความเสี่ยงเพิ่ม)',
  );
});

await test('ทุกไฟล์ SQL ต้องสร้าง trigger ด้วย active ค่าเดียวกัน (กัน repo กับ DB เลื่อนออกจากกัน)', async () => {
  // เคยเกิดจริง: แก้ค่าในฐานข้อมูลเป็น active=true แล้ว แต่ไฟล์ SQL ยังเขียน false
  // ไฟล์นี้เป็น create or replace function จึง "รันซ้ำแล้ว revert เงียบ ๆ"
  // บัญชีใหม่จะกลับไปค้างรอยืนยันโดยไม่มีใครรู้ — จึงต้องล็อกว่าทุกไฟล์พูดเรื่องเดียว
  const found = new Map();
  for (const rel of sqlFiles) {
    const body = stripSqlComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const m of body.matchAll(
      /insert into public\.members[\s\S]{0,200}?values\s*\(\s*new\.id\s*,[\s\S]*?'crew'\s*,\s*(true|false)\s*\)/g,
    )) {
      found.set(rel, m[1]);
    }
  }
  assert.ok(found.size >= 2, `ควรเจอ trigger insert อย่างน้อย 2 ไฟล์ แต่เจอ ${found.size}: ${[...found.keys()].join(', ')}`);
  const values = [...new Set(found.values())];
  assert.deepStrictEqual(values, ['true'],
    'ทุกไฟล์ต้องสร้างแถวสมาชิกใหม่เป็น active = true (ไม่ต้องมีขั้นอนุมัติ)'
    + `\n  ค่าที่เจอ: ${[...found].map(([f, v]) => `${f}=${v}`).join(', ')}`);
});

await test('ต้องมีไฟล์ migration บันทึกการถอดขั้นอนุมัติ และเตือนเรื่องห้ามเหมาเปิด active', async () => {
  const rel = 'supabase/migration-2026-11-13b-no-approval.sql';
  const full = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // การเปลี่ยนครั้งนี้ทำผ่าน SQL + การตั้งค่า Authentication จึงต้องบันทึกไว้ทั้งสองส่วน
  assert.ok(/disable_signup/.test(full), 'ต้องบันทึกการตั้งค่า disable_signup ไว้เป็นเอกสาร');
  assert.ok(/Dashboard|Management API/i.test(full), 'ต้องบอกว่า disable_signup ตั้งใน SQL ไม่ได้');
  // คำเตือนสำคัญ: การเหมา update active=true ทั้งตารางจะไปเปิดคืนให้คนที่ admin จงใจปิด
  assert.ok(
    /ห้ามรันแบบนี้เด็ดขาด/.test(full) && /set active = true where active = false/.test(full),
    'ต้องเตือนห้าม update active=true เหมาทั้งตาราง เพราะจะถอนการนำคนออกเงียบ ๆ',
  );
  // ไฟล์เก่าต้องชี้มาไฟล์ใหม่ ไม่งั้นคนรันซ้ำจะไม่รู้ว่าค่าถูกแก้แล้ว
  const old = fs.readFileSync(path.join(ROOT, 'supabase/migration-2026-11-13-member-admin.sql'), 'utf8');
  assert.ok(/migration-2026-11-13b-no-approval\.sql/.test(old),
    'migration ไฟล์เดิมต้องมีคำเตือนชี้ไปไฟล์ 11-13b');
});

await test('auth_uid ต้องมี unique — ไม่งั้น on conflict (auth_uid) จะ error', async () => {
  // trigger handle_new_auth_user ใช้ on conflict (auth_uid) do nothing
  // ซึ่ง Postgres จะปฏิเสธถ้าไม่มี unique/exclusion constraint ตรงกับที่ระบุ
  assert.ok(
    /auth_uid\s+uuid\s+unique/.test(membersDdl[1]),
    'members.auth_uid ต้องเป็น unique — on conflict (auth_uid) พึ่ง constraint นี้',
  );
  const mig = stripSqlComments(fs.readFileSync(
    path.join(ROOT, 'supabase/migration-2026-11-13-member-admin.sql'), 'utf8',
  ));
  assert.ok(/on conflict \(auth_uid\) do nothing/.test(mig), 'trigger ต้องมี on conflict กัน insert ซ้ำ');
});

// ======================= ระบบจอง: ชั้นข้อมูลฝั่งเว็บ (BookingStore) =======================
// หลักที่ต้องล็อกไว้: ยอดจองต้องมาจากฐานข้อมูลก้อนเดียวกับที่ trigger ใช้ตัดสิน
// และ "อ่านไม่ได้" ต้องไม่ทำให้การ์ดอุปกรณ์พัง (คืนสตริงว่าง แล้วหน้าตาเหมือนเดิม)

function avRow(over = {}) {
  return {
    item_type: 'fixture', item_id: 1, item_name: 'Aputure MC',
    stock: 28, booked: 0, available: 28, stock_unknown: false, hidden: false, out_count: 0,
    ...over,
  };
}

await test('BookingStore.load() อ่าน view แล้วแยก fixture/accessory แม้ id ซ้ำกัน', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      availability: [
        avRow({ item_type: 'fixture', item_id: 1, stock: 4, booked: 1, available: 3 }),
        avRow({ item_type: 'accessory', item_id: 1, item_name: 'LiteDimmer Pro Hybrid', stock: '10', booked: 2, available: 8, out_count: 2 }),
      ],
    },
  });
  const n = await sandbox.BookingStore.load();
  assert.strictEqual(n, 2, 'ต้องได้ 2 แถว');
  assert.strictEqual(sandbox.BookingStore.isReady(), true);
  // id ซ้ำกันคนละตารางต้องไม่ทับกัน (นี่คือเหตุผลที่ต้องใช้คู่ item_type + item_id)
  assert.strictEqual(sandbox.BookingStore.get('fixture', 1).stock, 4);
  assert.strictEqual(sandbox.BookingStore.get('accessory', 1).stock, 10);
  assert.strictEqual(sandbox.BookingStore.get('accessory', '1').stock, 10, 'id เป็น string ต้องหาเจอเหมือนกัน');
});

await test('stock จาก PostgREST ที่เป็น string ต้องแปลงได้ และ null ต้องคงเป็น null (ห้ามเป็น 0)', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      availability: [
        avRow({ item_id: 5, stock: '12', booked: '3', available: '9' }),
        avRow({ item_type: 'accessory', item_id: 9, item_name: 'ของที่ยังไม่กรอก', stock: null, booked: 0, available: null, stock_unknown: true }),
      ],
    },
  });
  await sandbox.BookingStore.load();
  const num = sandbox.BookingStore.get('fixture', 5);
  assert.strictEqual(num.stock, 12);
  assert.strictEqual(num.booked, 3);
  assert.strictEqual(num.available, 9);
  // หัวใจของกติกา "stock = null จองไม่ได้": ห้ามกลายเป็น 0 เพราะ 0 แปลว่าของหมด
  const unknown = sandbox.BookingStore.get('accessory', 9);
  assert.strictEqual(unknown.stock, null);
  assert.strictEqual(unknown.available, null);
  assert.strictEqual(unknown.stockUnknown, true);
});

await test('available ห้ามติดลบ และ reserved = booked - out_count', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      // จำลองกรณี view ค้าง/ข้อมูลเพี้ยน: booked มากกว่า stock
      availability: [avRow({ item_id: 7, stock: 2, booked: 5, available: -3, out_count: 5 })],
    },
  });
  await sandbox.BookingStore.load();
  const a = sandbox.BookingStore.get('fixture', 7);
  assert.strictEqual(a.available, 0, 'เหลือต้องไม่ติดลบ');
  assert.strictEqual(a.outCount, 5);
  assert.strictEqual(a.reserved, 0, 'reserved = booked - outCount และต้องไม่ติดลบ');
});

await test('อ่าน view ไม่ได้ (ยังไม่รัน SQL) ต้องไม่ throw และการ์ดต้องไม่พัง', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: { fixtures: [], accessories: [] },   // ไม่ seed availability = view ไม่มีอยู่จริง
  });
  let threw = null;
  let count = null;
  try { count = await sandbox.BookingStore.load(); } catch (err) { threw = err; }
  assert.strictEqual(threw, null, 'load() ห้าม throw — หน้าเว็บต้องไม่ขาวเพราะระบบจอง');
  assert.strictEqual(count, 0);
  assert.strictEqual(sandbox.BookingStore.isReady(), false);
  const st = sandbox.BookingStore.status();
  assert.strictEqual(st.isSupabase, false);
  assert.ok(/migration-2026-11-13c-bookings\.sql/.test(st.error),
    'ต้องบอกให้รันไฟล์ SQL ไหน: ' + st.error);
  assert.strictEqual(sandbox.BookingStore.get('fixture', 1), null);
  // สำคัญสุด: การ์ดต้องหน้าตาเหมือนเดิม (ไม่มีบรรทัดยอดจอง ไม่ใช่ขึ้น error)
  assert.strictEqual(sandbox.bookingLineHtml('fixture', 1), '');
});

await test('เน็ตหลุดก็ต้องถอยแบบเงียบ ๆ เหมือนกัน', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'network',
    seed: { fixtures: [], accessories: [], availability: [avRow()] },
  });
  await sandbox.BookingStore.load();
  const st = sandbox.BookingStore.status();
  assert.strictEqual(st.isSupabase, false);
  assert.ok(/Supabase ไม่ได้/.test(st.error), st.error);
  assert.strictEqual(sandbox.bookingLineHtml('fixture', 1), '');
});

await test('bookingLineHtml แสดง "ติดจอง X · เหลือ Y" เฉพาะตอนมียอดจอง', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      availability: [
        avRow({ item_id: 1, stock: 28, booked: 4, available: 24 }),
        avRow({ item_id: 2, stock: 4, booked: 0, available: 4 }),
      ],
    },
  });
  await sandbox.BookingStore.load();
  const booked = sandbox.bookingLineHtml('fixture', 1);
  assert.ok(/ติดจอง/.test(booked) && /<strong>4<\/strong>/.test(booked), booked);
  assert.ok(/เหลือ/.test(booked) && /<strong>24<\/strong>/.test(booked), booked);
  assert.ok(/booking-active/.test(booked), 'ต้องมี class ให้ CSS จับ: ' + booked);
  assert.ok(/เหลือให้จอง 24 ชิ้น/.test(booked), 'title ต้องบอกเลขที่เหลือ: ' + booked);
  // ไม่มีของติดจอง -> ไม่ต้องโชว์ (มี .stock-pill บอกจำนวนทั้งหมดอยู่แล้ว)
  assert.strictEqual(sandbox.bookingLineHtml('fixture', 2), '');
  // ยังไม่โหลด store ก็ต้องได้สตริงว่าง ไม่ใช่ 'undefined' โผล่บนการ์ด
  const fresh = makeContext({ supabaseMode: 'ok', seed: { fixtures: [], accessories: [] } });
  assert.strictEqual(fresh.sandbox.bookingLineHtml('fixture', 1), '');
});

await test('bookingLineHtml ต้องบอกว่า "ยังไม่ระบุจำนวน — จองไม่ได้" เมื่อ stock เป็น null', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      availability: [avRow({ item_type: 'accessory', item_id: 3, item_name: '200W Dimmer Unit', stock: null, available: null, stock_unknown: true })],
    },
  });
  await sandbox.BookingStore.load();
  const h = sandbox.bookingLineHtml('accessory', 3);
  assert.ok(/ยังไม่ระบุจำนวน/.test(h) && /จองไม่ได้/.test(h), h);
  assert.ok(/booking-unknown/.test(h), h);
  assert.ok(!/<strong>0<\/strong>/.test(h), 'ห้ามโชว์เลข 0 เพราะจะแปลว่าของหมด: ' + h);
  assert.strictEqual(sandbox.BookingStore.counts().unknownStock, 1);
  assert.strictEqual(sandbox.BookingStore.unknownStockItems()[0].itemId, '3');
});

await test('bookingLineHtml ห้ามเอาข้อความจากฐานข้อมูลมาประกอบ HTML (กัน XSS)', async () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      availability: [avRow({ item_id: 4, item_name: evil, stock: 4, booked: 1, available: 3 })],
    },
  });
  await sandbox.BookingStore.load();
  const h = sandbox.bookingLineHtml('fixture', 4);
  assert.ok(!h.includes('<img'), 'ชื่อรายการจาก DB ต้องไม่กลายเป็น tag: ' + h);
  assert.ok(!h.includes('onerror'), 'ห้ามมี onerror หลุดออกมา: ' + h);
  assert.ok(h.includes('ติดจอง'), 'ยังต้องแสดงยอดจองได้ปกติ: ' + h);
});

await test('getByCardKey / getBySetId ต้องถอดรหัส id ของทั้งสองระบบได้', async () => {
  const { sandbox } = makeContext({
    supabaseMode: 'ok',
    seed: {
      fixtures: [], accessories: [],
      availability: [
        avRow({ item_id: 12, stock: 4, booked: 1, available: 3 }),
        avRow({ item_type: 'accessory', item_id: 3, item_name: 'acc', stock: 10, booked: 2, available: 8 }),
      ],
    },
  });
  await sandbox.BookingStore.load();
  // equipment.html ใช้ data-key = "fixture-12" / "accessory-3"
  assert.strictEqual(sandbox.BookingStore.getByCardKey('fixture-12').booked, 1);
  assert.strictEqual(sandbox.BookingStore.getByCardKey('accessory-3').booked, 2);
  // Set Builder เก็บ id เป็น "12" / "a3"
  assert.strictEqual(sandbox.BookingStore.getBySetId('12').booked, 1);
  assert.strictEqual(sandbox.BookingStore.getBySetId('a3').booked, 2);
  // ของที่ไม่มีอยู่ / key เพี้ยน ต้องได้ null ไม่ใช่โยน error
  assert.strictEqual(sandbox.BookingStore.getByCardKey('12'), null);
  assert.strictEqual(sandbox.BookingStore.getByCardKey(''), null);
  assert.strictEqual(sandbox.BookingStore.getBySetId('virtual-1-x'), null);
  assert.strictEqual(sandbox.BookingStore.get('fixture', null), null);
});

await test('load() เรียกซ้ำต้องไม่ยิง query ซ้อน และ force=true ต้องยิงใหม่', async () => {
  const { sandbox, mockSb } = makeContext({
    supabaseMode: 'ok',
    seed: { fixtures: [], accessories: [], availability: [avRow()] },
  });
  await sandbox.BookingStore.load();
  const before = mockSb._calls.filter((c) => c.table === 'v_item_availability').length;
  await sandbox.BookingStore.load();
  await sandbox.BookingStore.load();
  assert.strictEqual(mockSb._calls.filter((c) => c.table === 'v_item_availability').length, before,
    'โหลดแล้วไม่ต้องยิงซ้ำ — การ์ดทั้งหน้าเรียกคนละครั้งไม่ได้');
  await sandbox.BookingStore.load({ force: true });
  assert.strictEqual(mockSb._calls.filter((c) => c.table === 'v_item_availability').length, before + 1);
});

await test('การ์ดจริงต้องเรียก bookingLineHtml และหน้านั้นต้องโหลด booking-store.js ด้วย', async () => {
  // บทเรียนจาก data/database.js: เขียน store ไว้แต่ไม่มีหน้าไหนโหลด = โค้ดตาย
  const pages = ['equipment.html', 'accessories.html', 'inventory.html'];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.ok(/<script src="js\/booking-store\.js"><\/script>/.test(html),
      `${page} ต้องโหลด js/booking-store.js`);
    const order = html.indexOf('js/supabase-client.js');
    const storeAt = html.indexOf('js/booking-store.js');
    assert.ok(order >= 0 && storeAt > order,
      `${page} ต้องโหลด booking-store.js หลัง supabase-client.js (ต้องใช้ window.sb)`);
  }
  // การ์ดทั้งสองชนิด + หน้า inventory ต้องใช้ยอดจองจริง
  const equip = fs.readFileSync(path.join(ROOT, 'equipment.html'), 'utf8');
  assert.ok(/bookingLineHtml\('accessory', item\.id\)/.test(equip), 'การ์ดอุปกรณ์เสริมใน equipment.html ต้องมียอดจอง');
  assert.ok(/bookingLineHtml\('fixture', item\.id\)/.test(equip), 'การ์ดอุปกรณ์ใน equipment.html ต้องมียอดจอง');
  const acc = fs.readFileSync(path.join(ROOT, 'js/accessories.js'), 'utf8');
  assert.ok(/bookingLineHtml\('accessory', item\.id\)/.test(acc), 'หน้า Accessories ต้องมียอดจอง');
  const inv = fs.readFileSync(path.join(ROOT, 'js/inventory.js'), 'utf8');
  assert.ok(/BookingStore\.get\('fixture', f\.id\)/.test(inv),
    'หน้า Inventory ต้องอ่านยอดจาก BookingStore ไม่ใช่คอลัมน์ reserved ที่กรอกมือ');
  assert.ok(/booking\.reserved/.test(inv) && /booking\.outCount/.test(inv),
    'Inventory ต้องแยก Reserved กับ In Use ออกจากกัน');
});

// ======================= ระบบจอง (bookings / booking_items) =======================
// กติกาที่เจ้าของเว็บล็อกไว้: จองวันเดียว + คืนอัตโนมัติ / ต้อง login /
// stock เป็น null = จองไม่ได้ / ชุดแตกเป็นรายชิ้น / ห้ามเขียนคอลัมน์ stock
// ทั้งหมดนี้บังคับที่ฐานข้อมูล เพราะ JS ข้ามได้เสมอ (ยิง POST ตรง ๆ / แก้ในเบราว์เซอร์)

const BOOKINGS_SQL_REL = 'supabase/migration-2026-11-13c-bookings.sql';
const bookingsSqlRaw = fs.readFileSync(path.join(ROOT, BOOKINGS_SQL_REL), 'utf8');
const bookingsSql = stripSqlComments(bookingsSqlRaw);

// ตัดก้อน create table ออกมาตรวจคอลัมน์ (นับวงเล็บเพื่อให้ได้ทั้ง DDL)
function extractCreateTable(src, table) {
  const start = src.indexOf(`create table if not exists public.${table} (`);
  assert.ok(start >= 0, `ไม่พบ create table public.${table}`);
  let depth = 0;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  throw new Error(`วงเล็บของ create table ${table} ไม่ปิด`);
}
const bookingsDdl = extractCreateTable(bookingsSql, 'bookings');
const bookingItemsDdl = extractCreateTable(bookingsSql, 'booking_items');

await test('ตาราง bookings/booking_items ต้องถูกนิยามในไฟล์ SQL ไฟล์เดียว (กัน repo กับ DB เลื่อน)', async () => {
  // บทเรียนจาก active=false: ไฟล์ SQL สองไฟล์นิยามของชิ้นเดียวกันแล้วค่าไม่ตรงกัน
  // คนรันไฟล์เก่าซ้ำก็ย้อนฐานข้อมูลกลับแบบเงียบ ๆ
  for (const table of ['bookings', 'booking_items']) {
    const owners = sqlFiles.filter((rel) => stripSqlComments(
      fs.readFileSync(path.join(ROOT, rel), 'utf8'),
    ).includes(`create table if not exists public.${table} (`));
    assert.deepStrictEqual(owners, [BOOKINGS_SQL_REL],
      `public.${table} ต้องถูกสร้างใน ${BOOKINGS_SQL_REL} ที่เดียว แต่เจอใน: ${owners.join(', ') || '(ไม่มีเลย)'}`);
  }
});

await test('DDL ของ bookings มีคอลัมน์ครบตามที่เว็บต้องใช้', async () => {
  // เจ้าของเว็บระบุว่าจะต้องเก็บ: ชื่อคนจอง / ชื่องาน / รายการของ / จำนวน / วันที่จอง
  for (const col of ['id', 'member_id', 'job_name', 'job_location', 'booking_date',
    'status', 'group_ref', 'note', 'created_by', 'created_at', 'updated_at']) {
    assert.ok(new RegExp(`\\n\\s*${col}\\s`).test(bookingsDdl), `bookings ขาดคอลัมน์ ${col}`);
  }
  // ชื่อคนจองมาจากตาราง members (ไม่ใช่ text ที่พิมพ์เอง) ไม่งั้นพอเปลี่ยนชื่อแล้วประวัติจะค้างชื่อเก่า
  assert.ok(/member_id\s+uuid\s+not null\s+references public\.members/i.test(bookingsDdl),
    'member_id ต้องเป็น FK ไป public.members และเป็น not null');
  assert.ok(/on delete restrict/i.test(bookingsDdl),
    'ห้ามลบสมาชิกที่มีใบจอง (on delete restrict) — ตรงกับกติกาที่ไม่มีการลบสมาชิก');
  assert.ok(/created_by\s+uuid\s+references auth\.users/i.test(bookingsDdl),
    'created_by ต้องผูกกับ auth.users เพื่อรู้ว่าใครกดสร้าง');
  assert.ok(/booking_date\s+date\s+not null default current_date/i.test(bookingsDdl),
    'booking_date ต้องเป็น date (ไม่ใช่ timestamptz) — กติกาจองเป็น "วัน" ไม่ใช่ช่วงเวลาที่แน่นอน');
});

await test('booking_items ใช้คู่ (item_type, item_id) และกันข้อมูลเพี้ยนด้วย constraint', async () => {
  for (const col of ['id', 'booking_id', 'item_type', 'item_id', 'quantity', 'returned_quantity']) {
    assert.ok(new RegExp(`\\n\\s*${col}\\s`).test(bookingItemsDdl), `booking_items ขาดคอลัมน์ ${col}`);
  }
  assert.ok(/check \(item_type in \('fixture', 'accessory'\)\)/i.test(bookingItemsDdl),
    'item_type ต้องจำกัดแค่ fixture/accessory — พิมพ์ผิดจะทำให้ item_stock() หาของไม่เจอ');
  assert.ok(/item_id\s+bigint\s+not null/i.test(bookingItemsDdl),
    'item_id ต้องเป็น bigint ให้ตรงกับ fixtures.id / accessories.id');
  assert.ok(/quantity\s+integer\s+not null check \(quantity > 0\)/i.test(bookingItemsDdl),
    'quantity ต้อง > 0 — ไม่งั้นเลขติดจองจะเพี้ยนและตรวจเกินสต็อกไม่ได้');
  assert.ok(/unique \(booking_id, item_type, item_id\)/i.test(bookingItemsDdl),
    'ต้องมี unique กันรายการซ้ำในใบจองเดียว (กดเพิ่มซ้ำจะทำให้ยอดจองเกินจริง)');
  assert.ok(/on delete cascade/i.test(bookingItemsDdl),
    'ลบใบจองต้องลบรายการตาม (on delete cascade) ไม่งั้นรายการกำพร้าจะค้างและนับสต็อกผิด');
});

await test('status มี check constraint ครบ 4 ค่า และยกเลิกต้องไม่วนกลับมา', async () => {
  const m = /check \(status in \(([^)]*)\)\)/i.exec(bookingsDdl);
  assert.ok(m, 'bookings.status ต้องมี check constraint');
  const allowed = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepStrictEqual(allowed, ['cancelled', 'checked_out', 'overdue', 'reserved'],
    'ค่า status ต้องตรงกับที่เว็บ/เอกสารใช้ — เพิ่มหรือลบค่าต้องแก้ทั้งสองฝั่ง');
});

await test('trigger กันจองเกินต้องล็อก advisory lock "ก่อน" นับจำนวนที่ถูกจองไว้', async () => {
  // สลับลำดับ = ล็อกหลังจากอ่านค่า แล้วคนที่สองก็ยังอ่านค่าเก่าได้ (race ไม่หาย)
  const fn = /create or replace function public\.booking_check_stock\([\s\S]*?\n\$\$;/m.exec(bookingsSql);
  assert.ok(fn, 'ต้องมีฟังก์ชัน booking_check_stock()');
  const body = fn[0];
  assert.ok(/pg_advisory_xact_lock\(hashtext\(/.test(body),
    'ต้องใช้ pg_advisory_xact_lock(hashtext(item_type||\':\'||item_id)) ล็อกรายชิ้น');
  const lockAt = body.indexOf('pg_advisory_xact_lock');
  const countAt = body.search(/sum\(greatest\(bi\.quantity/i);
  assert.ok(lockAt >= 0 && countAt >= 0 && lockAt < countAt,
    `ลำดับผิด: ล็อกที่ ${lockAt} แต่นับจำนวนที่ ${countAt} — ล็อกต้องมาก่อนนับ`);
  // ต้องนับเฉพาะที่ยังไม่ยกเลิก และนับ overdue ทุกวัน (ของยังไม่กลับคลังจริง)
  assert.ok(/b\.status <> 'cancelled'/i.test(body), 'ต้องไม่นับใบจองที่ยกเลิกแล้ว');
  assert.ok(/b\.booking_date = p_date or b\.status = 'overdue'/i.test(body),
    'สูตรนับต้องเป็น (วันเดียวกัน หรือ ค้างคืน) — ไม่งั้นคืนอัตโนมัติ/overdue จะทำงานผิด');
  assert.ok(/is distinct from p_exclude_item_id/i.test(body)
    && /is distinct from p_exclude_booking_id/i.test(body),
    'ต้องมีตัวข้ามแถวตัวเองตอน UPDATE/ย้ายวัน ไม่งั้นจะนับตัวเองซ้ำแล้วปฏิเสธผิด');
});

await test('รายการที่ยังไม่ระบุจำนวน (stock = null) ต้องจองไม่ได้ — ห้ามเดาเป็น 0', async () => {
  const fn = /create or replace function public\.booking_check_stock\([\s\S]*?\n\$\$;/m.exec(bookingsSql)[0];
  assert.ok(/if v_stock is null then\s+raise exception/i.test(fn),
    'stock = null ต้อง raise exception (accessories 70 จาก 72 แถวเป็นแบบนี้)');
  assert.ok(/ยังไม่ระบุจำนวน/.test(bookingsSqlRaw), 'ข้อความต้องบอกว่ายังไม่ระบุจำนวน ไม่ใช่ "ของหมด"');
  // parse_stock_text ต้องแกะด้วย regex ไม่ใช่ cast ตรง ๆ (cast "10 Pieces"::numeric จะ error ทั้งไฟล์)
  const parse = /create or replace function public\.parse_stock_text\([\s\S]*?\n\$\$;/m.exec(bookingsSql);
  assert.ok(parse, 'ต้องมี parse_stock_text() เพราะ accessories.stock เป็น text');
  assert.ok(/substring\(coalesce\(p_text, ''\) from/i.test(parse[0]),
    'ต้องแกะตัวเลขด้วย regex — text อย่าง "10 Pieces" cast เป็น numeric ตรง ๆ ไม่ได้');
});

await test('ห้ามมี SQL บรรทัดไหนเขียนคอลัมน์ stock (ยอดจองต้องถูกคำนวณ ไม่ใช่แก้สต็อก)', async () => {
  // ถ้ามี update ... set stock/stock_count แปลว่ามีแหล่งความจริง 2 แหล่ง
  // แล้วตัวเลขบนการ์ดกับยอดจองจริงจะเหลื่อมกันแบบตามแก้ไม่เจอ
  for (const rel of sqlFiles) {
    const body = stripSqlComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')).toLowerCase();
    const hits = [...body.matchAll(/update\s+public\.(fixtures|accessories)\s+set\s+[^;]*?(stock_count|stock)\s*=/g)];
    assert.deepStrictEqual(hits.map((h) => h[0].slice(0, 70)), [],
      `${rel} มีการเขียนคอลัมน์ stock — ยอดจองต้องคำนวณจาก booking_items เท่านั้น`);
  }
  assert.ok(!/alter table public\.(fixtures|accessories)[^;]*add column[^;]*booked/i.test(bookingsSql),
    'ห้ามเพิ่มคอลัมน์ booked เข้าตารางอุปกรณ์ — ใช้ view คำนวณแทน');
});

await test('trigger ต้องเติม created_by/member_id เอง และ crew จองแทนคนอื่นหรือตั้งสถานะข้ามขั้นไม่ได้', async () => {
  const guard = /create or replace function public\.bookings_guard\(\)[\s\S]*?\n\$\$;/m.exec(bookingsSql);
  assert.ok(guard, 'ต้องมี trigger bookings_guard()');
  const body = guard[0];
  assert.ok(/if v_uid is null then\s+raise exception/i.test(body), 'ไม่ login ต้องจองไม่ได้');
  assert.ok(/new\.member_id := v_self/i.test(body),
    'ต้องบังคับ member_id เป็นของตัวเองเสมอ (crew) — ไม่งั้นสวมรอยจองในชื่อคนอื่นได้');
  assert.ok(/not in \('reserved', 'cancelled'\)/i.test(body),
    'crew ต้องตั้งสถานะได้แค่ reserved/cancelled — checked_out/overdue เป็นงานของ admin');
  assert.ok(/v_active is not true/i.test(body), 'บัญชีที่ถูกปิดใช้งานต้องจองไม่ได้');
  assert.ok(/booking_date < current_date/i.test(body), 'crew ต้องจองย้อนหลังไม่ได้');
  // returned_quantity ปลดสต็อกได้โดยไม่ต้องคืนของจริง จึงต้องสงวนให้ admin
  const itemGuard = /create or replace function public\.booking_items_guard\(\)[\s\S]*?\n\$\$;/m.exec(bookingsSql);
  assert.ok(itemGuard, 'ต้องมี trigger booking_items_guard()');
  assert.ok(/new\.returned_quantity is distinct from old\.returned_quantity/i.test(itemGuard[0])
    && /not public\.is_admin\(\)/i.test(itemGuard[0]),
    'crew ต้องแก้ returned_quantity ไม่ได้ (แก้แล้วสต็อกจะว่างขึ้นโดยไม่มีการคืนของจริง)');
});

await test('ทุก trigger function ในทุกไฟล์ SQL ต้องปัก search_path', async () => {
  // เดิมตรวจแค่ schema.sql — แต่ไฟล์ migration เพิ่มฟังก์ชันใหม่เรื่อย ๆ
  // และฐานข้อมูลจริงเคยมี set_updated_at() ที่ proconfig เป็น null อยู่แล้ว
  //
  // ยอมรับได้ 2 ทาง (ตาม pattern ที่มีอยู่จริงใน repo):
  //   1. ปักไว้ใน CREATE เลย
  //   2. ไฟล์เก่าไม่ได้ปัก แล้วมี migration รุ่นหลัง alter function ... set search_path ให้
  //      (members_fill_code() เป็นแบบนี้ — ดูขั้น 4.5 ของ migration-2026-11-13)
  //      ที่ไม่แก้ไฟล์เก่าเพราะมันถูกรันไปแล้ว และการแก้ไฟล์ที่รันแล้วคือต้นตอ
  //      ของบั๊ก active=false ที่เพิ่งเจอมา
  const pinnedByAlter = new Set();
  let seen = 0;
  const unpinned = [];
  for (const rel of sqlFiles) {
    const body = stripSqlComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const m of body.matchAll(/alter function public\.([a-z_]+)\s*\(\s*\)\s+set search_path\s*=\s*public,\s*pg_temp/g)) {
      pinnedByAlter.add(m[1]);
    }
  }
  for (const rel of sqlFiles) {
    const body = stripSqlComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const m of body.matchAll(/create or replace function public\.([a-z_]+)\s*\(([\s\S]*?)\n\$\$;/g)) {
      const [, name, header] = m;
      if (!/returns\s+trigger/i.test(header)) continue;
      seen++;
      if (/set search_path\s*=\s*public,\s*pg_temp/.test(header)) continue;
      if (pinnedByAlter.has(name)) continue;
      unpinned.push(`${rel}: public.${name}()`);
    }
  }
  assert.deepStrictEqual(unpinned, [],
    'trigger function เหล่านี้ไม่ได้ปัก search_path และไม่มี alter function แก้ให้ในไฟล์ไหนเลย:\n  '
    + unpinned.join('\n  '));
  assert.ok(seen >= 6, `ควรเจอ trigger function อย่างน้อย 6 ตัว แต่เจอ ${seen}`);
});

await test('bookings/booking_items ต้องเปิด RLS และมี policy ครบทุกคำสั่ง', async () => {
  for (const t of ['bookings', 'booking_items']) {
    assert.ok(new RegExp(`alter table public\\.${t}\\s+enable row level security`).test(bookingsSql),
      `${t} ต้อง enable row level security — ลืมคือทุกคนอ่านใบจองของทุกคนได้`);
  }
  const policies = [...bookingsSql.matchAll(/create policy "([^"]+)"\s+on public\.(\w+)\s+for (\w+)/g)]
    .map((m) => ({ name: m[1], table: m[2], cmd: m[3] }));
  for (const t of ['bookings', 'booking_items']) {
    const cmds = new Set(policies.filter((p) => p.table === t).map((p) => p.cmd));
    for (const need of ['select', 'insert', 'update', 'delete']) {
      assert.ok(cmds.has(need), `${t} ขาด policy สำหรับ ${need}`);
    }
  }
  // policy เขียนต้องจำกัดที่ authenticated (anon จองไม่ได้) และอ้างสิทธิ์จริง
  for (const p of policies) {
    const block = new RegExp(`create policy "${p.name}"[\\s\\S]*?;`).exec(bookingsSql)[0];
    assert.ok(/to authenticated/.test(block), `policy "${p.name}" ต้องระบุ to authenticated (ไม่ให้ anon เข้า)`);
    assert.ok(/is_admin\(\)|current_member_id\(\)|auth\.uid\(\)|from public\.bookings b/i.test(block),
      `policy "${p.name}" ต้องอ้างสิทธิ์จริง ไม่ใช่ using (true)`);
  }
  // booking_items ต้องโยงผ่านใบจองแม่ — ไม่งั้น crew อ่านรายการของคนอื่นได้
  const itemSelect = /create policy "booking_items read own"[\s\S]*?;/m.exec(bookingsSql)[0];
  assert.ok(/exists \(select 1 from public\.bookings b where b\.id = booking_id\)/i.test(itemSelect),
    'policy อ่าน booking_items ต้องกรองผ่านใบจองแม่ (ซึ่งโดน RLS ของ bookings กรองอีกชั้น)');
});

await test('view ยอดคงเหลือต้องเปิดให้สาธารณะ แต่ view ที่มีชื่อคนต้องล็อกไว้ให้ admin', async () => {
  // การ์ดอุปกรณ์โชว์ "ติดจอง X / เหลือ Y" ให้ทุกคนเห็น จึงต้องอ่านได้แม้ยังไม่ login
  // และ view ต้องไม่ใช้ security_invoker — ไม่งั้น anon จะเห็น booked = 0 ทุกชิ้น
  assert.ok(/create or replace view public\.v_item_availability/i.test(bookingsSql),
    'ต้องมี view v_item_availability ให้เว็บอ่านยอดคงเหลือ');
  assert.ok(!/security_invoker/i.test(bookingsSql),
    'ห้ามตั้ง security_invoker ให้ v_item_availability — RLS ของ bookings จะกรองยอดจองทิ้งจนเหลือ 0');
  assert.ok(/grant select on public\.v_item_availability to anon, authenticated/i.test(bookingsSql),
    'ต้อง grant ให้ anon ด้วย (ผู้เยี่ยมชมยังไม่ได้ login ก็ต้องเห็นของเหลือกี่ชิ้น)');
  assert.ok(/stock_unknown/i.test(bookingsSql)
    && /case when i\.stock is null then null/i.test(bookingsSql),
    'stock เป็น null ต้องให้ available เป็น null ด้วย — ห้ามโชว์ 0 เพราะจะแปลว่าของหมด');

  // view นี้ join ตาราง members (มีชื่อคนจอง) จึงต้องล็อกด้วย is_admin() ใน where clause
  const stale = /create or replace view public\.v_booking_stale as[\s\S]*?;/m.exec(bookingsSql);
  assert.ok(stale, 'ต้องมี view v_booking_stale ไว้ให้ admin ดูใบจองที่เลยวันแล้วยังไม่คืน');
  assert.ok(/and public\.is_admin\(\)/i.test(stale[0]),
    'v_booking_stale ต้องมี and public.is_admin() ใน where — view ข้าม RLS จึงต้องกรองเอง');
  assert.ok(!/to anon/i.test(/grant select on public\.v_booking_stale[^;]*;/i.exec(bookingsSql)[0]),
    'v_booking_stale ห้าม grant ให้ anon (มีชื่อคนจองอยู่)');
});

await test('set_updated_at ต้องมีประกาศใน repo และ trigger ของ bookings ต้องใช้มัน', async () => {
  // ตรวจจากฐานข้อมูลจริง: trigger fixtures_set_updated_at / accessories_set_updated_at
  // ทำงานอยู่ แต่ไม่มีไฟล์ SQL ไหนใน repo ประกาศฟังก์ชันนี้ -> ติดตั้งใหม่จะพัง
  assert.ok(/create or replace function public\.set_updated_at\(\)/i.test(bookingsSql),
    'ไฟล์ bookings ต้องประกาศ set_updated_at() ไว้ด้วย (ของเดิมมีแต่ในฐานข้อมูล ไม่มีใน repo)');
  assert.ok(/create trigger bookings_set_updated_at/i.test(bookingsSql),
    'bookings ต้องมี trigger เติม updated_at');
  assert.ok(/create trigger fixtures_set_updated_at/i.test(bookingsSql)
    && /create trigger accessories_set_updated_at/i.test(bookingsSql),
    'ต้องสร้าง trigger updated_at ของ fixtures/accessories คืนให้ตรงกับฐานข้อมูลจริง');
  assert.ok(/set search_path = public, pg_temp/i.test(
    /create or replace function public\.set_updated_at\(\)[\s\S]*?\n\$\$;/m.exec(bookingsSql)[0],
  ), 'set_updated_at ตัวในฐานข้อมูลยังไม่ปัก search_path — ตัวที่ประกาศใหม่ต้องปัก');
});

await test('ต้องมีขั้นตรวจหลังรัน และบอกวิธีย้อนกลับ', async () => {
  assert.ok(/ขั้น 7/.test(bookingsSqlRaw) && /pg_get_triggerdef/.test(bookingsSqlRaw),
    'ต้องมีขั้นตรวจด้วย pg_get_triggerdef() (ห้ามถอด bitmask tgtype เอง — เคยพังมาแล้ว)');
  assert.ok(/pg_policies/.test(bookingsSqlRaw), 'ต้องมีขั้นตรวจ policy หลังรัน');
  assert.ok(/ย้อนกลับ/.test(bookingsSqlRaw) && /drop table if exists public\.booking_items/i.test(bookingsSqlRaw),
    'ต้องบอกวิธีย้อนกลับ และลบ booking_items ก่อน bookings (FK)');
  // บล็อกทดสอบต้องลบข้อมูลทดสอบทิ้งเสมอ
  assert.ok(/delete from public\.bookings where id = v_booking/i.test(bookingsSqlRaw),
    'บล็อกทดสอบ trigger ต้องลบใบจองทดสอบทิ้ง ไม่งั้นจะค้างไปนับสต็อกจริง');
});

console.log(`\nสรุป: ผ่าน ${passed} / ไม่ผ่าน ${failed}\n`);
process.exit(failed ? 1 : 0);
