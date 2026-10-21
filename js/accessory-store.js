// accessory-store.js - Accessory catalog data layer
//
// ทำงาน 2 โหมดเหมือน DB (เลือกอัตโนมัติตอน load()):
//   1) 'supabase' — อ่าน/เขียนตาราง accessories ใน Supabase
//   2) 'local'    — อ่าน data/accessories.json + เก็บส่วนแก้ไขใน localStorage
//
// ทุก method ที่ "เขียน" เป็น async ทั้งหมด (ต้อง await)

const AccessoryStore = (() => {
  const STORAGE_KEY = 'lighting_db_accessories_v1';
  const LOCAL_URL = 'data/accessories.json';

  // [ชื่อฟิลด์ในเว็บ, ชื่อคอลัมน์ใน Supabase]
  const FIELDS = [
    ['name', 'name'],
    ['brand', 'brand'],
    ['category', 'category'],
    ['stock', 'stock'],
    ['image', 'image'],
    ['pdfPage', 'pdf_page'],
    ['compatibleWith', 'compatible_with'],
    ['hidden', 'hidden'],
  ];

  let accessories = [];
  let mode = 'local';
  let knownColumns = null;
  let compatibleAsText = false;
  let supabaseReachable = false;
  let tableExists = false;
  let lastError = null;
  let lastWriteError = null;

  function tableName() {
    return (window.SUPABASE_TABLES && window.SUPABASE_TABLES.accessories) || 'accessories';
  }

  function toIdArray(value) {
    if (Array.isArray(value)) return value.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (typeof value !== 'string') return [];
    const s = value.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) return arr.map(Number).filter((n) => Number.isFinite(n) && n > 0);
      } catch (e) { /* fallthrough */ }
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      return s.slice(1, -1).split(',').map((x) => Number(x.replace(/"/g, '').trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    return s.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
  }

  function normalizeItem(item = {}) {
    return {
      ...item,
      id: Number(item.id),
      compatibleWith: toIdArray(item.compatibleWith ?? item.compatible_with),
      hidden: item.hidden === true || item.hidden === 'true',
      pdfPage: item.pdfPage === null || item.pdfPage === undefined || item.pdfPage === ''
        ? null
        : Number(item.pdfPage),
    };
  }

  function sortAll() {
    accessories.sort((a, b) => Number(a.id) - Number(b.id));
    return accessories;
  }

  // ============================ โหมด LOCAL ============================
  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function persistLocal() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(accessories)); } catch (e) { /* quota */ }
  }

  async function loadLocal() {
    const res = await fetch(LOCAL_URL, { cache: 'no-store' }).catch(() => null);
    if (!res || !res.ok) throw new Error(`โหลด ${LOCAL_URL} ไม่สำเร็จ`);
    const base = await res.json();
    const overrides = safeGet(STORAGE_KEY);

    if (overrides) {
      try {
        const parsed = JSON.parse(overrides);
        const map = new Map(parsed.map((item) => [Number(item.id), item]));
        accessories = base.map((item) => ({ ...item, ...(map.get(Number(item.id)) || {}) }));
        const baseIds = new Set(base.map((item) => Number(item.id)));
        parsed.forEach((item) => {
          if (!baseIds.has(Number(item.id))) accessories.push(item);
        });
      } catch (e) {
        accessories = base;
      }
    } else {
      accessories = base;
    }

    accessories = accessories.map(normalizeItem);
    return sortAll();
  }

  // ============================ โหมด SUPABASE ============================
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
      return `RLS ปิดกั้นการเข้าถึงตาราง "${tableName()}" — ต้องเพิ่ม policy (ดู supabase/schema.sql)`;
    }
    if (/Failed to fetch|NetworkError|fetch failed|ERR_NETWORK|timeout/i.test(msg)) {
      return 'เชื่อมต่อ Supabase ไม่ได้ (เน็ตหลุด / URL ผิด / project ถูก pause)';
    }
    if (/Invalid API key|JWT|401|403/i.test(msg)) {
      return 'API key ไม่ถูกต้องหรือหมดอายุ — ตรวจ SUPABASE_ANON_KEY ใน js/supabase-config.js';
    }
    return msg;
  }

  function mapRow(row) {
    const item = { id: Number(row.id) };
    FIELDS.forEach(([camel, snake]) => {
      item[camel] = row[snake] ?? row[camel] ?? null;
    });
    return normalizeItem(item);
  }

  function toRow(patch = {}) {
    const row = {};
    FIELDS.forEach(([camel, snake]) => {
      if (!(camel in patch)) return;
      if (knownColumns && !knownColumns.has(snake)) return;
      let v = patch[camel];
      if (camel === 'compatibleWith') {
        const ids = toIdArray(v);
        v = compatibleAsText ? JSON.stringify(ids) : ids;
      }
      if (camel === 'hidden') v = !!v;
      if (v === undefined || v === '') v = null;
      row[snake] = v;
    });
    return row;
  }

  function upsertLocal(item) {
    const idx = accessories.findIndex((a) => Number(a.id) === Number(item.id));
    if (idx === -1) accessories.push(item);
    else accessories[idx] = item;
    sortAll();
    return item;
  }

  async function loadFromSupabase() {
    if (!window.sb) {
      supabaseReachable = false;
      throw new Error((window.SB_DIAG && window.SB_DIAG.error) || 'Supabase client ไม่พร้อมใช้งาน');
    }

    const { data, error } = await window.sb.from(tableName()).select('*').order('id', { ascending: true });

    if (error) {
      supabaseReachable = !/Failed to fetch|NetworkError|fetch failed/i.test(String(error.message || ''));
      tableExists = !/relation .* does not exist|42P01/i.test(String(error.message || ''));
      throw new Error(describeError(error) || error.message);
    }

    supabaseReachable = true;
    tableExists = true;

    const rows = data || [];
    if (rows.length) {
      knownColumns = new Set(Object.keys(rows[0]));
      const sample = rows.find((r) => r.compatible_with !== null && r.compatible_with !== undefined && r.compatible_with !== '');
      compatibleAsText = !!sample && typeof sample.compatible_with === 'string';
    } else {
      knownColumns = null;
      compatibleAsText = false;
    }

    accessories = rows.map(mapRow);
    return sortAll();
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
          return accessories;
        }
        lastError = `ตาราง "${tableName()}" ใน Supabase ว่างเปล่า (ยังไม่ได้ import ข้อมูล หรือ RLS ปิดกั้นแถว)`;
        if (!allowFallback) { mode = 'supabase'; return accessories; }
      } catch (err) {
        lastError = describeError(err) || (err && err.message) || String(err);
        if (!allowFallback) throw err;
      }
    } else if (!window.sb) {
      lastError = (window.SB_DIAG && window.SB_DIAG.error) || 'Supabase client ไม่พร้อมใช้งาน';
      if (!allowFallback) throw new Error(lastError);
    }

    mode = 'local';
    await loadLocal();
    return accessories;
  }

  async function requireWritable() {
    if (!accessories.length && mode === 'local') return load();
    return null;
  }

  // ============================ อ่าน ============================
  function getAll() {
    return [...accessories];
  }

  function getById(id) {
    return accessories.find((item) => Number(item.id) === Number(id)) || null;
  }

  function nextId() {
    return accessories.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
  }

  // ============================ เขียน (async) ============================
  async function create(initial = {}) {
    await requireWritable();
    const item = normalizeItem({
      name: 'New Accessory',
      brand: '',
      category: 'Accessory',
      stock: null,
      image: '',
      pdfPage: null,
      compatibleWith: [],
      hidden: false,
      ...initial,
    });

    if (mode === 'supabase') {
      const { data, error } = await window.sb.from(tableName()).insert(toRow(item)).select().single();
      if (error) {
        lastWriteError = describeError(error) || error.message;
        throw new Error(lastWriteError);
      }
      return upsertLocal(mapRow(data));
    }

    item.id = nextId();
    accessories.push(item);
    sortAll();
    persistLocal();
    return item;
  }

  async function update(id, patch) {
    await requireWritable();

    if (mode === 'supabase') {
      const row = toRow(patch);
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

    const idx = accessories.findIndex((item) => Number(item.id) === Number(id));
    if (idx === -1) return null;
    accessories[idx] = normalizeItem({ ...accessories[idx], ...patch });
    persistLocal();
    return accessories[idx];
  }

  async function remove(id) {
    if (mode === 'supabase') {
      const { error } = await window.sb.from(tableName()).delete().eq('id', Number(id));
      if (error) {
        lastWriteError = describeError(error) || error.message;
        throw new Error(lastWriteError);
      }
      accessories = accessories.filter((item) => Number(item.id) !== Number(id));
      return true;
    }

    const before = accessories.length;
    accessories = accessories.filter((item) => Number(item.id) !== Number(id));
    if (accessories.length !== before) {
      persistLocal();
      return true;
    }
    return false;
  }

  async function replaceAll(newItems) {
    const list = (newItems || []).map(normalizeItem);

    if (mode === 'supabase') {
      const rows = list.map((item) => ({ id: Number(item.id), ...toRow(item) }));
      const { error } = await window.sb.from(tableName()).upsert(rows, { onConflict: 'id' });
      if (error) {
        lastWriteError = describeError(error) || error.message;
        throw new Error(lastWriteError);
      }
      return load();
    }

    accessories = list;
    sortAll();
    persistLocal();
    return accessories;
  }

  function persist() {
    if (mode === 'local') persistLocal();
  }

  function resetToOriginal() {
    if (mode === 'supabase') {
      console.warn('AccessoryStore.resetToOriginal() ไม่มีผลในโหมด Supabase');
      return false;
    }
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    return true;
  }

  function exportJson() {
    return JSON.stringify(accessories, null, 2);
  }

  function status() {
    return {
      mode,
      isSupabase: mode === 'supabase',
      count: accessories.length,
      hiddenCount: accessories.filter((a) => a.hidden).length,
      table: tableName(),
      reachable: supabaseReachable,
      tableExists,
      error: lastError || null,
      writeError: lastWriteError,
    };
  }

  // อ่าน data/accessories.json แล้ว upsert ขึ้น Supabase (ใช้ตอนตารางว่าง)
  async function importLocalToSupabase() {
    if (!window.sb) throw new Error('Supabase client ไม่พร้อมใช้งาน');

    const res = await fetch(LOCAL_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`โหลด ${LOCAL_URL} ไม่สำเร็จ`);
    const base = await res.json();

    const probe = await window.sb.from(tableName()).select('*').limit(1);
    if (probe.error && !/does not exist|42P01/i.test(String(probe.error.message || ''))) {
      throw new Error(describeError(probe.error) || probe.error.message);
    }
    knownColumns = probe.data && probe.data.length ? new Set(Object.keys(probe.data[0])) : null;
    compatibleAsText = false;

    const rows = base.map(normalizeItem).map((item) => ({ id: Number(item.id), ...toRow(item) }));
    const { error } = await window.sb.from(tableName()).upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(describeError(error) || error.message);

    supabaseReachable = true;
    tableExists = true;
    lastError = null;
    return rows.length;
  }

  return {
    load,
    getAll,
    getById,
    nextId,
    create,
    update,
    remove,
    replaceAll,
    persist,
    resetToOriginal,
    exportJson,
    status,
    getMode: () => mode,
    isSupabase: () => mode === 'supabase',
    importLocalToSupabase,
  };
})();
