// member-store.js - ทีมงานและสิทธิ์ (ตาราง public.members)
//
// ต่างจาก DB / AccessoryStore สองข้อ และทั้งสองข้อจงใจทำ:
//
//   1) "ไม่มี create" — บัญชี login สร้างจากเบราว์เซอร์ไม่ได้
//      publishable key เรียก auth.admin.createUser() ไม่ได้ (ต้องใช้ service_role
//      ซึ่งห้ามอยู่ในโค้ดฝั่งเว็บเด็ดขาด) และอ่าน auth.users ก็ไม่ได้
//      แถวในตาราง members จึงถูกสร้างโดย trigger handle_new_auth_user ใน Supabase
//      ตอนที่บัญชีถูกสร้างใน Dashboard — โผล่มาเป็น role 'crew' + active=false
//      หน้าเว็บมีหน้าที่ "อนุมัติและตั้งสิทธิ์" ไม่ใช่ "สร้างคน"
//
//   2) "ไม่มี remove" — การนำคนออกใช้ปิดใช้งาน (active=false) แทนการลบ
//      กดคืนได้ทันที และยังเหลือประวัติไว้ trigger protect_last_admin
//      จะกันไม่ให้ปิดใช้งานหรือลดสิทธิ์ admin คนสุดท้าย
//
// ⚠️ id ของตารางนี้เป็น uuid ไม่ใช่ bigint จึงห้ามเอาไป Number() เด็ดขาด
//    (Number('9f1c…') ได้ NaN แล้ว NaN === NaN เป็น false ทำให้ lookup พังเงียบ ๆ)

const MemberStore = (() => {
  const STORAGE_KEY = 'lighting_db_members_v1';

  // [ชื่อฟิลด์ในเว็บ, ชื่อคอลัมน์ใน Supabase, เขียนได้ไหม]
  // ตัวที่เขียนไม่ได้จะถูกข้ามใน toRow() เสมอ ต่อให้มีอยู่ใน patch ก็ตาม
  const FIELDS = [
    ['code', 'code', true],
    ['fullName', 'full_name', true],
    ['phone', 'phone', true],
    ['role', 'role', true],
    ['active', 'active', true],
    ['note', 'note', true],
    // สำเนาอีเมลที่ได้จาก trigger ตอนสร้างบัญชี — แก้ของจริงต้องไปที่
    // Supabase → Authentication ถ้าให้เว็บแก้ได้จะเกิดค่าที่เถียงกันสองที่
    ['email', 'email', false],
    // เขียนทับ auth_uid ผิดตัว = ยกสิทธิ์ให้คนผิดทั้งระบบ จึงอ่านอย่างเดียว
    ['authUid', 'auth_uid', false],
  ];

  let members = [];
  let mode = 'local';
  let knownColumns = null;
  let supabaseReachable = false;
  let tableExists = false;
  let lastError = null;
  let lastWriteError = null;

  function tableName() {
    return (window.SUPABASE_TABLES && window.SUPABASE_TABLES.members) || 'members';
  }

  function textOrNull(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s ? s : null;
  }

  function normalizeItem(item = {}) {
    // role ที่ไม่รู้จักให้ถือเป็น crew เสมอ — fail safe ไปทางสิทธิ์น้อยที่สุด
    const role = String(item.role ?? '').trim().toLowerCase() === 'admin' ? 'admin' : 'crew';
    return {
      ...item,
      id: item.id === null || item.id === undefined ? null : String(item.id),
      code: textOrNull(item.code),
      fullName: textOrNull(item.fullName),
      email: textOrNull(item.email),
      phone: textOrNull(item.phone),
      note: textOrNull(item.note),
      authUid: item.authUid === null || item.authUid === undefined ? null : String(item.authUid),
      role,
      active: item.active === true || item.active === 'true',
    };
  }

  function sortAll() {
    members.sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
    return members;
  }

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function persistLocal() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(members)); } catch (e) { /* quota */ }
  }

  // ============================ โหมด LOCAL ============================
  // ตาราง members ไม่มีไฟล์ data/*.json ให้ seed (รายชื่อคนไม่ใช่ข้อมูลแคตตาล็อก)
  // โหมด local จึงเริ่มจากว่าง และมีไว้แค่กันหน้าเว็บพังตอน Supabase หลุด
  // — ไม่ใช่ไว้ใช้งานจริง UI ต้องเตือนเสมอเมื่ออยู่ในโหมดนี้
  async function loadLocal() {
    const raw = safeGet(STORAGE_KEY);
    if (!raw) { members = []; return members; }
    try {
      const parsed = JSON.parse(raw);
      members = Array.isArray(parsed) ? parsed.map(normalizeItem) : [];
    } catch (e) {
      members = [];
    }
    return sortAll();
  }

  // ============================ โหมด SUPABASE ============================
  function describeError(err) {
    if (!err) return null;
    const msg = String(err.message || err.msg || err).trim();
    if (/relation .* does not exist|42P01/i.test(msg)) {
      return `ไม่พบตาราง "${tableName()}" ใน Supabase — ต้องรัน supabase/migration-2026-10-22-members.sql ก่อน`;
    }
    if (/column .* does not exist|42703/i.test(msg)) {
      return `คอลัมน์ในตาราง "${tableName()}" ไม่ครบ: ${msg}`
        + ' — รัน supabase/migration-2026-11-13-member-admin.sql';
    }
    if (/row-level security|new row violates|42501|permission denied/i.test(msg)) {
      return `RLS ปิดกั้นตาราง "${tableName()}" — บัญชีนี้ต้องเป็น admin ถึงจะจัดการทีมงานได้`;
    }
    if (/Failed to fetch|NetworkError|fetch failed|ERR_NETWORK|timeout/i.test(msg)) {
      return 'เชื่อมต่อ Supabase ไม่ได้ (เน็ตหลุด / URL ผิด / project ถูก pause)';
    }
    if (/Invalid API key|JWT|401|403/i.test(msg)) {
      return 'API key ไม่ถูกต้องหรือหมดอายุ — ตรวจ SUPABASE_ANON_KEY ใน js/supabase-config.js';
    }
    // trigger protect_last_admin ส่งข้อความไทยมาอยู่แล้ว ให้โชว์ตามนั้น
    return msg;
  }

  function mapRow(row) {
    const item = { id: row.id === null || row.id === undefined ? null : String(row.id) };
    FIELDS.forEach(([camel, snake]) => {
      item[camel] = row[snake] ?? row[camel] ?? null;
    });
    return normalizeItem(item);
  }

  function toRow(patch = {}) {
    const row = {};
    FIELDS.forEach(([camel, snake, writable]) => {
      if (!writable) return;                 // auth_uid / email ห้ามเขียนจากเว็บ
      if (!(camel in patch)) return;
      if (knownColumns && !knownColumns.has(snake)) return;
      let v = patch[camel];
      if (camel === 'active') v = v === true || v === 'true';
      if (camel === 'role') v = String(v || '').trim().toLowerCase() === 'admin' ? 'admin' : 'crew';
      if (typeof v === 'string') v = v.trim();
      if (v === undefined || v === '') v = null;
      row[snake] = v;
    });
    return row;
  }

  function upsertLocal(item) {
    const idx = members.findIndex((m) => String(m.id) === String(item.id));
    if (idx === -1) members.push(item);
    else members[idx] = item;
    sortAll();
    return item;
  }

  async function loadFromSupabase() {
    if (!window.sb) {
      supabaseReachable = false;
      throw new Error((window.SB_DIAG && window.SB_DIAG.error) || 'Supabase client ไม่พร้อมใช้งาน');
    }

    const { data, error } = await window.sb.from(tableName()).select('*').order('code', { ascending: true });

    if (error) {
      supabaseReachable = !/Failed to fetch|NetworkError|fetch failed/i.test(String(error.message || ''));
      tableExists = !/relation .* does not exist|42P01/i.test(String(error.message || ''));
      throw new Error(describeError(error) || error.message);
    }

    supabaseReachable = true;
    tableExists = true;

    const rows = data || [];
    knownColumns = rows.length ? new Set(Object.keys(rows[0])) : null;

    members = rows.map(mapRow);
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
        mode = 'supabase';
        // ต่างจาก store อื่น: ตารางว่างเป็นเรื่องปกติ (ยังไม่มีใครถูกสร้าง)
        // จึงไม่ถอยไปโหมด local เพราะจะโชว์ข้อมูลปลอมแทนที่จะโชว์ว่าว่างจริง
        return rows;
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
    return members;
  }

  // ============================ อ่าน ============================
  function getAll() {
    return [...members];
  }

  function getById(id) {
    return members.find((m) => String(m.id) === String(id)) || null;
  }

  function findByEmail(email) {
    const target = String(email || '').trim().toLowerCase();
    if (!target) return null;
    return members.find((m) => String(m.email || '').trim().toLowerCase() === target) || null;
  }

  // แถวที่ trigger สร้างไว้รอการอนุมัติ (ยังไม่ active)
  function pending() {
    return members.filter((m) => m.active !== true);
  }

  function activeAdmins() {
    return members.filter((m) => m.active === true && m.role === 'admin');
  }

  function counts() {
    return {
      total: members.length,
      admin: members.filter((m) => m.active && m.role === 'admin').length,
      crew: members.filter((m) => m.active && m.role === 'crew').length,
      pending: members.filter((m) => !m.active).length,
    };
  }

  // คอลัมน์ที่เว็บรู้จักแต่ตารางจริงยังไม่มี (เช่นยังไม่ได้รัน migration ตัวใหม่)
  // คืน [] เมื่อไม่รู้จริง ๆ (โหมด local หรือตารางว่างจน probe ไม่เห็นคอลัมน์)
  function missingColumns() {
    if (!knownColumns) return [];
    return FIELDS
      .filter(([, snake]) => !knownColumns.has(snake))
      .map(([camel, snake]) => ({ field: camel, column: snake }));
  }

  // ============================ เขียน (async) ============================
  // ไม่มี create() และไม่มี remove() — ดูคำอธิบายหัวไฟล์
  async function update(id, patch) {
    if (id === null || id === undefined) throw new Error('ไม่มี id ของสมาชิก');

    if (mode === 'supabase') {
      const row = toRow(patch);
      if (!Object.keys(row).length) return getById(id);
      const { data, error } = await window.sb
        .from(tableName())
        .update(row)
        .eq('id', String(id))
        .select()
        .single();
      if (error) {
        lastWriteError = describeError(error) || error.message;
        throw new Error(lastWriteError);
      }
      return upsertLocal(mapRow(data));
    }

    const idx = members.findIndex((m) => String(m.id) === String(id));
    if (idx === -1) return null;
    members[idx] = normalizeItem({ ...members[idx], ...patch });
    sortAll();
    persistLocal();
    return members[idx];
  }

  // อนุมัติ / ปิดใช้งาน — ทางเดียวที่ทำให้คนเข้าหรือออกจากระบบ
  async function setActive(id, active) {
    return update(id, { active: active === true });
  }

  async function setRole(id, role) {
    return update(id, { role: String(role || '').toLowerCase() === 'admin' ? 'admin' : 'crew' });
  }

  function status() {
    return {
      mode,
      isSupabase: mode === 'supabase',
      ...counts(),
      count: members.length,
      table: tableName(),
      reachable: supabaseReachable,
      tableExists,
      missingColumns: missingColumns(),
      error: lastError || null,
      writeError: lastWriteError || null,
    };
  }

  return {
    load,
    getAll,
    getById,
    findByEmail,
    pending,
    activeAdmins,
    counts,
    missingColumns,
    update,
    setActive,
    setRole,
    status,
    getMode: () => mode,
    isSupabase: () => mode === 'supabase',
  };
})();
