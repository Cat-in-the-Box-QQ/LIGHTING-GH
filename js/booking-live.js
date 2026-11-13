// js/booking-live.js
// ---------------------------------------------------------------------------
// แหล่งข้อมูล "จริง" สำหรับปฏิทินจอง — อ่านจากฐานข้อมูล Supabase
//
// สถานะตอนนี้: **ยังใช้ไม่ได้** เพราะ view/ฟังก์ชันฝั่ง SQL ยังไม่ได้ถูกสร้าง
// (ต้องรัน supabase/migration-2026-11-13d-booking-calendar.sql ก่อน) ไฟล์นี้จึง
// เขียนไว้ให้ครบรูป และ "บอกตรง ๆ" ว่าขาดอะไร — ไม่เดา ไม่เติมค่าเอง ไม่เงียบ
//
// ทำไมไม่ใช้ v_item_availability ที่มีอยู่แล้ว: view นั้นนับเฉพาะ
// booking_date = current_date (ภาพของวันนี้วันเดียว) จึงตอบคำถาม
// "ของชิ้นนี้ว่างวันไหน" ไม่ได้ — ปฏิทินต้องการข้อมูลรายวันย้อน/ล่วงหน้า
// ---------------------------------------------------------------------------

const BookingLiveProvider = (() => {
  const DAY_SUMMARY_VIEW = 'v_booking_day_summary';
  const DETAIL_FUNCTION = 'item_availability_between';

  function describeError(err) {
    const msg = String((err && (err.message || err.msg)) || err || 'ไม่ทราบสาเหตุ').trim();
    if (/relation .* does not exist/i.test(msg)) {
      return {
        short: 'ยังไม่มีตาราง/วิวที่ปฏิทินต้องใช้ในฐานข้อมูล',
        detail: msg,
        hint: `ต้องรัน supabase/migration-2026-11-13d-booking-calendar.sql เพื่อสร้าง ${DAY_SUMMARY_VIEW} และ ${DETAIL_FUNCTION}() ก่อน`,
      };
    }
    if (/permission denied/i.test(msg)) {
      return {
        short: 'บัญชีนี้ไม่มีสิทธิ์อ่านข้อมูลปฏิทิน',
        detail: msg,
        hint: 'ตรวจ grant ของวิวใน migration หรือ sign in ด้วยบัญชี crew/admin ที่มีอยู่ในตาราง members',
      };
    }
    return { short: 'อ่านข้อมูลปฏิทินจากฐานข้อมูลไม่สำเร็จ', detail: msg, hint: 'ตรวจการเชื่อมต่อเน็ตเวิร์กหรือ key ใน js/supabase-config.js' };
  }

  async function loadRange(fromISO, toISO, todayISO) {
    const sb = typeof window !== 'undefined' ? window.sb : null;
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
      // 1) สรุปปฏิทินรายวัน — แถวเล็ก (~120 แถว) ยิงครั้งเดียว
      const { data: summary, error: sumErr } = await sb
        .from(DAY_SUMMARY_VIEW)
        .select('*');
      if (sumErr) throw sumErr;

      // 2) รายเอียดรายชิ้นของช่วงที่ดู — ใช้ฟังก์ชันที่รับช่วงวันที่
      //    (rpc เพราะ view รับพารามิเตอร์ไม่ได้)
      const { data: detail, error: detErr } = await sb
        .rpc(DETAIL_FUNCTION, { d_from: fromISO, d_to: toISO });
      if (detErr) throw detErr;

      // ถ้ามาถึงตรงนี้ = migration ถูกรันแล้ว → ประกอบข้อมูลตามรูปเดียวกับ demo provider
      const days = {};
      (Array.isArray(detail) ? detail : []).forEach((row) => {
        const iso = String(row.day || '').slice(0, 10);
        if (!iso) return;
        if (!days[iso]) days[iso] = { iso, bookings: [] };
        // รายละเอียดรายวันจะถูกประกอบเป็นใบจองในขั้น integration รอบถัดไป
        days[iso].bookings.push(row);
      });

      const peopleMap = new Map();
      (Array.isArray(summary) ? summary : []).forEach((row) => {
        const pid = String(row.member_id || row.person_id || '');
        if (!pid) return;
        if (!peopleMap.has(pid)) {
          peopleMap.set(pid, {
            id: pid,
            name: row.member_name || row.person_name || pid,
            // สีประจำตัวมาจาก members.color_hue → ถาวรต่อคน ไม่สลับเมื่อมีคนใหม่เพิ่ม
            // ถ้ายังเป็น null ปฏิทินจะคำนวณจาก hash ของ id ให้เอง
            hue: row.member_hue === null || row.member_hue === undefined ? null : Number(row.member_hue),
            count: 0,
          });
        }
        peopleMap.get(pid).count += Number(row.booking_count || 0);
      });
      const people = [...peopleMap.values()];

      return { ok: true, source: 'live', from: fromISO, to: toISO, days, people };
    } catch (err) {
      return { ok: false, source: 'live', error: describeError(err) };
    }
  }

  return {
    id: 'live',
    label: 'ข้อมูลจริง (ฐานข้อมูล)',
    isLive: true,
    daySummaryView: DAY_SUMMARY_VIEW,
    detailFunction: DETAIL_FUNCTION,
    loadRange,
  };
})();

if (typeof window !== 'undefined') window.BookingLiveProvider = BookingLiveProvider;
