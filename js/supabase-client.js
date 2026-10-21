// supabase-client.js - สร้าง Supabase client ครั้งเดียว ใช้ร่วมกันทุกหน้า
// ไฟล์นี้ "ห้าม throw" เด็ดขาด เพราะถ้า throw จะทำให้ <script> ตัวถัดไป
// (database.js / admin.js) ไม่ทำงานเลยทั้งหน้า -> นั่นคืออาการ "admin ไม่ทำงาน"
//
// ผลลัพธ์การเชื่อมต่อถูกเก็บใน window.SB_DIAG เพื่อให้หน้า admin โชว์ได้ว่า
// ตอนนี้เว็บรันจาก Supabase หรือถอยกลับมาใช้ local

(function () {
  const diag = {
    libLoaded: false,   // โหลด supabase-js จาก CDN ได้ไหม
    clientReady: false, // createClient สำเร็จไหม
    disabled: false,    // ผู้ใช้สั่งปิดผ่าน SUPABASE_DISABLED
    url: window.SUPABASE_URL || '',
    hasKey: !!window.SUPABASE_ANON_KEY,
    error: null,        // เหตุผลที่ใช้ Supabase ไม่ได้ (ข้อความอ่านเข้าใจง่าย)
  };

  window.SB_DIAG = diag;
  window.sb = null;

  if (window.SUPABASE_DISABLED === true) {
    diag.disabled = true;
    diag.error = 'ปิด Supabase ไว้ (SUPABASE_DISABLED = true ใน js/supabase-config.js) — กำลังใช้ข้อมูล local';
    return;
  }

  if (!diag.url || !diag.hasKey) {
    diag.error = 'ยังไม่ได้ตั้ง SUPABASE_URL / SUPABASE_ANON_KEY ใน js/supabase-config.js';
    return;
  }

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    diag.libLoaded = false;
    diag.error = 'โหลด supabase-js จาก CDN ไม่สำเร็จ (เน็ตหลุด หรือ CDN ถูกบล็อก) — กำลังใช้ข้อมูล local';
    return;
  }

  diag.libLoaded = true;

  try {
    window.sb = window.supabase.createClient(diag.url, window.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    diag.clientReady = !!window.sb;
  } catch (err) {
    window.sb = null;
    diag.error = 'createClient ล้มเหลว: ' + (err && err.message ? err.message : String(err));
  }
})();
