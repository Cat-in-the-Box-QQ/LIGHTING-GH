if (!window.supabase) {
  throw new Error('Supabase client library not loaded');
}

window.sb = window.supabase.createClient(
  window.SUPABASE_URL,
  window.SUPABASE_ANON_KEY
);
