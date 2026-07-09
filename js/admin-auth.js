// admin-auth.js - simple PIN lock for static admin mode
// Uses localStorage so admin mode stays active across pages/tabs until logout.

const AdminAuth = (() => {
  const ADMIN_PIN = "1234";
  const STORAGE_KEY = "lighting_db_admin_mode_v2";

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

  function lock() {
    localStorage.removeItem(STORAGE_KEY);
  }

  return { isUnlocked, unlock, lock };
})();
