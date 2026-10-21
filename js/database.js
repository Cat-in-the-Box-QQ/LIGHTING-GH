// database.js - Fixtures data layer
//
// ทำงาน 2 โหมด เลือกอัตโนมัติตอน DB.load():
//   1) 'supabase' — อ่าน/เขียนตาราง fixtures ใน Supabase (ข้อมูลกลาง ใช้ร่วมกันทุกเครื่อง)
//   2) 'local'    — อ่าน data/fixtures.json แล้วเก็บส่วนแก้ไขไว้ใน localStorage
//
// โหมด local จะเป็น fallback อัตโนมัติเมื่อ Supabase ใช้ไม่ได้ (CDN หลุด / ตารางหาย /
// RLS ปิด / ตารางว่าง) เพื่อไม่ให้เว็บขาวเปล่า — และ DB.status() จะบอกเสมอว่าตอนนี้รันโหมดไหน
//
// ทุก method ที่ "เขียน" เป็น async ทั้งหมด (ต้อง await) เพราะโหมด supabase ยิงขึ้นเซิร์ฟเวอร์

const DB = (function () {
  // ============================ ค่าคงที่ ============================
  const STORAGE_KEY = 'lighting_db_fixtures_v6';
  const INVENTORY_KEY = 'lighting_db_inventory_v3';
  const LOCAL_FIXTURES_URL = 'data/fixtures.json';
  const LOCAL_ACCESSORIES_URL = 'data/accessories.json';

  const IMAGE_BASE = '';
  const NEW_IMAGE_DIR = 'images/NEW PRODUCT/Fixture/';
  const NEW_IMAGE_EXT = '.jpg';

  // [ชื่อฟิลด์ในเว็บ, ชื่อคอลัมน์ใน Supabase]
  const FIXTURE_FIELDS = [
    ['brand', 'brand'],
    ['model', 'model'],
    ['category', 'category'],
    ['type', 'type'],
    ['power', 'power'],
    ['powerRaw', 'power_raw'],
    ['weight', 'weight'],
    ['weightRaw', 'weight_raw'],
    ['lux', 'lux'],
    ['lumens', 'lumens'],
    ['beam', 'beam'],
    ['wireless', 'wireless'],
    ['whiteLight', 'white_light'],
    ['color', 'color'],
    ['colorTagStyle', 'color_tag_style'],
    ['ip', 'ip'],
    ['battery', 'battery'],
    ['stock', 'stock'],
    ['stockCount', 'stock_count'],
    ['stockNote', 'stock_note'],
    ['unitsPerSet', 'units_per_set'],
    ['setCountInStock', 'set_count_in_stock'],
    ['dimensions', 'dimensions'],
    ['image', 'image'],
    ['pdfPage', 'pdf_page'],
    ['accessories', 'accessories'],
    ['compatibleText', 'compatible_text'],
    ['hidden', 'hidden'],
    ['reserved', 'reserved'],
    ['inUse', 'in_use'],
    ['remaining', 'remaining'],
  ];

  const FIXTURE_NUMERIC = [
    'power', 'weight', 'lumens', 'stockCount', 'unitsPerSet',
    'setCountInStock', 'pdfPage', 'reserved', 'inUse', 'remaining',
  ];

  // ============================ state ============================
  let fixtures = [];
  let compatMap = new Map();       // fixtureId -> [accessory names] (จากตาราง accessories)
  let knownColumns = null;         // คอลัมน์ที่มีอยู่จริงในตาราง supabase
  let accessoriesAsText = false;   // คอลัมน์ accessories เป็น text หรือ array/jsonb

  let mode = 'local';              // 'supabase' | 'local'
  let supabaseReachable = false;   // ยิง query ไปถึง supabase สำเร็จไหม
  let tableExists = false;         // ตาราง fixtures มีอยู่จริงไหม
  let lastError = null;            // error ล่าสุด (ข้อความอ่านเข้าใจง่าย)
  let lastWriteError = null;

  function tableName() {
    return (window.SUPABASE_TABLES && window.SUPABASE_TABLES.fixtures) || 'fixtures';
  }

  function accessoryTableName() {
    return (window.SUPABASE_TABLES && window.SUPABASE_TABLES.accessories) || 'accessories';
  }

  // ============================ helpers ร่วม ============================
  function normalizeAccessories(value) {
    if (Array.isArray(value)) return value.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (typeof value !== 'string') return [];
    const s = value.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) return arr.map((x) => String(x ?? '').trim()).filter(Boolean);
      } catch (e) { /* ตกไปแบบอื่น */ }
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1);
      const out = [];
      const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
      let m;
      while ((m = re.exec(inner))) {
        const v = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
        if (v && v.trim()) out.push(v.trim());
      }
      return out;
    }
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }

  // alias ให้โค้ดเดิมที่อาจเรียก parseAccessories
  const parseAccessories = normalizeAccessories;

  function num(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function newFixtureImagePath(item) {
    const brand = String(item.brand || '').trim();
    const model = String(item.model || '').trim();
    if (!model) return '';
    const name = brand && !model.toLowerCase().startsWith(brand.toLowerCase())
      ? `${brand} ${model}`
      : model;
    return NEW_IMAGE_DIR + name + NEW_IMAGE_EXT;
  }

  function imageUrl(p) {
    if (!p) return '';
    let s = String(p).trim();
    if (/^(https?:)?\/\//i.test(s) || s.startsWith('data:')) return s;
    s = s.replace(/^\/+/, '');
    try { s = decodeURI(s); } catch (e) { /* ignore */ }
    return IMAGE_BASE + encodeURI(s);
  }

  // path เก่า (images/products/..., images/page-xxx.jpg) หรือว่าง -> สร้าง path ใหม่จาก brand+model
  function resolveFixtureImage(item) {
    const raw = String(item.imageRaw !== undefined ? item.imageRaw : (item.image || '')).trim();
    const isOld = !raw || /^\/?images\/products\//i.test(raw) || /^\/?images\/page-/i.test(raw);
    return imageUrl(isOld ? newFixtureImagePath(item) : raw);
  }

  function imagePathFromUrl(u) {
    if (!u) return u;
    let s = String(u);
    if (IMAGE_BASE && s.startsWith(IMAGE_BASE)) s = s.slice(IMAGE_BASE.length);
    if (!/^(https?:)?\/\//i.test(s) && !s.startsWith('data:')) {
      try { return decodeURI(s); } catch (e) { return s; }
    }
    return s;
  }

  // ============================ โหมด LOCAL ============================
  function loadInventoryMap() {
    try {
      return JSON.parse(localStorage.getItem(INVENTORY_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveInventoryMap(map) {
    try { localStorage.setItem(INVENTORY_KEY, JSON.stringify(map)); } catch (e) { /* quota */ }
  }

  function mergeAccessoriesFromCatalog(baseFixtures, accessoriesCatalog) {
    const compatibilityMap = new Map();

    (accessoriesCatalog || []).forEach((accessory) => {
      const name = String(accessory.name || accessory.model || '').trim();
      if (!name) return;
      const ids = accessory.compatibleWith || accessory.compatible_with || [];
      (ids || []).forEach((fixtureId) => {
        const id = Number(fixtureId);
        if (!id) return;
        if (!compatibilityMap.has(id)) compatibilityMap.set(id, []);
        compatibilityMap.get(id).push(name);
      });
    });

    return (baseFixtures || []).map((fixture) => {
      const direct = normalizeAccessories(fixture.accessories);
      const linked = normalizeAccessories(compatibilityMap.get(Number(fixture.id)) || []);
      const merged = [...new Set([...direct, ...linked])];
      return { ...fixture, accessories: merged, compatibleText: merged.join(' ') };
    });
  }

  function applyInventoryState(items) {
    const inventory = loadInventoryMap();
    items.forEach((item) => {
      const entry = inventory[String(item.id)] || {};
      item.reserved = Number(entry.reserved ?? item.reserved ?? 0) || 0;
      item.inUse = Number(entry.inUse ?? item.inUse ?? 0) || 0;
      item.remaining = Math.max(Number(item.stockCount || 0) - item.reserved - item.inUse, 0);
      item.accessories = normalizeAccessories(item.accessories);
      item.compatibleText = String(item.compatibleText || item.accessories.join(' '));
      item.hidden = !!item.hidden;
      item.imageRaw = item.imageRaw !== undefined ? item.imageRaw : (item.image || '');
    });
    return items;
  }

  function mergeBaseWithOverrides(base, overrides) {
    const overrideMap = new Map((overrides || []).map((item) => [Number(item.id), item]));
    const merged = base.map((item) => {
      const override = overrideMap.get(Number(item.id));
      if (!override) {
        const acc = normalizeAccessories(item.accessories);
        return { ...item, accessories: acc, compatibleText: item.compatibleText || acc.join(' ') };
      }

      const baseAccessories = normalizeAccessories(item.accessories);
      const overrideAccessories = Array.isArray(override.accessories) ? normalizeAccessories(override.accessories) : null;
      const mergedAccessories = overrideAccessories
        ? (overrideAccessories.length ? [...new Set([...baseAccessories, ...overrideAccessories])] : baseAccessories)
        : baseAccessories;

      return {
        ...item,
        ...override,
        accessories: mergedAccessories,
        compatibleText: mergedAccessories.join(' '),
      };
    });

    const baseIds = new Set(base.map((item) => Number(item.id)));
    (overrides || []).forEach((item) => {
      if (!baseIds.has(Number(item.id))) {
        const acc = normalizeAccessories(item.accessories);
        merged.push({ ...item, accessories: acc, compatibleText: acc.join(' ') });
      }
    });

    return merged;
  }

  async function loadLocal() {
    const overrides = safeGetLocalStorage(STORAGE_KEY);
    const [fixturesRes, accessoriesRes] = await Promise.all([
      fetch(LOCAL_FIXTURES_URL, { cache: 'no-store' }).catch(() => null),
      fetch(LOCAL_ACCESSORIES_URL, { cache: 'no-store' }).catch(() => null),
    ]);

    if (!fixturesRes || !fixturesRes.ok) {
      throw new Error(`โหลด ${LOCAL_FIXTURES_URL} ไม่สำเร็จ`);
    }

    const baseFixtures = await fixturesRes.json();
    let accessoriesCatalog = [];
    try {
      accessoriesCatalog = accessoriesRes && accessoriesRes.ok ? await accessoriesRes.json() : [];
    } catch (e) {
      accessoriesCatalog = [];
    }

    const base = mergeAccessoriesFromCatalog(baseFixtures, accessoriesCatalog);

    if (overrides) {
      try {
        fixtures = mergeBaseWithOverrides(base, JSON.parse(overrides));
      } catch (e) {
        fixtures = base;
      }
    } else {
      fixtures = base;
    }

    applyInventoryState(fixtures);
    fixtures.sort((a, b) => Number(a.id) - Number(b.id));
    return fixtures;
  }

  function safeGetLocalStorage(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function persistLocal() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(fixtures)); } catch (e) { /* quota */ }
  }

  // ============================ โหมด SUPABASE ============================
  function mapRow(row) {
    const item = { id: Number(row.id) };
    FIXTURE_FIELDS.forEach(([camel, snake]) => {
      let v = row[snake] ?? row[camel] ?? null;
      if (v !== null && FIXTURE_NUMERIC.includes(camel)) v = num(v, null);
      item[camel] = v;
    });
    item.imageRaw = item.image || '';
    item.hidden = item.hidden === true || item.hidden === 'true';
    item.reserved = Number(item.reserved || 0);
    item.inUse = Number(item.inUse || 0);
    item.accessories = normalizeAccessories(item.accessories);
    return finalize(item);
  }

  function finalize(item) {
    const linked = compatMap.get(Number(item.id)) || [];
    const merged = [...new Set([...normalizeAccessories(item.accessories), ...linked])];
    item.accessories = merged;
    item.compatibleText = merged.join(' ');
    item.image = resolveFixtureImage(item);
    item.remaining = Math.max(
      Number(item.stockCount || 0) - Number(item.reserved || 0) - Number(item.inUse || 0),
      0
    );
    return item;
  }

  function toRow(patch = {}) {
    const row = {};
    FIXTURE_FIELDS.forEach(([camel, snake]) => {
      if (!(camel in patch)) return;
      if (knownColumns && !knownColumns.has(snake)) return; // ข้ามคอลัมน์ที่ไม่มีในตาราง
      let v = patch[camel];
      if (camel === 'image') v = v ? imagePathFromUrl(v) : null;
      if (camel === 'accessories') {
        const arr = normalizeAccessories(v);
        v = accessoriesAsText ? JSON.stringify(arr) : arr;
      }
      if (camel === 'hidden') v = !!v;
      if (v === undefined || v === '') v = null;
      row[snake] = v;
    });
    return row;
  }

  function rebuildCompat(accessoryRows) {
    compatMap = new Map();
    (accessoryRows || []).forEach((acc) => {
      const name = String(acc.name || '').trim();
      if (!name) return;
      const ids = acc.compatible_with || acc.compatibleWith || [];
      (Array.isArray(ids) ? ids : normalizeAccessories(ids)).forEach((fid) => {
        const id = Number(fid);
        if (!id) return;
        if (!compatMap.has(id)) compatMap.set(id, []);
        compatMap.get(id).push(name);
      });
    });
  }

  function upsertLocal(item) {
    const idx = fixtures.findIndex((f) => Number(f.id) === Number(item.id));
    if (idx === -1) fixtures.push(item);
    else fixtures[idx] = item;
    fixtures.sort((a, b) => Number(a.id) - Number(b.id));
    return item;
  }

  // แปลง error จาก Supabase ให้เป็นข้อความที่คนอ่านเข้าใจ
  function describeError(err) {
    if (!err) return null;
    const msg = String(err.message || err.msg || err).trim();
    if (/relation .* does not exist|42P01/i.test(msg)) {
      return `ไม่พบตาราง "${tableName()}" ใน Supabase — ต้องสร้างตารางก่อน (ดู supabase/schema.sql)`;
    }
    if (/column .* does not exist|42703/i.test(msg)) {
      return `คอลัมน์ในตาราง "${tableName()}" ไม่ครบ: ${msg}`;
    }
    if (/row-level security|new row violates|42501|permission denied/i.test(msg)) {
      return `RLS ปิดกั้นการเข้าถึงตาราง "${tableName()}" — ต้องเพิ่ม policy ให้ role anon/authenticated (ดู supabase/schema.sql)`;
    }
    if (/Failed to fetch|NetworkError|fetch failed|ERR_NETWORK|timeout/i.test(msg)) {
      return 'เชื่อมต่อ Supabase ไม่ได้ (เน็ตหลุด / URL ผิด / project ถูก pause)';
    }
    if (/Invalid API key|JWT|401|403/i.test(msg)) {
      return 'API key ไม่ถูกต้องหรือหมดอายุ — ตรวจ SUPABASE_ANON_KEY ใน js/supabase-config.js';
    }
    return msg;
  }

  async function loadFromSupabase() {
    if (!window.sb) {
      supabaseReachable = false;
      throw new Error((window.SB_DIAG && window.SB_DIAG.error) || 'Supabase client ไม่พร้อมใช้งาน');
    }

    const [fx, ac] = await Promise.all([
      window.sb.from(tableName()).select('*').order('id', { ascending: true }),
      window.sb.from(accessoryTableName()).select('id,name,compatible_with,compatibleWith').catch(() => null),
    ]);

    if (fx.error) {
      // ถ้า select คอลัมน์ accessory พัง (ชื่อคอลัมน์ไม่ตรง) ให้ลองใหม่แบบกว้าง ๆ
      let accRows = null;
      if (ac && ac.error && /column|42703|42P01/i.test(String(ac.error.message || ''))) {
        const retry = await window.sb.from(accessoryTableName()).select('*');
        accRows = retry.error ? null : retry.data;
      } else {
        accRows = ac && !ac.error ? ac.data : null;
      }

      supabaseReachable = !/Failed to fetch|NetworkError|fetch failed/i.test(String(fx.error.message || ''));
      tableExists = !/relation .* does not exist|42P01/i.test(String(fx.error.message || ''));
      throw new Error(describeError(fx.error) || fx.error.message);
    }

    supabaseReachable = true;
    tableExists = true;

    let accRows = null;
    if (ac && !ac.error) accRows = ac.data;
    else if (ac && ac.error) {
      const retry = await window.sb.from(accessoryTableName()).select('*');
      accRows = retry.error ? null : retry.data;
    }
    rebuildCompat(accRows);

    const rows = fx.data || [];
    if (rows.length) {
      knownColumns = new Set(Object.keys(rows[0]));
      const sample = rows.find((r) => r.accessories !== null && r.accessories !== undefined && r.accessories !== '');
      accessoriesAsText = !!sample && typeof sample.accessories === 'string';
    } else {
      knownColumns = null;
      accessoriesAsText = false;
    }

    fixtures = rows.map(mapRow);
    fixtures.sort((a, b) => Number(a.id) - Number(b.id));
    return fixtures;
  }

  // ============================ load() ตัวหลัก ============================
  async function load() {
    lastError = null;

    const wantSupabase = !!window.sb && window.SUPABASE_DISABLED !== true;
    const allowFallback = window.SUPABASE_ALLOW_LOCAL_FALLBACK !== false;

    if (wantSupabase) {
      try {
        const rows = await loadFromSupabase();
        if (rows.length) {
          mode = 'supabase';
          return fixtures;
        }
        // ตารางมีอยู่แต่ "ว่าง" -> มักแปลว่ายังไม่ได้ import ข้อมูล หรือ RLS กันแถวไว้หมด
        lastError = `ตาราง "${tableName()}" ใน Supabase ว่างเปล่า (ยังไม่ได้ import ข้อมูล หรือ RLS ปิดกั้นแถว)`;
        if (!allowFallback) {
          mode = 'supabase';
          return fixtures;
        }
      } catch (err) {
        lastError = describeError(err) || (err && err.message) || String(err);
        if (!allowFallback) throw err;
      }
    } else if (!window.sb) {
      lastError = (window.SB_DIAG && window.SB_DIAG.error) || 'Supabase client ไม่พร้อมใช้งาน';
      if (!allowFallback) throw new Error(lastError);
    }

    // ---- fallback: โหมด local ----
    mode = 'local';
    await loadLocal();
    return fixtures;
  }

  // ============================ อ่าน ============================
  function getAll() {
    return [...fixtures];
  }

  function getById(id) {
    return fixtures.find((f) => Number(f.id) === Number(id)) || null;
  }

  function nextId() {
    return fixtures.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
  }

  function isSupabase() {
    return mode === 'supabase';
  }

  function getMode() {
    return mode;
  }

  // ============================ เขียน (async ทุกตัว) ============================
  function requireWritable() {
    if (!fixtures.length && mode === 'local') {
      // ยังไม่ load() -> โหลดก่อนกันข้อมูลหาย
      return load();
    }
    return Promise.resolve(null);
  }

  async function update(id, patch) {
    await requireWritable();

    if (mode === 'supabase') {
      const current = getById(id) || {};
      const next = { ...patch };

      if ('stockCount' in patch || 'reserved' in patch || 'inUse' in patch) {
        const stockCount = num('stockCount' in patch ? patch.stockCount : current.stockCount, 0) || 0;
        const reserved = num('reserved' in patch ? patch.reserved : current.reserved, 0) || 0;
        const inUse = num('inUse' in patch ? patch.inUse : current.inUse, 0) || 0;
        next.remaining = Math.max(stockCount - reserved - inUse, 0);
      }
      if ('accessories' in patch) {
        next.compatibleText = normalizeAccessories(patch.accessories).join(' ');
      }

      const row = toRow(next);
      if (!Object.keys(row).length) return getById(id);

      const { data, error } = await window.sb
        .from(tableName())
        .update(row)
        .eq('id', Number(id))
        .select()
        .single();

      if (error) {
        lastWriteError = describeError(error) || error.message;
        throw new Error(lastWriteError);
      }
      return upsertLocal(mapRow(data));
    }

    // ---- local ----
    const idx = fixtures.findIndex((f) => Number(f.id) === Number(id));
    if (idx === -1) return null;
    const accessories = patch.accessories !== undefined
      ? normalizeAccessories(patch.accessories)
      : normalizeAccessories(fixtures[idx].accessories);
    fixtures[idx] = {
      ...fixtures[idx],
      ...patch,
      accessories,
      compatibleText: accessories.join(' '),
    };
    applyInventoryState(fixtures);
    persistLocal();
    return fixtures[idx];
  }

  async function updateInventory(id, patch) {
    if (mode === 'supabase') {
      const current = getById(id) || { reserved: 0, inUse: 0 };
      return update(id, {
        reserved: Math.max(num(patch.reserved ?? current.reserved, 0) || 0, 0),
        inUse: Math.max(num(patch.inUse ?? current.inUse, 0) || 0, 0),
      });
    }

    const map = loadInventoryMap();
    const key = String(id);
    const current = map[key] || { reserved: 0, inUse: 0 };
    map[key] = {
      reserved: Math.max(num(patch.reserved ?? current.reserved, 0) || 0, 0),
      inUse: Math.max(num(patch.inUse ?? current.inUse, 0) || 0, 0),
    };
    saveInventoryMap(map);
    applyInventoryState(fixtures);
    persistLocal();
    return getById(id);
  }

  function blankFixture(initial = {}) {
    const item = {
      brand: '',
      model: 'New Item',
      category: '',
      type: 'fixture',
      power: null,
      powerRaw: null,
      weight: null,
      weightRaw: null,
      lux: null,
      lumens: null,
      beam: null,
      wireless: null,
      whiteLight: null,
      color: null,
      colorTagStyle: null,
      ip: null,
      battery: null,
      stock: '0 Pieces',
      stockCount: 0,
      stockNote: null,
      unitsPerSet: null,
      setCountInStock: null,
      dimensions: null,
      image: '',
      pdfPage: null,
      reserved: 0,
      inUse: 0,
      remaining: 0,
      accessories: [],
      compatibleText: '',
      hidden: false,
      ...initial,
    };
    item.accessories = normalizeAccessories(item.accessories);
    item.compatibleText = item.accessories.join(' ');
    item.remaining = Math.max(
      Number(item.stockCount || 0) - Number(item.reserved || 0) - Number(item.inUse || 0),
      0
    );
    return item;
  }

  async function create(initial = {}) {
    await requireWritable();
    const item = blankFixture(initial);

    if (mode === 'supabase') {
      const payload = { ...item };
      delete payload.id;            // ให้ฐานข้อมูลสร้าง id เอง
      delete payload.imageRaw;
      const { data, error } = await window.sb
        .from(tableName())
        .insert(toRow(payload))
        .select()
        .single();

      if (error) {
        lastWriteError = describeError(error) || error.message;
        throw new Error(lastWriteError);
      }
      return upsertLocal(mapRow(data));
    }

    item.id = nextId();
    if (!item.image) item.image = 'images/placeholder.svg';
    item.imageRaw = item.image;
    fixtures.push(item);
    fixtures.sort((a, b) => Number(a.id) - Number(b.id));
    applyInventoryState(fixtures);
    persistLocal();
    return item;
  }

  async function duplicate(id) {
    const source = getById(id);
    if (!source) return null;
    const copy = JSON.parse(JSON.stringify(source));
    delete copy.id;
    copy.model = `${copy.model || ''} Copy`.trim();
    copy.image = source.imageRaw || source.image || '';
    delete copy.imageRaw;
    return create(copy);
  }

  async function remove(id) {
    if (mode === 'supabase') {
      const { error } = await window.sb.from(tableName()).delete().eq('id', Number(id));
      if (error) {
        lastWriteError = describeError(error) || error.message;
        throw new Error(lastWriteError);
      }
      fixtures = fixtures.filter((f) => Number(f.id) !== Number(id));
      return true;
    }

    const before = fixtures.length;
    fixtures = fixtures.filter((f) => Number(f.id) !== Number(id));
    const map = loadInventoryMap();
    delete map[String(id)];
    saveInventoryMap(map);
    if (fixtures.length !== before) {
      persistLocal();
      return true;
    }
    return false;
  }

  async function replaceAll(newFixtures) {
    const list = newFixtures || [];

    if (mode === 'supabase') {
      const rows = list.map((item) => {
        const next = { ...item, image: item.imageRaw !== undefined ? item.imageRaw : item.image };
        next.compatibleText = normalizeAccessories(next.accessories).join(' ');
        delete next.imageRaw;
        return { id: Number(item.id), ...toRow(next) };
      });
      const { error } = await window.sb.from(tableName()).upsert(rows, { onConflict: 'id' });
      if (error) {
        lastWriteError = describeError(error) || error.message;
        throw new Error(lastWriteError);
      }
      return load();
    }

    fixtures = list.map((item) => {
      const accessories = normalizeAccessories(item.accessories);
      return { ...item, accessories, compatibleText: accessories.join(' ') };
    }).sort((a, b) => Number(a.id) - Number(b.id));
    applyInventoryState(fixtures);
    persistLocal();
    return fixtures;
  }

  function persist() {
    // โหมด supabase: ไม่ต้องทำอะไร เพราะบันทึกลงเซิร์ฟเวอร์ทุกครั้งอยู่แล้ว
    if (mode === 'local') persistLocal();
  }

  function resetToOriginal() {
    if (mode === 'supabase') {
      console.warn('DB.resetToOriginal() ไม่มีผลในโหมด Supabase (ข้อมูลอยู่บนเซิร์ฟเวอร์)');
      return false;
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(INVENTORY_KEY);
    } catch (e) { /* ignore */ }
    return true;
  }

  function exportJson() {
    const out = fixtures.map(({ imageRaw, ...rest }) => ({ ...rest, image: imageRaw || rest.image }));
    return JSON.stringify(out, null, 2);
  }

  function brands() {
    return [...new Set(fixtures.map((f) => f.brand).filter(Boolean))].sort();
  }

  function categories() {
    return [...new Set(fixtures.map((f) => f.category).filter(Boolean))].sort();
  }

  // ============================ diagnostics ============================
  function status() {
    const diag = window.SB_DIAG || {};
    return {
      mode,
      isSupabase: mode === 'supabase',
      fixtureCount: fixtures.length,
      hiddenCount: fixtures.filter((f) => f.hidden).length,
      supabaseUrl: diag.url || '',
      table: tableName(),
      clientReady: !!diag.clientReady,
      libLoaded: !!diag.libLoaded,
      disabled: !!diag.disabled,
      reachable: supabaseReachable,
      tableExists,
      allowFallback: window.SUPABASE_ALLOW_LOCAL_FALLBACK !== false,
      error: lastError || diag.error || null,
      writeError: lastWriteError,
    };
  }

  // อ่าน data/*.json แล้ว upsert ขึ้น Supabase (ใช้ตอนตารางว่าง)
  async function importLocalToSupabase() {
    if (!window.sb) throw new Error('Supabase client ไม่พร้อมใช้งาน');

    const [fxRes, acRes] = await Promise.all([
      fetch(LOCAL_FIXTURES_URL, { cache: 'no-store' }),
      fetch(LOCAL_ACCESSORIES_URL, { cache: 'no-store' }).catch(() => null),
    ]);
    if (!fxRes.ok) throw new Error(`โหลด ${LOCAL_FIXTURES_URL} ไม่สำเร็จ`);

    const baseFixtures = await fxRes.json();
    let catalog = [];
    try { catalog = acRes && acRes.ok ? await acRes.json() : []; } catch (e) { catalog = []; }

    // ตรวจคอลัมน์จริงของตารางก่อน (กัน insert คอลัมน์ที่ไม่มีอยู่)
    const probe = await window.sb.from(tableName()).select('*').limit(1);
    if (probe.error && !/does not exist|42P01/i.test(String(probe.error.message || ''))) {
      throw new Error(describeError(probe.error) || probe.error.message);
    }
    knownColumns = probe.data && probe.data.length ? new Set(Object.keys(probe.data[0])) : null;
    if (!knownColumns) {
      // ตารางว่าง -> สมมติว่ามีคอลัมน์มาตรฐานครบ ตาม supabase/schema.sql
      knownColumns = null;
      accessoriesAsText = false;
    } else {
      const sample = probe.data.find((r) => r.accessories !== null && r.accessories !== undefined && r.accessories !== '');
      accessoriesAsText = !!sample && typeof sample.accessories === 'string';
    }

    const merged = mergeAccessoriesFromCatalog(baseFixtures, catalog);
    const rows = merged.map((item) => ({
      id: Number(item.id),
      ...toRow({
        ...item,
        image: item.image || '',
        remaining: Math.max(
          Number(item.stockCount || 0) - Number(item.reserved || 0) - Number(item.inUse || 0), 0
        ),
      }),
    }));

    const { error } = await window.sb.from(tableName()).upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(describeError(error) || error.message);

    supabaseReachable = true;
    tableExists = true;
    lastError = null;
    return rows.length;
  }

  return {
    // อ่าน
    load,
    getAll,
    getById,
    nextId,
    brands,
    categories,
    // เขียน (async ทั้งหมด)
    update,
    updateInventory,
    create,
    duplicate,
    remove,
    replaceAll,
    persist,
    resetToOriginal,
    exportJson,
    // diagnostics / tools
    status,
    getMode,
    isSupabase,
    importLocalToSupabase,
  };
})();
