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
      then: (onF, onR) => { pending = pending || exec(); return pending.then(onF, onR); },
      catch: (onR) => { pending = pending || exec(); return pending.then(undefined, onR); },
      finally: (onF) => { pending = pending || exec(); return pending.finally(onF); },
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
    'window.DB = DB; window.AccessoryStore = AccessoryStore; window.AdminAuth = AdminAuth;',
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

console.log(`\nสรุป: ผ่าน ${passed} / ไม่ผ่าน ${failed}\n`);
process.exit(failed ? 1 : 0);
