-- =====================================================================
-- migration-2026-11-13b-no-approval.sql
-- ถอดขั้น "รอยืนยัน/อนุมัติ" ออก — บัญชีใหม่ใช้งานได้ทันที
-- =====================================================================
--
-- รันต่อจาก migration-2026-11-13-member-admin.sql
--
-- เหตุผลที่เปลี่ยน
-- ---------------
-- เดิม trigger สร้างแถว members เป็น role='crew' + active=false แล้วให้ admin
-- มากดอนุมัติทีหลัง ซึ่งจำเป็นเพราะตอนนั้น "ยังเปิดให้ใครก็ได้สมัครเอง"
-- (disable_signup = false) จึงต้องมีคนกรองว่าใครคือทีมงานจริง
--
-- ตอนนี้ตัดสินใจปิด public signup แล้ว บัญชีใหม่จึงเกิดได้จาก admin สร้างใน
-- Supabase Dashboard เท่านั้น -> ขั้นกดอนุมัติกลายเป็นงานซ้ำซ้อนที่ไม่มีประโยชน์
--
-- กำแพงที่แท้จริงย้ายจาก "ขั้นอนุมัติ" ไปอยู่ที่ "ใครสร้างบัญชีได้"
-- ซึ่งแข็งแรงกว่า เพราะเป็นการควบคุมที่ต้นทาง ไม่ใช่ปลายทาง
--
-- ทำ 2 อย่าง:
--   1. trigger สร้างแถวเป็น active = true (ไม่ต้องรออนุมัติ)
--   2. บันทึกการตั้งค่า disable_signup = true ไว้เป็นเอกสาร
--
-- รันซ้ำได้ปลอดภัย (create or replace)
-- =====================================================================


-- =====================================================================
-- ขั้นที่ 1 — trigger สร้างแถว members เป็น active = true
-- =====================================================================
-- เปลี่ยนจากเวอร์ชันเดิมแค่ค่าเดียว: false -> true
-- ส่วนที่เหลือคงเดิมทั้งหมด เพราะแต่ละจุดกันปัญหาจริงไว้:
--   * coalesce ชื่อ  — บัญชีแบบเบอร์โทรจะมี email เป็น null ขณะที่ full_name
--                      เป็น not null ถ้าไม่ coalesce ทั้ง insert จะพัง
--   * begin..exception -> raise warning
--                    — trigger นี้เป็น AFTER INSERT บน auth.users ถ้ามัน raise
--                      exception การสร้างบัญชีจะถูก rollback ทั้งก้อน
--                      = สร้างบัญชีไม่ได้ทั้งระบบ จึงห้ามพังเด็ดขาด
--   * on conflict    — กัน insert ซ้ำถ้ารัน trigger เบิ้ล
--   * return new     — AFTER trigger ต้องคืน new เสมอ
--
-- ยังเป็น role = 'crew' เสมอ -> เข้ามาได้แต่แก้ไขข้อมูลของไม่ได้
-- จนกว่า admin จะเลื่อนสิทธิ์ให้ผ่านหน้าเว็บ (RLS ยังเป็นตัวตัดสินจริง)

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  v_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(btrim(split_part(coalesce(new.email, new.phone, ''), '@', 1)), ''),
    'ยังไม่ระบุชื่อ'
  );

  begin
    insert into public.members (auth_uid, email, full_name, role, active)
    values (new.id, new.email, v_name, 'crew', true)
    on conflict (auth_uid) do nothing;
  exception when others then
    raise warning
      'handle_new_auth_user: สร้างแถว members ไม่สำเร็จ (%) — บัญชีถูกสร้างแล้ว ให้ admin เพิ่มแถวเองผ่าน SQL Editor',
      sqlerrm;
  end;

  return new;
end;
$$;


-- =====================================================================
-- ขั้นที่ 2 — ⚠️ อย่าเปิดแถวที่ถูกปิดใช้งานไว้แบบเหมาทั้งตาราง
-- =====================================================================
-- ระหว่างที่ trigger เวอร์ชันเดิมยัง active=false อยู่ อาจมีบัญชีที่ได้แถวเป็น
-- active=false ค้างไว้ ถ้าอยากเปิดให้คนที่สร้างไว้ในช่วงนั้น ต้องระบุเป็นรายคน
--
-- ห้ามรันแบบนี้เด็ดขาด:
--   update public.members set active = true where active = false;
-- เพราะมันจะ "เปิดคืนให้คนที่ admin จงใจปิดใช้งานไปด้วย" — ปิดใช้งานคือวิธี
-- นำคนออกของระบบนี้ (ไม่มีปุ่มลบ) การเหมาเปิดคืนจึงเท่ากับถอนการนำคนออกเงียบ ๆ
--
-- ถ้าจะเปิดให้เฉพาะคน ให้ระบุรหัสหรืออีเมล:
--   update public.members set active = true where code = 'M001';
--
-- (ตอนนี้ยังไม่มีแถวค้าง โครงการมีสมาชิก 1 แถวคือ admin ที่ active อยู่แล้ว
--  จึงไม่มีอะไรต้องทำในขั้นนี้)


-- =====================================================================
-- ขั้นที่ 3 — การตั้งค่าฝั่ง Authentication (ทำใน SQL ไม่ได้)
-- =====================================================================
-- disable_signup ต้องตั้งผ่าน Dashboard หรือ Management API เท่านั้น
-- เพราะเป็นการตั้งค่าของ GoTrue ไม่ใช่ข้อมูลในตาราง จึงไม่มีคำสั่ง SQL
--
-- ค่าที่ตั้งไว้แล้ว (ตรวจยืนยันผ่าน Management API):
--   disable_signup                    = true   <- ปิดให้คนนอกสมัครเอง
--   mailer_autoconfirm                = false
--   external_email_enabled            = true
--   external_phone_enabled            = false
--   security_captcha_enabled          = false
--   refresh_token_rotation_enabled    = true
--   site_url                          = https://lighting-gh.vercel.app/
--   uri_allow_list                    = https://lighting-gh.vercel.app/**
--
-- ถ้าต้องการตรวจ/ตั้งเอง: Supabase -> Authentication -> Providers -> Email
--   "Allow new users to sign up" = ปิด
--
-- สำคัญ: disable_signup = true "ไม่" ห้าม admin สร้าง user ใน Dashboard
-- และไม่ห้ามการส่ง invite — ปิดเฉพาะ endpoint สมัครสมาชิกสาธารณะ


-- =====================================================================
-- ขั้นที่ 4 — ตรวจผลหลังรัน
-- =====================================================================

-- 4.1 ต้องเห็นค่า true ในบรรทัด values(... 'crew', true)
select pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'handle_new_auth_user';

-- 4.2 trigger ต้องยังติดอยู่และเปิดใช้งาน (tgenabled = 'O')
select tgname, tgrelid::regclass as on_table, tgenabled
from pg_trigger
where tgname in ('on_auth_user_created', 'protect_last_admin', 'members_fill_code')
  and not tgisinternal
order by tgname;

-- 4.3 ความปลอดภัยของฟังก์ชันต้องไม่เปลี่ยน
--     handle_new_auth_user ต้องยังเป็น security definer + ปัก search_path
select p.proname, p.prosecdef as security_definer, p.proconfig as search_path
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('handle_new_auth_user', 'protect_last_admin', 'is_admin', 'members_fill_code')
order by p.proname;

-- 4.4 รายชื่อปัจจุบัน (ต้องไม่มีใครถูกเปลี่ยนสถานะจาก migration นี้)
select m.code, m.full_name, m.email, m.role, m.active
from public.members m
order by m.active desc, m.role, m.code;


-- =====================================================================
-- ย้อนกลับ (กลับไปใช้ขั้นอนุมัติแบบเดิม)
-- =====================================================================
-- ถ้าจะกลับไปใช้ active = false อีก ให้รัน migration-2026-11-13-member-admin.sql
-- เฉพาะขั้นที่ 2 (บล็อก create or replace function handle_new_auth_user)
-- และเปิด signup คืนที่ Authentication -> Providers -> Email
--
-- ระวัง: การรันทั้งไฟล์ migration-2026-11-13-member-admin.sql จะไม่ทำอย่างอื่นพัง
-- เพราะทุกขั้นเป็น idempotent และขั้น backfill ใช้ not exists จึงไม่ทับแถวเดิม
