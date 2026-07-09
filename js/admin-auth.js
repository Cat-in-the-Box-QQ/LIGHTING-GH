const AdminAuth = (() => {
  let unlocked = false;
  let currentUser = null;

  async function refresh() {
    try {
      const { data: userData, error: userError } = await window.sb.auth.getUser();
      if (userError || !userData?.user) {
        unlocked = false;
        currentUser = null;
        return false;
      }

      currentUser = userData.user;

      const { data, error } = await window.sb
        .from('admin_users')
        .select('user_id')
        .eq('user_id', currentUser.id)
        .maybeSingle();

      if (error || !data) {
        unlocked = false;
        return false;
      }

      unlocked = true;
      return true;
    } catch (err) {
      console.error('AdminAuth.refresh error:', err);
      unlocked = false;
      currentUser = null;
      return false;
    }
  }

  const ready = refresh();

  async function unlock(email, password) {
    const { error } = await window.sb.auth.signInWithPassword({
      email,
      password,
    });

    if (error) return false;
    return refresh();
  }

  async function lock() {
    await window.sb.auth.signOut();
    unlocked = false;
    currentUser = null;
  }

  function isUnlocked() {
    return unlocked;
  }

  function getUser() {
    return currentUser;
  }

  return {
    ready,
    refresh,
    unlock,
    lock,
    isUnlocked,
    getUser,
  };
})();
