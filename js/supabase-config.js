// supabase-config.js - ตั้งค่า Supabase ที่เดียวทั้งเว็บ
// แก้ไฟล์นี้ไฟล์เดียวพอ ทุกหน้า (index / equipment / fixture / accessories /
// inventory / setbuilder / admin) อ่านค่าจากตรงนี้

window.SUPABASE_URL = 'https://bizbhhzmrtntbszqhzyr.supabase.co';
window.SUPABASE_ANON_KEY = 'sb_publishable_wXoQUrRoUgr2zFeXBeP_6w_eaoPG6g2';

// ชื่อตารางใน Supabase (ถ้าเปลี่ยนชื่อตาราง แก้ตรงนี้ที่เดียว)
window.SUPABASE_TABLES = {
  fixtures: 'fixtures',
  accessories: 'accessories',
};

// true = บังคับใช้โหมด local (data/*.json + localStorage) ข้าม Supabase ไปเลย
// ใช้ตอนอยากทดสอบเว็บโดยไม่พึ่งเน็ต หรือตอน Supabase มีปัญหา
window.SUPABASE_DISABLED = false;

// true = ถ้า Supabase เชื่อมต่อไม่ได้ ให้ถอยกลับมาใช้ข้อมูล local อัตโนมัติ
// (แนะนำเปิดไว้ เว็บจะได้ไม่ขาวเปล่า)
window.SUPABASE_ALLOW_LOCAL_FALLBACK = true;

// ระบุ email ที่ยอมให้เข้าโหมด Admin
//   []              = ยอมทุกบัญชีที่ login ผ่าน Supabase ได้
//   ['a@b.com', ..] = ยอมเฉพาะ email ในรายการนี้
window.SUPABASE_ADMIN_EMAILS = [];
