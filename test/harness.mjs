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
// mode: 'ok' | 'no-table' | 'network' | 'empty' | 'rls-block-write'
function makeMockSupabase(mode, seed) {
  const tables = {
    fixtures: seed?.fixtures ? seed.fixtures.map((r) => ({ ...r })) : [],
    accessories: seed?.accessories ? seed.accessories.map((r) => ({ ...r })) : [],
  };
  const calls = [];
  let authed = !!seed?.authed;
  let authUser = seed?.authed ? { email: 'admin@test.com' } : null;

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
      if (mode === 'network') return { data: null, error: errorFor(table, 'network') };

      if (kind === 'select') {
        if (mode === 'empty' && table === 'fixtures') return { data: [], error: null };
        let rows = tables[table];
        if (state.limit) rows = rows.slice(0, state.limit);
        return { data: rows.map((r) => ({ ...r })), error: null };
      }

      if (mode === 'rls-block-write' && !authed) return { data: null, error: errorFor(table, 'rls') };

      const incoming = Array.isArray(payload) ? payload : [payload];
      const out = [];

      for (const row of incoming) {
        const id = state.filters.length ? state.filters[0][1] : row?.id;
        const idx = tables[table].findIndex((r) => Number(r.id) === Number(id));

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
        ? { data: { session: { user: { email: authUser?.email || 'admin@test.com' } } }, error: null }
        : { data: { session: null }, error: null }),
      signInWithPassword: async ({ email, password }) => {
        if (mode === 'network') return { data: null, error: { message: 'Failed to fetch' } };
        if (email === 'admin@test.com' && password === 'secret123') {
          authed = true;
          authUser = { email };
          return { data: { session: { user: { email } } }, error: null };
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
    + ' window.badgesHtmlFromCommaList = badgesHtmlFromCommaList;',
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

await test('SUPABASE_ADMIN_EMAILS จำกัดบัญชีได้', async () => {
  const { sandbox } = makeContext({ supabaseMode: 'ok', seed: { fixtures: [sbRowFromFixture(localFixtures[0])], accessories: [] } });
  sandbox.SUPABASE_ADMIN_EMAILS = ['boss@company.com'];
  await sandbox.AdminAuth.ready;
  const res = await sandbox.AdminAuth.signIn('admin@test.com', 'secret123');
  assert.strictEqual(res.ok, false, 'email นอก allowlist ต้องเข้าไม่ได้');
  assert.ok(res.error.includes('ไม่อยู่ในรายชื่อ admin'), `ได้: ${res.error}`);
  assert.strictEqual(sandbox.AdminAuth.isUnlocked(), false);
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

console.log(`\nสรุป: ผ่าน ${passed} / ไม่ผ่าน ${failed}\n`);
process.exit(failed ? 1 : 0);
