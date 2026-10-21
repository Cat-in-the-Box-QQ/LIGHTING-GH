// admin-auth.js - admin session shared across pages
// session เก็บใน localStorage จึงอยู่ได้ทุกหน้าจนกว่าจะ logout
// รองรับ 2 แบบ:
//   1) PIN เดิม 1234
//   2) ถ้ามี window.sb จะลอง signIn ด้วย email + password ผ่าน Supabase

const AdminAuth = (() => {
  const ADMIN_PIN = "1234";
  const STORAGE_KEY = "lighting_db_admin_mode_v2";

  // สำหรับหน้าต่าง ๆ ที่จะ await ก่อน render
  const ready = Promise.resolve(true);

  function isUnlocked() {
    return localStorage.getItem(STORAGE_KEY) === "ok";
  }

  function unlock(pin) {
    if (String(pin) === ADMIN_PIN) {
      localStorage.setItem(STORAGE_KEY, "ok");
      return true;
    }
    return false;
  }

  // ใช้เมื่อหน้า admin เปลี่ยนเป็น email + password (Supabase)
  async function unlockWithEmail(email, password) {
    if (!window.sb) return false;
    try {
      const { error } = await window.sb.auth.signInWithPassword({ email, password });
      if (!error) {
        localStorage.setItem(STORAGE_KEY, "ok");
        return true;
      }
    } catch (e) {
      console.error("Supabase admin login error:", e);
    }
    return false;
  }

  function lock() {
    localStorage.removeItem(STORAGE_KEY);
  }

  return { ready, isUnlocked, unlock, unlockWithEmail, lock };
})();
