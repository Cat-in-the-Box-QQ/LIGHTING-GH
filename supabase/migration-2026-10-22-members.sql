-- =====================================================================
-- migration-2026-10-22-members.sql
-- แยกสิทธิ์ Admin ออกจาก "คนที่ login ได้"
-- =====================================================================
--
-- ทำไมต้องมีไฟล์นี้
-- -----------------
-- RLS เดิม (schema.sql) อนุญาตให้ "ทุกคนที่ login ผ่าน Supabase Auth"
-- แก้/ซ่อน/ลบ fixtures และ accessories ได้ทั้งหมด
--
-- วันนี้ยังไม่เป็นไรเพราะมีเจ้าของเว็บ login อยู่คนเดียว
-- แต่พอสร้างบัญชีให้ทีมงานเพื่อใช้ระบบจองของ ทุกคนจะได้สิทธิ์ admin ไปด้วย
-- (ฝั่งเว็บก็ซ้ำรอยเดียวกัน: SUPABASE_ADMIN_EMAILS = [] แปลว่า "ยอมทุกบัญชี")
--
-- ไฟล์นี้จึงสร้างตาราง members เก็บ role แล้วผูกสิทธิ์เขียนไว้ที่ role = 'admin'
-- ทั้งในฐานข้อมูล (RLS — ตัวจริง) และฝั่งเว็บ (js/admin-auth.js — แค่หน้าจอ)
--
-- ⚠️ ลำดับสำคัญมาก: ต้องรันไฟล์นี้ "ก่อน" สร้างบัญชีทีมงาน
--    และต้องแก้ v_admin_email ในขั้นที่ 3 ก่อนรัน ไม่งั้นสคริปต์จะหยุดตัวเอง
--
-- รันซ้ำได้ปลอดภัย (ใช้ if not exists / or replace / drop policy if exists ทั้งหมด)
-- Supabase SQL Editor รันทั้งไฟล์ใน transaction เดียว
--   → ถ้ามี raise exception แม้แต่จุดเดียว ทุกอย่างจะถูก rollback หมด ไม่มีค้างครึ่งทาง
-- =====================================================================


-- =====================================================================
-- ขั้นที่ 1 — ตาราง members + ฟังก์ชันเช็คสิทธิ์
-- =====================================================================

create sequence if not exists public.members_code_seq;

create table if not exists public.members (
  id          uuid primary key default gen_random_uuid(),
  auth_uid    uuid unique references auth.users (id) on delete set null,
  code        text unique not null,
  full_name   text not null,
  phone       text,
  role        text not null default 'crew' check (role in ('admin', 'crew')),
  active      boolean not null default true,
  note        text,
  created_at  timestamptz not null default now()
);

comment on table  public.members            is 'รายชื่อทีมงาน — code คือรหัสประจำตัวที่แสดงบนเว็บ, auth_uid ผูกกับบัญชี Supabase Auth';
comment on column public.members.code       is 'รหัสประจำตัว เช่น TK01 — เป็นแค่ป้ายชื่อสำหรับคนอ่าน ไม่ใช่รหัสผ่าน';
comment on column public.members.role       is 'admin = แก้ไขข้อมูลของได้ / crew = จองของได้อย่างเดียว';
comment on column public.members.auth_uid   is 'null ได้ = ยังไม่ได้ผูกบัญชี (จองไม่ได้จนกว่าจะผูก)';


-- ถ้าไม่ระบุ code ตอนเพิ่มสมาชิก ระบบออกรหัสให้อัตโนมัติ (M001, M002, ...)
create or replace function public.members_fill_code()
returns trigger
language plpgsql
as $$
begin
  if new.code is null or btrim(new.code) = '' then
    new.code := 'M' || lpad(nextval('public.members_code_seq')::text, 3, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists members_fill_code on public.members;
create trigger members_fill_code
  before insert on public.members
  for each row execute function public.members_fill_code();


-- ฟังก์ชันเช็คว่าคนที่เรียกอยู่เป็น admin หรือเปล่า
--
-- ต้องเป็น security definer เพราะ:
--   policy ของตาราง fixtures ต้องอ่านตาราง members เพื่อตัดสินใจ
--   ถ้าอ่านตรง ๆ จะชน RLS ของ members เอง (policy ซ้อน policy) จนได้คำตอบผิด
--   security definer ทำให้ฟังก์ชันรันด้วยสิทธิ์เจ้าของ (postgres) จึงข้าม RLS ของ members ได้
--
-- `set search_path` จำเป็น — กันคนอื่นสร้างฟังก์ชันชื่อซ้ำใน schema อื่นมาแย่งทำงาน
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.members m
    where m.auth_uid = auth.uid()
      and m.role = 'admin'
      and m.active = true
  );
$$;


-- =====================================================================
-- ขั้นที่ 2 — RLS ของตาราง members
-- =====================================================================

alter table public.members enable row level security;

-- อ่านแถวของตัวเองได้ (เว็บต้องอ่านเพื่อรู้ว่าตัวเองเป็น admin หรือ crew)
-- admin อ่านได้ทุกคน (ไว้จัดการรายชื่อทีมงาน)
drop policy if exists "members read own" on public.members;
create policy "members read own"
  on public.members for select
  to authenticated
  using (auth.uid() = auth_uid or public.is_admin());

-- เพิ่ม/แก้/ลบสมาชิกได้เฉพาะ admin
drop policy if exists "admin write members" on public.members;
create policy "admin write members"
  on public.members for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- =====================================================================
-- ขั้นที่ 3 — เพิ่มตัวคุณเองเป็น admin
-- =====================================================================
-- ✏️✏️✏️ แก้บรรทัด v_admin_email ด้านล่างนี้เป็นอีเมลที่คุณใช้ login หน้า Admin ✏️✏️✏️
--
-- ถ้าไม่แก้ สคริปต์จะ raise exception และหยุดทั้งไฟล์ (ไม่มีอะไรพัง)
-- จงใจทำแบบนี้เพราะถ้าเผลอรันโดยยังไม่แก้ จะได้ admin ปลอม
-- แล้วพอขั้นที่ 5 สลับ policy คุณจะเข้าหน้า admin ไม่ได้อีกเลย

do $$
declare
  v_admin_email text := 'PUT_YOUR_EMAIL_HERE';   -- ✏️ แก้ตรงนี้ เช่น 'boss@company.com'
  v_uid         uuid;
  v_name        text;
begin
  if btrim(v_admin_email) = '' or lower(btrim(v_admin_email)) = 'put_your_email_here' then
    raise exception
      'ยังไม่ได้ใส่อีเมล admin — แก้ตัวแปร v_admin_email ในขั้นที่ 3 ของไฟล์นี้ก่อนรัน';
  end if;

  -- ดึงทั้ง uid และชื่อมาเก็บในตัวแปรก่อน
  -- (ห้ามอ้าง alias ของ select นี้ใน insert ข้างล่าง — คนละ statement กัน จะ error)
  select u.id,
         coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                  nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                  split_part(v_admin_email, '@', 1))
    into v_uid, v_name
  from auth.users u
  where lower(u.email) = lower(btrim(v_admin_email));

  if v_uid is null then
    raise exception
      'ไม่พบบัญชี % ใน Supabase Authentication — ไปสร้างที่ Authentication → Users → Add user ก่อน (ติ๊ก Auto Confirm User)',
      v_admin_email;
  end if;

  insert into public.members (auth_uid, code, full_name, role, active)
  values (v_uid, 'ADMIN01', v_name, 'admin', true)
  on conflict (auth_uid) do update
    set role   = 'admin',
        active = true;
end;
$$;


-- =====================================================================
-- ขั้นที่ 4 — ตรวจว่ามี admin จริงก่อนจะไปสลับสิทธิ์
-- =====================================================================
-- ถ้าตาราง members ไม่มี admin เลยสักคน แล้วไปสลับ policy
-- จะไม่มีใครเขียนข้อมูลได้อีก (รวมตัวคุณเอง) จึงหยุดไว้ตรงนี้ก่อน

do $$
begin
  if not exists (select 1 from public.members where role = 'admin' and active = true) then
    raise exception
      'ตาราง members ยังไม่มี admin ที่ active เลย — หยุดก่อนสลับ policy กันเข้าไม่ได้ถาวร';
  end if;
end;
$$;


-- =====================================================================
-- ขั้นที่ 5 — สลับสิทธิ์เขียน fixtures / accessories เป็น "admin เท่านั้น"
-- =====================================================================
-- policy อ่าน (public read) ยังอยู่เหมือนเดิม ทุกคนยังดูเว็บได้ตามปกติ
-- policy หลายตัวที่เป็นคำสั่งชนิดเดียวกันจะถูก OR กัน จึงไม่กระทบการอ่าน

drop policy if exists "auth write fixtures" on public.fixtures;
drop policy if exists "admin write fixtures" on public.fixtures;
create policy "admin write fixtures"
  on public.fixtures for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "auth write accessories" on public.accessories;
drop policy if exists "admin write accessories" on public.accessories;
create policy "admin write accessories"
  on public.accessories for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- =====================================================================
-- ขั้นที่ 6 — ตรวจผลหลังรัน
-- =====================================================================

-- 6.1 รายชื่อ admin (ต้องมีอย่างน้อย 1 แถว ไม่งั้นคุณจะแก้ไขข้อมูลไม่ได้)
select m.code, m.full_name, m.role, m.active, u.email
from public.members m
left join auth.users u on u.id = m.auth_uid
where m.role = 'admin'
order by m.code;

-- 6.2 policy ทั้งหมดของ 3 ตาราง (ควรเห็น "admin write ..." ไม่ใช่ "auth write ...")
select tablename, policyname, cmd, roles::text
from pg_policies
where schemaname = 'public'
  and tablename in ('fixtures', 'accessories', 'members')
order by tablename, policyname;

-- 6.3 สรุปจำนวนสมาชิกแยกตาม role
select role, active, count(*) as total
from public.members
group by role, active
order by role, active;


-- =====================================================================
-- เพิ่มทีมงานคนอื่น (รันทีหลังได้ ทีละคน)
-- =====================================================================
-- สร้างบัญชีใน Supabase → Authentication → Users → Add user ก่อน
-- แล้วรันบล็อกนี้ (แก้บรรทัดที่ทำเครื่องหมาย ✏️ ไว้)
--
-- insert into public.members (auth_uid, code, full_name, phone, role, active)
-- select u.id,
--        'TK01',                          -- ✏️ รหัสประจำตัว (เว้นว่างได้ ระบบจะออกรหัสให้อัตโนมัติ)
--        'ชื่อ นามสกุล',                   -- ✏️ ชื่อที่แสดงบนเว็บ
--        null,                            -- เบอร์โทร (ไม่บังคับ)
--        'crew',                          -- crew = จองได้อย่างเดียว
--        true
-- from auth.users u
-- where lower(u.email) = lower('someone@company.com');   -- ✏️ อีเมลของทีม


-- =====================================================================
-- ย้อนกลับ (ถ้าอยากกลับไปเป็นแบบเดิม — ทุกคนที่ login เขียนได้)
-- =====================================================================
-- drop policy if exists "admin write fixtures"    on public.fixtures;
-- drop policy if exists "admin write accessories" on public.accessories;
-- drop policy if exists "admin write members"     on public.members;
-- drop policy if exists "members read own"        on public.members;
--
-- create policy "auth write fixtures" on public.fixtures for all to authenticated
--   using (true) with check (true);
-- create policy "auth write accessories" on public.accessories for all to authenticated
--   using (true) with check (true);
