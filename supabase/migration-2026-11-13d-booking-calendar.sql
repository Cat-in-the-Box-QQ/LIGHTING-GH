-- =============================================================================
-- supabase/migration-2026-11-13d-booking-calendar.sql
-- ปฏิทินจอง + แก้ 2 บั๊กของระบบจองรอบก่อน
-- =============================================================================
-- รัน "หลัง" migration-2026-11-13c-bookings.sql (ต้องใช้ตาราง/ฟังก์ชันจากรอบก่อน)
-- รันทั้งไฟล์ครั้งเดียวใน Supabase SQL Editor ได้ (เป็น transaction เดียว)
--
-- สิ่งที่ได้จากไฟล์นี้
--   1. biz_today()            "วันนี้" ตามเวลาไทย — แก้ current_date ที่เป็น UTC
--   2. ⚠️ แก้บั๊กร้ายแรง       booking_check_stock นับยอด "ขาด" เมื่อ crew จอง
--                              (เพราะเป็น invoker rights จึงโดน RLS กรองตามผู้เรียก)
--   3. v_item_stock           แหล่งชื่อ+สต็อกก้อนเดียว ใช้ร่วมกันทุกที่
--   4. members.color_hue      สีประจำตัวคนจอง (ถาวร ไม่สลับตามเซสชัน)
--   5. item_availability_between(from,to)      ยอดคงเหลือรายชิ้นรายวัน (<= 92 วัน)
--   6. booking_day_flags_between(from,to)      ธงเตือนรายวัน (ของหมด / ค้างคืน)
--   7. v_booking_day_summary / v_booking_day_detail   ข้อมูลสำหรับปฏิทิน
--   8. create_booking(...)    สร้างใบจอง+รายการใน transaction เดียว (invoker rights)
--
-- ไม่มีการแก้/ลบข้อมูลเดิม ไม่มีการแตะคอลัมน์ stock ของ fixtures/accessories
-- =============================================================================

-- =============================================================================
-- ขั้น 1 — "วันนี้" ต้องเป็นเวลาไทย ไม่ใช่ UTC
-- =============================================================================
-- ฐานข้อมูลตั้ง timezone = UTC ดังนั้นช่วง 00:00-06:59 น. เวลาไทย
-- current_date ของฐานข้อมูลยังจะเป็น "เมื่อวาน" ส่งผล 3 อย่าง:
--   1) bookings.booking_date default current_date -> บันทึกวันผิด
--   2) bookings_guard ห้าม crew จองย้อนหลัง -> กดจองช่วงนั้น "ไม่ผ่าน" ทั้งที่ไม่ได้ทำอะไรผิด
--   3) ปฏิทินและหน้า Inventory ไฮไลต์/นับ "วันนี้" ผิดวัน ปีละ 365 คืน
-- แก้ด้วยฟังก์ชันเดียวที่ทุกจุดต้องใช้แทน current_date
-- (ไม่พึ่ง timezone ของเซสชัน จึงถูกต้องไม่ว่า client จะตั้งค่าอะไรไว้)

create or replace function public.biz_today()
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (now() at time zone 'Asia/Bangkok')::date;
$$;

comment on function public.biz_today() is
  'วันนี้ตามเวลาไทย (Asia/Bangkok) — ใช้แทน current_date ทุกจุดในระบบจอง';

-- ตั้ง timezone ระดับ role ไว้ด้วยเพื่อให้ SELECT now() ใน SQL Editor/client
-- แสดงเป็นเวลาไทย (ไม่จำเป็นต่อความถูกต้อง เพราะ biz_today() ผูกเขตเวลาเองแล้ว)
-- ถ้าไม่มีสิทธิ์เปลี่ยนจะข้ามไป ไม่ทำให้ migration ล้มทั้งก้อน
do $do$
begin
  begin
    execute format('alter role %I set timezone = %L', 'authenticated', 'Asia/Bangkok');
    execute format('alter role %I set timezone = %L', 'anon', 'Asia/Bangkok');
  exception when others then
    raise warning 'ตั้ง timezone ระดับ role ไม่สำเร็จ (%) — ไม่มีผลต่อความถูกต้อง เพราะ biz_today() ผูกเขตเวลาไว้เอง', sqlerrm;
  end;
end
$do$;


-- =============================================================================
-- ขั้น 2 — แก้บั๊กร้ายแรง: trigger นับยอดจอง "ขาด" เมื่อ crew เป็นคนจอง
-- =============================================================================
-- booking_check_stock() ถูกสร้างไว้แบบ invoker rights (security_definer = false)
-- แปลว่า SELECT ข้างในมันโดน RLS กรองตามสิทธิ์ "ผู้เรียก" ด้วย
-- แต่ policy ของ bookings จำกัดให้ crew เห็นเฉพาะใบจองของตัวเอง
--   -> ตอน crew จอง ระบบนับยอดติดจองจาก "ใบจองของเขาเอง" เท่านั้น
--   -> นับขาดของคนอื่นทั้งหมด -> จองเกินจำนวนที่มีได้จริง (ทั้งที่ trigger ทำงาน)
--
-- พิสูจน์บนโปรเจกต์จริงแล้ว (สร้างใบจองทดสอบ 1 ใบ แล้วนับด้วย 2 สิทธิ์):
--   owner_sees = 1   |   authenticated (ไม่ใช่เจ้าของใบจอง) sees = 0
--
-- ที่การทดสอบใน migration เดิม (ขั้น 7.7) ผ่าน เพราะรันด้วย JWT ของ admin
-- ซึ่ง is_admin() = true จึงมองเห็นทุกแถว — บั๊กนี้โผล่เฉพาะกับ crew เท่านั้น
--
-- แก้: ทำให้เป็น security definer (รันด้วยสิทธิ์เจ้าของ = postgres จึงข้าม RLS)
-- ปลอดภัยเพราะฟังก์ชันนี้ "อ่านอย่างเดียว" (SELECT + pg_advisory_xact_lock)
-- ไม่เขียนข้อมูล ไม่มีการ์ SQL แบบ dynamic และสิ่งที่หลุดออกมามีแค่
-- "ยอดรวมต่อชิ้น" ซึ่ง v_item_availability เปิดให้ anon เห็นอยู่แล้ว
-- และยังคงปัก search_path ไว้กันการยึดชื่อตาราง (search_path hijack)

create or replace function public.booking_check_stock(
  p_item_type          text,
  p_item_id            bigint,
  p_quantity           numeric,
  p_date               date,
  p_status             text,
  p_exclude_item_id    uuid default null,
  p_exclude_booking_id uuid default null
)
returns void
language plpgsql
-- ต้องเป็น volatile ไม่ใช่ stable — ฟังก์ชันนี้ "ล็อก" (มีผลข้างเคียง)
-- ถ้าประกาศเป็น stable ตัววางแผนอาจยุบการเรียกซ้ำหรือจำผลลัพธ์ไว้ แล้วล็อกจะไม่ทำงาน
volatile
-- ⚠️ ต้องเป็น security definer — ดูคำอธิบายขั้น 2 ด้านบน
-- ถ้าไม่ใส่ ฟังก์ชันนี้จะนับได้แค่ใบจองที่ "ผู้เรียกมองเห็น" ซึ่ง RLS จำกัดไว้
-- ให้ crew เห็นแค่ของตัวเอง -> นับขาด -> จองเกินสต็อกได้จริง
security definer
set search_path = public, pg_temp
as $$
declare
  v_stock   numeric;
  v_booked  numeric;
  v_qty     numeric;
  v_left    numeric;
  v_label   text;
begin
  -- ยกเลิกแล้วไม่นับสต็อก ไม่ต้องตรวจ
  if coalesce(p_status, '') = 'cancelled' then
    return;
  end if;

  v_qty := greatest(coalesce(p_quantity, 0), 0);
  if v_qty = 0 then
    return;
  end if;

  -- ล็อกรายชิ้นก่อน "อ่าน" จำนวนที่ถูกจองไว้เสมอ — สลับลำดับจะได้ผลผิด
  -- ล็อกชนิด transaction-level จะคลายเองตอน commit/rollback
  perform pg_advisory_xact_lock(hashtext(p_item_type || ':' || p_item_id));

  v_stock := public.item_stock(p_item_type, p_item_id);
  v_label := public.item_label(p_item_type, p_item_id);

  -- ยังไม่ระบุจำนวน = จองไม่ได้ (ไม่ใช่ "มี 0 ชิ้น" และไม่ใช่ "จองได้ไม่จำกัด")
  if v_stock is null then
    raise exception '% ยังไม่ระบุจำนวนในสต็อก จึงจองไม่ได้ — ให้ admin เติมจำนวนก่อน', v_label;
  end if;

  select coalesce(sum(greatest(bi.quantity - coalesce(bi.returned_quantity, 0), 0)), 0)
    into v_booked
    from public.booking_items bi
    join public.bookings b on b.id = bi.booking_id
   where b.status <> 'cancelled'
     and (b.booking_date = p_date or b.status = 'overdue')
     and bi.item_type = p_item_type
     and bi.item_id   = p_item_id
     and bi.id is distinct from p_exclude_item_id
     and b.id  is distinct from p_exclude_booking_id;

  v_left := greatest(v_stock - v_booked, 0);

  if v_booked + v_qty > v_stock then
    raise exception
      'จองเกินจำนวนที่มี — % มี % ชิ้น ถูกจองวันที่ % ไปแล้ว % ชิ้น จึงจองเพิ่มได้อีกแค่ % ชิ้น (ขอมา % ชิ้น)',
      v_label, v_stock, p_date, v_booked, v_left, v_qty;
  end if;
end;
$$;


-- =============================================================================
-- ขั้น 3 — v_item_stock: แหล่ง "ชื่อ + จำนวนสต็อก" ก้อนเดียวของทั้งระบบ
-- =============================================================================
-- เดิมตรรกะนี้ถูกคัดลอกไว้ใน v_item_availability ที่เดียว ตอนนี้ปฏิทินต้องถาม
-- ยอดรายวันด้วย จึงแยกออกมาเป็น view ของตัวเอง แล้วให้ทั้งสองที่อ่านจากมัน
-- ไม่งั้นวันหนึ่งแก้ชื่อ/สต็อกที่หนึ่งแต่ลืมอีกที่ ยอดจะเหลื่อมกันแบบตามแก้ไม่เจอ

create or replace view public.v_item_stock as
select 'fixture'::text              as item_type,
       f.id                         as item_id,
       concat_ws(' ', nullif(btrim(f.brand), ''), nullif(btrim(f.model), '')) as item_name,
       f.stock_count::numeric       as stock,
       f.hidden                     as hidden
  from public.fixtures f
union all
select 'accessory'::text,
       a.id,
       nullif(btrim(a.name), ''),
       public.parse_stock_text(a.stock),
       a.hidden
  from public.accessories a;

grant select on public.v_item_stock to anon, authenticated;


-- v_item_availability: เปลี่ยน 2 อย่าง (คอลัมน์เดิมครบและเรียงลำดับเดิมทุกอย่าง
-- เพราะ create or replace view ห้ามสลับ/เพิ่ม/ลบคอลัมน์กลางทาง)
--   1) อ่านรายการจาก v_item_stock
--   2) นับ "วันนี้" ด้วย biz_today() แทน current_date
create or replace view public.v_item_availability as
with items as (
  -- อ่านจาก v_item_stock ซึ่งเป็นแหล่งชื่อ/จำนวนสต็อกก้อนเดียวกับที่
  -- item_availability_between() ใช้ จึงไม่มีทางที่ปฏิทินกับการ์ดจะเหลื่อมกัน
  select item_type, item_id, item_name, stock, hidden from public.v_item_stock
),
booked as (
  select bi.item_type,
         bi.item_id,
         sum(greatest(bi.quantity - coalesce(bi.returned_quantity, 0), 0)) as qty,
         -- แยกส่วนที่ "ของออกจากคลังไปแล้ว" (checked_out / overdue) ออกจากที่จองไว้เฉย ๆ
         -- หน้า Inventory ใช้โชว์คอลัมน์ In Use ให้เป็นเลขจริงแทน 0 ที่กรอกมือไว้เดิม
         sum(greatest(bi.quantity - coalesce(bi.returned_quantity, 0), 0))
           filter (where b.status in ('checked_out', 'overdue')) as out_qty
    from public.booking_items bi
    join public.bookings b on b.id = bi.booking_id
   where b.status <> 'cancelled'
     and (b.booking_date = public.biz_today() or b.status = 'overdue')
   group by bi.item_type, bi.item_id
)
select i.item_type,
       i.item_id,
       coalesce(nullif(btrim(i.item_name), ''), i.item_type || ' id ' || i.item_id) as item_name,
       i.stock,
       coalesce(b.qty, 0)::integer as booked,
       -- stock เป็น null = ยังไม่ระบุจำนวน -> available ต้องเป็น null ด้วย
       -- (ห้ามโชว์ 0 เพราะจะแปลว่า "ของหมด" ซึ่งไม่จริง)
       case when i.stock is null then null
            else greatest(i.stock - coalesce(b.qty, 0), 0)::integer
       end                          as available,
       (i.stock is null)            as stock_unknown,
       i.hidden,
       -- เพิ่มท้ายสุดเสมอ — create or replace view ห้ามสลับ/ลบคอลัมน์เดิม
       coalesce(b.out_qty, 0)::integer as out_count
  from items i
  left join booked b
    on b.item_type = i.item_type
   and b.item_id   = i.item_id;

grant select on public.v_item_availability to anon, authenticated;


-- v_booking_stale: ใช้ biz_today() (รายการที่ admin ต้องดูทุกวันเพื่อปัก overdue)
create or replace view public.v_booking_stale as
select b.id,
       b.booking_date,
       (public.biz_today() - b.booking_date) as days_past,
       b.status,
       b.job_name,
       m.code       as member_code,
       m.full_name  as member_name,
       (select count(*) from public.booking_items bi where bi.booking_id = b.id) as item_count
  from public.bookings b
  left join public.members m on m.id = b.member_id
 where b.status in ('reserved', 'checked_out')
   and b.booking_date < public.biz_today()
   and public.is_admin();

grant select on public.v_booking_stale to authenticated;


-- =============================================================================
-- ขั้น 4 — bookings_guard: ห้ามจองย้อนหลังโดยเทียบเวลาไทย + ค่า default ของคอลัมน์
-- =============================================================================

alter table public.bookings
  alter column booking_date set default public.biz_today();

create or replace function public.bookings_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_self     uuid;
  v_active   boolean;
  v_is_admin boolean;
  v_item     record;
begin
  if v_uid is null then
    raise exception 'ต้อง login ก่อนจองอุปกรณ์';
  end if;

  v_is_admin := public.is_admin();

  select m.id, m.active into v_self, v_active
    from public.members m where m.auth_uid = v_uid;

  if v_self is null then
    raise exception 'ไม่พบบัญชีของคุณในตาราง members — ให้ admin เพิ่มรายชื่อก่อน';
  end if;
  if v_active is not true then
    raise exception 'บัญชีของคุณถูกปิดใช้งานไว้ — จองอุปกรณ์ไม่ได้จนกว่า admin จะเปิดให้';
  end if;

  if tg_op = 'INSERT' and new.created_by is null then
    new.created_by := v_uid;
  end if;

  if not v_is_admin then
    -- crew: บังคับให้เป็นใบจองในชื่อตัวเองเสมอ (ต่อให้เว็บส่ง member_id ของคนอื่นมา)
    new.member_id := v_self;

    if coalesce(new.status, '') not in ('reserved', 'cancelled') then
      raise exception
        'สิทธิ์ crew ตั้งสถานะ "%" ไม่ได้ — การรับของ/ค้างคืนให้ admin เป็นผู้บันทึก', new.status;
    end if;

    if new.booking_date < public.biz_today() then
      raise exception 'จองย้อนหลังไม่ได้ — เลือกวันนี้หรือวันถัดไป (admin เท่านั้นที่บันทึกย้อนหลังได้)';
    end if;

    if tg_op = 'UPDATE' then
      new.created_by := old.created_by;   -- ห้ามย้ายเจ้าของใบจอง
    end if;

  else
    -- admin จองแทนคนอื่นได้ แต่บัญชีนั้นต้องมีจริงและยังใช้งานอยู่
    if new.member_id is null then
      new.member_id := v_self;
    end if;

    select m.active into v_active from public.members m where m.id = new.member_id;
    if v_active is not true then
      raise exception 'บัญชีผู้จอง (member_id = %) ไม่มีอยู่จริงหรือถูกปิดใช้งานไว้', new.member_id;
    end if;
  end if;

  if nullif(btrim(coalesce(new.job_name, '')), '') is null then
    raise exception 'ต้องระบุชื่องาน (job_name) ทุกใบจอง';
  end if;
  new.job_name := btrim(new.job_name);

  -- ตอน INSERT ยังไม่มีรายการของ (จะถูกตรวจตอน insert booking_items ทีละแถว)
  -- แต่ตอนย้ายวันหรือเปลี่ยนสถานะ รายการเดิมทั้งหมดต้องผ่านกติกาของวันใหม่อีกครั้ง
  if tg_op = 'UPDATE'
     and coalesce(new.status, '') <> 'cancelled'
     and (old.booking_date is distinct from new.booking_date
          or old.status is distinct from new.status) then
    for v_item in
      select bi.item_type, bi.item_id,
             greatest(bi.quantity - coalesce(bi.returned_quantity, 0), 0) as qty
        from public.booking_items bi
       where bi.booking_id = new.id
    loop
      perform public.booking_check_stock(
        v_item.item_type, v_item.item_id, v_item.qty,
        new.booking_date, new.status,
        null,        -- ไม่ข้ามรายการไหน
        new.id);     -- ข้ามทั้งใบจองนี้ กันนับตัวเองซ้ำ
    end loop;
  end if;

  return new;
end;
$$;


-- =============================================================================
-- ขั้น 5 — สีประจำตัวคนจอง (members.color_hue)
-- =============================================================================
-- ปฏิทินแสดง "สี = คนจอง" สีจึงต้องถาวรต่อคน ไม่สลับเมื่อรีเฟรชหรือเมื่อมี
-- สมาชิกเพิ่ม คำนวณจาก hash ของ id อย่างเดียวการันตีได้แค่ "ไม่เปลี่ยน"
-- แต่การันตี "ไม่ซ้ำกัน" ไม่ได้ (สองคนอาจได้สีใกล้กัน) จึงต้องเก็บไว้จริง
-- และให้ admin เปลี่ยนทีหลังได้ถ้าสีดันไปซ้ำกับคนอื่น

alter table public.members add column if not exists color_hue integer;

comment on column public.members.color_hue is
  'สีประจำตัวบนปฏิทินจอง (hue 0-359) — เติมอัตโนมัติตอนเพิ่มสมาชิกถ้ายังว่าง';

-- เติมให้แถวที่มีอยู่แล้ว: กระจายด้วยมุมทอง 137 องศา ตามลำดับรหัสสมาชิก
-- (137 กับ 360 เป็นจำนวนเฉพาะสัมพัทธ์กัน จึงไม่ซ้ำกันจนกว่าจะมีครบ 360 คน)
update public.members m
   set color_hue = sub.hue
  from (
    select id, ((row_number() over (order by code) - 1) * 137) % 360 as hue
      from public.members
  ) sub
 where m.id = sub.id
   and m.color_hue is null;

create or replace function public.members_fill_color_hue()
returns trigger
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_i   integer := 0;
  v_hue integer;
begin
  if new.color_hue is null then
    loop
      v_hue := (v_i * 137) % 360;
      -- ข้ามช่องสีที่มีคนใช้อยู่แล้ว เพื่อให้สมาชิกใหม่ได้สีที่แยกออกจริง
      exit when not exists (select 1 from public.members m where m.color_hue = v_hue);
      v_i := v_i + 1;
      exit when v_i > 400;   -- กัน loop ไม่จบ (มี hue ให้ใช้ 360 ค่า)
    end loop;
    new.color_hue := v_hue;
  end if;

  if new.color_hue is not null and (new.color_hue < 0 or new.color_hue > 359) then
    new.color_hue := abs(new.color_hue) % 360;
  end if;

  return new;
end;
$$;

drop trigger if exists members_fill_color_hue on public.members;
create trigger members_fill_color_hue
  before insert on public.members
  for each row
  execute function public.members_fill_color_hue();


-- =============================================================================
-- ขั้น 6 — ยอดคงเหลือ "รายวัน" (สิ่งที่ปฏิทินต้องการ แต่ view เดิมให้ไม่ได้)
-- =============================================================================
-- v_item_availability ตอบได้แค่วันนี้ เพราะ view รับพารามิเตอร์ไม่ได้
-- จึงต้องใช้ฟังก์ชันที่รับช่วงวันที่ แล้วจำกัดความกว้างไว้ 92 วัน
-- (กันการยิง query กวาดทั้งปีโดยไม่จำเป็น — เว็บโหลดทีละไตรมาสพอดี)
--
-- เป็น security definer ด้วยเหตุผลเดียวกับ v_item_availability: ผลลัพธ์มีแค่
-- "ยอดรวมต่อชิ้นต่อวัน" ไม่มีชื่อคนจอง ชื่องาน หรือหมายเหตุ ถ้าปล่อยให้ anon เรียก
-- แบบ invoker ผู้เยี่ยมชมที่ยังไม่ login จะเห็นของว่างทุกชิ้น ขณะที่การ์ดอุปกรณ์
-- (ซึ่งอ่าน v_item_availability) โชว์ยอดติดจองจริง — สองที่เหลื่อมกันให้เห็นชัด ๆ

create or replace function public.item_availability_between(d_from date, d_to date)
returns table (
  day           date,
  item_type     text,
  item_id       bigint,
  item_name     text,
  stock         numeric,
  booked        integer,
  out_count     integer,
  available     integer,
  stock_unknown boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if d_from is null or d_to is null then
    raise exception 'ต้องระบุช่วงวันที่ (d_from / d_to)';
  end if;
  if d_to < d_from then
    raise exception 'วันสิ้นสุด (%) อยู่ก่อนวันเริ่มต้น (%)', d_to, d_from;
  end if;
  if (d_to - d_from) > 92 then
    raise exception 'ช่วงวันที่กว้างเกิน 92 วัน (ขอมา % วัน) — ให้แบ่งโหลดทีละไตรมาส', (d_to - d_from) + 1;
  end if;

  return query
  with days as (
    select generate_series(d_from, d_to, interval '1 day')::date as day
  ),
  booked as (
    -- ต้องนับให้ "ตรงกับที่ booking_check_stock() ใช้ตัดสินจริง" ไม่ใช่แค่ใบที่จองวันนั้น
    -- ใบที่ค้างคืน (overdue) ล็อกสต็อกทุกวันตั้งแต่วันจองเป็นต้นไป จนกว่า admin จะเคลียร์
    -- ถ้าไม่นับ ปฏิทินจะบอกว่าวันถัดไปเหลือทั้งที่จริงของยังไม่กลับคลัง
    -- และพอกดจองจริงจะโดน trigger ปฏิเสธ — หน้าจอกับกฎไม่ตรงกัน
    select d.day,
           bi.item_type,
           bi.item_id,
           sum(greatest(bi.quantity - coalesce(bi.returned_quantity, 0), 0)) as qty,
           sum(greatest(bi.quantity - coalesce(bi.returned_quantity, 0), 0))
             filter (where b.status in ('checked_out', 'overdue')) as out_qty
      from days d
      join public.bookings b
        on b.status <> 'cancelled'
       and (b.booking_date = d.day
            or (b.status = 'overdue' and b.booking_date <= d.day))
      join public.booking_items bi on bi.booking_id = b.id
     group by d.day, bi.item_type, bi.item_id
  )
  select d.day,
         i.item_type,
         i.item_id,
         coalesce(nullif(btrim(i.item_name), ''), i.item_type || ' id ' || i.item_id) as item_name,
         i.stock,
         coalesce(b.qty, 0)::integer     as booked,
         coalesce(b.out_qty, 0)::integer as out_count,
         -- stock เป็น null = ยังไม่ระบุจำนวน -> available ต้องเป็น null ด้วย
         -- (ห้ามเป็น 0 เพราะจะแปลว่า "ของหมด" ซึ่งไม่จริง)
         case when i.stock is null then null
              else greatest(i.stock - coalesce(b.qty, 0), 0)::integer
         end                             as available,
         (i.stock is null)               as stock_unknown
    from days d
   cross join public.v_item_stock i
    left join booked b
      on b.day = d.day
     and b.item_type = i.item_type
     and b.item_id = i.item_id;
end;
$$;

revoke all on function public.item_availability_between(date, date) from public;
grant execute on function public.item_availability_between(date, date) to anon, authenticated;


-- ธงเตือนรายวันของปฏิทิน (วงแหวนแดง = มีของหมด / แดงปรุ = มีของค้างคืน)
--
-- จุดที่ต้องระวัง: ใบจองที่ค้างคืน (overdue) "ล็อกสต็อกทุกวัน" จนกว่า admin จะเคลียร์
-- ไม่ใช่แค่ในวันจอง ถ้าธงแดงโผล่แค่วันจอง ผู้ใช้จะเห็นว่าวันถัดไปว่าง
-- ทั้งที่จริงของยังไม่กลับคลัง — จึงนับ overdue ทับทุกวันตั้งแต่วันจองเป็นต้นไป
-- ให้ตรงกับที่ booking_check_stock() ใช้ตัดสินจริง
create or replace function public.booking_day_flags_between(d_from date, d_to date)
returns table (
  day             date,
  booking_count   integer,
  overdue_count   integer,
  booked_items    integer,
  sold_out_items  integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if d_from is null or d_to is null then
    raise exception 'ต้องระบุช่วงวันที่ (d_from / d_to)';
  end if;
  if d_to < d_from then
    raise exception 'วันสิ้นสุด (%) อยู่ก่อนวันเริ่มต้น (%)', d_to, d_from;
  end if;
  if (d_to - d_from) > 92 then
    raise exception 'ช่วงวันที่กว้างเกิน 92 วัน (ขอมา % วัน) — ให้แบ่งโหลดทีละไตรมาส', (d_to - d_from) + 1;
  end if;

  return query
  with days as (
    select generate_series(d_from, d_to, interval '1 day')::date as day
  ),
  active_booking as (
    -- ใบจองที่ "กินสต็อก" ของวันนั้น = จองวันนั้น หรือค้างคืนมาตั้งแต่วันก่อน
    select d.day, b.id, b.status
      from days d
      join public.bookings b
        on b.status <> 'cancelled'
       and (b.booking_date = d.day or (b.status = 'overdue' and b.booking_date <= d.day))
  ),
  per_item as (
    select ab.day,
           bi.item_type,
           bi.item_id,
           sum(greatest(bi.quantity - coalesce(bi.returned_quantity, 0), 0)) as qty
      from active_booking ab
      join public.booking_items bi on bi.booking_id = ab.id
     group by ab.day, bi.item_type, bi.item_id
  )
  select d.day,
         (select count(*)::integer from active_booking ab where ab.day = d.day)   as booking_count,
         (select count(*)::integer from active_booking ab
           where ab.day = d.day and ab.status = 'overdue')                        as overdue_count,
         count(p.item_id)::integer                                                as booked_items,
         count(*) filter (where i.stock is not null and i.stock - p.qty <= 0)::integer as sold_out_items
    from days d
    left join per_item p on p.day = d.day
    left join public.v_item_stock i
      on i.item_type = p.item_type and i.item_id = p.item_id
   group by d.day
   order by d.day;
end;
$$;

revoke all on function public.booking_day_flags_between(date, date) from public;
grant execute on function public.booking_day_flags_between(date, date) to anon, authenticated;


-- =============================================================================
-- ขั้น 7 — view สำหรับปฏิทิน
-- =============================================================================
-- ทั้งสอง view นี้ "ไม่เปิด security_invoker" จึงรันด้วยสิทธิ์เจ้าของและข้าม RLS
-- ของตาราง bookings/members — จำเป็น เพราะโจทย์ของปฏิทินคือ "ให้ทุกคนเห็นว่าใคร
-- จองวันไหน" ขณะที่ policy ระดับแถวยังคงเดิม (crew แก้/ลบได้เฉพาะใบของตัวเอง)
--
-- สิ่งที่เปิดให้ดู: ชื่อคนจอง ชื่องาน สถานที่ สถานะ รายการอุปกรณ์ และสีประจำตัว
-- สิ่งที่ไม่เปิด: อีเมล รหัส auth หรือข้อมูลบัญชีอื่น ๆ
-- และ grant ให้เฉพาะ authenticated (ไม่เปิดให้ anon) เพราะมีชื่อคนจองอยู่ในนั้น

create or replace view public.v_booking_day_summary as
with per_booking as (
  select b.id,
         b.booking_date,
         b.member_id,
         coalesce((
           select sum(greatest(bi.quantity - coalesce(bi.returned_quantity, 0), 0))
             from public.booking_items bi
            where bi.booking_id = b.id
         ), 0)::integer as qty
    from public.bookings b
   where b.status <> 'cancelled'
)
select pb.booking_date                                       as day,
       m.id                                                  as member_id,
       coalesce(nullif(btrim(m.full_name), ''), m.code, 'ไม่ระบุชื่อ') as member_name,
       m.code                                                as member_code,
       m.color_hue                                           as member_hue,
       count(*)::integer                                     as booking_count,
       coalesce(sum(pb.qty), 0)::integer                     as qty_total
  from per_booking pb
  left join public.members m on m.id = pb.member_id
 group by pb.booking_date, m.id, m.full_name, m.code, m.color_hue;

grant select on public.v_booking_day_summary to authenticated;


-- รายละเอียดรายใบ รายรายการ — เว็บจะกรองด้วย .eq('day', 'YYYY-MM-DD') ตอนกดดูวันนั้น
--
-- ⚠️ day ในสอง view นี้คือ "วันที่จอง" (booking_date) ไม่ใช่ "วันที่ของถูกกิน"
-- ใบที่ค้างคืน (overdue) ล็อกสต็อกทุกวันตั้งแต่วันจองเป็นต้นไป ซึ่งฝั่ง "ตัวเลขสต็อก"
-- (item_availability_between / booking_day_flags_between) นับทับทุกวันไว้แล้ว
-- ฝั่ง "รายชื่อ" เว็บจะดึงเพิ่มเองตอนกดดูวันนั้นด้วย
--   .eq('status','overdue').lt('day', วันนั้น)
-- จึงไม่ต้องขยายวันใน view นี้ (การขยายด้วย generate_series ใน view จะสร้างแถว
-- มหาศาลเมื่อมีใบค้างคืนเก่า ๆ และไม่จำเป็นเพราะเว็บถามทีละวันอยู่แล้ว)
create or replace view public.v_booking_day_detail as
select b.booking_date                                        as day,
       b.id                                                  as booking_id,
       b.job_name,
       b.job_location,
       b.status,
       b.note,
       b.group_ref,
       m.id                                                  as member_id,
       coalesce(nullif(btrim(m.full_name), ''), m.code, 'ไม่ระบุชื่อ') as member_name,
       m.code                                                as member_code,
       m.color_hue                                           as member_hue,
       bi.id                                                 as booking_item_id,
       bi.item_type,
       bi.item_id,
       coalesce(nullif(btrim(v.item_name), ''), bi.item_type || ' id ' || bi.item_id) as item_name,
       v.stock                                               as item_stock,
       bi.quantity,
       coalesce(bi.returned_quantity, 0)                     as returned_quantity,
       bi.note                                               as item_note
  from public.bookings b
  left join public.members m       on m.id = b.member_id
  left join public.booking_items bi on bi.booking_id = b.id
  left join public.v_item_stock v   on v.item_type = bi.item_type and v.item_id = bi.item_id
 where b.status <> 'cancelled';

grant select on public.v_booking_day_detail to authenticated;


-- =============================================================================
-- ขั้น 8 — create_booking(): สร้างใบจอง + รายการใน transaction เดียวฝั่ง server
-- =============================================================================
-- ทำไมต้องมี: supabase-js จากเบราว์เซอร์ยิงได้ทีละคำสั่ง ถ้า insert ใบจองผ่าน
-- แต่ insert รายการพัง จะเหลือ "ใบจองว่างเปล่า" ค้างในระบบ (และถ้ารายการแรกผ่าน
-- รายการหลังโดนปฏิเสธ ใบจองก็จะค้างครึ่งใบ) การรวมไว้ในฟังก์ชันเดียวทำให้
-- ทั้งก้อน rollback พร้อมกัน
--
-- จงใจเป็น security invoker (ค่าเริ่มต้น = ไม่ใส่ security definer):
--   * RLS ยังบังคับอยู่ -> crew สร้างใบจองในชื่อตัวเองเท่านั้น
--   * trigger ทุกตัวยังทำงาน -> การจองเกินสต็อกยังถูกปฏิเสธด้วยข้อความไทยเดิม
-- ต่างจาก booking_check_stock ที่ต้อง definer เพราะมันต้อง "นับข้ามคน"

create or replace function public.create_booking(
  p_job_name     text,
  p_job_location text,
  p_booking_date date,
  p_note         text,
  p_items        jsonb
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_member      uuid;
  v_booking_id  uuid;
  v_item        jsonb;
  v_type        text;
  v_qty         integer;
  v_lines       integer := 0;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'ต้อง sign in ก่อนจองอุปกรณ์ — และบัญชีของคุณต้องมีอยู่ในตาราง members';
  end if;

  if nullif(btrim(coalesce(p_job_name, '')), '') is null then
    raise exception 'ต้องระบุชื่องาน';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ต้องเลือกอุปกรณ์อย่างน้อย 1 รายการ';
  end if;

  insert into public.bookings (member_id, job_name, job_location, booking_date, note, status, created_by)
  values (
    v_member,
    btrim(p_job_name),
    nullif(btrim(coalesce(p_job_location, '')), ''),
    coalesce(p_booking_date, public.biz_today()),
    nullif(btrim(coalesce(p_note, '')), ''),
    'reserved',
    auth.uid()
  )
  returning id into v_booking_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_type := case when lower(coalesce(v_item ->> 'item_type', '')) = 'accessory'
                   then 'accessory' else 'fixture' end;
    v_qty  := greatest(coalesce((v_item ->> 'quantity')::integer, 0), 0);

    if (v_item ->> 'item_id') is null then
      raise exception 'รายการที่ % ไม่มี item_id', v_lines + 1;
    end if;
    if v_qty < 1 then
      raise exception 'รายการ % ต้องจองอย่างน้อย 1 ชิ้น (ระบุมา % ชิ้น)',
        coalesce(nullif(btrim(v_item ->> 'item_name'), ''), public.item_label(v_type, (v_item ->> 'item_id')::bigint)),
        v_qty;
    end if;

    insert into public.booking_items (booking_id, item_type, item_id, quantity, note)
    values (
      v_booking_id,
      v_type,
      (v_item ->> 'item_id')::bigint,
      v_qty,
      nullif(btrim(coalesce(v_item ->> 'note', '')), '')
    );

    v_lines := v_lines + 1;
  end loop;

  return v_booking_id;
end;
$$;

revoke all on function public.create_booking(text, text, date, text, jsonb) from public;
grant execute on function public.create_booking(text, text, date, text, jsonb) to authenticated;


-- =============================================================================
-- ขั้น 9 — ตรวจว่ารันผ่านจริง (รันทีละข้อใน SQL Editor ได้เลย)
-- =============================================================================

-- 9.1 biz_today() ให้วันที่ถูกต้อง และต่างจาก current_date ของเซสชัน UTC ไหม
-- select current_setting('timezone') as tz,
--        current_date                as utc_today,
--        public.biz_today()          as bangkok_today,
--        (public.biz_today() <> current_date) as is_different_right_now;

-- 9.2 booking_check_stock ต้องเป็น security definer แล้ว (แก้บั๊กนับขาด)
-- select p.proname, p.prosecdef as security_definer,
--        (select count(*) from pg_proc q
--          where q.pronamespace = p.pronamespace and q.proname = p.proname) as overloads
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('booking_check_stock','item_stock','item_label','create_booking')
--  order by p.proname;
-- ความคาดหวัง: booking_check_stock = true / create_booking = false / item_stock,item_label = false

-- 9.3 ค่า default ของคอลัมน์ booking_date ต้องเป็น biz_today()
-- select column_name, column_default
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'bookings' and column_name = 'booking_date';

-- 9.4 members.color_hue ถูกเติมครบและไม่ซ้ำ
-- select count(*) as total,
--        count(color_hue) as has_hue,
--        count(distinct color_hue) as distinct_hue,
--        min(color_hue) as min_hue, max(color_hue) as max_hue
--   from public.members;

-- 9.5 view/ฟังก์ชันใหม่มีอยู่จริง
-- select table_name from information_schema.views
--  where table_schema = 'public'
--    and table_name in ('v_item_stock','v_booking_day_summary','v_booking_day_detail')
--  order by table_name;

-- 9.6 ยอดรายวัน (วันละ 136 แถว = เท่าจำนวนรายการในคลัง)
-- select day, count(*) as rows, count(*) filter (where available = 0) as sold_out
--   from public.item_availability_between(public.biz_today(), public.biz_today() + 6)
--  group by day order by day;

-- 9.7 ปฏิเสธช่วงที่กว้างเกิน 92 วัน
-- select count(*) from public.item_availability_between(current_date, current_date + 400);
-- ความคาดหวัง: ERROR "ช่วงวันที่กว้างเกิน 92 วัน (ขอมา 401 วัน)"

-- 9.8 ทดสอบพฤติกรรมเต็มรอบ (สร้างใบจอง -> ตรวจ -> จองเกิน -> ลบทิ้ง)
-- ⚠️ รันทั้งบล็อกนี้ครั้งเดียว จบแล้วข้อมูลทดสอบจะถูก rollback ทิ้งทั้งหมด
--     เพราะจงใจ raise exception ตอนท้ายเพื่อส่งผลการทดสอบออกมา
-- do $$
-- declare
--   v_admin  uuid := '165e05ce-2158-4575-acff-b7e08a85534d';   -- uid ของ ADMIN01
--   v_mid    uuid;
--   v_bid    uuid;
--   v_stock  numeric;
--   v_left   integer;
--   v_msg    text;
--   v_ok     text := '';
-- begin
--   select id into v_mid from public.members where code = 'ADMIN01';
--   perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
--   v_stock := public.item_stock('fixture', 1);
--
--   -- (ก) สร้างใบจองผ่าน create_booking() เต็มจำนวนที่มี
--   v_bid := public.create_booking('ทดสอบ create_booking', 'สตูดิโอทดสอบ', public.biz_today(), null,
--     jsonb_build_array(jsonb_build_object('item_type','fixture','item_id',1,'quantity',v_stock::int)));
--   v_ok := v_ok || 'ก.สร้างใบจองเต็มจำนวนผ่าน(' || v_bid || ') ';
--
--   select available into v_left
--     from public.item_availability_between(public.biz_today(), public.biz_today())
--    where item_type = 'fixture' and item_id = 1;
--   v_ok := v_ok || 'ข.เหลือ=' || coalesce(v_left::text,'NULL') || ' ';
--
--   -- (ค) จองเกินอีก 1 ชิ้น -> ต้องถูกปฏิเสธ
--   begin
--     perform public.create_booking('ทดสอบจองเกิน', null, public.biz_today(), null,
--       jsonb_build_array(jsonb_build_object('item_type','fixture','item_id',1,'quantity',1)));
--     v_ok := v_ok || 'ค.!! ไม่ถูกปฏิเสธ (ผิด) ';
--   exception when others then
--     get stacked diagnostics v_msg = message_text;
--     v_ok := v_ok || 'ค.ถูกปฏิเสธ: ' || left(v_msg, 60) || ' ';
--   end;
--
--   -- (ง) ของที่ยังไม่ระบุจำนวน -> ต้องถูกปฏิเสธ
--   begin
--     perform public.create_booking('ทดสอบของไม่ระบุจำนวน', null, public.biz_today(), null,
--       jsonb_build_array(jsonb_build_object('item_type','accessory','item_id',7,'quantity',1)));
--     v_ok := v_ok || 'ง.!! ไม่ถูกปฏิเสธ (ผิด) ';
--   exception when others then
--     get stacked diagnostics v_msg = message_text;
--     v_ok := v_ok || 'ง.ถูกปฏิเสธ: ' || left(v_msg, 40) || ' ';
--   end;
--
--   -- (จ) ไม่ระบุงาน -> ต้องถูกปฏิเสธ
--   begin
--     perform public.create_booking('   ', null, public.biz_today(), null,
--       jsonb_build_array(jsonb_build_object('item_type','fixture','item_id',1,'quantity',1)));
--     v_ok := v_ok || 'จ.!! ไม่ถูกปฏิเสธ (ผิด) ';
--   exception when others then
--     v_ok := v_ok || 'จ.ถูกปฏิเสธ(ต้องระบุชื่องาน) ';
--   end;
--
--   -- (ฉ) ธงรายวันต้องเห็นว่าวันนี้ของหมด
--   perform 1 from public.booking_day_flags_between(public.biz_today(), public.biz_today())
--    where day = public.biz_today() and sold_out_items >= 1;
--   v_ok := v_ok || case when found then 'ฉ.ธงของหมดทำงาน ' else 'ฉ.!! ไม่เห็นธงของหมด ' end;
--
--   -- (ช) summary/detail ต้องเห็นใบที่สร้าง
--   perform 1 from public.v_booking_day_detail where booking_id = v_bid;
--   v_ok := v_ok || case when found then 'ช.detail เห็นใบจอง ' else 'ช.!! detail ไม่เห็น ' end;
--
--   -- (ซ) ลบข้อมูลทดสอบ
--   delete from public.booking_items where booking_id = v_bid;
--   delete from public.bookings where id = v_bid;
--
--   perform set_config('request.jwt.claims', '{}', true);
--   raise exception 'TEST RESULT: %', v_ok;   -- rollback ทั้งก้อน + ส่งผลออกมาทาง error
-- end $$;


-- =============================================================================
-- ขั้น 10 — ถอยกลับ (รันตามลำดับ ห้ามสลับ)
-- =============================================================================
-- drop function if exists public.create_booking(text, text, date, text, jsonb);
-- drop view if exists public.v_booking_day_detail;
-- drop view if exists public.v_booking_day_summary;
-- drop function if exists public.booking_day_flags_between(date, date);
-- drop function if exists public.item_availability_between(date, date);
-- drop trigger if exists members_fill_color_hue on public.members;
-- drop function if exists public.members_fill_color_hue();
-- alter table public.members drop column if exists color_hue;
-- alter table public.bookings alter column booking_date set default current_date;
-- (ถ้าจะถอยขั้น 1-3 ด้วย ให้ copy บล็อกเดิมจาก migration-2026-11-13c-bookings.sql
--  มา create or replace ทับ: booking_check_stock แบบไม่มี security definer,
--  bookings_guard / v_item_availability / v_booking_stale แบบใช้ current_date,
--  แล้ว drop view public.v_item_stock และ drop function public.biz_today())
