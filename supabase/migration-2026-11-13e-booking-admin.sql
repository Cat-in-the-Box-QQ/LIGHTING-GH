-- =============================================================================
-- supabase/migration-2026-11-13e-booking-admin.sql
-- งานฝั่ง admin ของระบบจอง: คิวตรวจของคืน + บันทึกการคืนครบ
-- =============================================================================
-- รัน "หลัง" migration-2026-11-13d-booking-calendar.sql
-- รันทั้งไฟล์ครั้งเดียวใน Supabase SQL Editor ได้ (เป็น transaction เดียว)
--
-- ที่มา: ระบบคืนของเป็นแบบ "พ้นวันจองแล้วของกลับคลังเอง" จึงมีจุดบอดอยู่จุดเดียว
-- คือ **ของไม่กลับมาจริง** ระบบไม่มีทางรู้เองได้ ต้องมีคนดู
-- `v_booking_stale` คือคิวของใบจองที่เลยวันแล้วยังไม่ถูกปักว่าค้างคืน
-- แต่เวอร์ชันเดิมมีช่องโหว่: admin ที่ตรวจแล้วพบว่า "ของกลับมาครบ" จะทำอะไรไม่ได้เลย
-- ใบนั้นจึงค้างอยู่ในคิวตลอดไป จนคิวกลายเป็นของที่ nobody อ่าน
--
-- ไฟล์นี้จึงเพิ่ม
--   1. `settle_booking()`  บันทึกว่าของกลับคลังครบ → ใบนั้นออกจากคิว
--   2. `v_booking_stale` เวอร์ชันใหม่ ที่ซ่อนใบซึ่งคืนครบแล้ว
--      (และเพิ่มคอลัมน์ให้เว็บแสดงได้โดยไม่ต้องยิง query ซ้ำ)
--
-- ไม่มีการแก้/ลบข้อมูลเดิม · ไม่แตะคอลัมน์ stock ของ fixtures/accessories
-- =============================================================================


-- =============================================================================
-- ขั้น 1 — settle_booking(): บันทึกว่าของกลับคลังครบแล้ว
-- =============================================================================
-- ทำ 2 อย่างใน transaction เดียว
--   ก) เติม returned_quantity = quantity ให้ทุกรายการที่ยังคืนไม่ครบ
--   ข) ถ้าใบนั้นถูกปักเป็น overdue ไว้ ให้กลับเป็น checked_out
--
-- ทำไม ข) ถึงทำให้ "พ้นจากการกินสต็อก": booking_check_stock() นับใบจองที่
--   booking_date = วันที่ถาม  OR  status = 'overdue'
-- ใบที่เลยวันมาแล้วและไม่ใช่ overdue จึงไม่ถูกนับต่อ → ของกลับเข้าคลังตามกติกา
-- "คืนอัตโนมัติหลังวันจอง" เดิม ไม่ต้องเพิ่มสถานะใหม่ให้งง
--
-- จงใจเป็น invoker rights (ไม่ใส่ security definer)
--   → RLS ยังบังคับอยู่ (policy update ของ booking_items ให้ admin แก้อะไรก็ได้)
--   → trigger booking_items_guard ยังทำงานครบ รวมถึงกัน returned_quantity > quantity
--   → is_admin() ข้างในเป็น security definer อยู่แล้ว จึงตัดสินสิทธิ์ได้ถูกต้อง

create or replace function public.settle_booking(p_booking_id uuid)
returns integer
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_lines  integer := 0;
begin
  if p_booking_id is null then
    raise exception 'ต้องระบุ id ของใบจอง';
  end if;

  if not public.is_admin() then
    raise exception 'เฉพาะ admin เท่านั้นที่บันทึกการคืนของได้ — crew กดคืนเองจะทำให้สต็อกหลุดโดยไม่มีการตรวจของจริง';
  end if;

  select b.status into v_status
    from public.bookings b
   where b.id = p_booking_id;

  if not found then
    raise exception 'ไม่พบใบจองนี้ (id = %)', p_booking_id;
  end if;

  if v_status = 'cancelled' then
    raise exception 'ใบจองนี้ถูกยกเลิกไปแล้ว — ไม่มีการจ่ายของ จึงไม่ต้องบันทึกการคืน';
  end if;

  update public.booking_items
     set returned_quantity = quantity
   where booking_id = p_booking_id
     and coalesce(returned_quantity, 0) < quantity;

  get diagnostics v_lines = row_count;

  -- ของกลับครบแล้ว = พ้นสถานะค้างคืน (กลับไป checked_out ซึ่งเลยวันจึงไม่กินสต็อกต่อ)
  update public.bookings
     set status = 'checked_out'
   where id = p_booking_id
     and status = 'overdue';

  return v_lines;
end;
$$;

revoke all on function public.settle_booking(uuid) from public;
grant execute on function public.settle_booking(uuid) to authenticated;

comment on function public.settle_booking(uuid) is
  'admin บันทึกว่าของกลับคลังครบ: เติม returned_quantity ทุกรายการ แล้วปลดสถานะ overdue — คืนจำนวนแถวที่แก้';


-- =============================================================================
-- ขั้น 2 — v_booking_stale: คิวที่ admin ต้องดูทุกวัน
-- =============================================================================
-- ของเดิมมีปัญหา 2 อย่าง
--   1) ใบที่ "ของกลับมาครบแล้ว" ยังโผล่ในคิวตลอดไป เพราะไม่มีทางบันทึกว่าตรวจแล้ว
--      → แก้ด้วยการกรอง out ยอดคงค้าง = 0 (settle_booking() ทำให้เป็น 0)
--   2) เว็บต้องยิง query ซ้ำเพื่อดูสถานที่และยอดที่ยังไม่คืน
--      → เพิ่มคอลัมน์ต่อท้าย (create or replace view ห้ามสลับ/ลบคอลัมน์เดิม
--         จึงต้องต่อท้ายเท่านั้น: id, booking_date, days_past, status, job_name,
--         member_code, member_name, item_count ตามเดิม แล้วค่อยเพิ่ม 3 ตัวใหม่)
--
-- ยังล็อกด้วย is_admin() ใน where clause เหมือนเดิม → คืน 0 แถวให้ทุกคนที่ไม่ใช่ admin

create or replace view public.v_booking_stale as
with outstanding as (
  select bi.booking_id,
         count(*)::bigint as item_count,
         coalesce(sum(greatest(bi.quantity - coalesce(bi.returned_quantity, 0), 0)), 0)::integer as qty_outstanding
    from public.booking_items bi
   group by bi.booking_id
)
select b.id,
       b.booking_date,
       (public.biz_today() - b.booking_date) as days_past,
       b.status,
       b.job_name,
       m.code       as member_code,
       m.full_name  as member_name,
       coalesce(o.item_count, 0)     as item_count,
       -- 3 คอลัมน์ใหม่ที่เพิ่มต่อท้าย
       b.job_location,
       m.color_hue  as member_hue,
       coalesce(o.qty_outstanding, 0) as qty_outstanding
  from public.bookings b
  left join public.members m on m.id = b.member_id
  left join outstanding o    on o.booking_id = b.id
 where b.status in ('reserved', 'checked_out')
   and b.booking_date < public.biz_today()
   -- คืนครบแล้ว (ยอดคงค้าง = 0) ถือว่าตรวจเสร็จ ออกจากคิว
   and coalesce(o.qty_outstanding, 0) > 0
   and public.is_admin();

grant select on public.v_booking_stale to authenticated;


-- =============================================================================
-- ขั้น 3 — ตรวจว่ารันผ่านจริง
-- =============================================================================

-- 3.1 ฟังก์ชันและ view ต้องมีอยู่จริง และสิทธิ์ถูกต้อง
-- select p.proname, p.prosecdef as security_definer
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'settle_booking';
-- ความคาดหวัง: security_definer = false (invoker — RLS และ trigger ยังทำงาน)

-- 3.2 คอลัมน์ของ v_booking_stale ต้องเรียงลำดับเดิม 8 ตัวแรก แล้วค่อยเพิ่ม 3 ตัวท้าย
-- select ordinal_position, column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'v_booking_stale'
--  order by ordinal_position;
-- ความคาดหวัง: id, booking_date, days_past, status, job_name, member_code,
--              member_name, item_count, job_location, member_hue, qty_outstanding

-- 3.3 ไม่ใช่ admin ต้องเรียก settle_booking() ไม่ผ่าน
-- select public.settle_booking(gen_random_uuid());
-- ความคาดหวัง (เมื่อรันในฐานะ anon/authenticated ธรรมดา):
--   ERROR "เฉพาะ admin เท่านั้นที่บันทึกการคืนของได้ …"

-- 3.4 ทดสอบพฤติกรรมเต็มรอบ (รันทั้งบล็อกครั้งเดียว — จบแล้ว rollback ทิ้งทั้งหมด
--     เพราะจงใจ raise exception ตอนท้ายเพื่อส่งผลการทดสอบออกมาทางข้อความ error)
-- do $$
-- declare
--   v_admin uuid := '165e05ce-2158-4575-acff-b7e08a85534d';   -- uid ของ ADMIN01
--   v_mid   uuid;
--   v_bid   uuid;
--   v_past  date;
--   v_n     integer;
--   v_ok    text := '';
-- begin
--   select id into v_mid from public.members where code = 'ADMIN01';
--   perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
--   v_past := public.biz_today() - 3;      -- admin บันทึกย้อนหลังได้
--
--   v_bid := public.create_booking('ทดสอบ settle_booking', 'สตูดิโอทดสอบ', v_past, null,
--     jsonb_build_array(jsonb_build_object('item_type','fixture','item_id',1,'quantity',2)));
--
--   -- (ก) ใบที่เลยวันแล้วต้องโผล่ในคิว
--   perform 1 from public.v_booking_stale where id = v_bid;
--   v_ok := v_ok || case when found then 'ก.โผล่ในคิว ' else 'ก.!! ไม่โผล่ในคิว ' end;
--
--   -- (ข) คิวต้องบอกยอดที่ยังไม่คืน
--   perform 1 from public.v_booking_stale where id = v_bid and qty_outstanding = 2 and days_past = 3;
--   v_ok := v_ok || case when found then 'ข.qty_outstanding/days_past ถูก ' else 'ข.!! คอลัมน์ใหม่ผิด ' end;
--
--   -- (ค) ปักเป็นค้างคืน -> ต้องออกจากคิว (เพราะคิวเก็บเฉพาะ reserved/checked_out)
--   update public.bookings set status = 'overdue' where id = v_bid;
--   perform 1 from public.v_booking_stale where id = v_bid;
--   v_ok := v_ok || case when found then 'ค.!! overdue ยังอยู่ในคิว ' else 'ค.overdue ออกจากคิว ' end;
--
--   -- (ง) ของยังไม่กลับ -> นับสต็อกต่อทุกวัน
--   perform 1 from public.item_availability_between(public.biz_today(), public.biz_today())
--    where item_type = 'fixture' and item_id = 1 and booked = 2;
--   v_ok := v_ok || case when found then 'ง.overdue กินสต็อกวันนี้ ' else 'ง.!! ไม่กินสต็อก ' end;
--
--   -- (จ) บันทึกว่าคืนครบ
--   v_n := public.settle_booking(v_bid);
--   v_ok := v_ok || 'จ.settle แก้ ' || v_n || ' แถว ';
--
--   -- (ฉ) หลังคืนครบ สถานะต้องกลับเป็น checked_out และยอดคงค้างเป็น 0
--   perform 1 from public.bookings b
--    where b.id = v_bid and b.status = 'checked_out'
--      and not exists (select 1 from public.booking_items bi
--                       where bi.booking_id = b.id and bi.returned_quantity < bi.quantity);
--   v_ok := v_ok || case when found then 'ฉ.คืนครบ+พ้น overdue ' else 'ฉ.!! ยังไม่ครบ ' end;
--
--   -- (ช) ต้องไม่กินสต็อกวันนี้แล้ว (ของกลับคลังจริง)
--   perform 1 from public.item_availability_between(public.biz_today(), public.biz_today())
--    where item_type = 'fixture' and item_id = 1 and booked = 0;
--   v_ok := v_ok || case when found then 'ช.สต็อกกลับมาว่าง ' else 'ช.!! ยังค้างอยู่ ' end;
--
--   -- (ซ) settle ซ้ำต้องไม่พัง (แก้ 0 แถว)
--   v_n := public.settle_booking(v_bid);
--   v_ok := v_ok || 'ซ.settle ซ้ำแก้ ' || v_n || ' แถว ';
--
--   -- (ฌ) ยกเลิกแล้ว settle ไม่ได้
--   update public.bookings set status = 'cancelled' where id = v_bid;
--   begin
--     perform public.settle_booking(v_bid);
--     v_ok := v_ok || 'ฌ.!! ยกเลิกแล้วยัง settle ได้ ';
--   exception when others then
--     v_ok := v_ok || 'ฌ.ยกเลิกแล้วถูกปฏิเสธ ';
--   end;
--
--   delete from public.booking_items where booking_id = v_bid;
--   delete from public.bookings where id = v_bid;
--   perform set_config('request.jwt.claims', '{}', true);
--
--   raise exception 'TEST RESULT: %', v_ok;   -- rollback ทั้งก้อน + ส่งผลออกมาทาง error
-- end $$;


-- =============================================================================
-- ขั้น 4 — ถอยกลับ
-- =============================================================================
-- drop function if exists public.settle_booking(uuid);
-- (v_booking_stale ถอยไม่ได้ด้วยการ drop — view เดิมถูก replace ทับไปแล้ว
--  ถ้าต้องถอยจริงให้ copy บล็อก create or replace view public.v_booking_stale
--  จาก migration-2026-11-13d-booking-calendar.sql มารันทับ
--  ⚠️ แต่เวอร์ชันนั้นมีคอลัมน์น้อยกว่า — โค้ดเว็บที่อ้าง job_location / member_hue /
--     qty_outstanding จะพัง ต้องถอยโค้ดเว็บไปด้วยกัน)
