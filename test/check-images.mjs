// test/check-images.mjs
// ตรวจความสมบูรณ์ของรูปทั้งหมดที่เว็บอ้างอิง
//
// ทำไมต้องมี: มีรูป 26 รายการที่ path ชี้ไปไฟล์ที่ไม่มีอยู่จริง และเพราะ <img>
// เดิมใช้ onerror="this.style.display='none'" รูปที่พังจึง "หายเงียบ ๆ" ไม่มีอะไรบอก
// ผู้ใช้เห็นแค่ "บางรูปไม่แสดง" โดยไม่รู้ว่าเพราะอะไร
//
// ตรวจ 4 เรื่อง:
//   1. path ทุกตัวใน data/*.json ชี้ไปไฟล์ที่มีอยู่จริง
//   2. ตรงแบบ case-sensitive (Vercel/GitHub Pages รันบน Linux ซึ่งแบ่งตัวพิมพ์ใหญ่เล็ก
//      ต่างจาก macOS/Windows — รูปที่เปิดได้บนเครื่อง dev จึงอาจพังบน production)
//   3. path ที่โหมด Supabase จะ "สร้างใหม่" จาก brand+model ก็มีไฟล์รองรับ
//   4. ขนาดพิกเซล/น้ำหนักไฟล์ ไม่เกินเพดานที่มือถือถอดรหัสได้สบาย
//
// รันด้วย: node test/check-images.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// เพดานที่ปลอดภัยสำหรับมือถือ — iOS Safari ถอดรหัสรูปใหญ่ได้แต่กินแรมมาก
// และอาจไม่แสดงเลยถ้าใหญ่มาก รูปสแกนแคตตาล็อกในโปรเจกต์นี้อยู่ที่ ~2-3 MP
const MAX_MEGAPIXELS = 12;
const MAX_BYTES = 3 * 1024 * 1024;   // 3 MB

// อ่านขนาดพิกเซลจาก header ของ JPEG/PNG ตรง ๆ (ไม่ต้องพึ่ง ImageMagick)
function imageSize(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }

  // PNG: IHDR อยู่ offset 16 (width) และ 20 (height)
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: กวาดหา marker SOFn
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0-SOF15 ยกเว้น DHT(C4) JPG(C8) DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return null;   // SVG หรืออ่านไม่ได้
}

function existsExact(p) {
  return fs.existsSync(path.join(ROOT, p)) && fs.statSync(path.join(ROOT, p)).isFile();
}

// หาไฟล์ที่ชื่อตรงแบบไม่สนตัวพิมพ์ — ใช้แยก "case ผิด" ออกจาก "ไฟล์ไม่มี"
function findCaseMismatch(p) {
  const abs = path.join(ROOT, p);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  if (!fs.existsSync(dir)) return null;
  const real = fs.readdirSync(dir).find((f) => f.toLowerCase() === base.toLowerCase());
  return real ? path.relative(ROOT, path.join(dir, real)) : null;
}

function decode(p) {
  try { return decodeURIComponent(String(p || '')); } catch { return String(p || ''); }
}

// จำลอง newFixtureImagePath + resolveFixtureImage ใน js/database.js
// โหมด Supabase จะสร้าง path ใหม่เมื่อ path เดิมว่าง / เป็น images/products/ / images/page-
const NEW_IMAGE_DIR = 'images/NEW PRODUCT/Fixture/';
function generatedPath(item) {
  const brand = String(item.brand || '').trim();
  const model = String(item.model || '').trim();
  if (!model) return '';
  const name = brand && !model.toLowerCase().startsWith(brand.toLowerCase())
    ? `${brand} ${model}`
    : model;
  return NEW_IMAGE_DIR + name + '.jpg';
}
function supabaseWouldRegenerate(item) {
  const raw = String(item.image || '').trim();
  return !raw || /^\/?images\/products\//i.test(raw) || /^\/?images\/page-/i.test(raw);
}

const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/fixtures.json'), 'utf8'));
const accessories = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/accessories.json'), 'utf8'));

const missing = [];
const caseMismatch = [];
const regeneratedMissing = [];
const oversized = [];
let checked = 0;

function audit(label, item, rawPath) {
  const p = decode(rawPath).replace(/^\/+/, '');
  if (!p) { missing.push(`${label}: path ว่าง`); return; }
  checked++;

  if (existsExact(p)) {
    const abs = path.join(ROOT, p);
    const bytes = fs.statSync(abs).size;
    const dim = imageSize(abs);
    if (bytes > MAX_BYTES) {
      oversized.push(`${label}: ${(bytes / 1024 / 1024).toFixed(1)} MB — ${p}`);
    } else if (dim) {
      const mp = (dim.width * dim.height) / 1e6;
      if (mp > MAX_MEGAPIXELS) {
        oversized.push(`${label}: ${dim.width}x${dim.height} (${mp.toFixed(1)} MP) — ${p}`);
      }
    }
  } else {
    const alt = findCaseMismatch(p);
    if (alt) caseMismatch.push(`${label}: อ้าง "${path.basename(p)}" แต่ไฟล์จริงคือ "${path.basename(alt)}"`);
    else missing.push(`${label}: ไม่พบไฟล์ ${p}`);
  }
}

for (const f of fixtures) {
  const label = `fixture id=${f.id} ${f.brand || ''} ${f.model || ''}`.trim();
  audit(label, f, f.image);

  // โหมด Supabase จะทิ้ง path เดิมแล้วสร้างใหม่จาก brand+model — ต้องมีไฟล์รองรับด้วย
  // ไม่งั้นพอเชื่อม Supabase สำเร็จ รูปที่เคยขึ้นจะหาย
  if (supabaseWouldRegenerate(f)) {
    const gen = generatedPath(f);
    if (gen && !existsExact(gen)) {
      regeneratedMissing.push(`${label}: โหมด Supabase จะสร้าง path "${gen}" แต่ไม่มีไฟล์นี้`);
    }
  }
}

for (const a of accessories) {
  audit(`accessory id=${a.id} ${a.name || ''}`.trim(), a, a.image);
}

console.log('');
console.log(`ตรวจ path รูปไป ${checked} รายการ (fixtures ${fixtures.length} + accessories ${accessories.length})`);

let failures = 0;

function report(title, list, hint) {
  if (!list.length) { console.log(`  ✓ ${title}`); return; }
  failures += list.length;
  console.log(`  ✗ ${title} — ${list.length} รายการ`);
  list.slice(0, 30).forEach((x) => console.log(`      ${x}`));
  if (list.length > 30) console.log(`      ... อีก ${list.length - 30} รายการ`);
  if (hint) console.log(`      → ${hint}`);
}

console.log('');
report(
  'ทุก path ชี้ไปไฟล์ที่มีอยู่จริง',
  missing,
  'แก้ data/*.json ให้ชี้ไปไฟล์จริง หรือใส่ images/placeholder.svg'
);
report(
  'ชื่อไฟล์ตรงตัวพิมพ์เล็ก/ใหญ่ (สำคัญเพราะ Vercel รันบน Linux)',
  caseMismatch,
  'เครื่อง dev (macOS/Windows) ไม่แบ่งตัวพิมพ์ ทำให้รูปขึ้นแต่พังบน production'
);
report(
  'path ที่โหมด Supabase สร้างจาก brand+model มีไฟล์รองรับ',
  regeneratedMissing,
  'ถ้าปล่อยไว้ พอเชื่อม Supabase สำเร็จรูปจะหาย — ใส่ path เต็มในฟิลด์ image ให้ชัด'
);
report(
  `ขนาดรูปไม่เกิน ${MAX_MEGAPIXELS} MP / ${MAX_BYTES / 1024 / 1024} MB (มือถือถอดรหัสไหว)`,
  oversized,
  'ย่อรูปลง หรือแยกเป็น thumbnail สำหรับหน้ารายการ'
);

console.log('');
if (failures) {
  console.log(`สรุป: พบปัญหา ${failures} จุด\n`);
  process.exit(1);
}
console.log('สรุป: รูปทั้งหมดอ้างอิงถูกต้อง\n');
