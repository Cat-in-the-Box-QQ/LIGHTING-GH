// search.js - shared helpers for search/filter/sort/type handling

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function getStockCount(item) {
  if (item && Number.isFinite(Number(item.stockCount))) {
    return Number(item.stockCount);
  }
  const match = String(item?.stock || "").match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function inferItemType(item) {
  const explicit = normalizeText(item?.type);
  if (explicit) return explicit;

  const brand = normalizeText(item?.brand);
  const category = normalizeText(item?.category);
  const model = normalizeText(item?.model);

  if (brand === "dmx control" || category.includes("controller") || category.includes("transmitter")) {
    return "controller";
  }
  if (brand === "battery" || category === "battery" || category.includes("power station")) {
    return "power";
  }
  if (category.includes("accessory") || category.includes("lantern") || model.includes("dimmer") || brand === "chimera") {
    return "accessory";
  }
  return "fixture";
}

function itemTypeLabel(item) {
  const type = inferItemType(item);
  if (type === "controller") return "Controller";
  if (type === "power") return "Power";
  if (type === "accessory") return "Accessory";
  return "Fixture";
}

// แยก comma-list เป็น tag ย่อย — แต่ต้อง "ไม่" แยก comma ที่อยู่ข้างในวงเล็บ
// เพราะคำอธิบายในวงเล็บมี comma ได้ เช่น
//   'LED (หัวไฟ, Control Box และสายเคเบิล)'  ต้องเป็น tag เดียว ไม่ใช่สอง
// ค่าที่ไม่มีวงเล็บได้ผลเหมือน .split(',') เดิมทุกประการ
function splitTagParts(value) {
  const s = String(value || "");

  // ถ้าวงเล็บไม่สมดุล (กรอกมือแล้วลืมปิด หรือมีเครื่องหมายเกินมา) ให้ถอยกลับไป
  // แยก comma แบบเดิมทั้งหมด — ดีกว่าปล่อย depth ค้างแล้วกลืน tag ที่เหลือหายทั้งก้อน
  // เช่น 'LED (หัวไฟ, Fresnel' ต้องได้ ['LED (หัวไฟ', 'Fresnel'] ไม่ใช่ tag เดียวยาว
  let depth = 0;
  let balanced = true;
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (depth < 0) { balanced = false; break; }
  }
  if (depth !== 0) balanced = false;

  const out = [];
  let cur = "";
  depth = 0;
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && (depth === 0 || !balanced)) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((item) => item.trim()).filter(Boolean);
}

// escape สำหรับใส่ใน attribute (เช่น title="...")
// จำเป็นเพราะค่าเหล่านี้มาจากผู้ใช้ผ่านหน้า Admin — ถ้ามี " จะพัง attribute
function escapeAttrText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ตัดส่วนขยายในวงเล็บออก เหลือเฉพาะ "หัว tag" สำหรับแสดงบนการ์ดที่พื้นที่แคบ
//   'IP65 (ทั้งหัวไฟ, Control Box และสายเคเบิล)' -> 'IP65'
// รองรับทั้ง ( ) และ [ ] เพราะข้อมูลกรอกมืออาจใช้แบบใดแบบหนึ่ง
function shortTagText(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  const i = s.search(/[(\[]/);
  if (i < 0) return s;              // ไม่มีวงเล็บ -> ใช้ข้อความเดิมทั้งก้อน
  const head = s.slice(0, i).trim();
  return head || s;                 // ขึ้นต้นด้วยวงเล็บเลย -> อย่าให้ badge ว่าง
}

// badge แบบสั้นสำหรับ "การ์ด" — แสดงเฉพาะหัว tag นอกวงเล็บ
// ถ้ามีส่วนขยายในวงเล็บ จะใส่ title ไว้ให้ hover ดูค่าเต็มได้
//   'IP65 (ทั้งหัวไฟ, Control Box และสายเคเบิล)' -> <span ... title="ค่าเต็ม">IP65</span>
function shortBadgeHtml(value, className = 'bg-secondary') {
  const full = String(value ?? '').trim();
  if (!full) return '';
  const label = shortTagText(full);
  // ผูก title กับ "label สั้นกว่าค่าเต็ม" ไม่ใช่กับการหาวงเล็บให้ครบคู่
  // เคสวงเล็บปิดไม่ครบ เช่น 'LED (หัวไฟ, Fresnel' จะถูกตัดเหลือ 'LED'
  // ถ้ารอให้เจอวงเล็บปิดก่อนจึงใส่ title ข้อความส่วนนั้นจะหายถาวรไม่มีทางดูได้เลย
  const title = label === full ? '' : ` title="${escapeAttrText(full)}"`;
  return `<span class="badge ${className}"${title}>${escapeAttrText(label)}</span>`;
}

// หน้ารายละเอียด: คงข้อความ "ทั้งหมด" ไว้ แต่ทำส่วนในวงเล็บให้จางลง
//
// ห้ามประกอบใหม่จาก "หัว tag + วงเล็บแรก" เด็ดขาด เพราะค่าที่มีหลายวงเล็บ
// จะถูกตัดทิ้ง เช่น '62° (Hyper-Reflector) / 93° (No Reflector)'
// จะได้แค่ '62° (Hyper-Reflector)' — หายไปทั้ง '/ 93° (No Reflector)'
// (ค่า beam จริงใน data/fixtures.json มีรูปแบบนี้อยู่ 16 รายการ)
//
// ใช้ <span> จึงซ้อนใน spec-row ที่เป็น <span> ได้โดยไม่ผิด HTML
// คืน '-' เมื่อค่าว่าง เพื่อให้ตรงกับรูปแบบเดิมของ spec-row
function tagDetailHtml(value) {
  const full = String(value ?? '').trim();
  if (!full) return '-';
  const esc = escapeAttrText(full);
  if (!/[(\[]/.test(esc)) return esc;   // ไม่มีวงเล็บ -> คืนค่าเต็มตามเดิม
  return esc.replace(/([(\[][^)\]]*[)\]])/g, '<span class="small text-muted">$1</span>');
}

// opts.short = true  -> แสดงเฉพาะหัว tag (สำหรับการ์ด) พร้อม title ให้ hover ดูค่าเต็ม
// opts.short = false -> แสดงค่าเต็มตามเดิม (สำหรับหน้ารายละเอียด)
function badgesHtmlFromCommaList(value, className = 'bg-dark', opts = {}) {
  return splitTagParts(value)
    .map((tag) => {
      if (!opts.short) return `<span class="badge ${className}">${tag}</span>`;
      return shortBadgeHtml(tag, className);
    })
    .join(' ');
}

function hasCommaTag(value, target) {
  const targetText = normalizeText(target);
  if (!targetText) return true;
  return splitTagParts(value).some((tag) => normalizeText(tag) === targetText);
}

function isHiddenItem(item) {
  return !!item?.hidden;
}

function visibleItems(items, includeHidden = false) {
  return (items || []).filter((item) => includeHidden || !isHiddenItem(item));
}

function getUnitsPerSet(item) {
  if (item && Number.isFinite(Number(item.unitsPerSet)) && Number(item.unitsPerSet) > 1) {
    return Number(item.unitsPerSet);
  }
  const note = String(item?.stockNote || "");
  const match = note.match(/(\d+)\s+sets?\s+of\s+(\d+)/i);
  return match ? Number(match[2]) : null;
}

function hasSetOption(item) {
  return Number(getUnitsPerSet(item)) > 1;
}

function isBuildableItem(item) {
  return inferItemType(item) === "fixture";
}

// ทุกรายการสามารถเพิ่มเข้าชุดได้ ไม่ใช่แค่ Fixture
function isSetAddableItem(item) {
  const type = inferItemType(item);
  return type === "fixture" || type === "controller" || type === "power" || type === "accessory";
}

function hasWireless(item) {
  return !!normalizeText(item?.wireless);
}

function hasCrmx(item) {
  const wireless = normalizeText(item?.wireless);
  return /crmx|lumenradio/.test(wireless);
}

function hasBattery(item) {
  return !!normalizeText(item?.battery);
}

// ==================== แบตเตอรี่ / ความจุ Wh ====================
//
// เดิมรายการที่เป็นแบตเตอรี่เก็บค่าไว้ในฟิลด์ `power` ซึ่งเป็น "วัตต์ที่กิน"
// ทำให้ Set Builder บวกมันเข้าไปเป็นโหลด ทั้งที่แบตเตอรี่เป็น "แหล่งจ่ายไฟ"
// จึงแยกความจุเป็น Wh และห้ามเอาไปรวมกับกำลังไฟที่อุปกรณ์กิน

// รายการที่เป็นแหล่งจ่ายไฟ (ไม่ใช่ตัวกินไฟ)
function isPowerSource(item) {
  const type = normalizeText(item?.type);
  if (type === 'power') return true;
  const category = normalizeText(item?.category);
  if (category === 'battery' || category.includes('power station')) return true;
  const brand = normalizeText(item?.brand);
  if (brand === 'battery') return true;
  return false;
}

// อุปกรณ์ที่มีแบตในตัว (เป็นทั้งตัวกินไฟและแหล่งจ่ายไฟในเวลาเดียวกัน)
function hasBuiltInBattery(item) {
  if (isPowerSource(item)) return false;
  return /built-?in|battery/i.test(normalizeText(item?.battery));
}

// ดึง "ชั่วโมง runtime" จาก powerRaw เช่น '15 W (20 H.)' -> 20
//
// ต้องมี \b ปิดท้ายเสมอ ไม่งั้น '60Hz' (ความถี่ไฟบ้าน) จะถูกอ่านเป็น '60 ชั่วโมง'
// ซึ่งเคยทำให้ Avolites Tiger Touch II ถูกเดาความจุเป็น 4800 Wh (80 W x "60 ชม.")
// ทั้งที่เป็นแค่ DMX console กินไฟ AC — \b ไม่เกิดระหว่าง H กับ z จึง match ไม่ผ่าน
function runtimeHoursFromRaw(item) {
  const raw = String(item?.powerRaw || '');
  const m = raw.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i);
  return m ? Number(m[1]) : null;
}

// ความจุแบตเตอรี่เป็น Wh
// ลำดับความสำคัญ: ค่าที่ระบุไว้ตรง ๆ -> kWh -> คำนวณจาก W x ชั่วโมง -> null
function getBatteryWh(item) {
  if (!item) return null;

  const explicit = Number(item.batteryWh);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const sources = [String(item.battery || ''), String(item.powerRaw || ''), String(item.stockNote || '')];

  // ระบุเป็น kWh เช่น '3.6kWh LFP power station'
  for (const text of sources) {
    const kwh = text.match(/(\d+(?:[.,]\d+)?)\s*kWh/i);
    if (kwh) {
      const value = Number(kwh[1].replace(',', '.'));
      if (Number.isFinite(value) && value > 0) return Math.round(value * 1000);
    }
  }

  // ระบุเป็น Wh ตรง ๆ เช่น '3600Wh capacity' หรือ '99Wh'
  for (const text of sources) {
    const wh = text.match(/(\d+(?:[.,]\d+)?)\s*Wh\b/i);
    if (wh) {
      const value = Number(wh[1].replace(',', '.'));
      if (Number.isFinite(value) && value > 0) return Math.round(value);
    }
  }

  // คำนวณจาก "วัตต์ที่กิน x ชั่วโมงที่ใช้งานได้" เช่น '15 W (20 H.)' -> 300 Wh
  const hours = runtimeHoursFromRaw(item);
  const watts = Number(item.power);
  if (hours && Number.isFinite(watts) && watts > 0) return Math.round(watts * hours);

  return null;
}

// กำลังไฟที่ "กิน" จริง — แหล่งจ่ายไฟไม่นับเป็นโหลด
function getPowerDraw(item) {
  if (isPowerSource(item)) return 0;
  const w = Number(item?.power);
  return Number.isFinite(w) ? w : 0;
}

// ประมาณชั่วโมงที่ใช้งานได้ ถ้าเอาแหล่งจ่ายไฟไปเลี้ยงโหลดที่กิน watts
function estimateRuntimeHours(totalWh, watts) {
  const w = Number(watts);
  const wh = Number(totalWh);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(wh) || wh <= 0) return null;
  return wh / w;
}

function formatWh(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return n >= 1000 ? `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} kWh` : `${Math.round(n)} Wh`;
}

function formatHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n < 1) return `${Math.round(n * 60)} นาที`;
  const h = Math.floor(n);
  const m = Math.round((n - h) * 60);
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}

// ข้อความสำหรับแถว "กำลังไฟ" ในหน้า detail
// แหล่งจ่ายไฟ (แบตเตอรี่ / power station) แสดงเป็นความจุ Wh แทนวัตต์ที่กิน
function powerSpecText(item) {
  if (!item) return '-';
  const wh = getBatteryWh(item);

  if (isPowerSource(item)) {
    const raw = String(item.powerRaw || '').trim();
    return wh ? `${formatWh(wh)}${raw ? ` · ${raw}` : ''}` : (raw || 'ไม่ระบุความจุ (Wh)');
  }

  const base = String(item.powerRaw || '').trim()
    || (item.power != null ? `${item.power} W` : '-');
  // อุปกรณ์ที่มีแบตในตัว บอกความจุต่อท้ายเพื่อให้ประเมิน runtime ได้
  return wh && hasBuiltInBattery(item) ? `${base} · แบต ${formatWh(wh)}` : base;
}

// ข้อความสั้นสำหรับการ์ดในหน้ารายการ
function powerCardText(item) {
  if (!item) return '-';
  if (isPowerSource(item)) {
    const wh = getBatteryWh(item);
    return wh ? formatWh(wh) : 'ไม่ระบุ Wh';
  }
  return item.power != null ? `${item.power} W` : '-';
}

// กระแสที่ 220V — แหล่งจ่ายไฟไม่ใช่โหลด จึงไม่คำนวณให้
function currentAt220(item) {
  if (!item || isPowerSource(item)) return '-';
  const watts = getPowerDraw(item);
  return watts > 0 ? (watts / 220).toFixed(2) : '-';
}

function isRgbFixture(item) {
  const color = normalizeText(item?.color);
  return /(rgb|rgbw|rgbww|rgba|rgbaw|rgbma|rgblaw|rgbacl|rgbwa\+uv|rgb\+mint\+amber|full-rgb)/i.test(color);
}

function isBiColorFixture(item) {
  return /bi-?color/i.test(normalizeText(item?.color));
}

function colorTagStyleOf(item) {
  const explicit = normalizeText(item?.colorTagStyle);
  if (explicit === 'rainbow' || explicit === 'black') return explicit;
  return isRgbFixture(item) ? 'rainbow' : 'black';
}

function colorTagClass(item) {
  return colorTagStyleOf(item) === 'rainbow' ? 'badge-rgb' : 'bg-dark';
}

function filterFixtures(fixtures, filters) {
  return fixtures.filter((f) => {
    if (!filters?.includeHidden && isHiddenItem(f)) return false;
    const accessoryText = Array.isArray(f.accessories) ? f.accessories.join(' ') : '';
    const hay = [
      f.id,
      f.brand,
      f.model,
      f.category,
      f.type,
      f.color,
      f.whiteLight,
      f.wireless,
      f.ip,
      f.stock,
      f.dimensions,
      f.battery,
      f.compatibleText,
      accessoryText
    ].join(" ").toLowerCase();

    if (filters.q && !hay.includes(normalizeText(filters.q))) return false;
    if (filters.brand && f.brand !== filters.brand) return false;
    if (filters.category && f.category !== filters.category) return false;
    if (filters.type && inferItemType(f) !== filters.type) return false;
    // เทียบด้วย "หัว tag" นอกวงเล็บ เพื่อให้ 'IP65' กับ 'IP65 (ทั้งหัวไฟ...)' จัดเป็นกลุ่มเดียวกัน
    // ข้อมูลเดิมที่ไม่มีวงเล็บ shortTagText() คืนค่าเท่าเดิมทุกประการ จึงไม่กระทบของเก่า
    if (filters.ip && shortTagText(f.ip) !== shortTagText(filters.ip)) return false;
    if (filters.wireless === "yes" && !hasWireless(f)) return false;
    if (filters.wireless === "no" && hasWireless(f)) return false;
    if (filters.wireless === "crmx" && !hasCrmx(f)) return false;
    if (filters.color === "rgb" && !isRgbFixture(f)) return false;
    if (filters.color === "bicolor" && !isBiColorFixture(f)) return false;
    if (filters.battery === "yes" && !hasBattery(f)) return false;
    if (filters.inStock === "yes" && getStockCount(f) <= 0) return false;
    if (filters.maxWeight && f.weight != null && f.weight > Number(filters.maxWeight)) return false;
    // ใช้กำลังไฟที่ "กิน" จริง — แหล่งจ่ายไฟไม่ใช่โหลด จึงไม่ควรถูกกรองออกด้วยเกณฑ์นี้
    // (เดิม EcoFlow DELTA Pro ที่ power=3600 โดนกรองทิ้งเมื่อค้น "ไม่เกิน 500W")
    if (filters.maxPower && getPowerDraw(f) > Number(filters.maxPower)) return false;
    return true;
  });
}

function buildAccessoriesCatalog(fixtures, baseAccessories = []) {
  const map = new Map();

  function keyOf(item) {
    return `${normalizeText(item.name || item.model)}__${normalizeText(item.brand)}`;
  }

  baseAccessories.forEach((item) => {
    const copy = JSON.parse(JSON.stringify(item));
    copy.compatibleWith = Array.isArray(copy.compatibleWith) ? copy.compatibleWith.slice() : [];
    map.set(keyOf(copy), copy);
  });

  fixtures.forEach((fixture) => {
    const list = Array.isArray(fixture.accessories) ? fixture.accessories : [];
    list.forEach((name) => {
      const key = `${normalizeText(name)}__${normalizeText(fixture.brand)}`;
      if (!map.has(key)) {
        map.set(key, {
          id: map.size + 1,
          name,
          brand: fixture.brand,
          category: 'Accessory',
          stock: null,
          image: fixture.image || '',
          pdfPage: fixture.pdfPage || null,
          compatibleWith: []
        });
      }
      const entry = map.get(key);
      if (!entry.compatibleWith.includes(fixture.id)) {
        entry.compatibleWith.push(fixture.id);
      }
    });
  });

  return [...map.values()]
    .map((item) => ({ ...item, compatibleWith: (item.compatibleWith || []).sort((a, b) => a - b) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.brand || '').localeCompare(String(b.brand || '')));
}

function sortFixtures(fixtures, sortBy) {
  const arr = [...fixtures];
  switch (sortBy) {
    case "brand_asc":
      arr.sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));
      break;
    case "brand_desc":
      arr.sort((a, b) => b.brand.localeCompare(a.brand) || a.model.localeCompare(b.model));
      break;
    case "model_desc":
      arr.sort((a, b) => b.model.localeCompare(a.model));
      break;
    case "power":
    case "power_asc":
      arr.sort((a, b) => (a.power ?? 0) - (b.power ?? 0) || a.model.localeCompare(b.model));
      break;
    case "power_desc":
      arr.sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || a.model.localeCompare(b.model));
      break;
    case "weight":
    case "weight_asc":
      arr.sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0) || a.model.localeCompare(b.model));
      break;
    case "weight_desc":
      arr.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.model.localeCompare(b.model));
      break;
    case "stock":
    case "stock_desc":
      arr.sort((a, b) => getStockCount(b) - getStockCount(a) || a.model.localeCompare(b.model));
      break;
    case "stock_asc":
      arr.sort((a, b) => getStockCount(a) - getStockCount(b) || a.model.localeCompare(b.model));
      break;
    case "model":
    case "model_asc":
      arr.sort((a, b) => a.model.localeCompare(b.model));
      break;
    default:
      break;
  }
  return arr;
}
