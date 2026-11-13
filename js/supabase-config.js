// supabase-config.js - ตั้งค่า Supabase ที่เดียวทั้งเว็บ
// แก้ไฟล์นี้ไฟล์เดียวพอ ทุกหน้า (index / equipment / fixture / accessories /
// inventory / setbuilder / admin) อ่านค่าจากตรงนี้

window.SUPABASE_URL = 'https://bizbhhzmrtntbszqhzyr.supabase.co';
window.SUPABASE_ANON_KEY = 'sb_publishable_wXoQUrRoUgr2zFeXBeP_6w_eaoPG6g2';

// ชื่อตารางใน Supabase (ถ้าเปลี่ยนชื่อตาราง แก้ตรงนี้ที่เดียว)
window.SUPABASE_TABLES = {
  fixtures: 'fixtures',
  accessories: 'accessories',
  members: 'members',
  bookings: 'bookings',
  bookingItems: 'booking_items',
  // เป็น view ไม่ใช่ตาราง — คำนวณยอด "ติดจอง / เหลือ" จาก bookings + booking_items
  // (ดู supabase/migration-2026-11-13c-bookings.sql)
  itemAvailability: 'v_item_availability',
};

// true = บังคับใช้โหมด local (data/*.json + localStorage) ข้าม Supabase ไปเลย
// ใช้ตอนอยากทดสอบเว็บโดยไม่พึ่งเน็ต หรือตอน Supabase มีปัญหา
window.SUPABASE_DISABLED = false;

// true = ถ้า Supabase เชื่อมต่อไม่ได้ ให้ถอยกลับมาใช้ข้อมูล local อัตโนมัติ
// (แนะนำเปิดไว้ เว็บจะได้ไม่ขาวเปล่า)
window.SUPABASE_ALLOW_LOCAL_FALLBACK = true;

// ทางออกฉุกเฉินช่วงเปลี่ยนผ่าน — ปกติให้เว้นเป็น [] ไว้
//
// สิทธิ์ admin ตัวจริงอยู่ที่คอลัมน์ role ของตาราง public.members ใน Supabase
// (ดู supabase/migration-2026-10-22-members.sql) ไม่ใช่รายการอีเมลตรงนี้
//
// รายการนี้จะมีผลเฉพาะเมื่อ "อ่านตาราง members ไม่ได้เลย" เช่น deploy โค้ดใหม่ไปแล้ว
// แต่ยังไม่ทันได้รัน SQL — ช่วยไม่ให้เจ้าของเว็บเข้าหน้า admin ไม่ได้ในช่วงรอยต่อ
// ถ้าอ่านตาราง members ได้ คำตอบจากตารางเท่านั้นที่เป็นจริง
//
// ⚠️ ของเดิม [] แปลว่า "ยอมทุกบัญชีที่ login ผ่าน" ซึ่งอันตรายมาก
//    เพราะพอสร้างบัญชีให้ทีมงานจองของ ทุกคนจะได้สิทธิ์แก้/ลบอุปกรณ์ทั้งร้าน
//    ตอนนี้ [] แปลว่า "ไม่เปิดทางออกฉุกเฉิน" ซึ่งถูกต้องแล้ว
window.SUPABASE_ADMIN_EMAILS = [];
