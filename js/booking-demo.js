// js/booking-demo.js
// ---------------------------------------------------------------------------
// แหล่งข้อมูล "ตัวอย่าง" สำหรับปฏิทินจอง — ใช้ตอนดูหน้าตาอย่างเดียว
//
// ทำไมต้องมีไฟล์นี้แยก: ฐานข้อมูลจริงตอนนี้มีใบจอง 0 ใบ และ view สรุปปฏิทิน
// (v_booking_day_summary / item_availability_between) ยังไม่ได้ถูกสร้าง
// ถ้าอ่านจาก DB ตรง ๆ จะได้ปฏิทินว่างเปล่าทั้งปี ดูไม่ออกว่าหน้าตาตอนใช้งานจริง
// เป็นยังไง ไฟล์นี้จึง "จำลอง" ใบจอง 1 ปีโดยใช้ **ชื่ออุปกรณ์และจำนวนสต็อกจริง**
// จาก data/fixtures.json + data/accessories.json เพื่อให้ภาพที่เห็นตรงกับของที่มีอยู่
//
// ข้อสำคัญ 2 อย่าง:
//   1. ข้อมูลถูกสุ่มแบบ deterministic (seed จากวันที่) → รีเฟรชกี่ครั้งก็ได้ภาพเดิม
//      ไม่งั้นจะเทียบหน้าตาก่อน/หลังแก้โค้ดไม่ได้
//   2. ไฟล์นี้ไม่ถูกโหลดจากหน้าอื่นใด ๆ ทั้งสิ้น และไม่มีทางถูกเขียนลงฐานข้อมูล
//      (ดู isLive = false) — booking-calendar.js ใช้มันแค่แสดงภาพ
// ---------------------------------------------------------------------------

const BookingDemoProvider = (() => {
  // คนตัวอย่าง — ในของจริงจะมาจากตาราง members (ตอนนี้มีอยู่ 1 คน คือ ADMIN01)
  //
  // hue คือ "สีประจำตัว" ที่ผูกถาวรกับคนนั้น (0-359) ในของจริงค่านี้จะมาจาก
  // คอลัมน์ members.color_hue ที่ admin ตั้งได้ ที่นี่กำหนดตายตัวไว้ล่วงหน้าให้
  // ห่างกันชัดเจน: แดง / ส้ม / เขียวมะกอก / เขียวมิ้นต์ / ฟ้า / ม่วง
  // ถ้าไม่กำหนดไว้ โค้ดจะคำนวณจาก hash ของ id ซึ่ง "ไม่เปลี่ยน" แต่การันตี
  // "ไม่ซ้ำกัน" ไม่ได้ (สองคนอาจได้สีใกล้กัน)
  const PEOPLE = [
    { id: 'demo-p1', name: 'ธนกฤต ใจดี', hue: 8 },
    { id: 'demo-p2', name: 'วิชุดา แสงทอง', hue: 42 },
    { id: 'demo-p3', name: 'ปกรณ์ วงศ์ศรี', hue: 96 },
    { id: 'demo-p4', name: 'ศุภกร มีทรัพย์', hue: 158 },
    { id: 'demo-p5', name: 'ณัฐพล ชัยวัฒน์', hue: 208 },
    { id: 'demo-p6', name: 'พิมพ์ชนก รัตนกุล', hue: 268 },
  ];

  const JOB_NAMES = [
    'กองละคร — ช่อง 3', 'TVC สินค้า', 'งานอีเวนต์เปิดตัว', 'ถ่ายสัมภาษณ์ CEO',
    'กองภาพยนตร์สั้น', 'Live สด คอนเสิร์ต', 'งานแต่งงาน (เช้า-เย็น)',
    'ถ่ายสินค้า E-commerce', 'สารคดีท่องเที่ยว', 'งานสัมมนาประจำปี',
    'Music Video', 'ถ่ายแฟชั่นสตูดิโอ',
  ];

  const LOCATIONS = [
    'สตูดิโอ หนองจอก', 'ศูนย์ฯ สิริกิติ์', 'ไบเทค บางนา', 'กองนอก — อยุธยา',
    'สตูดิโอ ลาดพร้าว', 'โรงแรม ดิ แอทธินี', 'เอ็มควอเทียร์', 'กองนอก — ชลบุรี',
    'สตูดิโอ รามคำแหง', 'อิมแพ็ค เมืองทองธานี',
  ];

  // รายการที่ใช้เป็น fallback ถ้า fetch data/*.json ไม่ได้ (ชื่อจริงจากฐานข้อมูล)
  const FALLBACK_ITEMS = [
    { itemType: 'fixture', itemId: 1, itemName: 'Aladdin Bi-Flex 1', stock: 4 },
    { itemType: 'fixture', itemId: 2, itemName: 'Aladdin Bi-Flex 2', stock: 4 },
    { itemType: 'fixture', itemId: 4, itemName: 'Aputure MC', stock: 28 },
    { itemType: 'fixture', itemId: 12, itemName: 'Aputure LS 600d Pro', stock: 6 },
    { itemType: 'fixture', itemId: 20, itemName: 'Nanlite Forza 500B II', stock: 4 },
    { itemType: 'accessory', itemId: 1, itemName: 'LiteDimmer Pro Hybrid', stock: 10 },
    { itemType: 'accessory', itemId: 2, itemName: 'Chimera Panel Lantern', stock: 2 },
    { itemType: 'accessory', itemId: 7, itemName: '200W Dimmer Unit', stock: null },
  ];

  let itemPool = null;          // [{itemType,itemId,itemName,stock}]
  let poolPromise = null;

  // ---- ตัวสุ่มแบบ deterministic (mulberry32) --------------------------------
  function hashString(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rngFrom(seedText) {
    let a = hashString(seedText);
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick(rng, list) {
    return list[Math.floor(rng() * list.length)];
  }

  function pickSome(rng, list, count) {
    const copy = list.slice();
    const out = [];
    for (let i = 0; i < count && copy.length; i += 1) {
      out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
    }
    return out;
  }

  // เลือกแบบถ่วงน้ำหนักตามจำนวนสต็อก — ร้านเช่าไฟจริง ๆ จะถูกจอง "ไฟกองกลาง"
  // ที่มีหลายตัวบ่อยกว่าไฟเฉพาะทางที่มีตัวเดียว ถ้าสุ่มแบบเท่ากันหมด จะได้ภาพที่
  // ของหมดแทบทุกวัน (เพราะคลังนี้มีไฟ stock=1 อยู่ 5 รุ่น และ stock=2 อีก 10 รุ่น)
  // ซึ่งเกินจริงและทำให้สีแดงบนปฏิทินไม่มีความหมาย
  function pickSomeWeighted(rng, list, count) {
    const copy = list.slice();
    const out = [];
    for (let i = 0; i < count && copy.length; i += 1) {
      const total = copy.reduce((sum, it) => sum + Math.max(Number(it.stock) || 1, 1), 0);
      let r = rng() * total;
      let idx = copy.length - 1;
      for (let j = 0; j < copy.length; j += 1) {
        r -= Math.max(Number(copy[j].stock) || 1, 1);
        if (r <= 0) { idx = j; break; }
      }
      out.push(copy.splice(idx, 1)[0]);
    }
    return out;
  }

  // ---- โคลังข้อมูลอุปกรณ์จริง ------------------------------------------------
  function firstNumber(value) {
    const m = /(\d+)/.exec(String(value == null ? '' : value));
    return m ? Number(m[1]) : null;
  }

  async function loadItemPool() {
    if (itemPool) return itemPool;
    if (!poolPromise) {
      poolPromise = (async () => {
        try {
          const [fxRes, acRes] = await Promise.all([
            fetch('data/fixtures.json'),
            fetch('data/accessories.json'),
          ]);
          if (!fxRes.ok || !acRes.ok) throw new Error(`HTTP ${fxRes.status}/${acRes.status}`);
          const fixtures = await fxRes.json();
          const accessories = await acRes.json();
          const pool = [];
          (Array.isArray(fixtures) ? fixtures : []).forEach((row) => {
            if (!row || row.hidden === true) return;
            const stock = Number.isFinite(Number(row.stockCount))
              ? Number(row.stockCount)
              : firstNumber(row.stock);
            pool.push({
              itemType: 'fixture',
              itemId: row.id,
              itemName: `${row.brand || ''} ${row.model || ''}`.trim() || `Fixture #${row.id}`,
              stock: stock === null ? null : stock,
            });
          });
          (Array.isArray(accessories) ? accessories : []).forEach((row) => {
            if (!row || row.hidden === true) return;
            pool.push({
              itemType: 'accessory',
              itemId: row.id,
              itemName: row.name || `Accessory #${row.id}`,
              // accessories.stock เป็นข้อความ เช่น "10 Pieces" และส่วนใหญ่ยังไม่กรอก (null)
              stock: firstNumber(row.stock),
            });
          });
          itemPool = pool.length ? pool : FALLBACK_ITEMS;
        } catch (err) {
          itemPool = FALLBACK_ITEMS;
        }
        return itemPool;
      })();
    }
    return poolPromise;
  }

  // ---- สร้างใบจองของ "หนึ่งวัน" ---------------------------------------------
  // dow: 0 = อาทิตย์ … 6 = เสาร์
  // งานกองถ่าย/อีเวนต์จริงหนาแน่นช่วงพฤหัส-อาทิตย์ จึงถ่วงน้ำหนักตามนั้น
  function bookingCountFor(rng, dow, dayOffset) {
    const base = dow === 0 || dow === 5 || dow === 6 ? 0.78 : dow === 4 ? 0.6 : 0.42;
    const r = rng();
    if (r > base) return 0;
    // บางวันเป็นวันงานใหญ่ — จองทับกันหลายคน
    const heavy = rng();
    if (heavy > 0.93) return 4;
    if (heavy > 0.8) return 3;
    if (heavy > 0.45) return 2;
    return 1;
  }

  function statusFor(dayOffset, rng) {
    // dayOffset < 0 = วันในอดีต, 0 = วันนี้, > 0 = อนาคต
    if (dayOffset > 0) return 'reserved';
    if (dayOffset === 0) return rng() > 0.5 ? 'checked_out' : 'reserved';
    // ของที่เลยวันแล้วยังไม่กลับคลัง = overdue (จุดบอดที่ระบบเดิมมองไม่เห็น)
    if (rng() > 0.9) return 'overdue';
    return 'checked_out';
  }

  function buildDay(iso, todayISO, pool) {
    const rng = rngFrom(`booking-demo:${iso}`);
    const parts = iso.split('-').map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    const dow = date.getDay();
    const todayParts = todayISO.split('-').map(Number);
    const today = new Date(todayParts[0], todayParts[1] - 1, todayParts[2]);
    const dayOffset = Math.round((date - today) / 86400000);

    const bookable = pool.filter((it) => it.stock !== null && it.stock > 0);
    const scarce = bookable.filter((it) => it.stock <= 4);

    const count = bookingCountFor(rng, dow, dayOffset);
    const bookings = [];
    for (let i = 0; i < count; i += 1) {
      const person = pick(rng, PEOPLE);
      const lineCount = 2 + Math.floor(rng() * 4);        // 2–5 รายการต่อใบ
      let lines = pickSomeWeighted(rng, bookable, lineCount);

      // ทำให้ "บางวัน" ของหมดจริง เพื่อให้เห็นสีแดงบนปฏิทิน — แต่จงใจให้เกิดไม่บ่อย
      // (ถ้าเกิดทุกวัน ภาพตัวอย่างจะดูเกินจริงและแยกไม่ออกว่าวันไหนน่าห่วงจริง)
      let hotItem = null;
      if (scarce.length && rng() > 0.86) {
        hotItem = pick(rng, scarce);
        if (!lines.some((l) => l.itemId === hotItem.itemId && l.itemType === hotItem.itemType)) {
          lines = [hotItem].concat(lines.slice(0, lineCount - 1));
        }
      }

      const items = lines.map((line) => {
        const isHot = hotItem && line.itemId === hotItem.itemId && line.itemType === hotItem.itemType;
        // ปกติจองไม่เต็มสต็อก (เหลือเผื่อคนอื่น) — ยกเว้นรายการที่ถูกเลือกให้เป็น "วันของหมด"
        const cap = Math.max(1, Math.min(line.stock - 1, 6));
        const quantity = isHot ? line.stock : 1 + Math.floor(rng() * cap);
        return {
          itemType: line.itemType,
          itemId: line.itemId,
          itemName: line.itemName,
          quantity,
          returnedQuantity: 0,
          stock: line.stock,
        };
      });

      const status = statusFor(dayOffset, rng);
      bookings.push({
        id: `demo-${iso}-${i + 1}`,
        personId: person.id,
        personName: person.name,
        jobName: pick(rng, JOB_NAMES),
        jobLocation: pick(rng, LOCATIONS),
        status,
        note: rng() > 0.75 ? 'รับของหน้ากอง 06:00 น. · คืนภายใน 22:00 น.' : '',
        items,
      });
    }

    return { iso, bookings };
  }

  // ---- API ของ provider ----------------------------------------------------
  async function loadRange(fromISO, toISO, todayISO) {
    const pool = await loadItemPool();
    const days = {};
    const peopleCount = new Map();
    PEOPLE.forEach((p) => peopleCount.set(p.id, 0));

    const startParts = fromISO.split('-').map(Number);
    const cursor = new Date(startParts[0], startParts[1] - 1, startParts[2]);
    const endParts = toISO.split('-').map(Number);
    const end = new Date(endParts[0], endParts[1] - 1, endParts[2]);

    let guard = 0;
    while (cursor <= end && guard < 800) {
      const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      const day = buildDay(iso, todayISO, pool);
      if (day.bookings.length) days[iso] = day;
      day.bookings.forEach((b) => {
        peopleCount.set(b.personId, (peopleCount.get(b.personId) || 0) + 1);
      });
      cursor.setDate(cursor.getDate() + 1);
      guard += 1;
    }

    const people = PEOPLE.map((p) => ({
      id: p.id,
      name: p.name,
      hue: p.hue,                 // สีประจำตัว — ปฏิทินจะใช้ค่านี้โดยตรง
      count: peopleCount.get(p.id) || 0,
    })).filter((p) => p.count > 0);

    return {
      ok: true,
      source: 'demo',
      from: fromISO,
      to: toISO,
      days,
      people,
      itemCount: pool.length,
      // รายการที่ยังไม่ระบุจำนวนในสต็อก → จองไม่ได้ (นับให้ admin เห็น)
      unknownStockCount: pool.filter((it) => it.stock === null).length,
    };
  }

  return {
    id: 'demo',
    label: 'ข้อมูลตัวอย่าง',
    isLive: false,
    people: PEOPLE,
    loadRange,
  };
})();

if (typeof window !== 'undefined') window.BookingDemoProvider = BookingDemoProvider;
