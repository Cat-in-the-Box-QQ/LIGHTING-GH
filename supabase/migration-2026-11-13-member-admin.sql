-- =====================================================================
-- migration-2026-11-13-member-admin.sql
-- ทำให้จัดการทีมงานได้จากหน้า admin (แทนการรัน SQL ทีละคน)
-- =====================================================================
--
-- รันต่อจาก migration-2026-10-22-members.sql
--
-- ข้อจำกัดที่ทำให้ต้องมีไฟล์นี้:
--   เว็บถือแค่ publishable key จึง "สร้างบัญชี login" และ "อ่าน auth.users" ไม่ได้
--   (ทั้งคู่ต้องใช้ service_role ซึ่งห้ามอยู่ในโค้ดฝั่งเบราว์เซอร์เด็ดขาด)
--   หน้าเว็บจึงจัดการได้แค่แถวในตาราง members
--
--   ไฟล์นี้เชื่อมช่องว่างนั้นด้วย trigger:
--     สร้างบัญชีใน Dashboard  ->  แถว members โผล่เองอัตโนมัติ (crew, รออนุมัติ)
--     ->  admin เปิดหน้าเว็บมาตั้งรหัส/สิทธิ์/กดอนุมัติ  (ไม่ต้องแตะ SQL อีก)
--
-- ทำ 4 อย่าง:
--   1. เพิ่มคอลัมน์ email (สำเนาจาก auth.users ไว้โชว์ในรายการทีมงาน)
--   2. trigger สร้างแถว members ให้อัตโนมัติเมื่อมีบัญชีใหม่
--   3. backfill บัญชีที่มีอยู่ก่อนแล้ว (trigger ยิงเฉพาะ insert ใหม่)
--   4. trigger กันไม่ให้ลดสิทธิ์/ปิดใช้งาน admin คนสุดท้าย
--
-- รันซ้ำได้ปลอดภัยทั้งหมด (if not exists / or replace / drop trigger if exists)
-- Supabase SQL Editor รันทั้งไฟล์ใน transaction เดียว
--   -> ถ้ามี raise exception แม้แต่จุดเดียว ทุกอย่างจะถูก rollback ไม่มีค้างครึ่งทาง
-- =====================================================================


-- =====================================================================
-- ขั้นที่ 1 — เพิ่มคอลัมน์ email
-- =====================================================================
-- ตาราง members เดิมมีแต่ auth_uid ซึ่งฝั่งเว็บแปลกลับเป็นอีเมลไม่ได้
-- (อ่าน auth.users ไม่ได้) ถ้าไม่เพิ่มคอลัมน์นี้ รายการทีมงานจะโชว์ได้แค่
-- รหัสกับชื่อ ไม่รู้ว่าผูกกับบัญชีไหน
--
-- แลกกับการเป็นสำเนาที่อาจค้าง ถ้าไปแก้ email ใน Authentication
-- (เกิดยาก และแก้ได้โดยรันขั้นที่ 3 ซ้ำ) — แลกกับความเรียบง่ายที่ปลอดภัยกว่า
-- การทำฟังก์ชัน security definer อ่าน auth.users ให้

alter table public.members add column if not exists email text;

comment on column public.members.email is
  'สำเนาอีเมลจาก auth.users — trigger handle_new_auth_user เติมให้อัตโนมัติ แก้ของจริงที่ Supabase → Authentication';


-- =====================================================================
-- ขั้นที่ 2 — trigger สร้างแถว members ให้อัตโนมัติเมื่อมีบัญชีใหม่
-- =====================================================================
-- role = 'crew' และ active = false ไว้ก่อนเสมอ
--   -> ต่อให้เปิดให้ใครสมัครเองได้ ก็จะทำอะไรไม่ได้จนกว่า admin จะอนุมัติ
--   -> admin เห็นรายการ "รอยืนยัน" ในหน้าเว็บ แล้วค่อยตั้งรหัส/สิทธิ์
--
-- ไม่ต้องส่ง code ไป เพราะ trigger members_fill_code (before insert on members)
-- ที่สร้างไว้รอบก่อนจะออกรหัส M001, M002, ... ให้อัตโนมัติ สอง trigger ต่อกันพอดี

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  -- บัญชีแบบสมัครด้วยเบอร์โทรจะมี email เป็น null จึงห้ามพึ่ง email ตรง ๆ
  -- (full_name เป็น not null ถ้าได้ null มาทั้ง insert จะพัง)
  v_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(btrim(split_part(coalesce(new.email, new.phone, ''), '@', 1)), ''),
    'ยังไม่ระบุชื่อ'
  );

  -- สำคัญมาก: trigger นี้เป็น AFTER INSERT บน auth.users
  -- ถ้ามัน raise exception การสร้างบัญชีจะถูก rollback ทั้งก้อน
  -- = สมัครไม่ได้ทั้งระบบ จึงต้องเก็บ error ไว้แล้วปล่อยผ่านเสมอ
  begin
    insert into public.members (auth_uid, email, full_name, role, active)
    values (new.id, new.email, v_name, 'crew', false)
    on conflict (auth_uid) do nothing;
  exception when others then
    raise warning
      'handle_new_auth_user: สร้างแถว members ไม่สำเร็จ (%) — บัญชีถูกสร้างแล้ว ให้ admin เพิ่มแถวเองผ่าน SQL Editor',
      sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();


-- =====================================================================
-- ขั้นที่ 3 — backfill บัญชีที่มีอยู่ก่อนแล้ว
-- =====================================================================
-- trigger ข้างบนยิงเฉพาะ insert ใหม่ บัญชีที่สร้างไว้ก่อนหน้านั้นจึงยังไม่มีแถว
-- (รวมถึงตัวคุณเอง — แต่ขั้นที่ 3 ของ migration-2026-10-22-members.sql
--  สร้างแถว admin ไว้ให้แล้ว not exists จึงข้ามให้เองอัตโนมัติ)
--
-- รันซ้ำได้: แถวที่มีอยู่แล้วจะไม่ถูกแตะ ต้องไม่ไปทับสิทธิ์ที่ตั้งไว้แล้ว

insert into public.members (auth_uid, email, full_name, role, active)
select u.id,
       u.email,
       coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                nullif(btrim(split_part(coalesce(u.email, u.phone, ''), '@', 1)), ''),
                'ยังไม่ระบุชื่อ'),
       'crew',
       false
from auth.users u
where not exists (
  select 1 from public.members m where m.auth_uid = u.id
);

-- เติมอีเมลให้แถวที่ถูกสร้างไว้ก่อนหน้าจะมีคอลัมน์ email (เช่นแถว admin ของคุณ)
update public.members m
set email = u.email
from auth.users u
where m.auth_uid = u.id
  and (m.email is null or m.email = '')
  and u.email is not null;


-- =====================================================================
-- ขั้นที่ 4 — 🛡️ กันล็อกตัวเองออกถาวร
-- =====================================================================
-- ถ้า admin กดปิดใช้งานตัวเอง หรือลดสิทธิ์ admin คนสุดท้าย จะไม่มีใครเขียน
-- ข้อมูลได้อีก และเข้าหน้า admin ไม่ได้ด้วย — แก้ได้ทาง SQL Editor เท่านั้น
--
-- ต้องกันที่ฐานข้อมูล ไม่ใช่แค่เช็คฝั่งเว็บ เพราะโค้ดฝั่งเว็บข้ามได้ด้วย DevTools
--
-- หมายเหตุ: BEFORE DELETE trigger ที่คืนค่า null จะ "ยกเลิก" การลบ
--           จึงต้องคืน old เสมอ (ใช้ coalesce(new, old))

create or replace function public.protect_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_remaining int;
begin
  -- แถวที่ไม่ใช่ admin ที่ใช้งานอยู่ -> ไม่กระทบจำนวน admin ข้ามได้เลย
  if old.role is distinct from 'admin' or old.active is distinct from true then
    return coalesce(new, old);
  end if;

  -- UPDATE ที่ผลลัพธ์ยังเป็น admin ที่ active อยู่ -> จำนวนไม่เปลี่ยน
  if tg_op = 'UPDATE' and new.role = 'admin' and new.active = true then
    return new;
  end if;

  -- นับ admin ที่ active โดย "ไม่นับแถวนี้" เพราะแถวนี้กำลังจะพ้นสถานะ admin
  select count(*) into v_remaining
  from public.members m
  where m.role = 'admin'
    and m.active = true
    and m.id <> old.id;

  if v_remaining = 0 then
    -- เขียนเป็นสตริงบรรทัดเดียว deliberately: PL/pgSQL ต่อสตริงหลายบรรทัดให้ได้
    -- แต่พึ่งพาพฤติกรรมนั้นในจุดที่พลาดแล้วล็อกตัวเองออกถาวรไม่คุ้ม
    raise exception 'หยุด — ทำแบบนี้จะไม่มี admin ที่ใช้งานเหลือเลย จะเข้าหน้า admin และแก้ไขข้อมูลไม่ได้อีก / ตั้ง admin คนอื่นก่อน แล้วค่อยลดสิทธิ์หรือปิดใช้งาน % (%) / ถ้าจำเป็นต้องทำจริงให้แก้ผ่าน Supabase SQL Editor',
      coalesce(old.code, '(ไม่มีรหัส)'), coalesce(old.email, '(ไม่มีอีเมล)');
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists protect_last_admin on public.members;
create trigger protect_last_admin
  before update or delete on public.members
  for each row execute function public.protect_last_admin();


-- =====================================================================
-- ขั้นที่ 5 — ตรวจผลหลังรัน
-- =====================================================================

-- 5.1 ทีมงานทั้งหมด (ควรมีอีเมลครบทุกแถวแล้ว)
select m.code, m.full_name, m.email, m.role, m.active,
       case when m.auth_uid is null then 'ยังไม่ได้ผูกบัญชี' else 'ผูกแล้ว' end as auth_link
from public.members m
order by m.active desc, m.role, m.code;

-- 5.2 สรุปจำนวน
select
  count(*) filter (where role = 'admin' and active)  as admin_active,
  count(*) filter (where role = 'crew'  and active)  as crew_active,
  count(*) filter (where not active)                 as pending_approval,
  count(*)                                           as total
from public.members;

-- 5.3 ต้องได้ 3 แถว ถ้าขาดแถวไหนแปลว่า trigger ตัวนั้นติดไม่ครบ
--   members_fill_code      -> ออกรหัสประจำตัว M001, M002, ...  (มาจากไฟล์ 2026-10-22)
--   on_auth_user_created   -> สร้างแถว members ให้เองเมื่อมีบัญชีใหม่  (ขั้นที่ 2)
--   protect_last_admin     -> กันลดสิทธิ์/ปิดใช้งาน admin คนสุดท้าย  (ขั้นที่ 4)
select tgname, tgrelid::regclass as on_table,
       -- ประกอบชื่อจังหวะจาก pg_trigger ตรง ๆ แทนการเดา
       -- (members_fill_code เป็น BEFORE INSERT ไม่ใช่ AFTER — ดูแค่ tgisinsert ไม่พอ)
       (case when tgisbefore then 'before ' when tgisafter then 'after ' else 'instead of ' end)
       || trim(
            (case when tgisinsert then 'insert ' else '' end)
         || (case when tgisupdate then 'update ' else '' end)
         || (case when tgisdelete then 'delete ' else '' end)
          ) as fires_on
from pg_trigger
where tgname in ('on_auth_user_created', 'protect_last_admin', 'members_fill_code')
  and not tgisinternal
order by tgname;

-- 5.4 ต้องได้อย่างน้อย 1 แถว (admin ที่ใช้งานได้) — ถ้าว่างแปลว่ามีปัญหา
select m.code, m.full_name, m.email
from public.members m
where m.role = 'admin' and m.active = true;


-- =====================================================================
-- ทดสอบว่า trigger กันล็อกทำงานจริง (เลือกรันทีละบรรทัด ดูผลแล้วค่อย COMMIT)
-- =====================================================================
-- สมมติคุณเป็น admin คนเดียว บรรทัดนี้ต้อง "ขึ้น error"
-- ถ้ามันสำเร็จแปลว่า trigger ไม่ทำงาน
--
-- update public.members set active = false
-- where email = 'zombe.jpm@gmail.com' and role = 'admin';
--
-- ถ้าขึ้น error แปลว่าถูกต้องแล้ว ให้รัน ROLLBACK; เพื่อยกเลิก
-- (อย่ากด COMMIT เพราะจะไม่มีทางเข้าหน้า admin อีกนอกจากแก้ผ่าน SQL Editor)


-- =====================================================================
-- ย้อนกลับ
-- =====================================================================
-- drop trigger if exists protect_last_admin on public.members;
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop function if exists public.protect_last_admin();
-- drop function if exists public.handle_new_auth_user();
-- alter table public.members drop column if exists email;
