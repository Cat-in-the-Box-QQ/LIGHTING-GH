// js/booking-live.js
// ---------------------------------------------------------------------------
// แหล่งข้อมูล "จริง" สำหรับปฏิทินจอง — อ่านจากฐานข้อมูล Supabase
//
// ต้องรัน supabase/migration-2026-11-13d-booking-calendar.sql ก่อน ไฟล์นี้จึงจะ
// อ่านข้อมูลได้ ถ้ายังไม่ได้รัน มันจะ "บอกตรง ๆ ว่าขาดอะไร" — ไม่เดา ไม่เติมค่าเอง
//
// อ่านจาก 3 แหล่ง (ยิงขนานกัน):
//   1. v_booking_day_detail   รายชื่อใบจอง + รายการของ ในช่วงที่ดู (มีชื่อคนจอง
//                             จึง grant ให้เฉพาะ authenticated — ต้อง sign in)
//   2. ใบจองที่ค้างคืน (overdue) จาก "ก่อน" ช่วงที่ดู — เพราะของที่ยังไม่กลับคลัง
//                             ล็อกสต็อกทุกวันตั้งแต่วันจอง ต้องนับทับทุกวันให้ตรง
//                             กับที่ trigger ฝั่ง SQL ใช้ตัดสินจริง
//   3. v_item_stock           ทั้งคลัง (138 แถว) เพื่อรู้ว่ามีกี่รายการ และกี่รายการ
//                             ที่ยังไม่ระบุจำนวน (จองไม่ได้) — แคชไว้ใช้ซ้ำ
// ---------------------------------------------------------------------------

const BookingLiveProvider = (() => {
  const DETAIL_VIEW = 'v_booking_day_detail';
  const SUMMARY_VIEW = 'v_booking_day_summary';
  const STOCK_VIEW = 'v_item_stock';
  const RANGE_FUNCTION = 'item_availability_between';
  const FLAGS_FUNCTION = 'booking_day_flags_between';
  const MIGRATION = 'supabase/migration-2026-11-13d-booking-calendar.sql';
  const OVERDUE_CARRY_LIMIT = 500;   // กันดึงใบค้างคืนเก่า ๆ มาทั้งตาราง

  const DETAIL_COLUMNS = [
    'day', 'booking_id', 'job_name', 'job_location', 'status', 'note', 'group_ref',
    'member_id', 'member_name', 'member_code', 'member_hue',
    'booking_item_id', 'item_type', 'item_id', 'item_name', 'item_stock',
    'quantity', 'returned_quantity', 'item_note',
  ].join(',');

  let catalogueCache = null;      // [{itemType,itemId,itemName,stock}]
  let cataloguePromise = null;

  function client() {
    return typeof window !== 'undefined' ? window.sb : null;
  }

  function describeError(err) {
    const msg = String((err && (err.message || err.msg)) || err || 'ไม่ทราบสาเหตุ').trim();

    if (/relation .* does not exist/i.test(msg)) {
      return {
        short: 'ยังไม่มีตาราง/วิวที่ปฏิทินต้องใช้ในฐานข้อมูล',
        detail: msg,
        hint: `ต้องรัน ${MIGRATION} เพื่อสร้าง ${DETAIL_VIEW}, ${STOCK_VIEW} และ ${RANGE_FUNCTION}() ก่อน`,
      };
    }
    if (/function .* does not exist/i.test(msg)) {
      return {
        short: 'ยังไม่มีฟังก์ชันฝั่งฐานข้อมูลที่ปฏิทินต้องใช้',
        detail: msg,
        hint: `ต้องรัน ${MIGRATION} เพื่อสร้าง ${RANGE_FUNCTION}() / ${FLAGS_FUNCTION}() ก่อน`,
      };
    }
    // view ปฏิทินมีชื่อคนจองอยู่ จึง grant ให้เฉพาะ authenticated (ไม่เปิดให้ anon)
    if (/permission denied/i.test(msg) || /42501/.test(msg)) {
      return {
        short: 'ต้อง sign in ก่อนดูปฏิทินข้อมูลจริง',
        detail: msg,
        hint: 'ข้อมูลจริงมีชื่อผู้จองอยู่ จึงเปิดให้เฉพาะบัญชี crew/admin ที่ sign in แล้ว — ถ้า sign in แล้วยังติด แปลว่าบัญชีนี้ไม่มีแถวในตาราง members ให้ admin เพิ่มรายชื่อก่อน',
      };
    }
    if (/jwt|token|401|invalid claim/i.test(msg)) {
      return {
        short: 'เซสชันหมดอายุ — กรุณา sign in ใหม่',
        detail: msg,
        hint: 'ไปที่หน้า Sign in แล้วเข้าระบบอีกครั้ง',
      };
    }
    if (/กว้างเกิน 92 วัน|92 วัน/.test(msg)) {
      return {
        short: 'ช่วงวันที่ที่ขอเกินกว่าที่ฐานข้อมูลรับได้',
        detail: msg,
        hint: 'เว็บโหลดทีละไตรมาส (ไม่เกิน 92 วัน) อยู่แล้ว — ถ้าเห็นข้อความนี้แปลว่ามีบั๊กใน js/booking-calendar.js',
      };
    }
    return {
      short: 'อ่านข้อมูลปฏิทินจากฐานข้อมูลไม่สำเร็จ',
      detail: msg,
      hint: 'ตรวจการเชื่อมต่อเน็ตเวิร์กหรือ key ใน js/supabase-config.js',
    };
  }

  // ---- แคตตาล็อกทั้งคลัง (แคชไว้ — ไม่เปลี่ยนระหว่างใช้งานหน้าเดียว) -------
  async function loadCatalogue(sb, force) {
    if (catalogueCache && !force) return catalogueCache;
    if (cataloguePromise && !force) return cataloguePromise;

    cataloguePromise = (async () => {
      const { data, error } = await sb
        .from(STOCK_VIEW)
        .select('item_type,item_id,item_name,stock');
      if (error) throw error;

      catalogueCache = (Array.isArray(data) ? data : []).map((r) => ({
        itemType: r.item_type === 'accessory' ? 'accessory' : 'fixture',
        itemId: Number(r.item_id),
        itemName: r.item_name || `${r.item_type} id ${r.item_id}`,
        stock: r.stock === null || r.stock === undefined ? null : Number(r.stock),
      }));
      return catalogueCache;
    })();

    try {
      return await cataloguePromise;
    } finally {
      cataloguePromise = null;
    }
  }

  // รายชื่อวัน ISO ทั้งหมดในช่วง [from, to] — คำนวณจาก Date.UTC ล้วน ๆ
  // (ไม่แปลงวันผ่าน string ของ Date เพราะเสี่ยงเลื่อนวันตาม timezone ของเครื่อง)
  function dayList(fromISO, toISO) {
    const out = [];
    const f = String(fromISO).split('-').map(Number);
    const t = String(toISO).split('-').map(Number);
    if (f.length !== 3 || t.length !== 3 || f.some((n) => !Number.isFinite(n)) || t.some((n) => !Number.isFinite(n))) return out;
    let ms = Date.UTC(f[0], f[1] - 1, f[2]);
    const end = Date.UTC(t[0], t[1] - 1, t[2]);
    let guard = 0;
    while (ms <= end && guard < 400) {
      const dt = new Date(ms);
      out.push(
        `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`,
      );
      ms += 86400000;   // UTC ไม่มีออมเวลา จึงบวกวันละ 86,400,000 ms ได้ตรง ๆ
      guard += 1;
    }
    return out;
  }

  // แปลงแถวจาก view (1 แถว = 1 รายการของใน 1 ใบจอง) ให้เป็นใบจองที่มี items[]
  function groupBookings(rows, stockByName) {
    const byDay = new Map();        // iso -> Map(bookingId -> booking)
    const people = new Map();       // memberId -> {id,name,hue,count}

    rows.forEach((r) => {
      const iso = String(r.day || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;

      const bid = String(r.booking_id || '');
      if (!bid) return;

      if (!byDay.has(iso)) byDay.set(iso, new Map());
      const dayMap = byDay.get(iso);

      let b = dayMap.get(bid);
      if (!b) {
        const pid = r.member_id === null || r.member_id === undefined ? '' : String(r.member_id);
        b = {
          id: bid,
          personId: pid,
          personName: r.member_name || r.member_code || (pid ? `สมาชิก ${pid.slice(0, 8)}` : 'ไม่ระบุชื่อ'),
          personCode: r.member_code || '',
          hue: r.member_hue === null || r.member_hue === undefined ? null : Number(r.member_hue),
          jobName: r.job_name || '(ไม่ระบุชื่องาน)',
          jobLocation: r.job_location || '',
          status: r.status || 'reserved',
          note: r.note || '',
          groupRef: r.group_ref || null,
          items: [],
        };
        dayMap.set(bid, b);

        if (pid) {
          if (!people.has(pid)) {
            people.set(pid, { id: pid, name: b.personName, hue: b.hue, count: 0 });
          } else if (people.get(pid).hue === null && b.hue !== null) {
            people.get(pid).hue = b.hue;
          }
          people.get(pid).count += 1;
        }
      }

      // รายการของ — แถวที่ไม่มี booking_item_id แปลว่าใบจองยังไม่มีรายการ
      if (r.booking_item_id) {
        const type = r.item_type === 'accessory' ? 'accessory' : 'fixture';
        const id = Number(r.item_id);
        let stock = r.item_stock === null || r.item_stock === undefined ? null : Number(r.item_stock);
        let name = r.item_name || '';
        // ของถูกลบออกจากคลังหลังจอง → view join ไม่เจอ ต้องไม่เดาชื่อ/สต็อกเอง
        if (!name && stockByName) {
          const hit = stockByName.get(`${type}:${id}`);
          if (hit) { name = hit.itemName; if (stock === null) stock = hit.stock; }
        }
        b.items.push({
          itemType: type,
          itemId: id,
          itemName: name || `${type} id ${id}`,
          quantity: Number(r.quantity || 0),
          returnedQuantity: Number(r.returned_quantity || 0),
          stock,
          itemNote: r.item_note || '',
          bookingItemId: String(r.booking_item_id),
        });
      }
    });

    const days = {};
    byDay.forEach((dayMap, iso) => {
      days[iso] = { iso, bookings: [...dayMap.values()] };
    });

    return { days, people: [...people.values()] };
  }

  async function loadRange(fromISO, toISO, todayISO) {
    const sb = client();
    if (!sb || typeof sb.from !== 'function') {
      return {
        ok: false,
        source: 'live',
        error: {
          short: 'ยังเชื่อมต่อ Supabase ไม่ได้',
          detail: 'window.sb ไม่มีอยู่ — js/supabase-client.js ยังไม่ได้โหลด หรือยังไม่ได้กรอก URL/key',
          hint: 'หน้านี้ยังดูได้เฉพาะโหมดข้อมูลตัวอย่าง',
        },
      };
    }

    try {
      const [catalogue, inRange, carried] = await Promise.all([
        loadCatalogue(sb, false),
        sb.from(DETAIL_VIEW)
          .select(DETAIL_COLUMNS)
          .gte('day', fromISO)
          .lte('day', toISO)
          .order('day', { ascending: true }),
        // ใบที่ค้างคืนมาก่อนช่วงนี้ ยังล็อกสต็อกทุกวันในช่วงนี้
        sb.from(DETAIL_VIEW)
          .select(DETAIL_COLUMNS)
          .eq('status', 'overdue')
          .lt('day', fromISO)
          .limit(OVERDUE_CARRY_LIMIT),
      ]);

      if (inRange.error) throw inRange.error;
      if (carried.error) throw carried.error;

      const stockByName = new Map(
        catalogue.map((c) => [`${c.itemType}:${c.itemId}`, c]),
      );

      const main = groupBookings(Array.isArray(inRange.data) ? inRange.data : [], stockByName);

      // ใบค้างคืนจากก่อนช่วงนี้: ต้องโผล่ "ทุกวัน" ในช่วงที่ดู ไม่ใช่แค่วันจอง
      const carriedRows = Array.isArray(carried.data) ? carried.data : [];
      if (carriedRows.length) {
        const carriedGrouped = groupBookings(carriedRows, stockByName);
        const carriedBookings = [];
        Object.keys(carriedGrouped.days).forEach((iso) => {
          carriedGrouped.days[iso].bookings.forEach((b) => carriedBookings.push(b));
        });

        // วนวันด้วยเลข UTC ล้วน ๆ — ห้ามพึ่ง timezone ของเครื่องผู้ใช้
        dayList(fromISO, toISO).forEach((iso) => {
          if (!main.days[iso]) main.days[iso] = { iso, bookings: [] };
          // สำเนาแยกต่อวัน เพราะใบเดียวกันโผล่ได้หลายวัน
          carriedBookings.forEach((b) => {
            main.days[iso].bookings.push({
              ...b,
              items: b.items.map((it) => ({ ...it })),
              carriedOverdue: true,
            });
          });
        });

        carriedGrouped.people.forEach((p) => {
          const hit = main.people.find((x) => x.id === p.id);
          if (!hit) { main.people.push(p); return; }
          // ใบค้างคืนก็นับเป็นใบจองของคนนั้น — ไม่งั้นตัวเลขในคำอธิบายสี
          // จะน้อยกว่าจำนวนใบงานที่โผล่บนปฏิทินจริง
          hit.count += p.count;
          if (hit.hue === null && p.hue !== null) hit.hue = p.hue;
        });
      }

      const unknownStockCount = catalogue.filter((c) => c.stock === null).length;

      return {
        ok: true,
        source: 'live',
        from: fromISO,
        to: toISO,
        days: main.days,
        people: main.people,
        itemCount: catalogue.length,
        unknownStockCount,
      };
    } catch (err) {
      return { ok: false, source: 'live', error: describeError(err) };
    }
  }

  // ---- ยอดคงเหลือของ "วันเดียว" ตรงจากฐานข้อมูล -----------------------------
  // ใช้ตอนกดดูวันนั้น และตอนกรอกฟอร์มจอง — ตัวเลขนี้มาจากฟังก์ชันเดียวกับที่
  // trigger ใช้ตัดสิน จึงไม่มีทางที่หน้าจอจะบอกว่าเหลือแล้วพอกดจองกลับโดนปฏิเสธ
  async function availabilityForDay(iso) {
    const sb = client();
    if (!sb || typeof sb.rpc !== 'function') return { ok: false, error: describeError('window.sb ไม่พร้อมใช้งาน') };
    try {
      const { data, error } = await sb.rpc(RANGE_FUNCTION, { d_from: iso, d_to: iso });
      if (error) throw error;
      const rows = (Array.isArray(data) ? data : []).map((r) => ({
        itemType: r.item_type === 'accessory' ? 'accessory' : 'fixture',
        itemId: Number(r.item_id),
        itemName: r.item_name,
        stock: r.stock === null || r.stock === undefined ? null : Number(r.stock),
        booked: Number(r.booked || 0),
        outCount: Number(r.out_count || 0),
        available: r.available === null || r.available === undefined ? null : Number(r.available),
        stockUnknown: !!r.stock_unknown,
      }));
      return { ok: true, day: iso, rows };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  // "วันนี้" ของระบบจอง — ถามจากฐานข้อมูลตรง ๆ เพราะฐานข้อมูลตั้ง timezone = UTC
  // ถ้าใช้นาฬิกาเครื่องผู้ใช้ จะได้วันผิดเมื่อเครื่องตั้งเขตเวลาไว้ที่อื่น
  // (fallback = คำนวณจากนาฬิกาเครื่อง +7 ชั่วโมง ถ้าเรียกฟังก์ชันไม่ได้)
  async function bizToday() {
    const sb = client();
    if (sb && typeof sb.rpc === 'function') {
      try {
        const { data, error } = await sb.rpc('biz_today');
        if (!error && data) return String(data).slice(0, 10);
      } catch (err) { /* ใช้ค่าจากเครื่องแทน */ }
    }
    const ms = Date.now() + 7 * 3600 * 1000;
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }

  async function catalogue(force) {
    const sb = client();
    if (!sb || typeof sb.from !== 'function') return [];
    try {
      return await loadCatalogue(sb, !!force);
    } catch (err) {
      return [];
    }
  }

  function resetCache() {
    catalogueCache = null;
    cataloguePromise = null;
  }

  return {
    id: 'live',
    label: 'ข้อมูลจริง (ฐานข้อมูล)',
    isLive: true,
    detailView: DETAIL_VIEW,
    summaryView: SUMMARY_VIEW,
    rangeFunction: RANGE_FUNCTION,
    flagsFunction: FLAGS_FUNCTION,
    migrationFile: MIGRATION,
    loadRange,
    availabilityForDay,
    bizToday,
    catalogue,
    resetCache,
  };
})();

if (typeof window !== 'undefined') window.BookingLiveProvider = BookingLiveProvider;
