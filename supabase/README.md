# การตั้งค่า Supabase สำหรับเว็บ LIGHTING

เว็บนี้เป็น static site ที่เรียก Supabase ตรงจากเบราว์เซอร์ จึงต้องตั้ง 3 อย่างให้ครบ:
**ตาราง → Row Level Security → บัญชี Admin** ถ้าขาดอย่างใดอย่างหนึ่ง เว็บจะถอยกลับไป
ใช้ข้อมูล local (ป้ายสีเหลืองในหน้า admin) ซึ่งทำให้ดูเหมือน "ข้อมูลไม่ซิงก์"

---

## ⚠️ อ่านก่อน — ลำดับการตั้งค่าเปลี่ยนแล้ว

สิทธิ์แก้ไขข้อมูล **ไม่ได้ผูกกับ "login ผ่าน" อีกต่อไป** แต่ผูกกับ `role = 'admin'`
ในตาราง `public.members`

ถ้ารัน SQL โดยยังไม่กำหนด admin **คุณจะเข้าหน้า admin ไม่ได้** จึงต้องทำตามลำดับนี้:

1. สร้างบัญชีใน **Authentication → Users → Add user** (ติ๊ก *Auto Confirm User*)
2. ตรวจว่า `v_admin_email` ในไฟล์ SQL ตรงกับบัญชีนั้น
   — ตอนนี้เติมไว้ให้แล้วเป็น `zombe.jpm@gmail.com` ถ้าใช้อีเมลอื่นให้แก้ก่อน
3. ค่อยกด **Run**

สคริปต์จะ `raise exception` และถูก rollback ทั้งไฟล์ ถ้าอีเมลยังเป็น placeholder
หรือยังไม่มีบัญชีนั้นใน Authentication — ไม่มีอะไรค้างครึ่งทาง
แก้แล้วรันใหม่ได้ทันที (สคริปต์เป็น idempotent)

---

## ขั้นที่ 1 — สร้างตาราง + RLS

เปิด Supabase Dashboard → **SQL Editor** → วางเนื้อหาทั้งหมดของ [`schema.sql`](./schema.sql)
→ **ตรวจ `v_admin_email` ในบล็อก "เพิ่ม admin คนแรก"** (เติมไว้ให้แล้วเป็น `zombe.jpm@gmail.com`)
→ **Run**

> **ถ้าสร้างตารางไปก่อนหน้าแล้ว** ให้รันไฟล์ migration เพิ่มตามลำดับ
>
> 1. [`migration-2026-10-21.sql`](./migration-2026-10-21.sql) — เพิ่มคอลัมน์ `battery_wh`,
>    แก้ path รูป 30 รายการที่ชี้ไปไฟล์ไม่มีอยู่จริง
>    และเติมความจุแบตเตอรี่จากสเปกที่มีหลักฐาน
> 2. [`migration-2026-10-22-members.sql`](./migration-2026-10-22-members.sql) — **ตัวนี้สำคัญ**
>    สร้างตาราง `members` + ฟังก์ชัน `is_admin()` แล้วสลับสิทธิ์เขียนจาก
>    "ทุกคนที่ login" เป็น "เฉพาะ role admin"
>    ขั้นที่ 3 เติม `v_admin_email` ไว้ให้แล้วเป็น `zombe.jpm@gmail.com` — ตรวจว่าตรงก่อนรัน
> 3. [`migration-2026-11-13-member-admin.sql`](./migration-2026-11-13-member-admin.sql) —
>    ทำให้**จัดการทีมงานได้จากหน้า admin** ไม่ต้องรัน SQL ทีละคน
>    เพิ่มคอลัมน์ `email`, trigger สร้างแถว `members` ให้อัตโนมัติเมื่อมีบัญชีใหม่,
>    backfill บัญชีเดิม และ trigger กันลดสิทธิ์ admin คนสุดท้าย
> 4. [`migration-2026-11-13b-no-approval.sql`](./migration-2026-11-13b-no-approval.sql) —
>    **ถอดขั้นอนุมัติออก** บัญชีใหม่เป็น `crew` + `active=true` ใช้งานได้ทันที
>    พร้อมบันทึกว่าต้องปิด `disable_signup` ใน Dashboard (SQL ตั้งให้ไม่ได้)
>    และคำเตือนเรื่อง **ห้าม** `update members set active = true` ทั้งตาราง
> 5. [`migration-2026-11-13c-bookings.sql`](./migration-2026-11-13c-bookings.sql) —
>    **ระบบจองอุปกรณ์** สร้างตาราง `bookings` + `booking_items`, trigger กันจองเกินสต็อก
>    (ใช้ `pg_advisory_xact_lock` กันสองคนกดจองชิ้นสุดท้ายพร้อมกัน), RLS 8 policy,
>    view `v_item_availability` (ยอดติดจอง/เหลือ) และ `v_booking_stale` (ของเลยวันยังไม่คืน)
>    ไฟล์นี้**ไม่ได้**ถูกรวมใน `schema.sql` — ติดตั้งใหม่ต้องรันต่อจาก `schema.sql` เสมอ
>
> ทั้งห้าไฟล์รันซ้ำได้ปลอดภัยเหมือนกัน ต้องรันตามลำดับเพราะขั้นหลังอ้างอิงของขั้นก่อน
>
> **รันไปแล้วบนโปรเจกต์จริง:** ข้อ 1–5 รันครบและตรวจซ้ำด้วย `SELECT` แล้ว
> (`handle_new_auth_user()` ตอนนี้ insert `active = true` · ตารางจอง + trigger + view ติดครบ
> และทดสอบแล้วว่าปฏิเสธการจองเกินสต็อกจริง) — ไฟล์ทั้งห้ายังเก็บไว้เพื่อให้
> ติดตั้งซ้ำที่อื่นได้ และเพื่อให้ repo กับฐานข้อมูลจริงตรงกัน

สคริปต์รันซ้ำได้ปลอดภัย (ใช้ `IF NOT EXISTS` ทั้งหมด) และจะสร้าง:

| ตาราง | คอลัมน์หลัก |
|---|---|
| `fixtures` | `id`, `brand`, `model`, `category`, `type`, `power`, `power_raw`, `battery_wh`, `weight`, `stock_count`, `accessories` (text[]), `hidden`, `reserved`, `in_use`, `remaining`, ... |
| `accessories` | `id`, `name`, `brand`, `category`, `stock`, `image`, `pdf_page`, `compatible_with` (bigint[]), `hidden` |
| `members` | `id` (uuid), `auth_uid`, `code` (รหัสประจำตัว), `full_name`, `email`, `phone`, `role` (`admin`/`crew`), `active`, `note` |
| `bookings` | `id` (uuid), `member_id` → `members`, `job_name`, `job_location`, `booking_date` (date), `status` (`reserved`/`checked_out`/`overdue`/`cancelled`), `group_ref`, `note`, `created_by` → `auth.users` |
| `booking_items` | `id` (uuid), `booking_id` → `bookings` (cascade), `item_type` (`fixture`/`accessory`), `item_id` (bigint), `quantity`, `returned_quantity`, `note` · unique (`booking_id`, `item_type`, `item_id`) |

และ view (อ่านอย่างเดียว ใช้โชว์ยอดบนการ์ดอุปกรณ์และหน้า Inventory)

| view | หน้าที่ | ใครอ่านได้ |
|---|---|---|
| `v_item_availability` | `stock` / `booked` / `available` / `out_count` / `stock_unknown` ต่อหนึ่งรายการ | ทุกคน (รวม `anon`) — เป็นยอดรวม ไม่มีชื่อคนจอง |
| `v_booking_stale` | ใบจองที่เลยวันแล้วยังไม่ถูกปักว่าค้างคืน = ของน่าจะยังไม่ได้กลับคลัง | เฉพาะ `admin` (กรองด้วย `is_admin()` ใน where) |

พร้อมฟังก์ชันและ trigger (ทั้งหมดเป็น `security definer` + `set search_path` ยกเว้นตัวออกรหัส):

| ตัว | หน้าที่ |
|---|---|
| `is_admin()` | policy ทุกตัวใช้ตัดสินสิทธิ์เขียนข้อมูล |
| `members_fill_code()` | ออกรหัสประจำตัว `M001`, `M002`, … ให้อัตโนมัติถ้าไม่ได้ระบุ `code` |
| `handle_new_auth_user()` | สร้างแถว `members` ให้เองเมื่อมีบัญชีใหม่ (`crew` + `active=true` ใช้งานได้ทันที ไม่มีขั้นอนุมัติ) |
| `protect_last_admin()` | ปฏิเสธการลดสิทธิ์/ปิดใช้งาน admin คนสุดท้าย กันล็อกออกถาวร |
| `set_updated_at()` | เติม `updated_at` ให้ `fixtures` / `accessories` / `bookings` |
| `parse_stock_text()` | แกะตัวเลขจากข้อความสต็อก เช่น `"10 Pieces"` → `10` (accessories เก็บเป็น text) |
| `item_stock()` | สต็อกของหนึ่งรายการ — คืน `null` เมื่อ "ยังไม่ระบุจำนวน" ซึ่งแปลว่า**จองไม่ได้** |
| `item_label()` | ชื่อรายการสำหรับประกอบข้อความ error ให้คนอ่านรู้เรื่อง |
| `current_member_id()` | `members.id` ของคนที่กำลังเรียก — policy RLS ใช้เทียบว่าเป็นใบจองของตัวเอง |
| `booking_check_stock()` | หัวใจของระบบ: ล็อกรายชิ้นแล้วนับยอดจอง **ปฏิเสธถ้าเกินของที่มี** |
| `bookings_guard()` | trigger: เติม `created_by`/`member_id`, crew จองแทนคนอื่นหรือตั้งสถานะข้ามขั้นไม่ได้, ตรวจสต็อกใหม่เมื่อย้ายวัน |
| `booking_items_guard()` | trigger: กันจองเกิน + crew แก้ `returned_quantity` ไม่ได้ |

> **`power` vs `battery_wh`** — `power` คือวัตต์ที่อุปกรณ์ *กิน* (ใช้คำนวณโหลดและกระแสไฟ)
> ส่วน `battery_wh` คือความจุแบตเตอรี่เป็น Wh (ใช้คำนวณว่าเลี้ยงโหลดได้นานแค่ไหน)
> รายการที่เป็นแบตเตอรี่หรือ power station จะ **ไม่ถูกนับเป็นโหลด** ใน Set Builder
> ถ้า `battery_wh` ว่าง เว็บจะพยายามเดาจาก `power_raw` ให้เอง เช่น
> `15 W (20 H.)` → 300 Wh หรือ `3.6kWh LFP` → 3600 Wh — แต่ถ้าเดาไม่ได้จะเว้นว่างไว้
> **ไม่มั่วสเปก** ให้กรอกผ่านหน้า Admin เอง

พร้อม policy:
- **อ่าน** `fixtures` / `accessories` ได้ทุกคน (รวมผู้เยี่ยมชมที่ยังไม่ login)
- **เขียน** `fixtures` / `accessories` ได้เฉพาะ `members.role = 'admin'`
- **อ่าน** `members` ได้เฉพาะแถวของตัวเอง (admin อ่านได้ทุกคน)
- **เขียน** `members` ได้เฉพาะ admin
- **อ่าน** `bookings` / `booking_items` ได้เฉพาะใบจองของตัวเอง (admin อ่านได้ทุกคน)
- **สร้าง/แก้** `bookings` ได้ทุกคนที่ login และเป็นบัญชีที่ยังเปิดใช้งาน
  แต่ `booking_items` เพิ่ม/แก้ได้เฉพาะตอนใบจองยัง `reserved`
- **ลบ** ใบจองได้เฉพาะ admin (เว็บไม่มีปุ่มลบ — ใช้ "ยกเลิก" แทน)

### ระบบจองทำงานยังไง

```
1 ใบจอง (bookings)  =  ชื่องาน + ชื่อคนจอง + วันที่ใช้งาน 1 วัน + สถานะ
        └── หลายรายการ (booking_items)  =  (ชนิดของ, id, จำนวน, จำนวนที่คืนแล้ว)
```

| กติกา | ผลในฐานข้อมูล |
|---|---|
| จองได้ **วันเดียว** ต่อใบจอง | `booking_date` เป็น `date` — พ้นวันนั้นไม่นับว่าติดจองแล้ว จึง**คืนคลังอัตโนมัติโดยไม่ต้องใช้ cron** |
| **ห้ามจองเกินของที่มี** | trigger `booking_items_guard` เรียก `booking_check_stock()` ซึ่งล็อกด้วย `pg_advisory_xact_lock` แล้วนับยอดจองของวันนั้น → เกินคือ `raise exception` |
| ของที่ยัง**ไม่ระบุจำนวน** จองไม่ได้ | `item_stock()` คืน `null` → trigger ปฏิเสธพร้อมข้อความ "ยังไม่ระบุจำนวนในสต็อก" (ตอนนี้ accessories 70 จาก 72 รายการ) |
| **ของไม่กลับคลังจริง** | ระบบคืนอัตโนมัติมองไม่เห็นกรณีนี้ จึงมีสถานะ `overdue` ให้ admin ปัก → จะถูกนับว่าติดจอง**ทุกวัน**จนกว่าจะแก้ และโผล่ใน `v_booking_stale` |
| crew **จองแทนคนอื่นไม่ได้** | `bookings_guard()` เขียนทับ `member_id` เป็นบัญชีของตัวเองเสมอ และตั้งสถานะได้แค่ `reserved`/`cancelled` |
| crew **แก้จำนวนที่คืนแล้วไม่ได้** | `booking_items_guard()` ปฏิเสธ — เพราะแก้เลขนี้คือปลดสต็อกให้ตัวเองโดยไม่ต้องคืนของจริง |
| **ห้ามแก้คอลัมน์ `stock`** | ยอดจองถูกคำนวณจาก `booking_items` ทุกครั้ง (แหล่งความจริงแหล่งเดียว) — `fixtures.reserved` / `in_use` / `remaining` ของเดิมเป็นค่ากรอกมือและเลิกใช้แล้ว |

> 🛡️ **trigger คือกำแพงจริง ไม่ใช่ JavaScript** — เว็บเช็คจำนวนให้ก่อนเพื่อความสวยงาม
> แต่ต่อให้ใครยิง `POST` ข้ามเว็บ หรือแก้ JS ในเบราว์เซอร์ ก็ยังติด trigger อยู่ดี
> และเพราะล็อกแบบ `pg_advisory_xact_lock` สองคนที่กดจองชิ้นสุดท้ายพร้อมกันจะ**เรียงคิว**
> คนที่สองจึงเห็นยอดที่คนแรกจองไปแล้ว (ไม่ล็อก = ทั้งคู่ผ่านแล้วได้ของเกินสต็อก)

> ถ้าไม่สร้าง policy เขียนไว้ RLS จะบล็อกการบันทึกทั้งหมด
> และหน้าเว็บจะขึ้น "บันทึกไม่สำเร็จ: RLS ใน Supabase ไม่อนุญาตให้เขียนข้อมูล"

> **นี่คือตัวตัดสินสิทธิ์จริง** — โค้ดฝั่งเว็บ (`js/admin-auth.js`) คุมแค่ว่าจะแสดงปุ่มแก้ไขหรือไม่
> ต่อให้ใครแก้ JavaScript ในเบราว์เซอร์ให้ `isUnlocked()` คืน `true` ก็ยังบันทึกไม่ผ่าน RLS อยู่ดี

---

## ขั้นที่ 2 — สร้างบัญชี + กำหนดสิทธิ์

**ตัวคุณเอง (admin)** — ทำในขั้นที่ 1 ไปแล้วผ่านบล็อก "เพิ่ม admin คนแรก"

ตรวจว่าสำเร็จ: รัน
```sql
select m.code, m.full_name, m.role, m.active, u.email
from public.members m left join auth.users u on u.id = m.auth_uid;
```

**ทีมงาน — ทำผ่านหน้าเว็บได้เลย ไม่ต้องรัน SQL** (ต้องรัน `migration-2026-11-13-member-admin.sql` ก่อน)

1. Supabase → **Authentication → Users → Add user** → ใส่อีเมล + รหัสผ่าน (ติ๊ก *Auto Confirm User*)
   — *ขั้นนี้ทำในเว็บไม่ได้ เพราะ publishable key ไม่มีสิทธิ์จัดการ Authentication*
   — *ปิดการสมัครเองไว้แล้ว (`disable_signup = true`) จึงมีเฉพาะ admin ที่สร้างบัญชีทางนี้ได้*
2. เปิด `admin.html` → section **ทีมงานและสิทธิ์** → แถวใหม่โผล่เองเป็นสิทธิ์ `crew`
   และ**ใช้งานได้ทันทีโดยไม่ต้องกดอนุมัติ**
   (trigger `on_auth_user_created` สร้างแถวให้ และ trigger เดิมออกรหัส `M001`, `M002`… ให้ด้วย)
3. เจ้าของบัญชี login ด้วยอีเมล/รหัสผ่านที่ตั้งไว้ได้เลย — เห็นเฉพาะบัญชีของตัวเอง + ปุ่มจอง
4. ถ้าต้องการให้แก้ข้อมูลได้ → admin กด **แก้ไข** ที่แถวนั้น → ตั้งรหัสประจำตัว / ชื่อ / เบอร์
   → เลือกสิทธิ์เป็น **admin** → บันทึก

การนำคนออกให้กด **ปิดใช้งาน** (ไม่มีปุ่มลบ) — กดคืนได้ทันทีและยังเหลือประวัติ

> **อย่าให้ทีมงานเป็น `admin`** — role `admin` แก้/ซ่อน/ลบอุปกรณ์ได้ทั้งร้าน
> ให้เป็น `admin` เฉพาะคนที่ดูแลข้อมูลจริง
>
> ระบบจะ**ปฏิเสธ**การลดสิทธิ์หรือปิดใช้งาน admin คนสุดท้าย
> (trigger `protect_last_admin`) กันไม่ให้ทุกคนถูกล็อกออกถาวร

<details>
<summary>ทางสำรอง: เพิ่มผ่าน SQL (กรณีเข้าหน้า admin ไม่ได้)</summary>

```sql
insert into public.members (auth_uid, email, code, full_name, phone, role, active)
select u.id,
       u.email,
       'TK01',                          -- รหัสประจำตัว (เว้น '' ได้ ระบบจะออกรหัสให้อัตโนมัติ)
       'ชื่อ นามสกุล',                   -- ชื่อที่แสดงบนเว็บ
       null,                            -- เบอร์โทร (ไม่บังคับ)
       'crew',                          -- crew = จองได้อย่างเดียว
       true
from auth.users u
where lower(u.email) = lower('someone@company.com');   -- อีเมลของทีม
```
</details>

### `SUPABASE_ADMIN_EMAILS` ใน `js/supabase-config.js`

```js
window.SUPABASE_ADMIN_EMAILS = [];   // ปกติเว้นว่างไว้แบบนี้
```

ตอนนี้รายการนี้**ไม่ได้ใช้ตัดสินสิทธิ์**แล้ว เป็นแค่ทางออกฉุกเฉินช่วงเปลี่ยนผ่าน:
จะมีผลเฉพาะเมื่อเว็บ**อ่านตาราง `members` ไม่ได้เลย** (เช่น deploy โค้ดใหม่ไปแล้ว
แต่ยังไม่ได้รัน SQL) ช่วยไม่ให้เจ้าของเว็บเข้าหน้า admin ไม่ได้ในช่วงรอยต่อ
ถ้าอ่านตาราง `members` ได้ คำตอบจากตารางเท่านั้นที่เป็นจริง

> ⚠️ **ของเดิม `[]` แปลว่า "ยอมทุกบัญชีที่ login ผ่าน"** ซึ่งเป็นอันตราย
> ตอนนี้ `[]` แปลว่า "ไม่เปิดทางออกฉุกเฉิน" ซึ่งถูกต้องแล้ว

---

## ขั้นที่ 3 — เติมข้อมูลเข้าตาราง

เลือกได้ 2 ทาง:

**ทางที่ 1 (แนะนำ) — ผ่านหน้า admin**
1. เปิด `admin.html`
2. ถ้าแผง "การเชื่อมต่อ Supabase" ขึ้นป้ายสีเหลือง **โหมด local (fallback)** และรายงานว่าตารางว่าง
   ให้กดปุ่ม **Import ข้อมูล local ขึ้น Supabase**
3. ระบบจะอ่าน `data/fixtures.json` (64 รายการ) และ `data/accessories.json` (72 รายการ)
   แล้ว upsert ขึ้นตาราง
4. กด **ตรวจซ้ำ** — ป้ายควรเปลี่ยนเป็นสีเขียว **เชื่อมต่อ Supabase แล้ว**

**ทางที่ 2 — ผ่าน SQL Editor / Table Editor** โดย import CSV เอง

---

## ตรวจว่าใช้งานได้แล้วหรือยัง

เปิด `admin.html` แล้วดูแผง **การเชื่อมต่อ Supabase** ด้านบนสุดของหน้า:

| ค่าที่แสดง | ความหมาย |
|---|---|
| ป้ายเขียว `เชื่อมต่อ Supabase แล้ว` | ข้อมูลวิ่งจากฐานข้อมูลกลาง แก้แล้วซิงก์ทุกเครื่อง |
| ป้ายเหลือง `โหมด local (fallback)` | Supabase ใช้ไม่ได้ชั่วคราว ข้อมูลถูกเก็บในเครื่องนี้ก่อน |
| `ตาราง fixtures: ว่างเปล่า` | ยังไม่ได้ import ข้อมูล หรือ RLS ปิดกั้นแถวทั้งหมด |
| `ตาราง fixtures: เข้าไม่ได้` | ตารางยังไม่ถูกสร้าง หรือ URL/key ผิด |
| `โหลด supabase-js จาก CDN: ไม่ผ่าน` | เน็ตหลุด หรือ CDN ถูกบล็อก |

ปุ่ม **ตรวจซ้ำ** จะโหลดข้อมูลและรายงานใหม่โดยไม่ต้องรีเฟรชหน้า

---

## ค่าที่ตั้งได้ใน `js/supabase-config.js`

| ตัวแปร | ค่าเริ่มต้น | หน้าที่ |
|---|---|---|
| `SUPABASE_URL` | `https://bizbhhzmrtntbszqhzyr.supabase.co` | URL ของ project |
| `SUPABASE_ANON_KEY` | `sb_publishable_...` | publishable key (ใช้กับเบราว์เซอร์ได้ปลอดภัย) |
| `SUPABASE_TABLES` | `{fixtures, accessories, members, bookings, bookingItems, itemAvailability}` | ชื่อตาราง/view ถ้าเปลี่ยนชื่อแก้ที่นี่ |
| `SUPABASE_DISABLED` | `false` | `true` = บังคับใช้โหมด local ข้าม Supabase |
| `SUPABASE_ALLOW_LOCAL_FALLBACK` | `true` | `true` = ถ้า Supabase พังให้ถอยกลับมาใช้ local อัตโนมัติ |
| `SUPABASE_ADMIN_EMAILS` | `[]` | ทางออกฉุกเฉิน ใช้**เฉพาะ**ตอนอ่านตาราง `members` ไม่ได้ — ตัวตัดสินสิทธิ์จริงคือ `members.role` |

---

## เรื่องความปลอดภัย

- `SUPABASE_ANON_KEY` / publishable key **ไม่ใช่ความลับ** — มันถูกส่งให้เบราว์เซอร์ทุกเครื่องอยู่แล้ว
  ความปลอดภัยจริงอยู่ที่ **RLS policy** (ขั้นที่ 1) ดังนั้นห้ามลบ policy ทิ้ง
- ห้ามใส่ `sb_secret_...` (secret key) ลงในโค้ดฝั่งเว็บเด็ดขาด เพราะใครก็อ่านเห็นได้
- ระบบเดิมมี PIN `1234` ฝังอยู่ในโค้ด ซึ่งใครก็เปิด DevTools อ่านได้ **ถูกถอดออกแล้ว**
  ตอนนี้การเข้าโหมด Admin ต้อง login ผ่าน Supabase Auth เท่านั้น
- **"login ผ่าน" ไม่เท่ากับ "เป็น admin"** — สิทธิ์ผูกกับ `members.role` ทั้งใน RLS และฝั่งเว็บ
  ของเดิม policy เขียนเปิดให้ role `authenticated` ทั้งหมด และ `SUPABASE_ADMIN_EMAILS = []`
  แปลว่า "ยอมทุกบัญชี" ถ้าปล่อยไว้แบบนี้ พอสร้างบัญชีให้ทีมงานใช้ระบบจองของ
  ทุกคนจะแก้/ซ่อน/ลบอุปกรณ์ได้ทั้งร้าน
- ถ้าอยากตรวจว่าตอนนี้ใครเขียนข้อมูลได้บ้าง รัน:
  ```sql
  select m.code, m.full_name, m.role, m.active, u.email
  from public.members m left join auth.users u on u.id = m.auth_uid
  where m.role = 'admin' and m.active = true;
  ```
  รายชื่อนี้คือคน**ทั้งหมด**ที่แก้ไขข้อมูลได้ ถ้าว่างเปล่า = ไม่มีใครแก้ได้เลย

---

## รันชุดตรวจของโปรเจกต์

```bash
node test/run-all.mjs
```

จะตรวจ 3 เรื่อง:
1. **DOM id wiring** — id ที่ JS เรียกผ่าน `getElementById()` มีอยู่จริงในหน้านั้นหรือไม่
   (นี่คือตัวที่จับบั๊กที่ทำให้หน้า admin พัง)
2. **Image references** — path รูปทุกใบใน `data/*.json` ชี้ไปไฟล์ที่มีอยู่จริง,
   ชื่อไฟล์ตรงตัวพิมพ์เล็ก/ใหญ่ (Vercel รันบน Linux) และขนาดไม่เกินที่มือถือถอดรหัสไหว
3. **Data layer + AdminAuth** — จำลอง Supabase ใน Node แล้วทดสอบทั้งโหมด Supabase,
   การถอยกลับมาใช้ local เมื่อตารางหาย/เน็ตหลุด/ตารางว่าง, การ login
   และการตัดสินสิทธิ์จากตาราง `members` (admin / crew / ไม่มีแถว / ตารางหาย / ถูกปิดใช้งาน)
