// database.js - Fixtures loaded from Supabase (table: fixtures)
// รูปเก็บใน GitHub: ใน Supabase เก็บ path สัมพัทธ์ เช่น
//   images/NEW PRODUCT/Fixture/Aladdin Bi-Flex 1.jpg
// แล้วให้โค้ดต่อ IMAGE_BASE ให้ตอนแสดงผล

// ===== ตั้งค่าตรงนี้ที่เดียว =====
// repo เป็น private: ให้เว็บโหลดรูปจากที่เดียวกับตัวเว็บ (path สัมพัทธ์) จึงเว้นว่างไว้
// ต้องอัปโหลดโฟลเดอร์ images/NEW PRODUCT/Fixture/ ไปไว้ที่เดียวกับไฟล์เว็บ (index.html)
const IMAGE_BASE = '';

// โฟลเดอร์รูปแบบใหม่ของ Fixture
const NEW_IMAGE_DIR = 'images/NEW PRODUCT/Fixture/';
const NEW_IMAGE_EXT = '.jpg';

// สร้าง path รูปใหม่จาก brand + model เช่น "Aladdin Bi-Flex 1" -> images/NEW PRODUCT/Fixture/Aladdin Bi-Flex 1.jpg
// ถ้า model ขึ้นต้นด้วยชื่อ brand อยู่แล้ว (เช่น Kino Flo FreeStyle 21) จะไม่ต่อ brand ซ้ำ
function newFixtureImagePath(item) {
  const brand = String(item.brand || '').trim();
  const model = String(item.model || '').trim();
  if (!model) return '';
  const name = brand && !model.toLowerCase().startsWith(brand.toLowerCase())
    ? `${brand} ${model}`
    : model;
  return NEW_IMAGE_DIR + name + NEW_IMAGE_EXT;
}

const FIXTURE_TABLE = 'fixtures';

// [ชื่อฟิลด์ในเว็บ, ชื่อคอลัมน์ใน Supabase] ตรงกับ fixtures_rows.csv
// คอลัมน์ที่ไม่มีในตารางจริงจะถูกข้ามอัตโนมัติ (เช่น color_tag_style ถ้ายังไม่ได้เพิ่ม)
const FIXTURE_FIELDS = [
  ['brand', 'brand'],
  ['model', 'model'],
  ['category', 'category'],
  ['type', 'type'],
  ['power', 'power'],
  ['powerRaw', 'power_raw'],
  ['weight', 'weight'],
  ['weightRaw', 'weight_raw'],
  ['lux', 'lux'],
  ['lumens', 'lumens'],
  ['beam', 'beam'],
  ['wireless', 'wireless'],
  ['whiteLight', 'white_light'],
  ['color', 'color'],
  ['colorTagStyle', 'color_tag_style'],
  ['ip', 'ip'],
  ['battery', 'battery'],
  ['stock', 'stock'],
  ['stockCount', 'stock_count'],
  ['stockNote', 'stock_note'],
  ['unitsPerSet', 'units_per_set'],
  ['setCountInStock', 'set_count_in_stock'],
  ['dimensions', 'dimensions'],
  ['image', 'image'],
  ['pdfPage', 'pdf_page'],
  ['accessories', 'accessories'],
  ['compatibleText', 'compatible_text'],
  ['hidden', 'hidden'],
  ['reserved', 'reserved'],
  ['inUse', 'in_use'],
  ['remaining', 'remaining'],
];

const FIXTURE_NUMERIC = ['power', 'weight', 'lumens', 'stockCount', 'unitsPerSet', 'setCountInStock', 'pdfPage', 'reserved', 'inUse', 'remaining'];

// แปลง path ใน Supabase -> URL ที่เปิดรูปได้ (ใช้ค่าใน Supabase ตามที่เก็บไว้)
function imageUrl(p) {
  if (!p) return '';
  let s = String(p).trim();
  if (/^(https?:)?\/\//i.test(s) || s.startsWith('data:')) return s;
  s = s.replace(/^\/+/, '');
  try { s = decodeURI(s); } catch (e) {}   // กัน %20 ถูกเข้ารหัสซ้ำ
  return IMAGE_BASE + encodeURI(s);
}

// path เก่า (images/products/..., images/page-xxx.jpg) หรือว่าง -> ใช้ path ใหม่ที่สร้างจาก brand+model แทน
function resolveFixtureImage(item) {
  const raw = String(item.imageRaw || '').trim();
  const isOld = !raw || /^\/?images\/products\//i.test(raw) || /^\/?images\/page-/i.test(raw);
  return imageUrl(isOld ? newFixtureImagePath(item) : raw);
}

// แปลง URL กลับเป็น path สัมพัทธ์ก่อนบันทึกลง Supabase
function imagePathFromUrl(u) {
  if (!u) return u;
  let s = String(u);
  if (IMAGE_BASE && s.startsWith(IMAGE_BASE)) s = s.slice(IMAGE_BASE.length);
  if (!/^(https?:)?\/\//i.test(s) && !s.startsWith('data:')) {
    try { return decodeURI(s); } catch (e) { return s; }
  }
  return s;
}

const DB = (function () {
  let fixtures = [];
  let compatMap = new Map();      // fixtureId -> [accessory names] จากตาราง accessories
  let knownColumns = null;        // คอลัมน์ที่มีอยู่จริงในตาราง (ดูจากแถวแรก)
  let accessoriesAsText = false;  // true ถ้าคอลัมน์ accessories เป็น text (ไม่ใช่ array/jsonb)

  // รองรับ array, JSON string, Postgres array literal {a,b} และ comma-separated
  function parseAccessories(value) {
    if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
    if (typeof value !== 'string') return [];
    const s = value.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
      } catch (e) { /* ตกไปแบบอื่น */ }
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1);
      const out = [];
      const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
      let m;
      while ((m = re.exec(inner))) {
        const v = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
        if (v && v.trim()) out.push(v.trim());
      }
      return out;
    }
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }

  function mapRow(row) {
    const item = { id: Number(row.id) };
    FIXTURE_FIELDS.forEach(([camel, snake]) => {
      let v = row[snake] ?? row[camel] ?? null;
      if (v !== null && FIXTURE_NUMERIC.includes(camel)) {
        const n = Number(v);
        v = Number.isFinite(n) ? n : null;
      }
      item[camel] = v;
    });
    item.imageRaw = item.image || '';
    item.hidden = item.hidden === true || item.hidden === 'true';
    item.reserved = Number(item.reserved || 0);
    item.inUse = Number(item.inUse || 0);
    item.accessories = parseAccessories(item.accessories);
    return finalize(item);
  }

  // คำนวณฟิลด์ที่เว็บใช้แสดงผล
  function finalize(item) {
    const linked = compatMap.get(Number(item.id)) || [];
    const merged = [...new Set([...parseAccessories(item.accessories), ...linked])];
    item.accessories = merged;
    item.compatibleText = merged.join(' ');
    item.image = resolveFixtureImage(item);
    item.remaining = Math.max(Number(item.stockCount || 0) - Number(item.reserved || 0) - Number(item.inUse || 0), 0);
    return item;
  }

  // patch จากเว็บ -> แถวสำหรับ Supabase
  function toRow(patch = {}) {
    const row = {};
    FIXTURE_FIELDS.forEach(([camel, snake]) => {
      if (!(camel in patch)) return;
      if (knownColumns && !knownColumns.has(snake)) return; // ข้ามคอลัมน์ที่ไม่มีในตาราง
      let v = patch[camel];
      if (camel === 'image') v = v ? imagePathFromUrl(v) : null;
      if (camel === 'accessories') {
        const arr = parseAccessories(v);
        v = accessoriesAsText ? JSON.stringify(arr) : arr;
      }
      if (camel === 'hidden') v = !!v;
      if (v === undefined || v === '') v = null;
      row[snake] = v;
    });
    return row;
  }

  function rebuildCompat(accessoryRows) {
    compatMap = new Map();
    (accessoryRows || []).forEach((acc) => {
      const name = String(acc.name || '').trim();
      if (!name) return;
      (Array.isArray(acc.compatible_with) ? acc.compatible_with : []).forEach((fid) => {
        const id = Number(fid);
        if (!compatMap.has(id)) compatMap.set(id, []);
        compatMap.get(id).push(name);
      });
    });
  }

  function upsertLocal(item) {
    const idx = fixtures.findIndex((f) => Number(f.id) === Number(item.id));
    if (idx === -1) fixtures.push(item);
    else fixtures[idx] = item;
    fixtures.sort((a, b) => Number(a.id) - Number(b.id));
    return item;
  }

  async function load() {
    const [fx, ac] = await Promise.all([
      window.sb.from(FIXTURE_TABLE).select('*').order('id', { ascending: true }),
      window.sb.from('accessories').select('id,name,compatible_with'),
    ]);

    if (fx.error) throw fx.error;
    rebuildCompat(ac.error ? [] : ac.data);

    const rows = fx.data || [];
    if (rows.length) {
      knownColumns = new Set(Object.keys(rows[0]));
      const sample = rows.find((r) => r.accessories !== null && r.accessories !== undefined && r.accessories !== '');
      accessoriesAsText = !!sample && typeof sample.accessories === 'string';
    }

    fixtures = rows.map(mapRow);
    fixtures.sort((a, b) => Number(a.id) - Number(b.id));
    return fixtures;
  }

  function getAll() {
    return [...fixtures];
  }

  function getById(id) {
    return fixtures.find((f) => Number(f.id) === Number(id)) || null;
  }

  async function update(id, patch) {
    const current = getById(id) || {};
    const next = { ...patch };

    // อัปเดตคอลัมน์ที่คำนวณจากค่าอื่นให้ตรงกันเสมอ
    if ('stockCount' in patch || 'reserved' in patch || 'inUse' in patch) {
      const stockCount = Number('stockCount' in patch ? patch.stockCount : current.stockCount) || 0;
      const reserved = Number('reserved' in patch ? patch.reserved : current.reserved) || 0;
      const inUse = Number('inUse' in patch ? patch.inUse : current.inUse) || 0;
      next.remaining = Math.max(stockCount - reserved - inUse, 0);
    }
    if ('accessories' in patch) {
      next.compatibleText = parseAccessories(patch.accessories).join(' ');
    }

    const row = toRow(next);
    if (!Object.keys(row).length) return getById(id);

    const { data, error } = await window.sb
      .from(FIXTURE_TABLE)
      .update(row)
      .eq('id', Number(id))
      .select()
      .single();

    if (error) throw error;
    return upsertLocal(mapRow(data));
  }

  async function updateInventory(id, patch) {
    const current = getById(id) || { reserved: 0, inUse: 0 };
    return update(id, {
      reserved: Math.max(Number(patch.reserved ?? current.reserved) || 0, 0),
      inUse: Math.max(Number(patch.inUse ?? current.inUse) || 0, 0),
    });
  }

  async function create(initial = {}) {
    const item = {
      brand: '',
      model: 'New Item',
      category: '',
      type: 'fixture',
      stock: '0 Pieces',
      stockCount: 0,
      image: '',
      reserved: 0,
      inUse: 0,
      accessories: [],
      hidden: false,
      ...initial,
    };
    delete item.id; // ให้ฐานข้อมูลสร้าง id เอง
    item.remaining = Math.max(Number(item.stockCount || 0) - Number(item.reserved || 0) - Number(item.inUse || 0), 0);
    item.compatibleText = parseAccessories(item.accessories).join(' ');

    const { data, error } = await window.sb
      .from(FIXTURE_TABLE)
      .insert(toRow(item))
      .select()
      .single();

    if (error) throw error;
    return upsertLocal(mapRow(data));
  }

  async function duplicate(id) {
    const source = getById(id);
    if (!source) return null;
    const copy = { ...source, model: `${source.model} Copy`, image: source.imageRaw };
    delete copy.id;
    return create(copy);
  }

  async function remove(id) {
    const { error } = await window.sb
      .from(FIXTURE_TABLE)
      .delete()
      .eq('id', Number(id));

    if (error) throw error;
    fixtures = fixtures.filter((f) => Number(f.id) !== Number(id));
    return true;
  }

  async function replaceAll(newFixtures) {
    const rows = (newFixtures || []).map((item) => {
      const next = { ...item, image: item.imageRaw !== undefined ? item.imageRaw : item.image };
      next.compatibleText = parseAccessories(next.accessories).join(' ');
      return { id: Number(item.id), ...toRow(next) };
    });
    const { error } = await window.sb
      .from(FIXTURE_TABLE)
      .upsert(rows, { onConflict: 'id' });

    if (error) throw error;
    return load();
  }

  function persist() {
    // ไม่ต้องทำอะไร: ข้อมูลบันทึกลง Supabase ทุกครั้งที่ update/create/remove
  }

  function resetToOriginal() {
    console.warn('DB.resetToOriginal() ปิดใช้งานในโหมด Supabase');
  }

  function exportJson() {
    // export เป็น path แบบสั้น (ไม่ใช่ URL เต็ม)
    const out = fixtures.map(({ imageRaw, ...rest }) => ({ ...rest, image: imageRaw }));
    return JSON.stringify(out, null, 2);
  }

  function brands() {
    return [...new Set(fixtures.map((f) => f.brand).filter(Boolean))].sort();
  }

  function categories() {
    return [...new Set(fixtures.map((f) => f.category).filter(Boolean))].sort();
  }

  return {
    load,
    getAll,
    getById,
    update,
    updateInventory,
    create,
    duplicate,
    remove,
    replaceAll,
    persist,
    resetToOriginal,
    exportJson,
    brands,
    categories,
  };
})();
