// admin-auth.js - Admin session (Supabase Auth เท่านั้น)
//
// ทำไมเวอร์ชันเดิมพัง:
//   - admin.html เปลี่ยนเป็นช่อง Email + Password แล้ว แต่ admin.js ยังไปหา
//     element id "adminPinInput" ที่ไม่มีอยู่ -> pinInput เป็น null -> โยน TypeError
//     ทันทีที่กดปุ่ม login ทำให้เข้าหน้า admin ไม่ได้เลย
//   - AdminAuth.unlockWithEmail() มีอยู่ แต่ไม่มีโค้ดตรงไหนเรียกใช้
//
// เวอร์ชันนี้: login ด้วย Supabase email/password อย่างเดียว (ถอด PIN ออกแล้ว)
// session ถูกเก็บโดย supabase-js ใน localStorage จึงอยู่ครบทุกหน้าจนกว่าจะ logout
//
// ⚠️ เปลี่ยนสำคัญ (2026-10-22): "login ผ่าน" ไม่เท่ากับ "เป็น admin" อีกแล้ว
//   ของเดิม: SUPABASE_ADMIN_EMAILS = []  ->  emailAllowed() คืน true ทุกอีเมล
//           แปลว่าใครก็ตามที่มีบัญชี Supabase จะได้โหมด admin ทันที
//           วันนี้ยังไม่เป็นไรเพราะมีเจ้าของเว็บคนเดียว แต่พอสร้างบัญชีให้ทีมงาน
//           ใช้ระบบจองของ ทุกคนจะแก้/ซ่อน/ลบอุปกรณ์ได้ทั้งร้าน
//   ตอนนี้: สิทธิ์อ่านจากคอลัมน์ role ในตาราง public.members
//           (admin = แก้ข้อมูลได้, crew = login ได้แต่ไม่ใช่ admin)
//           ตัวตัดสินจริงคือ RLS ใน Supabase — ไฟล์นี้คุมแค่หน้าจอ
//           ดู supabase/migration-2026-10-22-members.sql

const AdminAuth = (() => {
  let unlocked = false;      // true = โหมด admin (แก้ไขข้อมูลได้)
  let loggedIn = false;      // true = login ผ่าน Supabase แล้ว (ไม่สน role)
  let userEmail = null;
  let userId = null;
  let role = null;           // 'admin' | 'crew' | null (ไม่มีแถวใน members)
  let member = null;         // แถวจากตาราง members (code / full_name / ...)
  let restoreError = null;
  let roleError = null;      // เหตุผลที่อ่าน role ไม่ได้ เช่นตาราง members ยังไม่ถูกสร้าง

  function membersTable() {
    return (window.SUPABASE_TABLES && window.SUPABASE_TABLES.members) || 'members';
  }

  function allowedEmails() {
    const list = window.SUPABASE_ADMIN_EMAILS;
    if (!Array.isArray(list)) return [];
    return list.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
  }

  function inAllowedEmails(email) {
    return allowedEmails().includes(String(email || '').trim().toLowerCase());
  }

  // อ่านแถวของตัวเองจากตาราง members
  // ห้ามใส่ .catch() ต่อท้าย builder ของ supabase-js เด็ดขาด — มันเป็น PromiseLike
  // ที่มีแค่ .then() การใส่ .catch() จะโยน TypeError ก่อนส่ง query จริง
  // (บั๊กนี้เคยทำให้ทั้งเว็บถอยไปโหมด local มาแล้ว) จึงใช้ try/await แทน
  async function fetchMember(uid) {
    if (!window.sb || !uid) return { row: null, error: null, queried: false };
    try {
      const { data, error } = await window.sb
        .from(membersTable())
        .select('id, code, full_name, phone, role, active, auth_uid')
        .eq('auth_uid', uid)
        .maybeSingle();
      if (error) return { row: null, error, queried: true };
      return { row: data || null, error: null, queried: true };
    } catch (e) {
      return { row: null, error: e, queried: true };
    }
  }

  function describeMemberError(raw) {
    const msg = String((raw && (raw.message || raw.msg)) || raw || '');
    const code = String((raw && raw.code) || '');
    if (code === '42P01' || /does not exist/i.test(msg)) {
      return `ยังไม่มีตาราง ${membersTable()} ใน Supabase — รัน supabase/migration-2026-10-22-members.sql ก่อน แล้ว login ใหม่`;
    }
    if (code === '42501' || /row-level security|permission denied/i.test(msg)) {
      return `RLS ไม่ให้อ่านตาราง ${membersTable()} — ตรวจว่ารัน migration ครบทุกขั้นแล้ว`;
    }
    if (/Failed to fetch|NetworkError|fetch failed|timeout/i.test(msg)) {
      return 'อ่านสิทธิ์จากตาราง members ไม่สำเร็จ (เน็ตหลุด) — ลองรีเฟรชหน้าใหม่';
    }
    return `อ่านสิทธิ์จากตาราง ${membersTable()} ไม่สำเร็จ: ${msg || 'ไม่ทราบสาเหตุ'}`;
  }

  // แปล error ดิบจาก Supabase ให้เป็นข้อความที่ผู้ใช้เข้าใจและแก้เองได้
  function humanizeAuthError(raw) {
    const msg = String((raw && (raw.message || raw.msg)) || raw || '').trim();
    if (!msg) return 'เข้าสู่ระบบไม่สำเร็จ';
    if (/Invalid login credentials/i.test(msg)) {
      return 'Email หรือรหัสผ่านไม่ถูกต้อง (ตรวจใน Supabase → Authentication → Users)';
    }
    if (/Failed to fetch|NetworkError|fetch failed|ERR_NETWORK|timeout/i.test(msg)) {
      return 'เชื่อมต่อ Supabase ไม่ได้ — ตรวจเน็ต / SUPABASE_URL / ว่า project ยัง active อยู่ไหม';
    }
    if (/Email not confirmed/i.test(msg)) {
      return 'บัญชีนี้ยังไม่ได้ยืนยัน email — กดยืนยันในกล่องจดหมายก่อน หรือปิด Email confirm ใน Supabase';
    }
    if (/rate limit|too many requests|429/i.test(msg)) {
      return 'ลอง login บ่อยเกินไป — รอสักครู่แล้วลองใหม่';
    }
    if (/Invalid API key|JWT|401|403/i.test(msg)) {
      return 'API key ไม่ถูกต้องหรือหมดอายุ — ตรวจ SUPABASE_ANON_KEY ใน js/supabase-config.js';
    }
    if (/User not found/i.test(msg)) {
      return 'ไม่พบบัญชีผู้ใช้นี้ใน Supabase — ต้องเพิ่ม user ใน Authentication → Users ก่อน';
    }
    return msg;
  }

  function resetSession() {
    unlocked = false;
    loggedIn = false;
    userEmail = null;
    userId = null;
    role = null;
    member = null;
    roleError = null;
  }

  // ตัดสินสิทธิ์จาก session + แถวในตาราง members
  // คืนค่า true เฉพาะเมื่อเป็น admin (เพราะ isUnlocked() ถูกใช้คุมปุ่มแก้ไขทั้งเว็บ)
  async function applySession(session) {
    const email = session?.user?.email || null;
    if (!session || !session.user) {
      resetSession();
      return false;
    }

    // login ผ่านแล้ว — จำไว้ก่อน แม้จะไม่ใช่ admin ก็ตาม (ระบบจองต้องใช้)
    loggedIn = true;
    userEmail = email;
    userId = session.user.id || null;

    const { row, error, queried } = await fetchMember(userId);
    member = row;
    roleError = error ? describeMemberError(error) : null;

    if (row && row.active !== false) {
      role = row.role === 'admin' ? 'admin' : (row.role || 'crew');
    } else if (row && row.active === false) {
      role = null;
      restoreError = 'บัญชีนี้ถูกปิดใช้งานไว้ (active = false ในตาราง members) — ให้ admin เปิดก่อน';
    } else {
      role = null;
    }

    // "ตัดสินจากตารางไม่ได้" = query พัง (ตารางหาย/RLS/เน็ตหลุด) หรือ query ไม่ได้ตั้งแต่แรก
    // (ไม่มี user id ใน session) — ต่างจาก "query สำเร็จแต่ไม่พบแถว" ซึ่งแปลว่า
    // ตารางอ่านได้และบัญชีนี้ไม่มีสิทธิ์จริง ต้องปฏิเสธสถานเดียว
    const undetermined = !row && (!!error || !queried);
    if (undetermined && !roleError) {
      roleError = 'อ่านสิทธิ์จากตาราง ' + membersTable() + ' ไม่ได้'
        + (userId ? '' : ' (session ไม่มี user id)')
        + ' — รัน supabase/migration-2026-10-22-members.sql แล้ว login ใหม่';
    }

    // ทางออกฉุกเฉินช่วงเปลี่ยนผ่าน: ถ้า "อ่านตาราง members ไม่ได้เลย" (ยังไม่รัน migration)
    // และอีเมลถูกระบุไว้ใน SUPABASE_ADMIN_EMAILS ชัดเจน ให้ถือเป็น admin
    // — จำเป็นเพราะไม่งั้นเจ้าของเว็บจะเข้าหน้า admin ไม่ได้ในจังหวะที่ deploy โค้ดใหม่
    //   ไปแล้วแต่ยังไม่ได้รัน SQL
    // ถ้าอ่านตาราง members ได้ คำตอบจากตารางเท่านั้นที่เป็นจริง (รายการอีเมลไม่ช่วย)
    if (role !== 'admin' && undetermined && inAllowedEmails(email)) {
      role = 'admin';
      roleError = `${roleError} — ใช้รายชื่อใน SUPABASE_ADMIN_EMAILS แทนชั่วคราว`
        + ' (ฝั่ง Supabase ยังให้เขียนได้อยู่จนกว่าจะรัน migration)';
    }

    unlocked = role === 'admin';

    if (!unlocked && !restoreError) {
      if (error) {
        restoreError = roleError;
      } else if (!row) {
        restoreError = `login สำเร็จ แต่ไม่พบบัญชี ${email} ในตาราง ${membersTable()}`
          + ' — ให้ admin เพิ่มรายชื่อก่อน (ดู supabase/migration-2026-10-22-members.sql)';
      } else {
        // ไม่ใช่ error เสมอไป — crew เข้าหน้า sign-in ได้ (เห็นเฉพาะบัญชีตัวเอง + ปุ่มจอง)
        // แค่ไม่มีเครื่องมือจัดการข้อมูลของ admin
        restoreError = `บัญชี ${email} login สำเร็จแล้ว สิทธิ์เป็น "${role || 'ไม่มี'}"`
          + (role === 'crew'
            ? ' — เห็นเฉพาะบัญชีของตัวเองและใช้จองอุปกรณ์ได้ ไม่มีเครื่องมือแก้ไขข้อมูลของ admin'
            : ' — ไม่ใช่ admin จึงไม่มีสิทธิ์แก้ไขข้อมูล');
      }
    }

    return unlocked;
  }

  // กู้ session เดิมกลับมา — ทุกหน้าต้อง await AdminAuth.ready ก่อนเช็ก isUnlocked()
  const ready = (async () => {
    if (!window.sb) {
      restoreError = (window.SB_DIAG && window.SB_DIAG.error)
        || 'Supabase client ไม่พร้อมใช้งาน — login ด้วย Supabase ไม่ได้';
      return false;
    }
    try {
      const { data, error } = await window.sb.auth.getSession();
      if (error) {
        restoreError = humanizeAuthError(error);
        return false;
      }
      return await applySession(data?.session || null);
    } catch (e) {
      restoreError = humanizeAuthError(e);
      return false;
    }
  })();

  function isUnlocked() {
    return unlocked === true;
  }

  function getEmail() {
    return userEmail;
  }

  function getLastError() {
    return restoreError;
  }

  function hasClient() {
    return !!window.sb;
  }

  // login ด้วย email + password ผ่าน Supabase Auth
  // คืนค่า { ok, error } แทน true/false เพื่อให้หน้าเว็บโชว์เหตุผลจริงได้
  async function signIn(email, password) {
    restoreError = null;

    if (!window.sb) {
      const msg = (window.SB_DIAG && window.SB_DIAG.error)
        || 'Supabase client ไม่พร้อมใช้งาน (โหลด supabase-js ไม่สำเร็จ)';
      restoreError = msg;
      return { ok: false, error: msg };
    }

    const cleanEmail = String(email || '').trim();
    const cleanPassword = String(password || '');
    if (!cleanEmail || !cleanPassword) {
      return { ok: false, error: 'กรุณากรอก Email และรหัสผ่านให้ครบ' };
    }

    try {
      const { data, error } = await window.sb.auth.signInWithPassword({
        email: cleanEmail,
        password: cleanPassword,
      });

      if (error) {
        const msg = humanizeAuthError(error);
        restoreError = msg;
        return { ok: false, error: msg };
      }

      // ไม่ signOut แม้จะไม่ใช่ admin — บัญชี crew ยังต้อง login ค้างไว้
      // เพื่อใช้ระบบจองของต่อไป แค่ไม่ให้เข้าโหมด admin
      if (!await applySession(data?.session || null)) {
        const msg = restoreError || `บัญชี ${cleanEmail} ไม่มีสิทธิ์เข้าโหมด admin`;
        return { ok: false, error: msg, loggedIn, role };
      }

      return { ok: true, email: userEmail, role, member };
    } catch (e) {
      const msg = humanizeAuthError(e);
      restoreError = msg;
      return { ok: false, error: msg };
    }
  }

  async function signOut() {
    resetSession();
    restoreError = null;
    if (window.sb) {
      try { await window.sb.auth.signOut(); } catch (e) { /* ignore */ }
    }
    return true;
  }

  // login ผ่าน Supabase แล้วหรือยัง (ไม่เกี่ยวกับ role)
  // ใช้แยก "ยังไม่ login" ออกจาก "login แล้วแต่เป็น crew"
  function isLoggedIn() {
    return loggedIn === true;
  }

  function getRole() {
    return role;
  }

  function getMember() {
    return member;
  }

  function getMemberCode() {
    return (member && member.code) || null;
  }

  function getMemberName() {
    return (member && member.full_name) || null;
  }

  function getRoleError() {
    return roleError;
  }

  // ภาพรวมทั้งหมด — หน้า admin ใช้โชว์สถานะการเชื่อมต่อและสิทธิ์
  function status() {
    return {
      unlocked,
      loggedIn,
      role,
      member,
      email: userEmail,
      userId,
      hasClient: !!window.sb,
      error: restoreError,
      roleError,
      restricted: allowedEmails(),
    };
  }

  return {
    ready,
    isUnlocked,
    isLoggedIn,
    getRole,
    getMember,
    getMemberCode,
    getMemberName,
    getRoleError,
    signIn,
    signOut,
    getEmail,
    getLastError,
    hasClient,
    status,
    // alias กันโค้ดเก่าพัง
    lock: () => signOut(),
  };
})();
