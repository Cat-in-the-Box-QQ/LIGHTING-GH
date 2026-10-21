# CHANGELOG

## 2026-10-21 (รอบสอง) แก้ Supabase เชื่อมไม่ติด + แบตเตอรี่ใช้ความจุ Wh

### 1. แก้บั๊กที่ทำให้ Supabase เชื่อมไม่ติด (เว็บค้างที่โหมด local)

แผงสถานะในหน้า admin รายงานว่า `ตาราง fixtures เข้าไม่ได้` พร้อมข้อความ
`window.sb.from(...).select(...).catch is not a function`

**ต้นเหตุ:** query builder ของ supabase-js v2 เป็นแค่ **PromiseLike** — มี `.then()`
อย่างเดียว **ไม่มี `.catch()` / `.finally()`** แต่โค้ดไปเขียน

```js
window.sb.from(accessoryTableName())
  .select('id,name,compatible_with,compatibleWith')
  .catch(() => null)          // <- ไม่มี method นี้ โยน TypeError ทันที
```

exception ถูกโยนก่อนที่ยิง query ไปยังตาราง `fixtures` จริง ๆ ป้าย "เข้าไม่ได้"
จึงเป็นการวินิจฉัยผิด — ตารางไม่ได้หาย และ RLS ไม่ได้บล็อก

บรรทัดเดียวกันยังมีปัญหาซ้อน: `select()` ระบุคอลัมน์ `compatibleWith` (camelCase)
ซึ่งไม่มีอยู่ในฐานข้อมูล PostgREST จะปฏิเสธอยู่ดี

**แก้:** เพิ่ม helper `safeQuery()` ครอบด้วย try/catch แทนการต่อ `.catch()` ท้าย builder
และเปลี่ยนเป็น `select('*')` ทั้งคู่ เลิกเดาชื่อคอลัมน์ (โค้ดอ่านได้ทั้ง snake_case และ
camelCase อยู่แล้ว) ตาราง `accessories` เป็นแค่ข้อมูลเสริม ถ้าพังจะข้ามโดยไม่ล้มการโหลด fixtures

**ทำไม test เดิมจับไม่ได้:** mock ใน `test/harness.mjs` ใส่ `.catch()` และ `.finally()`
ให้ builder ทำให้ mock *เก่งกว่าของจริง* และปิดบังความไม่เข้ากันไว้ ถอดออกแล้วเพื่อให้
ซื่อตรงกับ supabase-js และเพิ่ม test 3 ตัวกันเกิดซ้ำ: ตรวจว่า mock ไม่มี `.catch()`,
สแกน source ว่าไม่มี `.catch()`/`.finally()` ต่อท้าย `window.sb` chain (ไล่ chain ย้อนกลับ
จริงเพื่อไม่ให้ false positive กับ `fetch().catch()` ซึ่งถูกต้องเพราะ fetch คืน Promise จริง),
และตรวจว่า accessories พังต้องไม่ล้ม fixtures

### 2. แผงสถานะ Supabase แยกเป็นรายตาราง

เดิมป้ายสถานะสะท้อนแค่ตาราง `fixtures` ทำให้กรณีสองตารางต่อติดไม่พร้อมกันอ่านไม่ออก
(เช่น `accessories` เชื่อมผ่านแต่ `fixtures` พัง) ตอนนี้แยกป้าย per-table:
`ผ่านเน็ต · Supabase` / `ตารางว่าง` / `เข้าไม่ได้` / `โหมด local (fallback)`
พร้อมสรุปภาพรวมว่า "ครบทุกตาราง" "ได้บางตาราง" หรือ "ไม่ได้เชื่อมเลย"

### 3. แบตเตอรี่: ใช้ความจุ Wh แทนวัตต์ที่กิน

**ปัญหา:** รายการที่เป็นแบตเตอรี่/power station เก็บค่าไว้ในฟิลด์ `power` ซึ่งเป็นวัตต์ที่กิน
Set Builder จึงบวกมันเข้าไปเป็นโหลด เช่น EcoFlow DELTA Pro (`power=3600.0`)
ถูกนับเป็นอุปกรณ์กินไฟ 3600 W ทั้งที่เป็นตัวจ่ายไฟ — `powerRaw` ของมันเขียนไว้ชัดว่า
`3600W AC output / 7200W surge / 3600Wh capacity`

**เพิ่มฟิลด์ `batteryWh` (คอลัมน์ `battery_wh`)** แยกจากความจุ และเพิ่ม helper ใน `js/search.js`:

| helper | หน้าที่ |
|---|---|
| `isPowerSource(item)` | แยกแหล่งจ่ายไฟ (type=power, category=Battery/Power Station) ออกจากตัวกินไฟ |
| `getPowerDraw(item)` | วัตต์ที่กินจริง — แหล่งจ่ายไฟคืน 0 |
| `getBatteryWh(item)` | ความจุ Wh ตามลำดับ: ค่าที่ระบุไว้ → kWh → Wh ใน `powerRaw` → คำนวณจาก W × ชั่วโมง |
| `hasBuiltInBattery(item)` | ไฟที่มีแบตในตัว (เป็นทั้งตัวกินและแหล่งจ่าย) |
| `estimateRuntimeHours(wh, w)` | ประมาณ runtime |
| `formatWh` / `formatHours` | แสดงผลอ่านง่าย (3600 → `3.6 kWh`, 1.5 → `1 ชม. 30 นาที`) |
| `powerSpecText` / `powerCardText` / `currentAt220` | ข้อความแสดงผล ใช้ซ้ำทุกหน้า |

`getBatteryWh` เดาได้จากข้อมูลที่มีอยู่จริง เช่น
- `3.6kWh LFP power station` → 3600 Wh
- `3600Wh capacity` → 3600 Wh (จับ Wh ไม่จับ W output)
- `15 W (20 H.)` + power 15 → 300 Wh (Astera Ax3)
- `45 W ( 20 H.)` → 900 Wh (Ax5)

**แต่ถ้าเดาไม่ได้จะคืน `null` ไม่มั่วสเปก** — FXLION V-Mount (id 61, 62) ยังไม่รู้ความจุจริง
จึงเว้นว่างให้กรอกผ่านหน้า Admin (สอดคล้องกับที่ CHANGELOG รอบก่อนบันทึกไว้ว่า
"exact Wh / size / weight variant still unresolved")

**Set Builder** (`js/power.js` + `setbuilder.html`):
- `totalPower()` ไม่นับแหล่งจ่ายไฟเป็นโหลด → ชุดที่เคยโชว์ 4100 W ตอนนี้เป็น 500 W
- เพิ่ม `totalBatteryWh()` และ `countPowerSources()`
- กล่องสรุปเพิ่ม 3 แถว: แหล่งจ่ายไฟในชุด / ความจุแบตเตอรี่รวม / เลี้ยงโหลดได้นานประมาณ
  พร้อมหมายเหตุบอกสูตรที่ใช้และเตือนว่ายังไม่หักการสูญเสียของ inverter
- การ์ดรายชิ้นของแหล่งจ่ายไฟโชว์ความจุ Wh แทนวัตต์ และไม่คิดกระแสไฟ (เพราะไม่ใช่โหลด)
- อุปกรณ์ที่มีแบตในตัวโชว์ความจุต่อท้าย เช่น `15 W (20 H.) · แบต 300 Wh`
- ตารางในหน้าพิมพ์ PDF อัปเดตตาม

**หน้า detail** (`equipment.html`, `fixture.html`): แบตเตอรี่เปลี่ยนหัวข้อจาก
"กำลังไฟ"/"Power" เป็น "ความจุแบตเตอรี่"/"Battery Capacity" และไม่คำนวณ Current @ 220V ให้

**ตัวกรอง `maxPower`** ใช้ `getPowerDraw()` — เดิมค้น "ไม่เกิน 500W" จะกรอง DELTA Pro ทิ้ง
เพราะ power=3600 ทั้งที่มันไม่ใช่โหลด

**ฟอร์มแก้ไข** เพิ่มช่อง "Battery Capacity (Wh)" พร้อมโชว์ค่าที่ระบบเดาให้เทียบ

**ฐานข้อมูล:** `supabase/schema.sql` เพิ่มคอลัมน์ `battery_wh numeric`
(สคริปต์ใช้ `add column if not exists` จึงรันซ้ำทับของเดิมได้)

### 4. อื่น ๆ

- แก้ข้อความ warn ที่อ้างชื่อตารางผิด (`describeError` อ้างตาราง fixtures เสมอ
  ทำให้อ่านผิดตอนตาราง accessories พัง)
- test เพิ่มเป็น 41 เคส (เดิม 22)

---

## 2026-10-21 แก้หน้า Admin ที่เข้าไม่ได้ + เชื่อม Supabase ให้ทำงานจริง

### อาการ

กดปุ่ม "เข้าสู่ระบบ Admin" ในหน้า `admin.html` แล้วไม่มีอะไรเกิดขึ้น เข้าโหมด Admin
ไม่ได้เลย จึงแก้ไข / ซ่อน / ลบ / เพิ่มข้อมูลไม่ได้

### ต้นเหตุ (มี 3 ชั้น)

1. **id ใน HTML กับ JS ไม่ตรงกัน (ตัวที่ทำให้พังจริง)**
   `admin.html` ถูกเปลี่ยนเป็นช่อง Email + Password (`adminEmailInput`, `adminPasswordInput`)
   แต่ `js/admin.js` ยังเรียก `getElementById('adminPinInput')` ซึ่งไม่มีอยู่
   → `pinInput` เป็น `null` → `pinInput.value` โยน `TypeError` ทันทีที่ submit
   → ฟอร์มพังเงียบ ๆ ไม่มีข้อความ error ให้ผู้ใช้เห็น
2. **โค้ด Supabase Auth ไม่เคยถูกเรียก**
   `AdminAuth.unlockWithEmail()` มีอยู่แต่ไม่มีไฟล์ไหนเรียกใช้ จึงไม่มีทาง login ผ่าน Supabase ได้
3. **ข้อมูลไม่ได้วิ่งไป Supabase จริง**
   `data/database.js` (เวอร์ชัน Supabase) ไม่ถูกโหลดจากหน้าไหนเลย — ทุกหน้าโหลด
   `js/database.js` ซึ่งเป็นเวอร์ชัน localStorage + `data/*.json` และ `equipment.html` /
   `fixture.html` / `accessories.html` / `setbuilder.html` ไม่มีแม้แต่ `<script>` โหลด
   supabase client ทำให้ข้อความ "ข้อมูลที่บันทึกจะเขียนลงฐานข้อมูลกลาง Supabase"
   ไม่เป็นความจริง (ข้อมูลเก็บในเครื่องนั้นเครื่องเดียว)

### สิ่งที่แก้

- `js/admin.js` — ผูกฟอร์ม login เข้ากับช่อง Email/Password ที่มีอยู่จริง, แสดงเหตุผล
  ที่ login ไม่สำเร็จให้ผู้ใช้เห็น, เพิ่มแผง "การเชื่อมต่อ Supabase" พร้อมปุ่มตรวจซ้ำ
  และปุ่ม Import ข้อมูล local ขึ้น Supabase
- `js/admin-auth.js` — login ผ่าน Supabase Auth เท่านั้น (ถอด PIN `1234` ที่ฝังในโค้ดออก
  เพราะใครก็เปิด DevTools อ่านได้), กู้ session เดิมอัตโนมัติตอนเปิดหน้า,
  แปล error ดิบเป็นข้อความไทยที่แก้ตามได้, รองรับ allowlist อีเมล admin
- `js/database.js` — รวมเป็น data layer เดียว ใช้ Supabase เป็นหลัก และถอยกลับมาใช้
  `data/*.json` + localStorage อัตโนมัติเมื่อ Supabase ใช้ไม่ได้ (ตารางหาย / เน็ตหลุด /
  ตารางว่าง / CDN ถูกบล็อก) เว็บจึงไม่ขาวเปล่า และ `DB.status()` บอกเสมอว่ารันโหมดไหน
- `js/accessory-store.js` — ทำแบบเดียวกันกับตาราง `accessories`
- `js/supabase-client.js` — ห้าม throw เด็ดขาด (ของเดิม throw ถ้าโหลด lib ไม่สำเร็จ
  ซึ่งทำให้ `<script>` ตัวถัดไปไม่ทำงานทั้งหน้า) และรายงานสถานะไว้ใน `window.SB_DIAG`
- `js/supabase-config.js` — รวมค่าที่ตั้งได้ไว้ที่เดียว (URL, key, ชื่อตาราง, allowlist,
  สวิตช์ปิด/เปิด fallback)
- เพิ่ม `<script>` โหลด supabase-config / supabase-client ให้ `equipment.html`,
  `fixture.html`, `accessories.html`, `setbuilder.html` (เดิมมีแค่ index / inventory / admin)
- แก้ทุกจุดที่เขียนข้อมูลโดยไม่ `await` — `inline-fixture-editor.js`,
  `inline-accessory-editor.js`, `equipment.html`, `fixture.html`, `js/accessories.js`,
  `js/admin.js` (จำเป็นเพราะโหมด Supabase เป็น async ทั้งหมด ถ้าไม่ await จะบันทึกไม่สำเร็จ)
- error จากการบันทึกถูกโชว์ให้ผู้ใช้เห็นแทนที่จะเงียบหาย พร้อมแยกสาเหตุ
  (เน็ตหลุด / RLS บล็อก / ตารางหรือคอลัมน์ไม่ครบ)
- `supabase/schema.sql` (ใหม่) — สคริปต์สร้างตาราง `fixtures` + `accessories` และ RLS policy
  รันซ้ำได้ปลอดภัย
- `supabase/README.md` (ใหม่) — คู่มือตั้งค่า 3 ขั้น + ตารางอ่านค่าแผงสถานะ
- `test/` (ใหม่) — `check-dom-ids.mjs` ตรวจ id ระหว่าง HTML ↔ JS อัตโนมัติ
  (กันบั๊กต้นเหตุเกิดซ้ำ), `harness.mjs` จำลอง Supabase ใน Node ทดสอบ 22 เคส,
  `run-all.mjs` รันทั้งหมด

### ย้ายไฟล์

- ตรรกะ Supabase เดิมใน `data/database.js` ถูกรวมเข้า `js/database.js` แล้ว
  (`data/database.js` ยังเก็บไว้เป็น reference แต่ไม่มีหน้าไหนโหลด —
  ตัวตรวจจะเตือนเรื่องนี้เป็น orphan)

- Generated verified database files on 2026-07-09
- Total fixtures: 63
- Verified: 24
- Partially verified: 15
- Pending manual verification: 24

## Major corrected records

- **Aladdin Bi-Flex 1** (partially_verified)
  - `accessories`: `None` → `['200W Dimmer Unit', 'Metal Frame', 'Diffuser', '2 m Extension Cable', '5 m Extension Cable']`
  - `color`: `None` → `Bi-Color`
  - `ip`: `IP 32` → `IP32`
  - `stockCount`: `None` → `4`
  - `type`: `None` → `fixture`
  - `whiteLight`: `2,850 - 6,098 k` → `2,850 - 6,098K`
- **Aladdin Bi-Flex 2** (partially_verified)
  - `accessories`: `None` → `['200W Dimmer Unit', 'Metal Frame', 'Diffuser', '2 m Extension Cable', '5 m Extension Cable']`
  - `color`: `None` → `Bi-Color`
  - `ip`: `IP 32` → `IP32`
  - `stockCount`: `None` → `4`
  - `type`: `None` → `fixture`
  - `whiteLight`: `2,850 - 6,098 k` → `2,850 - 6,098K`
- **Aladdin Bi-Flex 4** (partially_verified)
  - `accessories`: `None` → `['200W Dimmer Unit', 'Metal Frame', 'Diffuser', '2 m Extension Cable', '5 m Extension Cable']`
  - `color`: `None` → `Bi-Color`
  - `ip`: `IP 32` → `IP32`
  - `powerRaw`: `48-12 VDC <200 W >` → `12-48 VDC <200 W>`
  - `stockCount`: `None` → `4`
  - `type`: `None` → `fixture`
- **Aputure MC** (pending)
  - `accessories`: `None` → `[]`
  - `battery`: `3.7 V (2,600 mAh)` → `Built-in battery`
  - `color`: `None` → `RGBWW`
  - `setCountInStock`: `None` → `7`
  - `stock`: `7 Set of 4` → `28 Pieces (7 sets of 4)`
  - `stockCount`: `None` → `28`
- **Aputure MC Pro** (verified)
  - `accessories`: `None` → `['Bubble Diffuser', 'Dome Diffuser', 'Flat Diffuser', '30° Grid']`
  - `battery`: `3.7 V (4,200 mAh)` → `Built-in battery`
  - `color`: `None` → `RGBWW`
  - `ip`: `IP 65` → `IP65`
  - `setCountInStock`: `None` → `2`
  - `stock`: `2 Set of 8` → `16 Pieces (2 sets of 8)`
- **Aputure Accent B7C** (verified)
  - `accessories`: `None` → `[]`
  - `battery`: `3.7 V (1,300 mAh)` → `7.4V 1300mAh built-in battery`
  - `category`: `Pocket Light` → `Bulb`
  - `color`: `None` → `RGBWW`
  - `setCountInStock`: `None` → `3`
  - `stock`: `3 set of 8` → `24 Pieces (3 sets of 8)`
- **Aputure Light Storm 60X** (verified)
  - `accessories`: `None` → `['Spotlight Mini Zoom', 'Dual NP-F Battery Plate', 'D-Tap Power Cable']`
  - `beam`: `15°- 45°` → `15° - 45°`
  - `color`: `None` → `Bi-Color`
  - `stockCount`: `None` → `4`
  - `type`: `None` → `fixture`
  - `whiteLight`: `2,700 - 6,500 k` → `2,700 - 6,500K`
- **Aputure Light Storm 300X** (verified)
  - `accessories`: `None` → `['Fresnel 2X', 'Barn Doors', '5-Pin Head Cable']`
  - `beam`: `93°` → `62° (Hyper-Reflector) / 93° (No Reflector)`
  - `color`: `None` → `Bi-Color`
  - `ip`: `IP 54` → `IP54`
  - `stockCount`: `None` → `5`
  - `type`: `None` → `fixture`
- **Aputure Light Storm 600X Pro** (verified)
  - `accessories`: `None` → `['Hyper Reflector', 'Spotlight Max', '5-Pin Weatherproof Head Cable']`
  - `beam`: `93°` → `62° (Hyper-Reflector) / 93° (No Reflector)`
  - `color`: `None` → `Bi-Color`
  - `ip`: `IP 54` → `IP54`
  - `stockCount`: `None` → `2`
  - `type`: `None` → `fixture`
- **Aputure Light Storm 600C Pro** (verified)
  - `accessories`: `None` → `['Hyper Reflector', 'BM1215 Hyper Reflector (Narrow)', 'Rolling Carrying Case']`
  - `beam`: `93°` → `62° (Hyper-Reflector) / 93° (No Reflector)`
  - `ip`: `IP 54` → `IP54`
  - `stockCount`: `None` → `17`
  - `type`: `None` → `fixture`
  - `weight`: `11.0` → `11.07`
- **Aputure Light Storm 1200D Pro** (verified)
  - `accessories`: `None` → `['Hyper Reflector 45°', 'Hyper Reflector 30°', 'Hyper Reflector 15°']`
  - `beam`: `66°` → `45° / 30° / 15° (Hyper-Reflector) / 66° (No Reflector)`
  - `color`: `None` → `Daylight`
  - `ip`: `IP 54` → `IP54`
  - `stockCount`: `None` → `2`
  - `type`: `None` → `fixture`
- **Aputure Storm 80C** (verified)
  - `accessories`: `None` → `['CF4 Fresnel', 'CF4 Barn Doors', 'Bowens Mount Adapter']`
  - `beam`: `None` → `35° (Reflector)`
  - `color`: `None` → `BLAIR-CG`
  - `ip`: `IP 65` → `IP65`
  - `powerRaw`: `100 W` → `100 W input / 80 W output`
  - `stockCount`: `None` → `3`
- **Aputure Storm 1200X** (verified)
  - `accessories`: `None` → `['CF12 Fresnel', 'CF12 Barn Doors', 'Reflector Kit']`
  - `beam`: `66°` → `45° / 30° / 15° (Hyper-Reflector) / 66° (No Reflector)`
  - `color`: `None` → `Bi-Color`
  - `ip`: `IP 65` → `IP65`
  - `power`: `1550.0` → `1450.0`
  - `powerRaw`: `1,550 W` → `1450 W input / 1200 W output`
- **Aputure Electro Storm XT 26** (verified)
  - `accessories`: `None` → `['Standard Reflector', 'Motorized F14 Fresnel', 'Barn Doors']`
  - `beam`: `62°` → `50° / 35° / 20° (Reflector) / 62° (No Reflector)`
  - `color`: `None` → `Bi-Color`
  - `ip`: `IP 65` → `IP65`
  - `stockCount`: `None` → `5`
  - `type`: `None` → `fixture`
- **Aputure Amaran F21C** (partially_verified)
  - `accessories`: `None` → `['Softbox', 'Control Grid']`
  - `color`: `None` → `RGBWW`
  - `stockCount`: `None` → `5`
  - `type`: `None` → `fixture`
  - `whiteLight`: `2,500 - 7,500 k` → `2,500 - 7,500K`
- **Aputure Amaran F22C** (partially_verified)
  - `accessories`: `None` → `['Softbox', 'Control Grid']`
  - `color`: `None` → `RGBWW`
  - `stockCount`: `None` → `8`
  - `type`: `None` → `fixture`
  - `whiteLight`: `2,500 - 7,500 k` → `2,500 - 7,500K`
- **ARRI SkyPanel S30-C** (verified)
  - `accessories`: `None` → `['Standard Diffusion Panel', 'SkyLink Receiver']`
  - `brand`: `Arri` → `ARRI`
  - `power`: `None` → `200.0`
  - `powerRaw`: `48 VDC` → `48 VDC <200 W Maximum>`
  - `stockCount`: `None` → `22`
  - `type`: `None` → `fixture`
- **ARRI SkyPanel S60-C** (verified)
  - `accessories`: `None` → `['Standard Diffusion Panel', 'SkyLink Receiver']`
  - `brand`: `Arri` → `ARRI`

## 2026-07-10 Battery / Power / Controller verification batch 1

- **Avolites Tiger Touch II** (`id: 54`)
  - `brand`: `DMX Control` → `Avolites`
  - `model`: `Avolite Tiger Touch 2` → `Tiger Touch II`
  - `power`: `None` → `80.0`
  - `weight`: `None` → `15.2`
  - `dimensions`: `None` → `674 x 435 x 147 mm`
- **Gaffer's Control GC-28** (`id: 55`)
  - `brand`: `DMX Control` → `Gaffer's Control`
  - `model`: `Gaffer Control` → `GC-28`
  - `power`: `None` → `15.0`
  - `battery`: `None` → `Li-ion 70Wh built-in battery`
  - `weight`: `None` → `2.725`
- **LumenRadio CRMX Nova TX2 RDM** (`id: 60`)
  - `brand`: `DMX Control` → `LumenRadio`
  - `model`: `TX2` → `CRMX Nova TX2 RDM`
  - `power`: `None` → `12.0`
  - `weight`: `None` → `0.9`
  - `dimensions`: `None` → `220 x 44 x 160 mm`
- **EcoFlow DELTA Pro** (`id: 63`)
  - `brand`: `Battery` → `EcoFlow`
  - `model`: `Battery EcoFlow Delta Pro` → `DELTA Pro`
  - `power`: `None` → `3600.0`
  - `weight`: `None` → `45.0`
  - `wireless`: `None` → `Wi‑Fi / Bluetooth`

- Remaining pending items in this group still need exact manufacturer/model confirmation:
  - `id 56` Kingkong KK 1024
  - `id 57` iPad 11 Pro (generation/variant not specified)
  - `id 58` Moonlite (generation unclear)
  - `id 59` Aurora (weight/power still needs exact official reference)
  - `id 61-62` generic V-Mount entries need manufacturer/capacity-specific references

## 2026-07-10 Battery / Power / Controller verification batch 2

- **Kingkong KK 1024** (`id: 56`)
  - `brand`: `DMX Control` → `Kingkong`
  - `model`: `Kingkong KK 1024` → `KK 1024`
  - `powerRaw`: `None` → `AC 90-240V / 50-60Hz`
  - `weight`: `None` → `9.53`
  - `dimensions`: `None` → `485 x 420 x 105 mm`
  - status → `partially_verified` (manual-level source)
- **LumenRadio MoonLite** (`id: 58`)
  - `brand`: `DMX Control` → `LumenRadio`
  - `model`: `Moonlite` → `MoonLite`
  - `battery`: `None` → `Built-in rechargeable battery (10h CRMX RX / 20h Bluetooth Smart mode)`
  - `wireless`: `LumenRadio CRMX` → `LumenRadio CRMX / W-DMX / Bluetooth 5.0 / RDM`
  - `weight`: `None` → `0.14`
  - `dimensions`: `None` → `100 x 50 x 26 mm`
  - status → `partially_verified`
- **LumenRadio Aurora** (`id: 59`)
  - `brand`: `DMX Control` → `LumenRadio`
  - `powerRaw`: `None` → `DC 10-20V / AC 100-240VAC`
  - `wireless`: `LumenRadio CRMX` → `LumenRadio CRMX / W-DMX / Wi‑Fi / Bluetooth 5.0 / RDM / Art-Net / sACN`
  - `dimensions`: `None` → `200 x 140 x 44 mm`
  - status → `partially_verified`
- **FXLION V-Mount entries** (`id: 61-62`)
  - `brand`: `Battery` → `FXLION`
  - status → `partially_verified`
  - note: exact Wh / size / weight variant still unresolved within FXLION family pages

- Still pending in this group:
  - `id 57` Apple iPad Pro 11-inch generation/weight exact variant not yet confirmed

- Clarified user-provided confirmations: `MoonLite` = original model (not MoonLite2), and `V-Mount 26V` remains 26V under FXLION family.

## 2026-07-13 SkyPanel battery-mode clarification

- **SkyPanel S30-C** (`id: 17`)
  - `battery`: `None` → `Battery mode 23-36V DC (26V compatible) via battery adapter; 100% output in battery mode`
- **SkyPanel S60-C** (`id: 18`)
  - `battery`: `None` → `Battery mode 23-36V DC (26V compatible) via battery adapter; 50% output in battery mode`
- **SkyPanel S120-C** (`id: 19`)
  - `battery`: `None` → `Battery mode 23-36V DC (26V compatible) via battery adapter; 50% output in battery mode`
- **SkyPanel S360-C** (`id: 20`)
  - `battery`: `None` → `Battery mode not supported`

- Refined SkyPanel battery wording to preserve normal lamphead input voltage (48V/54V DC) while separately describing battery-adapter mode and reduced output where applicable.

