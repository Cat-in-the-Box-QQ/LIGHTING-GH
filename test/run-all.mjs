#!/usr/bin/env node
// test/run-all.mjs - รันชุดตรวจทั้งหมดของโปรเจกต์
// ใช้: node test/run-all.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const here = import.meta.dirname;
const suites = [
  ['DOM id wiring (HTML ↔ JS)', 'check-dom-ids.mjs'],
  ['Image references', 'check-images.mjs'],
  ['Data layer + AdminAuth', 'harness.mjs'],
  ['Member admin UI (เรนเดอร์จริงใน DOM ปลอม)', 'check-member-ui.mjs'],
  ['Booking calendar (ปฏิทินจอง — เรนเดอร์จริงใน DOM ปลอม)', 'check-booking-calendar.mjs'],
];

let failed = 0;
for (const [label, file] of suites) {
  console.log(`\n########## ${label} ##########`);
  const r = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(failed
  ? `\nมี ${failed} ชุดตรวจที่ไม่ผ่าน\n`
  : '\nทุกชุดตรวจผ่านหมด\n');
process.exit(failed ? 1 : 0);
