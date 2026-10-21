-- =====================================================================
--  supabase/migration-2026-10-21.sql
--  Migration สำหรับรันใน Supabase Dashboard -> SQL Editor -> Run
--
--  ทำ 3 อย่าง:
--    1. เพิ่มคอลัมน์ battery_wh (ความจุแบตเตอรี่ เป็น Wh)
--    2. แก้ path รูป 30 รายการที่ชี้ไปไฟล์ที่ไม่มีอยู่จริง
--    3. เติม battery_wh จากสเปกที่มีหลักฐานในข้อมูล (9 รายการ)
--
--  รันซ้ำได้ปลอดภัย (idempotent) ทุกคำสั่ง
--  ต้องรัน "หลัง" จาก schema.sql แล้ว
-- =====================================================================


-- ---------------------------------------------------------------
-- ส่วนที่ 1: เพิ่มคอลัมน์ battery_wh
-- ---------------------------------------------------------------
-- power     = วัตต์ที่อุปกรณ์ "กิน"  (ใช้คิดโหลดและกระแสไฟ)
-- battery_wh = ความจุแบตเตอรี่ "Wh"  (ใช้คิดว่าเลี้ยงโหลดได้นานแค่ไหน)
--
-- ไม่รันก็ได้ เว็บยังเดาความจุจาก power_raw / battery ให้เอง
-- แต่จะ "บันทึกค่าที่กรอกผ่านหน้า Admin ไม่ได้" เพราะโค้ดข้ามคอลัมน์ที่ไม่มีอยู่

alter table public.fixtures add column if not exists battery_wh numeric;

comment on column public.fixtures.battery_wh is
  'ความจุแบตเตอรี่เป็น Wh (ไม่ใช่วัตต์ที่กิน) - ใช้คำนวณ runtime ใน Set Builder';


-- ---------------------------------------------------------------
-- ส่วนที่ 2: แก้ path รูปที่ชี้ไปไฟล์ไม่มีอยู่จริง
-- ---------------------------------------------------------------
-- เดิม fixtures 26 จาก 64 รายการ และ accessories 5 จาก 72 รายการ
-- ชี้ไปไฟล์ที่ไม่มีใน repo -> 404 -> เพราะ <img> ใช้ onerror ซ่อนรูป
-- ผู้ใช้จึงเห็นแค่ "บางรูปไม่แสดง" โดยไม่รู้ว่าเพราะอะไร
--
-- 18 รายการแก้ให้ชี้ไฟล์จริง (ตรวจทีละตัวแล้วว่าไฟล์มีอยู่)
-- 7 รายการ LiteGear Litemat ไม่มีรูปใน repo เลย -> ใช้ placeholder.svg
--   (ไม่หารูปอื่นมาแทน และไม่มั่วสเปก)
-- 5 accessories ของ Aladdin อ้าง images/page-014.jpg ที่ไม่มี
--   (ไฟล์สแกนเริ่มที่ page-015) -> ใช้ placeholder.svg

-- ----- fixtures -----
-- id=32 Creamsource Vortex 8
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/Creamsource Vortex 8.jpg' where id = 32;
-- id=33 Digital Sputnik DS1
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/Digital Sputnik DS1.jpg' where id = 33;
-- id=34 Digital Sputnik DS6
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/Digital Sputnik DS6.jpg' where id = 34;
-- id=35 Digital Sputnik Voyager 2FT (60cm)
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/Digital Sputnik Voyager.jpg' where id = 35;
-- id=36 Digital Sputnik Voyager 4FT (120cm)
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/Digital Sputnik Voyager.jpg' where id = 36;
-- id=37 Falcon Eyes RX-818
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/Falcon Eyes RX-818.jpg' where id = 37;
-- id=38 Fiilex Q5 Color
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/Fiilex_ Q5 Color Fresnel_Light .jpg' where id = 38;
-- id=39 LiteGear Litemat Spectrum 1
update public.fixtures set image = 'images/placeholder.svg' where id = 39;
-- id=40 LiteGear Litemat Plus 2
update public.fixtures set image = 'images/placeholder.svg' where id = 40;
-- id=41 LiteGear Litemat Spectrum 2L
update public.fixtures set image = 'images/placeholder.svg' where id = 41;
-- id=42 LiteGear Litemat Plus 2L
update public.fixtures set image = 'images/placeholder.svg' where id = 42;
-- id=43 LiteGear Litemat Spectrum 4
update public.fixtures set image = 'images/placeholder.svg' where id = 43;
-- id=44 LiteGear Litemat Plus 4
update public.fixtures set image = 'images/placeholder.svg' where id = 44;
-- id=45 LiteGear Litemat Plus 8
update public.fixtures set image = 'images/placeholder.svg' where id = 45;
-- id=46 LiteGear LiteDimmer Pro Hybrid
update public.fixtures set image = 'images/NEW PRODUCT/Assetsory/LiteDimmer_ProHybrid_Front_1274.jpg' where id = 46;
-- id=47 Rosco DMG Dash
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/Rosco DMG Dash.jpg' where id = 47;
-- id=48 Other Light Dj Par Led 18X18W
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/Unknow Dj Par Led 18X18W.jpg' where id = 48;
-- id=49 Litepanels Astra Soft Bi-Color LED Panel
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/Litepanels Astra Soft Bi-Color LED Panel.jpg' where id = 49;
-- id=50 ETC Source Four LED Series 2
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/ETC Source Four LED Series 2.jpg' where id = 50;
-- id=51 Kino Flo Kino Flo FreeStyle 21
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/KinoFlo_FreeStyle 21.jpg' where id = 51;
-- id=52 Kino Flo Kino Flo FreeStyle 31
update public.fixtures set image = 'images/NEW PRODUCT/Fixture/KinoFlo_FreeStyle 31.jpg' where id = 52;
-- id=53 Chimera Chimera Panel Lantern
update public.fixtures set image = 'images/NEW PRODUCT/Assetsory/Chimera_Softbox_Accessory_1324.jpg' where id = 53;
-- id=55 Gaffer's Control
update public.fixtures set image = 'images/NEW PRODUCT/Control/Gaffers_Control_Case_1356.jpg' where id = 55;
-- id=56 Kingkong KK 1024
update public.fixtures set image = 'images/NEW PRODUCT/Control/Kingkong KK 1024.jpg' where id = 56;
-- id=58 LumenRadio MoonLite
update public.fixtures set image = 'images/NEW PRODUCT/Control/LumenRadio MoonLite.jpg' where id = 58;

-- ----- accessories -----
-- id=3 200W Dimmer Unit
update public.accessories set image = 'images/placeholder.svg' where id = 3;
-- id=4 Metal Frame
update public.accessories set image = 'images/placeholder.svg' where id = 4;
-- id=5 Diffuser
update public.accessories set image = 'images/placeholder.svg' where id = 5;
-- id=6 2 m Extension Cable
update public.accessories set image = 'images/placeholder.svg' where id = 6;
-- id=7 5 m Extension Cable
update public.accessories set image = 'images/placeholder.svg' where id = 7;



-- ---------------------------------------------------------------
-- ส่วนที่ 3: เติม battery_wh จากสเปกที่มีหลักฐาน
-- ---------------------------------------------------------------
-- เติมเฉพาะที่ "อ่านได้จากข้อมูลที่มีอยู่จริง" เท่านั้น
--เงื่อนไข `and (battery_wh is null or battery_wh = 0)` ทำให้ไม่ทับค่าที่
-- คุณกรอกเองผ่านหน้า Admin ไว้แล้ว
--
-- ที่มาของแต่ละค่า:
--   Astera Ax3/Ax5/Ax9/HydraPanel  -> คำนวณจาก "วัตต์ x ชั่วโมง" ใน power_raw
--                                     เช่น '15 W (20 H.)' = 300 Wh
--   Rosco DMG Dash                 -> '14 W (3 H.)' = 42 Wh
--   Digital Sputnik Voyager 2FT/4FT -> ระบุ '45Wh battery' / '90Wh battery' ไว้ตรงๆ
--   Gaffer's Control GC-28         -> ระบุ 'Li-ion 70Wh built-in battery'
--   EcoFlow DELTA Pro              -> ระบุ '3.6kWh LFP power station' = 3600 Wh
--
-- *** จงใจ "ไม่" เติมให้ 2 รายการนี้ ***
--   id=61 FXLION V-Mount 14.8V
--   id=62 FXLION V-Mount 26V
-- เพราะในข้อมูลมีแค่แรงดัน (V) ไม่มีกระแส (Ah) หรือ Wh จึงคำนวณไม่ได้
-- การเดาจะได้ค่าผิด ให้กรอกเองผ่านหน้า Admin เมื่อทราบสเปกจริง
--
-- *** และจงใจ "ไม่" เติมให้ Avolites Tiger Touch II (id=54)
--     กับ LumenRadio CRMX Nova TX2 RDM (id=60) ***
-- เพราะ power_raw ของมันมี '50-60Hz' / '47-70Hz' ซึ่งเป็น "ความถี่ไฟบ้าน"
-- ไม่ใช่ชั่วโมงใช้งาน ทั้งสองตัวกินไฟ AC ไม่มีแบตเตอรี่
-- (บั๊กในโค้ดรุ่นก่อนเคยอ่าน 60Hz เป็น 60 ชั่วโมง แล้วเดาเป็น 4800 Wh)

-- id=24 Astera Lightdrop Ax3 -> 300 Wh  (15.0W x 20.0h)
update public.fixtures set battery_wh = 300
  where id = 24 and (battery_wh is null or battery_wh = 0);
-- id=25 Astera TriplePAR Ax5 -> 900 Wh  (45.0W x 20.0h)
update public.fixtures set battery_wh = 900
  where id = 25 and (battery_wh is null or battery_wh = 0);
-- id=26 Astera PowerPAR Ax9 -> 1400 Wh  (70.0W x 20.0h)
update public.fixtures set battery_wh = 1400
  where id = 26 and (battery_wh is null or battery_wh = 0);
-- id=27 Astera HydraPanel -> 340 Wh  (17.0W x 20.0h)
update public.fixtures set battery_wh = 340
  where id = 27 and (battery_wh is null or battery_wh = 0);
-- id=35 Digital Sputnik Voyager 2FT (60cm) -> 45 Wh  (Wh: 45Wh battery)
update public.fixtures set battery_wh = 45
  where id = 35 and (battery_wh is null or battery_wh = 0);
-- id=36 Digital Sputnik Voyager 4FT (120cm) -> 90 Wh  (Wh: 90Wh battery)
update public.fixtures set battery_wh = 90
  where id = 36 and (battery_wh is null or battery_wh = 0);
-- id=47 Rosco DMG Dash -> 42 Wh  (14.0W x 3.0h)
update public.fixtures set battery_wh = 42
  where id = 47 and (battery_wh is null or battery_wh = 0);
-- id=55 Gaffer's Control -> 70 Wh  (Wh: Li-ion 70Wh built-in battery)
update public.fixtures set battery_wh = 70
  where id = 55 and (battery_wh is null or battery_wh = 0);
-- id=63 EcoFlow DELTA Pro -> 3600 Wh  (kWh: 3.6kWh LFP power station)
update public.fixtures set battery_wh = 3600
  where id = 63 and (battery_wh is null or battery_wh = 0);

-- ---------------------------------------------------------------
-- ส่วนที่ 4: ตรวจผลหลังรัน
-- ---------------------------------------------------------------

-- 4.1 คอลัมน์ battery_wh มีอยู่หรือยัง (ต้องได้ 1 แถว)
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'fixtures' and column_name = 'battery_wh';

-- 4.2 ยังเหลือ path รูปที่ชี้ไปไฟล์นอก repo ไหม
--     (ตรวจได้แค่รูปแบบ path ที่รู้ว่ามีปัญหา - path ที่ถูกต้องควรขึ้นต้นด้วย
--      'images/NEW PRODUCT/' หรือ 'images/page-' หรือ 'images/placeholder.svg')
select id, brand, model, image
from public.fixtures
where image is not null
  and image !~ '^images/(NEW PRODUCT/|page-|placeholder\.svg)'
order by id;

select id, name, image
from public.accessories
where image is not null
  and image !~ '^images/(NEW PRODUCT/|page-|placeholder\.svg)'
order by id;

-- 4.3 สรุป battery_wh ที่เติมแล้ว
select id, brand, model, battery_wh, power, power_raw
from public.fixtures
where battery_wh is not null
order by battery_wh desc;

-- 4.4 รายการที่เป็นแหล่งจ่ายไฟ แต่ยังไม่มี battery_wh (ต้องกรอกเอง)
select id, brand, model, category, battery, power_raw
from public.fixtures
where (lower(type) = 'power' or lower(category) in ('battery','power station'))
  and (battery_wh is null or battery_wh = 0)
order by id;
