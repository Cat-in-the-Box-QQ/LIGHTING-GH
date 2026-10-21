# การตั้งค่า Supabase สำหรับเว็บ LIGHTING

เว็บนี้เป็น static site ที่เรียก Supabase ตรงจากเบราว์เซอร์ จึงต้องตั้ง 3 อย่างให้ครบ:
**ตาราง → Row Level Security → บัญชี Admin** ถ้าขาดอย่างใดอย่างหนึ่ง เว็บจะถอยกลับไป
ใช้ข้อมูล local (ป้ายสีเหลืองในหน้า admin) ซึ่งทำให้ดูเหมือน "ข้อมูลไม่ซิงก์"

---

## ขั้นที่ 1 — สร้างตาราง + RLS

เปิด Supabase Dashboard → **SQL Editor** → วางเนื้อหาทั้งหมดของ [`schema.sql`](./schema.sql) → **Run**

> **ถ้าสร้างตารางไปก่อนหน้าแล้ว** ให้รัน [`migration-2026-10-21.sql`](./migration-2026-10-21.sql) เพิ่ม
> ไฟล์นี้จะเพิ่มคอลัมน์ `battery_wh`, แก้ path รูป 30 รายการที่ชี้ไปไฟล์ไม่มีอยู่จริง
> และเติมความจุแบตเตอรี่จากสเปกที่มีหลักฐาน — รันซ้ำได้ปลอดภัยเหมือนกัน

สคริปต์รันซ้ำได้ปลอดภัย (ใช้ `IF NOT EXISTS` ทั้งหมด) และจะสร้าง:

| ตาราง | คอลัมน์หลัก |
|---|---|
| `fixtures` | `id`, `brand`, `model`, `category`, `type`, `power`, `power_raw`, `battery_wh`, `weight`, `stock_count`, `accessories` (text[]), `hidden`, `reserved`, `in_use`, `remaining`, ... |
| `accessories` | `id`, `name`, `brand`, `category`, `stock`, `image`, `pdf_page`, `compatible_with` (bigint[]), `hidden` |

> **`power` vs `battery_wh`** — `power` คือวัตต์ที่อุปกรณ์ *กิน* (ใช้คำนวณโหลดและกระแสไฟ)
> ส่วน `battery_wh` คือความจุแบตเตอรี่เป็น Wh (ใช้คำนวณว่าเลี้ยงโหลดได้นานแค่ไหน)
> รายการที่เป็นแบตเตอรี่หรือ power station จะ **ไม่ถูกนับเป็นโหลด** ใน Set Builder
> ถ้า `battery_wh` ว่าง เว็บจะพยายามเดาจาก `power_raw` ให้เอง เช่น
> `15 W (20 H.)` → 300 Wh หรือ `3.6kWh LFP` → 3600 Wh — แต่ถ้าเดาไม่ได้จะเว้นว่างไว้
> **ไม่มั่วสเปก** ให้กรอกผ่านหน้า Admin เอง

พร้อม policy:
- **อ่าน** ได้ทุกคน (รวมผู้เยี่ยมชมที่ยังไม่ login)
- **เขียน** ได้เฉพาะ role `authenticated` (ต้อง login ผ่านหน้า admin ก่อน)

> ถ้าไม่สร้าง policy สำหรับ `authenticated` ไว้ RLS จะบล็อกการบันทึกทั้งหมด
> และหน้าเว็บจะขึ้น "บันทึกไม่สำเร็จ: RLS ใน Supabase ไม่อนุญาตให้เขียนข้อมูล"

---

## ขั้นที่ 2 — สร้างบัญชี Admin

Supabase Dashboard → **Authentication** → **Users** → **Add user** → ใส่อีเมล + รหัสผ่าน
(ติ๊ก *Auto Confirm User* จะได้ไม่ต้องกดยืนยันอีเมล)

ถ้าต้องการจำกัดว่าอีเมลไหนเข้าโหมด Admin ได้บ้าง แก้ที่ `js/supabase-config.js`:

```js
window.SUPABASE_ADMIN_EMAILS = ['boss@company.com'];  // [] = ยอมทุกบัญชีที่ login ผ่าน
```

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
| `SUPABASE_TABLES` | `{fixtures, accessories}` | ชื่อตาราง ถ้าเปลี่ยนชื่อตารางแก้ที่นี่ |
| `SUPABASE_DISABLED` | `false` | `true` = บังคับใช้โหมด local ข้าม Supabase |
| `SUPABASE_ALLOW_LOCAL_FALLBACK` | `true` | `true` = ถ้า Supabase พังให้ถอยกลับมาใช้ local อัตโนมัติ |
| `SUPABASE_ADMIN_EMAILS` | `[]` | รายชื่ออีเมลที่เข้าโหมด Admin ได้ (`[]` = ไม่จำกัด) |

---

## เรื่องความปลอดภัย

- `SUPABASE_ANON_KEY` / publishable key **ไม่ใช่ความลับ** — มันถูกส่งให้เบราว์เซอร์ทุกเครื่องอยู่แล้ว
  ความปลอดภัยจริงอยู่ที่ **RLS policy** (ขั้นที่ 1) ดังนั้นห้ามลบ policy ทิ้ง
- ห้ามใส่ `sb_secret_...` (secret key) ลงในโค้ดฝั่งเว็บเด็ดขาด เพราะใครก็อ่านเห็นได้
- ระบบเดิมมี PIN `1234` ฝังอยู่ในโค้ด ซึ่งใครก็เปิด DevTools อ่านได้ **ถูกถอดออกแล้ว**
  ตอนนี้การเข้าโหมด Admin ต้อง login ผ่าน Supabase Auth เท่านั้น

---

## รันชุดตรวจของโปรเจกต์

```bash
node test/run-all.mjs
```

จะตรวจ 2 เรื่อง:
1. **DOM id wiring** — id ที่ JS เรียกผ่าน `getElementById()` มีอยู่จริงในหน้านั้นหรือไม่
   (นี่คือตัวที่จับบั๊กที่ทำให้หน้า admin พัง)
2. **Data layer + AdminAuth** — จำลอง Supabase ใน Node แล้วทดสอบทั้งโหมด Supabase,
   การถอยกลับมาใช้ local เมื่อตารางหาย/เน็ตหลุด/ตารางว่าง, และการ login
