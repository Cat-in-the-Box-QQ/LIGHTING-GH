// test/check-dom-ids.mjs
// ตรวจว่า id ที่โค้ด JavaScript เรียกผ่าน getElementById() มีอยู่จริงในหน้านั้น ๆ
//
// ทำไมต้องมี: บั๊กที่ทำให้หน้า admin พังคือ admin.html เปลี่ยนช่อง login เป็น
// id "adminEmailInput"/"adminPasswordInput" แล้ว แต่ admin.js ยังเรียก
// getElementById('adminPinInput') ซึ่งไม่มีอยู่ -> ได้ null -> โยน TypeError
// ตอนกด submit และพังเงียบ ๆ ไม่มีอะไรบอกผู้ใช้
//
// รันด้วย: node test/check-dom-ids.mjs

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ดึงรายการ <script src="..."> ที่เป็นไฟล์ local (ข้าม CDN)
function localScripts(html) {
  const out = [];
  const re = /<script[^>]+src=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (/^(https?:)?\/\//i.test(src)) continue;   // ข้าม CDN
    out.push(src.replace(/^\.\//, ''));
  }
  return out;
}

// ดึง script ที่ฝังใน HTML (ข้าม cloudflare beacon / challenge platform)
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)(?![^>]*type=["']module["'])[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    if (!body.trim()) continue;
    if (body.includes('cdn-cgi') || body.includes('__CF$cv')) continue;
    out.push(body);
  }
  return out;
}

// id ที่ "ประกาศ" ไว้ — ทั้งใน markup จริงและใน template string ที่ JS สร้างขึ้นทีหลัง
function declaredIds(source) {
  const ids = new Set();
  // id="foo" / id='foo'
  let re = /\bid=["']([^"'{}]+)["']/g;
  let m;
  while ((m = re.exec(source))) ids.add(m[1].trim());
  // id="${...}" แบบมี prefix คงที่ เช่น id="${formId}-cancel" -> จับส่วนท้ายไว้ด้วย
  re = /\bid=["']([^"']*)\$\{[^"']*["']/g;
  while ((m = re.exec(source))) {
    const parts = m[1].split(/[^A-Za-z0-9_-]+/).filter(Boolean);
    parts.forEach((p) => ids.add(`*${p}`));   // marker: suffix แบบ dynamic
  }
  return ids;
}

// id ที่ "ถูกเรียกใช้" ผ่าน getElementById
function referencedIds(jsSource) {
  const ids = new Set();
  const re = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(jsSource))) ids.add(m[1]);
  return ids;
}

function matches(declared, id) {
  if (declared.has(id)) return true;
  // id dynamic เช่น `${formId}-cancel` -> โค้ดเรียก 'adminFixtureCreateForm-cancel'
  for (const marker of declared) {
    if (!marker.startsWith('*')) continue;
    const suffix = marker.slice(1);
    if (suffix && id.endsWith(suffix)) return true;
  }
  return false;
}

const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
let failures = 0;
let checked = 0;

console.log('');
for (const page of pages.sort()) {
  const html = read(page);
  const scripts = localScripts(html);
  const inline = inlineScripts(html);

  const declared = declaredIds(html);
  const jsSources = [];
  for (const s of scripts) {
    if (!fs.existsSync(path.join(ROOT, s))) {
      console.log(`  !! ${page}: อ้างไฟล์ที่ไม่มีอยู่ -> ${s}`);
      failures++;
      continue;
    }
    const code = read(s);
    declaredIds(code).forEach((x) => declared.add(x));
    jsSources.push({ name: s, code });
  }
  inline.forEach((code, i) => {
    declaredIds(code).forEach((x) => declared.add(x));
    jsSources.push({ name: `${page} (inline #${i})`, code });
  });

  const missing = [];
  for (const { name, code } of jsSources) {
    for (const id of referencedIds(code)) {
      checked++;
      if (!matches(declared, id)) missing.push({ file: name, id });
    }
  }

  if (missing.length) {
    failures += missing.length;
    console.log(`  ✗ ${page}`);
    for (const { file, id } of missing) {
      console.log(`      ${file} เรียก getElementById('${id}') แต่ไม่มี id นี้ในหน้า`);
    }
  } else {
    console.log(`  ✓ ${page}  (${scripts.length} ไฟล์ JS, id ถูกเรียก ${jsSources.reduce((n, s) => n + referencedIds(s.code).size, 0)} ตัว)`);
  }
}

// เช็กเพิ่ม: ไฟล์ js/*.js ทุกตัวต้องถูกโหลดจากอย่างน้อยหนึ่งหน้า
// (กันกรณีแบบ data/database.js ที่เขียนไว้แต่ไม่มีหน้าไหนโหลดเลย)
const jsFiles = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js'));
const loadedAnywhere = new Set();
for (const page of pages) localScripts(read(page)).forEach((s) => loadedAnywhere.add(s.replace(/^js\//, '')));
const orphans = jsFiles.filter((f) => !loadedAnywhere.has(f));

console.log('');
if (orphans.length) {
  console.log(`  ⚠ ไฟล์ใน js/ ที่ไม่มีหน้าไหนโหลดเลย: ${orphans.join(', ')}`);
  console.log('    (ถ้าตั้งใจเก็บไว้เป็น reference ให้ข้ามได้ แต่ถ้าควรใช้งานแปลว่า wiring หาย)');
} else {
  console.log('  ✓ js/ ทุกไฟล์ถูกโหลดจากอย่างน้อยหนึ่งหน้า');
}

console.log('');
try {
  assert.strictEqual(failures, 0, `พบ id ที่ไม่ตรงกัน ${failures} จุด`);
  console.log(`สรุป: ตรวจ id ไป ${checked} จุด — ผ่านหมด\n`);
} catch (err) {
  console.log(`สรุป: ${err.message}\n`);
  process.exit(1);
}
