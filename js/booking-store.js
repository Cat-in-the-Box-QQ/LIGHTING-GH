// booking-store.js - ชั้นข้อมูลของระบบจอง (ฝั่งอ่าน "ยอดคงเหลือ")
//
// อ่านจาก view public.v_item_availability ใน Supabase ซึ่งคำนวณมาจาก
// ตาราง bookings + booking_items (ดู supabase/migration-2026-11-13c-bookings.sql)
//
// ทำไมเว็บไม่คำนวณเอง
// --------------------
// จำนวนที่ติดจองต้องมาจากฐานข้อมูลเท่านั้น เพราะเป็นตัวเลขเดียวกันกับที่
// trigger ใช้ตัดสินใจว่า "จองเกินไหม" ถ้าเว็บคำนวณเองจะได้เลขคนละก้อน
// และผู้ใช้จะเห็น "เหลือ 2" ทั้งที่กดจองแล้วโดนปฏิเสธ
//
// ไฟล์นี้ "อ่านอย่างเดียว" — ไม่มีการเขียนใด ๆ ทั้งสิ้น
// (การสร้างใบจองจะมาพร้อมกับหน้า booking.html ในรอบถัดไป)
//
// โหมดการทำงาน
// ------------
// ต่างจาก store ตัวอื่น: "ไม่มีโหมด local" เพราะข้อมูลจองในเครื่องไม่มีประโยชน์
// (จองใน localStorage = คนอื่นไม่เห็น และกันจองเกินไม่ได้)
// ถ้าอ่าน view ไม่ได้ (ยังไม่ได้รัน SQL / เน็ตหลุด) จะคืนค่า null ทุกคำถาม
// -> การ์ดอุปกรณ์จะแสดงเหมือนเดิมทุกประการ แค่ไม่มีบรรทัดยอดจอง
//    (จงใจ: ระบบจองต้องไม่ทำให้หน้าเว็บที่ใช้ได้อยู่แล้วพังตามไปด้วย)

const BookingStore = (() => {
  const VIEW_FALLBACK = 'v_item_availability';

  // key = "fixture:12" / "accessory:3" — ใช้คู่ (ชนิด, id) เหมือนคอลัมน์ในตาราง
  // เพราะ fixtures กับ accessories มี id ซ้ำกันได้ (fixture id 1 กับ accessory id 1)
  const byKey = new Map();

  let mode = 'none';        // 'supabase' | 'none'
  let lastError = null;
  let loadedAt = null;
  let rowCount = 0;
  let inflight = null;

  function viewName() {
    return (window.SUPABASE_TABLES && window.SUPABASE_TABLES.itemAvailability) || VIEW_FALLBACK;
  }

  function keyOf(itemType, itemId) {
    return `${itemType === 'accessory' ? 'accessory' : 'fixture'}:${String(itemId)}`;
  }

  // เลขจาก PostgREST อาจมาเป็น string (คอลัมน์ numeric) — แปลงไม่สำเร็จต้องได้ null
  // ห้ามแปลเป็น 0 เพราะ 0 แปลว่า "ของหมด" ส่วน null แปลว่า "ยังไม่ระบุจำนวน"
  function toNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function toIntOrZero(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(Math.trunc(n), 0) : 0;
  }

  function describeError(err) {
    if (!err) return null;
    const msg = String(err.message || err.msg || err).trim();
    if (/relation .* does not exist|42P01/i.test(msg)) {
      return `ไม่พบ view "${viewName()}" ใน Supabase`
        + ' — ต้องรัน supabase/migration-2026-11-13c-bookings.sql ก่อน ระบบจองถึงจะโชว์ยอดคงเหลือ';
    }
    if (/column .* does not exist|42703/i.test(msg)) {
      return `view "${viewName()}" ขาดคอลัมน์: ${msg}`
        + ' — รัน supabase/migration-2026-11-13c-bookings.sql ใหม่';
    }
    if (/row-level security|permission denied|42501/i.test(msg)) {
      return `ไม่มีสิทธิ์อ่าน "${viewName()}" — ตรวจ grant select ใน migration ของระบบจอง`;
    }
    if (/Failed to fetch|NetworkError|fetch failed|ERR_NETWORK|timeout/i.test(msg)) {
      return 'เชื่อมต่อ Supabase ไม่ได้ (เน็ตหลุด / URL ผิด / project ถูก pause)';
    }
    if (/Invalid API key|JWT|401|403/i.test(msg)) {
      return 'API key ไม่ถูกต้องหรือหมดอายุ — ตรวจ SUPABASE_ANON_KEY ใน js/supabase-config.js';
    }
    return msg;
  }

  function normalizeRow(row) {
    const itemType = String(row.item_type || 'fixture') === 'accessory' ? 'accessory' : 'fixture';
    const stock = toNumberOrNull(row.stock);
    const booked = toIntOrZero(row.booked);
    const outCount = toIntOrZero(row.out_count ?? row.outCount);
    // stock_unknown มาจากฐานข้อมูล แต่ถ้าคอลัมน์หาย (view รุ่นเก่า) ให้เทียบ stock เอง
    const stockUnknown = row.stock_unknown === true || row.stock_unknown === 'true' || stock === null;
    const available = stock === null ? null : Math.max(stock - booked, 0);
    return {
      itemType,
      itemId: String(row.item_id),
      itemName: row.item_name === null || row.item_name === undefined ? '' : String(row.item_name),
      stock,
      booked,
      outCount,
      reserved: Math.max(booked - outCount, 0),
      available,
      stockUnknown,
      hidden: row.hidden === true || row.hidden === 'true',
    };
  }

  async function readFromSupabase() {
    if (!window.sb) {
      throw new Error((window.SB_DIAG && window.SB_DIAG.error) || 'Supabase client ไม่พร้อมใช้งาน');
    }
    // supabase-js v2: builder เป็น PromiseLike — ใช้ await + try/catch เท่านั้น
    // ห้าม .then().catch() เพราะจะพังเงียบ ๆ (เคยเจอมาแล้วในโค้ดชุดเดิม)
    const { data, error } = await window.sb.from(viewName()).select('*');
    if (error) throw new Error(describeError(error) || error.message);
    return data || [];
  }

  // โหลดยอดคงเหลือ — เรียกซ้ำได้ ไม่ยิง query ซ้อนกัน (มี inflight guard)
  // ไม่ throw: หน้าเว็บต้องไม่พังเพราะระบบจองโหลดไม่ได้ ให้ดูเหตุผลจาก status()
  async function load({ force = false } = {}) {
    if (mode === 'supabase' && !force) return byKey.size;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        if (!window.sb) {
          mode = 'none';
          lastError = (window.SB_DIAG && window.SB_DIAG.error) || 'Supabase client ไม่พร้อมใช้งาน';
          return 0;
        }
        if (window.SUPABASE_DISABLED === true) {
          mode = 'none';
          lastError = 'SUPABASE_DISABLED = true จึงไม่อ่านยอดจอง';
          return 0;
        }
        const rows = await readFromSupabase();
        byKey.clear();
        rows.forEach((raw) => {
          const item = normalizeRow(raw);
          byKey.set(keyOf(item.itemType, item.itemId), item);
        });
        mode = 'supabase';
        rowCount = byKey.size;
        lastError = null;
        loadedAt = new Date().toISOString();
        return rowCount;
      } catch (err) {
        mode = 'none';
        lastError = describeError(err) || (err && err.message) || String(err);
        return 0;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  // ============================ อ่าน ============================
  // คืน null เสมอเมื่อไม่รู้ (ยังไม่โหลด / อ่านไม่ได้ / ไม่มีรายการนี้)
  // ผู้เรียกจึงต้องแยก "ไม่มีข้อมูล" ออกจาก "มี 0 ชิ้น" ให้ได้
  function get(itemType, itemId) {
    if (itemId === null || itemId === undefined || itemId === '') return null;
    return byKey.get(keyOf(itemType, itemId)) || null;
  }

  // การ์ดใน equipment.html ใช้ data-key เป็น "fixture-12" / "accessory-3"
  function getByCardKey(cardKey) {
    const m = /^(fixture|accessory)-(.+)$/.exec(String(cardKey || ''));
    if (!m) return null;
    return get(m[1], m[2]);
  }

  // Set Builder เก็บ id เป็น "12" (อุปกรณ์) / "a3" (อุปกรณ์เสริม)
  function getBySetId(setId) {
    const s = String(setId || '');
    if (!s) return null;
    return s.startsWith('a') ? get('accessory', s.slice(1)) : get('fixture', s);
  }

  function isReady() {
    return mode === 'supabase';
  }

  // จำนวนรายการที่ยังไม่ระบุจำนวน (จองไม่ได้) — หน้า admin ใช้เตือนว่าต้องไปกรอกเพิ่ม
  function unknownStockItems() {
    return [...byKey.values()].filter((i) => i.stockUnknown);
  }

  function counts() {
    const all = [...byKey.values()];
    return {
      total: all.length,
      unknownStock: all.filter((i) => i.stockUnknown).length,
      withBooking: all.filter((i) => i.booked > 0).length,
      outNow: all.filter((i) => i.outCount > 0).length,
      bookedTotal: all.reduce((sum, i) => sum + i.booked, 0),
    };
  }

  function status() {
    return {
      view: viewName(),
      mode,
      isSupabase: mode === 'supabase',
      error: lastError,
      count: rowCount,
      loadedAt,
    };
  }

  return {
    load,
    get,
    getByCardKey,
    getBySetId,
    isReady,
    unknownStockItems,
    counts,
    status,
    keyOf,
  };
})();
