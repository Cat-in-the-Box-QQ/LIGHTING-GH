# 💡 LIGHTING-GH

เว็บคลังอุปกรณ์ไฟ (Lighting inventory) สำหรับทีมถ่ายทำ — ค้นหา กรอง ดูสเปก จัดชุดอุปกรณ์
และติดตามสต็อก เป็น static site ล้วน ไม่มี build step

Deploy บน **Vercel** (production deploy จาก branch `main` อัตโนมัติ)

---

## หน้านี้ทำอะไรได้บ้าง

| หน้า | หน้าที่ |
|---|---|
| `index.html` | Dashboard — สรุปจำนวนอุปกรณ์ แบรนด์ สต็อก และสัดส่วน RGB |
| `equipment.html` | รายการอุปกรณ์ทั้งหมด + ค้นหา/กรอง/เรียง + popup รายละเอียด |
| `fixture.html` | หน้ารายละเอียดอุปกรณ์หนึ่งรายการ พร้อมแหล่งอ้างอิงการตรวจสอบข้อมูล |
| `accessories.html` | คลังอุปกรณ์เสริม |
| `inventory.html` | มุมมองสต็อกแบบกางดู (available / reserved / in use / remaining) |
| `setbuilder.html` | จัดชุดอุปกรณ์ คำนวณกำลังไฟที่กิน น้ำหนัก กระแสไฟฟ้า และความจุแบตเตอรี่ (Wh) + runtime |
| `admin.html` | โหมดผู้ดูแล — เพิ่ม/แก้ไข/ซ่อน/ลบ + แผงสถานะการเชื่อมต่อ Supabase |

---

## ข้อมูลมาจากไหน

ระบบมี 2 โหมด เลือกอัตโนมัติตอนโหลดหน้า:

1. **Supabase** (โหมดหลัก) — อ่าน/เขียนตาราง `fixtures` และ `accessories`
   เป็นข้อมูลกลางที่ใช้ร่วมกันทุกเครื่อง
2. **Local** (fallback) — อ่าน `data/*.json` แล้วเก็บส่วนแก้ไขใน `localStorage`

ถ้า Supabase ใช้ไม่ได้ (ตารางยังไม่ได้สร้าง / เน็ตหลุด / ตารางว่าง / CDN ถูกบล็อก)
เว็บจะถอยกลับมาใช้โหมด local อัตโนมัติเพื่อไม่ให้หน้าขาวเปล่า และจะแสดงป้ายสีเหลือง
บอกสถานะเสมอในหน้า `admin.html`

ดูรายละเอียดการตั้งค่าที่ [`supabase/README.md`](./supabase/README.md)

---

## แบตเตอรี่กับกำลังไฟ

เว็บแยกสองค่านี้จากกันชัดเจน เพราะความหมายต่างกันและเอาไปคำนวณคนละอย่าง:

| ฟิลด์ | หน่วย | ความหมาย | ใช้ทำอะไร |
|---|---|---|---|
| `power` | **W** | กำลังไฟที่อุปกรณ์ **กิน** | รวมเป็นโหลด คิดกระแสไฟ (A) |
| `batteryWh` | **Wh** | ความจุแบตเตอรี่ | คิดว่าเลี้ยงโหลดได้นานแค่ไหน |

รายการที่เป็นแบตเตอรี่หรือ power station (`type = power`, category เป็น
`Battery` / `Power Station`) ถือเป็น **แหล่งจ่ายไฟ ไม่ใช่โหลด** จึงไม่ถูกนับในกำลังไฟรวม
และไม่ถูกกรองด้วยเกณฑ์ "กำลังไฟสูงสุด"

ถ้า `batteryWh` ว่าง ระบบจะพยายามเดาจากข้อความที่มีอยู่:

```
3.6kWh LFP power station                          → 3600 Wh
3600W AC output / 7200W surge / 3600Wh capacity   → 3600 Wh  (จับ Wh ไม่จับ W output)
15 W (20 H.)  + power = 15                        → 300 Wh   (Astera Ax3)
```

**ถ้าเดาไม่ได้จะเว้นว่าง ไม่มั่วสเปก** — เช่น FXLION V-Mount ที่ยังไม่ทราบความจุแน่นอน
ให้กรอกเองผ่านหน้า Admin (มีช่อง "Battery Capacity (Wh)" พร้อมแสดงค่าที่ระบบเดาให้เทียบ)

---

## โครงสร้างโปรเจกต์

```
├── *.html                  หน้าเว็บทั้งหมด
├── css/style.css
├── js/
│   ├── supabase-config.js  ← จุดตั้งค่า Supabase ที่เดียว (URL, key, ชื่อตาราง, allowlist)
│   ├── supabase-client.js  สร้าง client (ห้าม throw — ถ้า throw หน้าจะพังทั้งหน้า)
│   ├── database.js         data layer ของ fixtures (Supabase + local fallback)
│   ├── accessory-store.js  data layer ของ accessories (Supabase + local fallback)
│   ├── admin-auth.js       login ผ่าน Supabase Auth
│   ├── admin.js            หน้า admin
│   ├── search.js           helper ค้นหา/กรอง/เรียง/คำนวณประเภทอุปกรณ์
│   ├── inventory.js        หน้า inventory
│   ├── accessories.js      หน้า accessories
│   ├── app.js              dashboard
│   ├── inline-fixture-editor.js     ฟอร์มแก้ไข fixture (ใช้ซ้ำหลายหน้า)
│   ├── inline-accessory-editor.js   ฟอร์มแก้ไข accessory (ใช้ซ้ำหลายหน้า)
│   ├── verification-store.js        อ่าน metadata การตรวจสอบข้อมูล
│   ├── setbuilder-helper.js         เก็บ "ชุดปัจจุบัน" ใน localStorage
│   └── power.js / weight.js         คำนวณกำลังไฟและน้ำหนัก
├── data/                   ข้อมูลตั้งต้น (JSON) ใช้เป็น fallback และแหล่ง import
├── images/                 รูปภาพอุปกรณ์
├── supabase/
│   ├── schema.sql          สคริปต์สร้างตาราง + RLS policy (รันซ้ำได้ปลอดภัย)
│   └── README.md           คู่มือตั้งค่า Supabase
└── test/                   ชุดตรวจอัตโนมัติ
```

> `data/database.js` เป็นเวอร์ชันเก่าที่เก็บไว้เป็น reference — ไม่มีหน้าไหนโหลดแล้ว
> เพราะตรรกะ Supabase ถูกรวมเข้า `js/database.js` ไปแล้ว

---

## รันในเครื่อง

ไม่ต้อง install อะไร:

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

แล้วเปิด <http://localhost:8080/admin.html>

> ต้องเสิร์ฟผ่าน HTTP server ไม่ใช่เปิดไฟล์ตรง ๆ (`file://`) เพราะโค้ดใช้ `fetch()`
> อ่าน `data/*.json` ซึ่งจะโดน CORS บล็อกถ้าเปิดเป็นไฟล์

---

## ชุดตรวจอัตโนมัติ

```bash
node test/run-all.mjs
```

ตรวจ 2 เรื่อง:

1. **DOM id wiring** (`test/check-dom-ids.mjs`) — id ที่ JavaScript เรียกผ่าน
   `getElementById()` มีอยู่จริงในหน้านั้นหรือไม่
   ตัวนี้เกิดจากบั๊กจริงที่เคยทำให้หน้า admin พัง: `admin.html` ถูกเปลี่ยนเป็นช่อง
   Email + Password แล้ว แต่ `admin.js` ยังเรียกหา `adminPinInput` ที่ไม่มีอยู่
   จึงได้ `null` และโยน `TypeError` ตอนกด submit โดยไม่มีข้อความ error ให้เห็น
2. **Data layer + AdminAuth** (`test/harness.mjs`) — จำลอง Supabase ใน Node
   (ไม่ต้องมีเบราว์เซอร์ ไม่ต้องต่อเน็ต) ครอบคลุม 22 เคส: โหมด Supabase,
   การแปลง snake_case ↔ camelCase, การถอยกลับมาใช้ local เมื่อตารางหาย/เน็ตหลุด/ตารางว่าง,
   และการ login

---

## เข้าโหมด Admin

1. เปิด `admin.html`
2. ดูแผง **การเชื่อมต่อ Supabase** ด้านบนสุดก่อนเสมอ
3. login ด้วยบัญชีที่สร้างไว้ใน Supabase → Authentication → Users
4. เมื่อปลดล็อกแล้ว ปุ่ม **แก้ไข / ซ่อน / ลบ** จะปรากฏใน popup รายละเอียด
   ของหน้า Equipment และ Accessories

ระบบเดิมใช้ PIN `1234` ฝังในโค้ด ซึ่งใครก็เปิด DevTools อ่านได้ — ถอดออกแล้ว
ตอนนี้ต้อง login ผ่าน Supabase Auth เท่านั้น

ถ้าต้องการจำกัดว่าอีเมลไหนเข้าได้บ้าง แก้ที่ `js/supabase-config.js`:

```js
window.SUPABASE_ADMIN_EMAILS = ['boss@company.com'];  // [] = ยอมทุกบัญชีที่ login ผ่าน
```

---

## บันทึกการเปลี่ยนแปลง

ดูที่ [`CHANGELOG.md`](./CHANGELOG.md) และ [`VERIFICATION.md`](./VERIFICATION.md)
(รายการอุปกรณ์ที่ถูกตรวจทานกับสเปกผู้ผลิต พร้อมแหล่งอ้างอิง)

## License

Apache-2.0
