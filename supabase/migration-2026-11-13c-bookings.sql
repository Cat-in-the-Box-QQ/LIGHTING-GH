-- =============================================================================
-- migration-2026-11-13c-bookings.sql
-- ระบบจองอุปกรณ์ — ชั้นฐานข้อมูล (ตาราง bookings + booking_items)
-- =============================================================================
--
-- รันที่ไหน : Supabase Dashboard -> SQL Editor -> วางทั้งไฟล์ -> Run
-- รันซ้ำได้  : ปลอดภัยทุกขั้น (if not exists / create or replace / drop if exists)
-- ต้องรันหลัง: migration-2026-10-22-members.sql (ใช้ตาราง members และ is_admin())
--
-- ⚠️ Supabase SQL Editor รันทั้งไฟล์เป็น "transaction เดียว"
--    ถ้ามี error แค่บรรทัดเดียว ทุกขั้นจะถูก rollback หมด (จงใจ — ดีกว่าค้างครึ่ง ๆ)
--
-- -----------------------------------------------------------------------------
-- กติกาที่เจ้าของเว็บตัดสินใจไว้แล้ว (ห้ามแก้โดยไม่ถาม)
-- -----------------------------------------------------------------------------
--  1. จองได้ "วันเดียว" ต่อ 1 ใบจอง — พ้นวันนั้นถือว่าของกลับคลังเองอัตโนมัติ
--     จึงไม่ต้องใช้ cron / edge function: แค่ booking_date <> current_date
--     ก็ไม่นับว่าติดจองแล้ว
--  2. คนจองต้อง login (role crew หรือ admin ก็ได้)
--  3. รายการที่ยังไม่ระบุจำนวน (stock เป็น null/ว่าง) -> "จองไม่ได้"
--     ตอนนี้ accessories 70 จาก 72 แถวเป็นแบบนี้ (มีแค่ id 1 กับ 2 ที่กรอกไว้)
--  4. "ชุด" (set) ไม่เป็น entity ที่มีสต็อกเอง — เว็บแตกชุดเป็นรายชิ้นก่อนส่งมา
--     (จึงไม่มีตาราง sets ในไฟล์นี้)
--  5. ห้ามเขียนคอลัมน์ stock / stock_count ของ fixtures และ accessories
--     จำนวนที่ติดจองถูก "คำนวณ" จาก booking_items เสมอ — มีแหล่งความจริงแหล่งเดียว
--     (คอลัมน์ fixtures.reserved / in_use / remaining ของเดิมเป็นค่าที่กรอกมือ
--      และตอนนี้ยังเป็น 0 ทุกแถว — เว็บจะอ่านค่าจาก view ของระบบจองแทน)
--
-- -----------------------------------------------------------------------------
-- ทำไมต้องมี trigger กันจองเกิน ทั้งที่ฝั่งเว็บก็เช็คได้
-- -----------------------------------------------------------------------------
--  การเช็คใน JavaScript เป็นแค่ด่านสวยงาม — ใครก็ยิง POST ข้ามเว็บได้
--  และต่อให้ทุกคนใช้เว็บ สองคนที่กดจองชิ้นสุดท้าย "พร้อมกัน" จะอ่านค่าเก่าทั้งคู่
--  แล้วเขียนผ่านทั้งคู่ (race condition) ได้ของเกินสต็อก
--
--  จึงใช้ pg_advisory_xact_lock(hashtext(item_type || ':' || item_id))
--  ล็อกรายชิ้นตลอด transaction แล้วค่อยนับของที่ถูกจองไว้
--  -> คนที่สองจะ "รอคิว" และเห็นจำนวนที่คนแรกจองไปแล้ว จึงปฏิเสธได้ถูกต้อง
--
--  หมายเหตุ: ใบจองที่มีหลายรายการจะล็อกทีละชิ้นตามลำดับที่ insert
--  ถ้าสองใบจองล็อกสลับลำดับกัน Postgres จะตรวจเจอ deadlock แล้ว abort หนึ่งอัน
--  (ผู้ใช้กดซ้ำได้) — ยอมรับได้เพราะเกิดยากและไม่มีข้อมูลเสีย
-- =============================================================================


-- =============================================================================
-- ขั้น 0 — ปิดรอยต่อของเดิม: set_updated_at() มีในฐานข้อมูลจริงแต่ไม่มีใน repo
-- =============================================================================
-- ตอนตรวจฐานข้อมูลพบว่า trigger fixtures_set_updated_at / accessories_set_updated_at
-- ทำงานอยู่จริง แต่ไม่มีไฟล์ SQL ไหนใน repo ประกาศฟังก์ชันนี้ไว้เลย
-- -> ติดตั้งใหม่จาก schema.sql จะขาดฟังก์ชันนี้ และไฟล์ bookings ข้างล่างก็ใช้มันด้วย
-- จึงประกาศไว้ตรงนี้ (create or replace = ไม่กระทบของเดิมที่กำลังทำงานอยู่)
-- พร้อมปัก search_path ให้เหมือนฟังก์ชันตัวอื่น ๆ ในโปรเจกต์

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists fixtures_set_updated_at on public.fixtures;
create trigger fixtures_set_updated_at
  before update on public.fixtures
  for each row execute function public.set_updated_at();

drop trigger if exists accessories_set_updated_at on public.accessories;
create trigger accessories_set_updated_at
  before update on public.accessories
  for each row execute function public.set_updated_at();


-- =============================================================================
-- ขั้น 1 — ตาราง bookings และ booking_items
-- =============================================================================
-- แยก 2 ตารางเพราะ 1 ใบจองมีหลายรายการ (header / line items)
-- ลบใบจอง -> รายการหายตาม (on delete cascade) แต่ลบ "คน" ไม่ได้ถ้ามีใบจองค้าง
-- (on delete restrict — ตรงกับกติกาที่ไม่มีการลบสมาชิก มีแค่ปิดใช้งาน)

create table if not exists public.bookings (
  id            uuid primary key default gen_random_uuid(),

  -- ใครจอง: ผูกกับตาราง members (ไม่ใช่ auth.users) เพราะเว็บต้องโชว์ชื่อ + รหัสประจำตัว
  -- trigger จะบังคับให้เป็นบัญชีของคนกดจองเสมอ (crew จองแทนคนอื่นไม่ได้)
  member_id     uuid not null references public.members (id) on delete restrict,

  job_name      text not null,
  job_location  text,

  -- วันที่ใช้งานของ — "วันเดียว" ตามกติกา พ้นวันนี้ถือว่าคืนคลังอัตโนมัติ
  booking_date  date not null default current_date,

  -- reserved    = จองไว้ (ยังไม่รับของ)
  -- checked_out = รับของออกไปแล้ว
  -- overdue     = เลยวันแล้วยังไม่คืน -> ถูกนับว่าติดจอง "ทุกวัน" จนกว่าจะแก้
  --               (ช่องนี้ปิดจุดบอดของการคืนอัตโนมัติ: ถ้าของไม่กลับจริง
  --                ระบบจะไม่มีทางรู้เอง ต้องให้ admin ปักไว้)
  -- cancelled   = ยกเลิก -> ไม่นับสต็อกเลย
  status        text not null default 'reserved'
                check (status in ('reserved', 'checked_out', 'overdue', 'cancelled')),

  -- งานเดียวกันหลายวัน = หลายแถวที่ share group_ref ตัวเดียวกัน
  -- (ยังไม่ใช้ในเว็บ แต่จองไว้ก่อนเพื่อไม่ต้อง alter ตารางทีหลัง)
  group_ref     uuid,

  note          text,

  -- ใครกดสร้าง (อาจเป็น admin ที่จองแทนคนอื่น) — เติมจาก auth.uid() อัตโนมัติ
  created_by    uuid references auth.users (id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.booking_items (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null references public.bookings (id) on delete cascade,

  -- item_type + item_id แทน foreign key เพราะของอยู่ 2 ตาราง (fixtures / accessories)
  -- ผูก FK ข้ามสองตารางไม่ได้ — ใช้คู่ (type, id) แบบเดียวกับที่ Set Builder
  -- ในเว็บแทนอุปกรณ์ด้วย "1" และอุปกรณ์เสริมด้วย "a1"
  item_type     text not null check (item_type in ('fixture', 'accessory')),
  item_id       bigint not null,

  quantity          integer not null check (quantity > 0),
  -- ของที่ส่งคืนแล้ว (คืนไม่ครบจำนวนได้) — จำนวนที่นับว่าติดจองคือ
  -- quantity - returned_quantity และเฉพาะ admin ที่แก้ช่องนี้ได้
  returned_quantity integer not null default 0 check (returned_quantity >= 0),

  note text,

  -- ใบจองหนึ่งใบมีรายการเดิมได้ครั้งเดียว (กันกดเพิ่มซ้ำจนสต็อกเพี้ยน)
  unique (booking_id, item_type, item_id)
);

create index if not exists bookings_date_idx   on public.bookings (booking_date);
create index if not exists bookings_member_idx on public.bookings (member_id);
create index if not exists bookings_status_idx on public.bookings (status);
create index if not exists booking_items_item_idx    on public.booking_items (item_type, item_id);
create index if not exists booking_items_booking_idx on public.booking_items (booking_id);

drop trigger if exists bookings_set_updated_at on public.bookings;
create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function public.set_updated_at();


-- =============================================================================
-- ขั้น 2 — ฟังก์ชันอ่านสต็อกของ "ทั้ง 2 ตาราง" ผ่านประตูเดียว
-- =============================================================================
-- สำคัญ: fixtures ใช้คอลัมน์ numeric (stock_count) แต่ accessories มีแค่ text (stock)
-- เช่น "10 Pieces" จึงต้องแกะตัวเลขออกมา — และถ้าแกะไม่ได้ต้องคืน null
-- (null = ยังไม่ระบุจำนวน = จองไม่ได้) ห้ามเดาเป็น 0 หรือเดาเป็นจำนวนมั่ว ๆ

-- แกะตัวเลขนำหน้าจากข้อความสต็อก: "10 Pieces" -> 10, "2 Pieces" -> 2, null -> null
-- ใช้ regex ดักเฉพาะตัวเลข จึง cast เป็น numeric ไม่พังแม้ข้อความแปลก
create or replace function public.parse_stock_text(p_text text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(substring(coalesce(p_text, '') from '^\s*([0-9]+(?:\.[0-9]+)?)'), '')::numeric;
$$;

-- สต็อกของหนึ่งรายการ — คืน null เมื่อ "ยังไม่ระบุจำนวน"
-- ถ้าไม่พบรายการเลยจะ raise (ต่างจาก "เจอแต่ไม่ได้กรอกจำนวน")
create or replace function public.item_stock(p_item_type text, p_item_id bigint)
returns numeric
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_stock numeric;
  v_found boolean := false;
begin
  if p_item_type = 'fixture' then
    select true, f.stock_count::numeric into v_found, v_stock
      from public.fixtures f where f.id = p_item_id;
  elsif p_item_type = 'accessory' then
    select true, public.parse_stock_text(a.stock) into v_found, v_stock
      from public.accessories a where a.id = p_item_id;
  else
    raise exception 'item_type ต้องเป็น "fixture" หรือ "accessory" เท่านั้น (ได้ "%")', p_item_type;
  end if;

  if not v_found then
    raise exception 'ไม่พบรายการนี้ในฐานข้อมูล — % id = %', p_item_type, p_item_id;
  end if;

  return v_stock;   -- null = ยังไม่ระบุจำนวน
end;
$$;

-- ชื่อรายการสำหรับเอาไปประกอบข้อความ error ให้คนอ่านรู้เรื่อง
-- (ข้อความจาก trigger ถูกโชว์ให้ผู้ใช้เห็นตรง ๆ จึงต้องไม่ใช่แค่ id)
create or replace function public.item_label(p_item_type text, p_item_id bigint)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(
      case
        when p_item_type = 'fixture' then (
          select concat_ws(' ', nullif(btrim(f.brand), ''), nullif(btrim(f.model), ''))
            from public.fixtures f where f.id = p_item_id)
        else (
          select nullif(btrim(a.name), '')
            from public.accessories a where a.id = p_item_id)
      end,
      ''),
    p_item_type || ' id ' || p_item_id);
$$;

-- members.id ของคนที่กำลังเรียกอยู่ — policy RLS ใช้เทียบว่า "ใบจองของตัวเอง"
-- เป็น security invoker จึงโดน RLS ของตาราง members กรองด้วย (อ่านได้แค่แถวตัวเอง)
create or replace function public.current_member_id()
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select id from public.members where auth_uid = auth.uid();
$$;


-- =============================================================================
-- ขั้น 3 — หัวใจของระบบ: ฟังก์ชันตรวจว่า "จองเกินของที่มีไหม"
-- =============================================================================
-- ทั้ง trigger ของ booking_items (เพิ่ม/แก้รายการ) และ trigger ของ bookings
-- (ย้ายวัน / เปลี่ยนสถานะ) เรียกฟังก์ชันนี้ตัวเดียวกัน จึงไม่มีทางที่กติกาจะเหลื่อมกัน
--
-- สูตรนับของที่ติดจองในวัน D:
--   sum(quantity - returned_quantity) ของใบจองที่
--     status <> 'cancelled'  และ  (booking_date = D  หรือ  status = 'overdue')
--   -> ใบจองวันอื่นไม่นับ (ของกลับคลังอัตโนมัติแล้ว)
--   -> ใบจองที่ค้างคืน (overdue) นับทุกวันจนกว่า admin จะแก้
--
-- p_exclude_item_id    : ข้ามรายการบรรทัดนี้ (ใช้ตอน UPDATE — แถวเก่ายังอยู่ในตาราง)
-- p_exclude_booking_id : ข้ามทั้งใบจองนี้ (ใช้ตอนย้ายวัน — กันนับตัวเองซ้ำ)
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
-- ขั้น 4 — trigger ประจำตาราง
-- =============================================================================

-- 4.1 bookings: เติม created_by/member_id, กันสวมรอย, กัน crew ตั้งสถานะข้ามขั้น,
--     และตรวจสต็อกใหม่เมื่อ "ย้ายวัน" หรือ "เปลี่ยนสถานะ"
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

    if new.booking_date < current_date then
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

drop trigger if exists bookings_guard on public.bookings;
create trigger bookings_guard
  before insert or update on public.bookings
  for each row execute function public.bookings_guard();


-- 4.2 booking_items: กันจองเกิน + กัน crew แก้จำนวนที่คืนแล้ว
create or replace function public.booking_items_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_date   date;
  v_status text;
  v_found  boolean := false;
begin
  select b.booking_date, b.status into v_date, v_status
    from public.bookings b where b.id = new.booking_id;
  v_found := found;

  -- มองไม่เห็นใบจอง = ไม่ใช่ของตัวเอง (RLS กรองทิ้ง) หรือยังไม่ได้สร้าง
  if not v_found then
    raise exception 'ไม่พบใบจองนี้ — สร้างใบจองก่อน แล้วค่อยเพิ่มรายการของ';
  end if;

  if new.returned_quantity > new.quantity then
    raise exception 'จำนวนที่คืน (%) เกินจำนวนที่จอง (%)', new.returned_quantity, new.quantity;
  end if;

  -- returned_quantity มีผลตรง ๆ ต่อจำนวนที่ระบบเห็นว่าติดจอง
  -- ให้ crew แก้เองได้ = ปลดสต็อกให้ตัวเองโดยไม่ต้องคืนของจริง จึงสงวนไว้ให้ admin
  if tg_op = 'UPDATE'
     and not public.is_admin()
     and new.returned_quantity is distinct from old.returned_quantity then
    raise exception 'สิทธิ์ crew แก้ "จำนวนที่คืนแล้ว" ไม่ได้ — ให้ admin ยืนยันว่าของกลับคลังก่อน';
  end if;

  perform public.booking_check_stock(
    new.item_type,
    new.item_id,
    greatest(new.quantity - coalesce(new.returned_quantity, 0), 0),
    v_date,
    v_status,
    new.id,   -- ตอน UPDATE แถวเก่ายังอยู่ในตาราง ต้องข้ามตัวเอง
    null);

  return new;
end;
$$;

drop trigger if exists booking_items_guard on public.booking_items;
create trigger booking_items_guard
  before insert or update on public.booking_items
  for each row execute function public.booking_items_guard();


-- =============================================================================
-- ขั้น 5 — Row Level Security
-- =============================================================================
-- กฎ: ใบจองเป็น "ข้อมูลส่วนตัว" ต่างจากอุปกรณ์ที่ใครก็ดูได้
--   - เจ้าของใบจอง (และ admin) เท่านั้นที่อ่าน/แก้ได้
--   - แต่ "จำนวนที่ติดจอง/เหลือกี่ชิ้น" เป็นข้อมูลสาธารณะ (โชว์บนการ์ดอุปกรณ์)
--     จึงแยกออกไปเป็น view v_item_availability ในขั้น 6

alter table public.bookings      enable row level security;
alter table public.booking_items enable row level security;

-- ---- bookings ----
drop policy if exists "bookings read own or admin" on public.bookings;
create policy "bookings read own or admin"
  on public.bookings for select
  to authenticated
  using (
    public.is_admin()
    or created_by = auth.uid()
    or member_id = public.current_member_id()
  );

drop policy if exists "member create own booking" on public.bookings;
create policy "member create own booking"
  on public.bookings for insert
  to authenticated
  with check (
    public.is_admin()
    or member_id = public.current_member_id()
  );

drop policy if exists "member update own booking" on public.bookings;
create policy "member update own booking"
  on public.bookings for update
  to authenticated
  using (public.is_admin() or member_id = public.current_member_id())
  with check (public.is_admin() or member_id = public.current_member_id());

-- การลบไม่มีในเว็บ (ใช้ยกเลิกแทน) — เผื่อไว้ให้ admin เก็บข้อมูลทดสอบผ่าน SQL เท่านั้น
drop policy if exists "admin delete bookings" on public.bookings;
create policy "admin delete bookings"
  on public.bookings for delete
  to authenticated
  using (public.is_admin());

-- ---- booking_items ----
-- ทุก policy อ้างใบจองแม่ผ่าน exists(...) ซึ่ง subquery นี้โดน RLS ของ bookings กรองด้วย
-- -> crew เห็น/แก้ได้เฉพาะรายการในใบจองของตัวเองโดยไม่ต้องเขียนเงื่อนไขซ้ำ
drop policy if exists "booking_items read own" on public.booking_items;
create policy "booking_items read own"
  on public.booking_items for select
  to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id));

-- เพิ่มรายการได้เฉพาะใบจองที่ยัง reserved (ยกเลิก/จ่ายแล้ว = แก้ไม่ได้)
drop policy if exists "booking_items insert own reserved" on public.booking_items;
create policy "booking_items insert own reserved"
  on public.booking_items for insert
  to authenticated
  with check (exists (
    select 1 from public.bookings b
     where b.id = booking_id
       and b.status = 'reserved'
       and (public.is_admin() or b.member_id = public.current_member_id())
  ));

drop policy if exists "booking_items update own reserved" on public.booking_items;
create policy "booking_items update own reserved"
  on public.booking_items for update
  to authenticated
  using (exists (
    select 1 from public.bookings b
     where b.id = booking_id
       and (public.is_admin() or (b.status = 'reserved' and b.member_id = public.current_member_id()))
  ))
  with check (exists (
    select 1 from public.bookings b
     where b.id = booking_id
       and (public.is_admin() or (b.status = 'reserved' and b.member_id = public.current_member_id()))
  ));

drop policy if exists "booking_items delete own reserved" on public.booking_items;
create policy "booking_items delete own reserved"
  on public.booking_items for delete
  to authenticated
  using (exists (
    select 1 from public.bookings b
     where b.id = booking_id
       and (public.is_admin() or (b.status = 'reserved' and b.member_id = public.current_member_id()))
  ));

-- สิทธิ์ระดับ role (RLS กรองละเอียดอีกชั้นข้างบน)
grant select, insert, update, delete on public.bookings      to authenticated;
grant select, insert, update, delete on public.booking_items to authenticated;


-- =============================================================================
-- ขั้น 6 — view สำหรับแสดง "ติดจองกี่ชิ้น / เหลือกี่ชิ้น"
-- =============================================================================
-- ทำไม view นี้ถึง "ไม่" ใช้ security_invoker
-- ------------------------------------------
-- view ปกติรันด้วยสิทธิ์ของเจ้าของ (postgres) จึงข้าม RLS ของตารางข้างใต้
-- ที่นี่จงใจให้เป็นแบบนั้น: การ์ดอุปกรณ์ต้องโชว์ยอดรวมว่าของชิ้นนี้ถูกจองไปกี่ชิ้น
-- ให้ "ทุกคน" เห็น (รวมผู้เยี่ยมชมที่ยังไม่ login) เหมือนที่เห็นจำนวนสต็อกอยู่แล้ว
-- ถ้าเปิด security_invoker ผู้เยี่ยมชมจะเห็น booked = 0 ทุกชิ้น เพราะอ่าน bookings ไม่ได้
--
-- สิ่งที่หลุดออกไปมีแค่ "ยอดรวมต่อชิ้น" — ไม่มีชื่อคนจอง ชื่องาน หรือหมายเหตุ
-- (ข้อมูลพวกนั้นอยู่ใน v_booking_stale ซึ่งล็อกไว้ให้ admin เท่านั้น)

create or replace view public.v_item_availability as
with items as (
  select 'fixture'::text              as item_type,
         f.id                          as item_id,
         concat_ws(' ', nullif(btrim(f.brand), ''), nullif(btrim(f.model), '')) as item_name,
         f.stock_count::numeric        as stock,
         f.hidden                      as hidden
    from public.fixtures f
  union all
  select 'accessory'::text,
         a.id,
         nullif(btrim(a.name), ''),
         public.parse_stock_text(a.stock),
         a.hidden
    from public.accessories a
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
     and (b.booking_date = current_date or b.status = 'overdue')
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


-- ใบจองที่ "เลยวันแล้วที่ยังไม่ถูกปักสถานะว่าค้างคืน" — ของน่าจะยังไม่ได้กลับคลังจริง
-- แต่ระบบคืนอัตโนมัติไปแล้วเพราะ booking_date ผ่านไป
-- นี่คือรายการที่ admin ต้องดูทุกวันในแท็บจอง แล้วกดปักเป็น overdue ถ้าของไม่ได้กลับคลัง
-- (view นี้ล็อกด้วย is_admin() ใน where clause จึงคืน 0 แถวให้ทุกคนที่ไม่ใช่ admin)
create or replace view public.v_booking_stale as
select b.id,
       b.booking_date,
       (current_date - b.booking_date) as days_past,
       b.status,
       b.job_name,
       m.code       as member_code,
       m.full_name  as member_name,
       (select count(*) from public.booking_items bi where bi.booking_id = b.id) as item_count
  from public.bookings b
  left join public.members m on m.id = b.member_id
 where b.status in ('reserved', 'checked_out')
   and b.booking_date < current_date
   and public.is_admin();

grant select on public.v_booking_stale to authenticated;


-- =============================================================================
-- ขั้น 7 — ตรวจว่ารันผ่านจริง (รันทีละข้อใน SQL Editor ได้เลย)
-- =============================================================================

-- 7.1 ตารางและคอลัมน์ครบไหม
-- select table_name, column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name in ('bookings', 'booking_items')
--  order by table_name, ordinal_position;

-- 7.2 trigger ติดครบ 3 ตัว (bookings_guard / booking_items_guard / bookings_set_updated_at)
-- select c.relname as table_name, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as def
--   from pg_trigger t
--   join pg_class c on c.oid = t.tgrelid
--   join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public'
--    and not t.tgisinternal
--    and c.relname in ('bookings', 'booking_items')
--  order by 1, 2;

-- 7.3 RLS เปิดอยู่ และมี policy ครบ
-- select c.relname as table_name, c.relrowsecurity as rls_on, p.policyname, p.cmd
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--   left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
--  where n.nspname = 'public'
--    and c.relname in ('bookings', 'booking_items')
--  order by 1, 3;

-- 7.4 ฟังก์ชันทุกตัวต้องปัก search_path (กัน search_path hijack)
-- select p.proname, p.prosecdef as security_definer, p.proconfig
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('set_updated_at', 'parse_stock_text', 'item_stock', 'item_label',
--                      'current_member_id', 'booking_check_stock',
--                      'bookings_guard', 'booking_items_guard')
--  order by 1;

-- 7.5 view อ่านได้จริง + ตอนนี้ยังไม่มียอดจอง (booked ต้องเป็น 0 ทุกแถว)
-- select item_type, count(*) as rows, sum(booked) as total_booked,
--        count(*) filter (where stock_unknown) as unknown_stock
--   from public.v_item_availability
--  group by item_type;

-- 7.6 รายการที่ยังไม่ระบุจำนวน (จองไม่ได้) — ตอนนี้คาดว่า accessories 70 แถว
-- select item_type, item_id, item_name
--   from public.v_item_availability
--  where stock_unknown
--  order by item_type, item_id;

-- 7.7 ทดสอบว่า trigger กันจองเกินทำงานจริง (สร้างข้อมูลทดสอบแล้วลบทิ้ง)
-- ⚠️ ต้องรันเป็นบล็อกเดียว และปิดท้ายด้วย delete เสมอ
--
-- ทำไมต้อง set_config('request.jwt.claims', ...) ก่อน
--   trigger บังคับว่า "ต้อง login" (auth.uid() ห้ามเป็น null) แต่ SQL Editor
--   รันในฐานะเจ้าของฐานข้อมูลซึ่งไม่มี JWT -> auth.uid() เป็น null -> trigger จะปฏิเสธ
--   จึงต้องบอก Postgres ว่า "สมมติว่าเป็น uid ของ admin คนนี้" ก่อน
--   (ค่านี้หายเองเมื่อจบ transaction ไม่ได้แก้สิทธิ์ถาวร)
--
-- do $$
-- declare
--   v_uid     uuid;
--   v_fixture bigint;
--   v_stock   integer;
--   v_booking uuid;
--   v_hit     boolean := false;
-- begin
--   select auth_uid into v_uid from public.members
--    where role = 'admin' and active and auth_uid is not null
--    order by created_at limit 1;
--   if v_uid is null then
--     raise exception 'ไม่พบ admin ที่ผูกกับบัญชี login — ทดสอบเองไม่ได้ ให้ทดสอบผ่านเว็บแทน';
--   end if;
--   perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
--
--   select id, stock_count into v_fixture, v_stock from public.fixtures
--    where stock_count > 1 order by id limit 1;
--
--   insert into public.bookings (member_id, job_name, booking_date)
--   values (public.current_member_id(), 'ทดสอบ trigger (จะถูกลบ)', current_date)
--   returning id into v_booking;
--
--   -- จองเท่าที่มีพอดี -> ต้องผ่าน
--   insert into public.booking_items (booking_id, item_type, item_id, quantity)
--   values (v_booking, 'fixture', v_fixture, v_stock);
--
--   -- ขอเกินอีก 1 ชิ้น -> ต้องโดนปฏิเสธ
--   begin
--     insert into public.booking_items (booking_id, item_type, item_id, quantity)
--     values (v_booking, 'fixture', v_fixture, 1)
--     on conflict (booking_id, item_type, item_id)
--     do update set quantity = public.booking_items.quantity + 1;
--   exception when others then
--     v_hit := true;
--     raise notice 'ปฏิเสธถูกต้อง: %', sqlerrm;
--   end;
--
--   -- ของที่ยังไม่ระบุจำนวน (accessories ที่ไม่มี stock) -> ต้องจองไม่ได้
--   begin
--     insert into public.booking_items (booking_id, item_type, item_id, quantity)
--     select v_booking, 'accessory', a.id, 1 from public.accessories a
--      where nullif(btrim(coalesce(a.stock, '')), '') is null limit 1;
--   exception when others then
--     raise notice 'ปฏิเสธถูกต้อง (ยังไม่ระบุจำนวน): %', sqlerrm;
--   end;
--
--   delete from public.bookings where id = v_booking;
--
--   if not v_hit then
--     raise exception 'trigger ไม่ทำงาน — จองเกินสต็อกได้ ต้องแก้ก่อนใช้งานจริง';
--   end if;
--   raise notice 'ผ่าน: trigger กันจองเกินทำงานถูกต้อง และลบข้อมูลทดสอบแล้ว';
-- end $$;


-- =============================================================================
-- ย้อนกลับ (ถ้าต้องการถอดระบบจองออกทั้งชุด)
-- =============================================================================
-- drop view if exists public.v_booking_stale;
-- drop view if exists public.v_item_availability;
-- drop table if exists public.booking_items;   -- ลบใบจองทั้งหมดที่อยู่ในตารางนี้ด้วย
-- drop table if exists public.bookings;
-- drop function if exists public.booking_items_guard();
-- drop function if exists public.bookings_guard();
-- drop function if exists public.booking_check_stock(text, bigint, numeric, date, text, uuid, uuid);
-- drop function if exists public.current_member_id();
-- drop function if exists public.item_label(text, bigint);
-- drop function if exists public.item_stock(text, bigint);
-- drop function if exists public.parse_stock_text(text);
-- (set_updated_at() อย่าลบ — fixtures กับ accessories ใช้อยู่)
