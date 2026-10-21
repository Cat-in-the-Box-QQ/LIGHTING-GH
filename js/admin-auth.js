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

const AdminAuth = (() => {
  let unlocked = false;
  let userEmail = null;
  let restoreError = null;

  function allowedEmails() {
    const list = window.SUPABASE_ADMIN_EMAILS;
    if (!Array.isArray(list)) return [];
    return list.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
  }

  function emailAllowed(email) {
    const allow = allowedEmails();
    if (!allow.length) return true;              // ไม่ได้จำกัด = ยอมทุกบัญชีที่ login ผ่าน
    return allow.includes(String(email || '').trim().toLowerCase());
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

  function applySession(session) {
    const email = session?.user?.email || null;
    if (!session || !emailAllowed(email)) {
      unlocked = false;
      userEmail = null;
      return false;
    }
    unlocked = true;
    userEmail = email;
    return true;
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
      return applySession(data?.session || null);
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

      if (!applySession(data?.session || null)) {
        const allow = allowedEmails();
        const msg = allow.length
          ? `บัญชี ${cleanEmail} ไม่อยู่ในรายชื่อ admin (แก้ที่ SUPABASE_ADMIN_EMAILS ใน js/supabase-config.js)`
          : ' login สำเร็จแต่ไม่พบข้อมูลผู้ใช้';
        restoreError = msg;
        try { await window.sb.auth.signOut(); } catch (e) { /* ignore */ }
        return { ok: false, error: msg };
      }

      return { ok: true, email: userEmail };
    } catch (e) {
      const msg = humanizeAuthError(e);
      restoreError = msg;
      return { ok: false, error: msg };
    }
  }

  async function signOut() {
    unlocked = false;
    userEmail = null;
    if (window.sb) {
      try { await window.sb.auth.signOut(); } catch (e) { /* ignore */ }
    }
    return true;
  }

  // เข้าโหมด admin โดยไม่ต้อง login (ใช้ในหน้าอื่นที่เช็ค session ไว้แล้ว)
  function status() {
    return {
      unlocked,
      email: userEmail,
      hasClient: !!window.sb,
      error: restoreError,
      restricted: allowedEmails(),
    };
  }

  return {
    ready,
    isUnlocked,
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
