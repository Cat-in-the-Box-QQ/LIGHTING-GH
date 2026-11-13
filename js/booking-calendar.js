// js/booking-calendar.js
// ---------------------------------------------------------------------------
// ปฏิทินจองอุปกรณ์
//
// มุมมอง: "เดือน" (ค่าเริ่มต้น) = รางเลื่อนแนวนอน 12 เดือน เลื่อนซ้าย-ขวาได้
//         "ปี"               = ภาพรวม 12 เดือนย่อในจอเดียว
// ในตารางวันจะแสดง "สี" เท่านั้น (ไม่ใส่ชื่อ/ตัวเลขให้รก) — สีคือคนจอง
// กดวันที่ → แผงล่างแสดง "ใบงาน" เป็นการ์ด พร้อมตารางรวมทั้งวัน
//
// หลักการ 4 ข้อที่ยึดไว้ตลอดไฟล์นี้:
//
// 1) **ใช้ "ข้อความวันที่" (YYYY-MM-DD) เป็นตัวเชื่อมเสมอ ไม่ส่ง Date object ข้ามฟังก์ชัน**
//    new Date('2026-11-15') ถูกตีความเป็น UTC แล้ว toISOString() บนเครื่องที่เวลา
//    ท้องถิ่นติดลบจะเลื่อนเป็นวันก่อนหน้า → ปฏิทินเพี้ยน 1 วันแบบสุ่มตามเครื่องผู้ใช้
//
// 2) **สีของคนจองต้อง "ถาวร"** — ผูกกับตัวตนของคน ไม่ผูกกับลำดับที่เจอในเซสชัน
//    ลำดับความสำคัญ: hue ที่บันทึกไว้ในฐานข้อมูล (members.color_hue) → ถ้ายังไม่มี
//    จึงคำนวณจาก hash ของ id คนนั้น (ได้ค่าเดิมเสมอทุกเครื่องทุกเซสชัน)
//    เหตุผลที่ต้องเก็บใน DB: hash อย่างเดียวการันตีได้แค่ "ไม่เปลี่ยน" แต่การันตี
//    "ไม่ซ้ำกัน" ไม่ได้ — ถ้ามีสมาชิกสองคน hash ลงช่องใกล้กัน สีจะดูคล้ายกัน
//    การเก็บ hue ไว้จึงเป็นทางเดียวที่ให้ทั้งถาวรและแยกกันชัด
//
// 3) **ทุกข้อความที่มาจากข้อมูล (ชื่อคน ชื่องาน ชื่ออุปกรณ์) ผ่าน escapeHtml() ก่อนลง HTML**
//
// 4) **ยอดคงเหลือของวันหนึ่งต้องหัก "ทุกใบจอง" ของวันนั้นพร้อมกัน** เพราะวันเดียว
//    มีคนจองหลายคนได้ — ถ้าโชว์ทีละใบ ผู้ใช้จะคิดว่าของยังเหลือทั้งที่เต็มแล้ว
// ---------------------------------------------------------------------------

const BookingCalendar = (() => {
  const TH_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const TH_MONTHS_LONG = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  const TH_DOW_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  const TH_DOW_LONG = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

  const STATUS_LABEL = {
    reserved: 'จองไว้',
    checked_out: 'จ่ายออกแล้ว',
    overdue: 'ค้างคืน',
    cancelled: 'ยกเลิก',
  };

  // ---- สถานะของหน้า --------------------------------------------------------
  const state = {
    provider: null,
    view: 'month',                // month (รางเลื่อน) | year (ภาพรวมย่อ)
    anchorISO: null,              // วันที่อ้างอิง (กำหนดว่าเดือนไหนอยู่กลางจอ)
    selectedISO: null,            // วันที่กำลังดูในแผงใบงาน
    personFilter: null,           // id คนที่กรองอยู่ (null = ดูทุกคน)
    loading: false,
    lastError: null,
    data: null,
    yearCache: new Map(),         // year -> payload
    hueById: new Map(),           // personId -> hue (จำไว้ทั้งเซสชันเพื่อความเร็วนิดหน่อย)
    knownPeople: [],
    unknownStockCount: 0,
  };

  // ---- ตัวช่วยเรื่องวันที่ (ไม่ใช้ toISOString เด็ดขาด) ----------------------
  function pad2(n) { return String(n).padStart(2, '0'); }

  function isoOf(year, month1, day) { return `${year}-${pad2(month1)}-${pad2(day)}`; }

  function splitISO(iso) {
    const p = String(iso || '').split('-').map(Number);
    return { y: p[0] || 1970, m: (p[1] || 1) - 1, d: p[2] || 1 };
  }

  function dateOf(iso) { const p = splitISO(iso); return new Date(p.y, p.m, p.d); }

  function toISO(date) { return isoOf(date.getFullYear(), date.getMonth() + 1, date.getDate()); }

  function todayISO() { return toISO(new Date()); }

  function addDays(iso, n) {
    const d = dateOf(iso);
    d.setDate(d.getDate() + n);
    return toISO(d);
  }

  function addMonths(iso, n) {
    const p = splitISO(iso);
    return toISO(new Date(p.y, p.m + n, 1));
  }

  function addYears(iso, n) {
    const p = splitISO(iso);
    return isoOf(p.y + n, p.m + 1, 1);
  }

  function dayDiff(fromISO, toISO) {
    return Math.round((dateOf(toISO) - dateOf(fromISO)) / 86400000);
  }

  // พ.ศ. = ค.ศ. + 543 (ไม่ใช้ Intl เพราะผลลัพธ์ขึ้นกับ locale ของเครื่องผู้ใช้)
  function thYear(iso) { return splitISO(iso).y + 543; }

  function thDateLong(iso) {
    const p = splitISO(iso);
    return `${TH_DOW_LONG[dateOf(iso).getDay()]} ${p.d} ${TH_MONTHS_LONG[p.m]} ${p.y + 543}`;
  }

  function thDateShort(iso) {
    const p = splitISO(iso);
    return `${p.d} ${TH_MONTHS_SHORT[p.m]}`;
  }

  function monthLabel(year, month0) { return `${TH_MONTHS_LONG[month0]} ${year + 543}`; }

  // ---- สีของคนจอง (ถาวรต่อคน) ----------------------------------------------
  function hashString(text) {
    let h = 2166136261;
    const s = String(text == null ? '' : text);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // มุมทอง 137.508° → hue ถัดไปห่างจาก hue ก่อนหน้าเสมอ
  function hueAt(index) { return Math.round((index * 137.508) % 360); }

  // hue สำรองเมื่อฐานข้อมูลยังไม่เก็บสีไว้ — คำนวณจาก id จึงได้ค่าเดิมเสมอ
  function hueFromKey(key) { return hueAt(hashString(key) % 360); }

  function hueOfPerson(person) {
    const id = String((person && (person.id || person.personId)) || person || '');
    const stored = Number(person && (person.hue ?? person.color_hue ?? person.member_hue));
    if (Number.isFinite(stored) && stored >= 0 && stored < 360) return Math.round(stored);
    if (!state.hueById.has(id)) state.hueById.set(id, hueFromKey(id));
    return state.hueById.get(id);
  }

  function cssOf(hue, sat, light) { return `hsl(${hue}, ${sat}%, ${light}%)`; }

  function colorOfPerson(person) { return cssOf(hueOfPerson(person), 62, 45); }

  function softColorOfPerson(person) { return cssOf(hueOfPerson(person), 72, 95); }

  function inkColorOfPerson(person) { return cssOf(hueOfPerson(person), 65, 27); }

  // หาข้อมูลคนจาก id (เพื่อดู hue ที่ provider ส่งมา)
  function personById(id) {
    const key = String(id || '');
    return state.knownPeople.find((p) => String(p.id) === key) || { id: key, name: key, hue: null };
  }

  function colorOf(personId) { return colorOfPerson(personById(personId)); }

  function shortName(fullName) {
    const s = String(fullName || '').trim();
    if (!s) return 'ไม่ระบุชื่อ';
    const head = s.split(/\s+/)[0];
    return head.length > 12 ? `${head.slice(0, 12)}…` : head;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- โหลดข้อมูล ----------------------------------------------------------
  function quarterRanges(year) {
    // โหลดทีละไตรมาส เพราะฟังก์ชันฝั่ง SQL จะจำกัดช่วงไม่เกิน 92 วัน
    return [
      [isoOf(year, 1, 1), isoOf(year, 3, 31)],
      [isoOf(year, 4, 1), isoOf(year, 6, 30)],
      [isoOf(year, 7, 1), isoOf(year, 9, 30)],
      [isoOf(year, 10, 1), isoOf(year, 12, 31)],
    ];
  }

  async function loadYear(year) {
    if (state.yearCache.has(year)) return state.yearCache.get(year);
    const provider = state.provider;
    const today = todayISO();
    const chunks = await Promise.all(
      quarterRanges(year).map(([from, to]) => provider.loadRange(from, to, today)),
    );

    const failed = chunks.find((c) => !c || c.ok !== true);
    if (failed) {
      return { ok: false, source: provider.id, error: (failed && failed.error) || { short: 'โหลดข้อมูลไม่สำเร็จ', detail: '', hint: '' } };
    }

    const days = {};
    const peopleById = new Map();
    let itemCount = 0;
    let unknownStockCount = 0;

    chunks.forEach((chunk) => {
      Object.keys(chunk.days || {}).forEach((iso) => { days[iso] = chunk.days[iso]; });
      (chunk.people || []).forEach((p) => {
        if (!peopleById.has(p.id)) {
          peopleById.set(p.id, {
            id: p.id,
            name: p.name,
            hue: Number.isFinite(Number(p.hue)) ? Number(p.hue) : null,
            count: 0,
          });
        }
        peopleById.get(p.id).count += Number(p.count || 0);
      });
      itemCount = Math.max(itemCount, Number(chunk.itemCount || 0));
      unknownStockCount = Math.max(unknownStockCount, Number(chunk.unknownStockCount || 0));
    });

    const people = [...peopleById.values()].sort(
      (a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name), 'th'),
    );

    const payload = { ok: true, source: provider.id, year, days, people, itemCount, unknownStockCount };
    state.yearCache.set(year, payload);
    return payload;
  }

  async function ensureData() {
    const year = splitISO(state.anchorISO).y;
    state.loading = true;
    state.lastError = null;
    renderAll();
    try {
      const payload = await loadYear(year);
      if (!payload.ok) {
        state.data = null;
        state.lastError = payload.error;
      } else {
        state.data = payload;
        state.knownPeople = payload.people;
        state.unknownStockCount = payload.unknownStockCount || 0;
      }
    } catch (err) {
      state.data = null;
      state.lastError = {
        short: 'ปฏิทินทำงานผิดพลาด',
        detail: String((err && err.message) || err),
        hint: 'ลองรีเฟรชหน้า หรือสลับกลับไปโหมดข้อมูลตัวอย่าง',
      };
    } finally {
      state.loading = false;
      renderAll();
      if (state.view === 'month') scrollToAnchorMonth(false);
    }
  }

  // ---- สรุปข้อมูลของหนึ่งวัน (นับรวมทุกใบจองของวันนั้น) --------------------
  function summarizeDay(day) {
    const bookings = (day && Array.isArray(day.bookings) ? day.bookings : [])
      .filter((b) => b && b.status !== 'cancelled');

    const itemMap = new Map();
    const personIds = [];
    let qtyTotal = 0;

    bookings.forEach((b) => {
      const pid = String(b.personId || b.member_id || '');
      if (pid && !personIds.includes(pid)) personIds.push(pid);
      (b.items || []).forEach((it) => {
        const key = `${it.itemType}:${it.itemId}`;
        if (!itemMap.has(key)) {
          itemMap.set(key, {
            itemType: it.itemType,
            itemId: it.itemId,
            itemName: it.itemName || `#${it.itemId}`,
            stock: it.stock === null || it.stock === undefined ? null : Number(it.stock),
            booked: 0,
            outCount: 0,
            lines: 0,
            people: [],
          });
        }
        const row = itemMap.get(key);
        const qty = Math.max(Number(it.quantity || 0) - Number(it.returnedQuantity || it.returned_quantity || 0), 0);
        row.booked += qty;
        row.lines += 1;
        qtyTotal += qty;
        if (pid && !row.people.includes(pid)) row.people.push(pid);
        if (b.status === 'checked_out' || b.status === 'overdue') row.outCount += qty;
      });
    });

    const items = [...itemMap.values()].map((row) => ({
      ...row,
      available: row.stock === null ? null : Math.max(row.stock - row.booked, 0),
      stockUnknown: row.stock === null,
      soldOut: row.stock !== null && row.stock - row.booked <= 0,
    }));

    return {
      iso: day ? day.iso : null,
      bookings,
      personIds,
      bookingCount: bookings.length,
      peopleCount: personIds.length,
      itemCount: items.length,
      qtyTotal,
      items,
      soldOutItems: items.filter((i) => i.soldOut),
      unknownItems: items.filter((i) => i.stockUnknown),
      hasOverdue: bookings.some((b) => b.status === 'overdue'),
    };
  }

  function daySummary(iso) {
    const day = state.data && state.data.days ? state.data.days[iso] : null;
    return summarizeDay(day || { iso, bookings: [] });
  }

  function visibleBookings(summary) {
    if (!state.personFilter) return summary.bookings;
    return summary.bookings.filter((b) => String(b.personId) === state.personFilter);
  }

  // ---- จุดสีของช่องวัน (เหมือนแสตมป์กลมเล็ก มุมล่างของช่อง) ----------------
  // 1 คน = 1 จุด · หลายคนจองวันเดียวกัน = หลายจุดเรียงกัน (ไม่เกิน MAX_DOTS จุด
  // ถ้าเกินจะปิดท้ายด้วย "จุดโปร่ง" เพื่อบอกว่ายังมีอีก โดยไม่ต้องใส่ตัวเลขในช่อง)
  // · ว่าง = ไม่มีจุด
  const MAX_DOTS = 5;

  function personIdsOf(summary) {
    const ids = [];
    visibleBookings(summary).forEach((b) => {
      const pid = String(b.personId || '');
      if (pid && !ids.includes(pid)) ids.push(pid);
    });
    return ids;
  }

  // มุมมองปีช่องเล็กมาก ใส่หลายจุดไม่ไหว → ใช้จุดเดียวแบ่งสีเป็นเสี้ยววงกลม
  function conicStyle(ids) {
    if (ids.length === 1) return `background:${colorOf(ids[0])}`;
    const step = 100 / ids.length;
    const stops = ids.map((pid, i) => `${colorOf(pid)} ${(i * step).toFixed(2)}% ${((i + 1) * step).toFixed(2)}%`);
    return `background:conic-gradient(${stops.join(', ')})`;
  }

  function dayDotsHtml(summary, options = {}) {
    const ids = personIdsOf(summary);
    if (!ids.length) return '';

    if (options.single) {
      return `<span class="cal-dots"><i class="cal-dot" style="${escapeHtml(conicStyle(ids))}"></i></span>`;
    }

    const overflow = ids.length > MAX_DOTS;
    const shown = ids.slice(0, overflow ? MAX_DOTS - 1 : MAX_DOTS);
    const dots = shown.map((pid) => `<i class="cal-dot" style="background:${escapeHtml(colorOf(pid))}" title="${escapeHtml(personById(pid).name || pid)}"></i>`).join('');
    return `<span class="cal-dots">${dots}${overflow ? '<i class="cal-dot cal-dot-more" title="มีอีก"></i>' : ''}</span>`;
  }

  // ---- เรนเดอร์: แถบเครื่องมือ --------------------------------------------
  function rangeTitle() {
    const p = splitISO(state.anchorISO);
    if (state.view === 'year') return `ภาพรวมปี ${p.y + 543}`;
    return monthLabel(p.y, p.m);
  }

  function renderToolbar() {
    const title = document.getElementById('calTitle');
    if (title) title.textContent = rangeTitle();

    [['calViewMonth', 'month'], ['calViewYear', 'year']].forEach(([id, v]) => {
      const btn = document.getElementById(id);
      if (btn) btn.classList.toggle('active', state.view === v);
    });

    const jump = document.getElementById('calJump');
    if (jump && document.activeElement !== jump) jump.value = state.anchorISO;

    const filterNote = document.getElementById('calFilterNote');
    if (filterNote) {
      if (state.personFilter) {
        const person = personById(state.personFilter);
        filterNote.innerHTML = `กำลังกรองเฉพาะ <strong style="color:${escapeHtml(colorOfPerson(person))}">${escapeHtml(person.name || 'คนที่เลือก')}</strong> <button type="button" class="btn btn-sm btn-link p-0 ms-1" data-cal-action="clear-filter">ดูทุกคน</button>`;
        filterNote.hidden = false;
      } else {
        filterNote.innerHTML = '';
        filterNote.hidden = true;
      }
    }
  }

  // ---- เรนเดอร์: ลูกศรเลื่อนข้างปฏิทิน (ให้เห็นชัด ๆ ว่าเลื่อนเดือนได้) -----
  // ป้ายบอกล่วงหน้าว่ากดแล้วจะไปเจออะไร — มุมมองเดือนบอกชื่อเดือน
  // มุมมองปีบอก พ.ศ. จึงไม่ต้องเดาว่าลูกศรจะพาไปที่ไหน
  function renderStageArrows() {
    const prev = document.getElementById('calPrevMonth');
    const next = document.getElementById('calNextMonth');
    if (!prev || !next) return;

    const hasData = !!state.data && state.data.ok === true && !state.loading;
    prev.hidden = !hasData;
    next.hidden = !hasData;
    if (!hasData) return;

    const p = splitISO(state.anchorISO);
    if (state.view === 'year') {
      prev.innerHTML = `<span class="cal-arrow">‹</span><span class="cal-arrow-label">${p.y + 542}<small>ปีก่อน</small></span>`;
      next.innerHTML = `<span class="cal-arrow-label">${p.y + 544}<small>ปีถัดไป</small></span><span class="cal-arrow">›</span>`;
      prev.setAttribute('aria-label', `ดูก่อนหน้า ปี ${p.y + 542}`);
      next.setAttribute('aria-label', `ดูถัดไป ปี ${p.y + 544}`);
      prev.title = `ภาพรวมปี ${p.y + 542} (←)`;
      next.title = `ภาพรวมปี ${p.y + 544} (→)`;
      return;
    }

    const prevP = splitISO(addMonths(state.anchorISO, -1));
    const nextP = splitISO(addMonths(state.anchorISO, 1));
    prev.innerHTML = `<span class="cal-arrow">‹</span><span class="cal-arrow-label">${escapeHtml(TH_MONTHS_SHORT[prevP.m])}<small>${prevP.y + 543}</small></span>`;
    next.innerHTML = `<span class="cal-arrow-label">${escapeHtml(TH_MONTHS_SHORT[nextP.m])}<small>${nextP.y + 543}</small></span><span class="cal-arrow">›</span>`;
    prev.setAttribute('aria-label', `เดือน${TH_MONTHS_LONG[prevP.m]} ${prevP.y + 543}`);
    next.setAttribute('aria-label', `เดือน${TH_MONTHS_LONG[nextP.m]} ${nextP.y + 543}`);
    prev.title = `${monthLabel(prevP.y, prevP.m)} (←)`;
    next.title = `${monthLabel(nextP.y, nextP.m)} (→)`;
  }

  // ---- เรนเดอร์: ป้ายสถานะแหล่งข้อมูล --------------------------------------
  function renderBanner() {
    const box = document.getElementById('calBanner');
    if (!box) return;
    const provider = state.provider;

    if (state.lastError) {
      box.className = 'cal-banner cal-banner-warn';
      box.innerHTML = `
        <div class="cal-banner-title">⚠️ ${escapeHtml(state.lastError.short || 'อ่านข้อมูลไม่สำเร็จ')}</div>
        ${state.lastError.detail ? `<div class="cal-banner-detail">${escapeHtml(state.lastError.detail)}</div>` : ''}
        ${state.lastError.hint ? `<div class="cal-banner-hint">${escapeHtml(state.lastError.hint)}</div>` : ''}`;
      box.hidden = false;
      return;
    }

    if (!provider || provider.isLive) { box.hidden = true; return; }

    box.className = 'cal-banner cal-banner-demo';
    box.innerHTML = `
      <div class="cal-banner-title">🎨 โหมดข้อมูลตัวอย่าง — ยังไม่ได้อ่านจากฐานข้อมูล</div>
      <div class="cal-banner-detail">ใบจองในปฏิทินนี้ถูกจำลองขึ้นเพื่อดูหน้าตาเท่านั้น (ชื่อคนและชื่องานไม่ใช่ข้อมูลจริง) แต่<strong>ชื่ออุปกรณ์และจำนวนสต็อกเป็นของจริง</strong>จากคลังของคุณ จึงเห็นได้ว่าการจองทับกันทำให้ของหมดหน้าตาเป็นยังไง · สีของคนจองถูกกำหนดตายตัวไว้ จึงไม่เปลี่ยนทุกครั้งที่รีเฟรช</div>
      <div class="cal-banner-hint">สลับเป็นข้อมูลจริงได้เมื่อรัน SQL สร้าง view สรุปปฏิทินแล้ว — ปุ่ม "ข้อมูลจริง" ด้านบน</div>`;
    box.hidden = false;
  }

  // ---- เรนเดอร์: แถบสถิติ ---------------------------------------------------
  function renderStats() {
    const box = document.getElementById('calStats');
    if (!box) return;
    if (!state.data || !state.data.ok) { box.innerHTML = ''; return; }

    const isos = Object.keys(state.data.days).sort();
    let bookingTotal = 0;
    let qtyTotal = 0;
    let soldOutDays = 0;
    let overdueCount = 0;
    let multiPeopleDays = 0;
    const busy = [];

    isos.forEach((iso) => {
      const s = daySummary(iso);
      bookingTotal += s.bookingCount;
      qtyTotal += s.qtyTotal;
      if (s.soldOutItems.length) soldOutDays += 1;
      if (s.hasOverdue) overdueCount += 1;
      if (s.peopleCount > 1) multiPeopleDays += 1;
      if (s.bookingCount) busy.push({ iso, count: s.bookingCount, soldOut: s.soldOutItems.length });
    });

    busy.sort((a, b) => b.soldOut - a.soldOut || b.count - a.count);
    const busiest = busy[0];

    const cards = [
      { label: `ใบจองปี ${thYear(state.anchorISO)}`, value: bookingTotal.toLocaleString('th-TH'), sub: `${isos.length} วันที่มีการจอง` },
      { label: 'ชิ้นที่ถูกจองรวม', value: qtyTotal.toLocaleString('th-TH'), sub: `คลังมี ${state.data.itemCount || 0} รายการ` },
      { label: 'วันที่ของหมด', value: soldOutDays.toLocaleString('th-TH'), sub: 'ถูกจองจนไม่เหลือ', tone: soldOutDays ? 'bad' : 'good' },
      { label: 'วันที่หลายคนจองตรงกัน', value: multiPeopleDays.toLocaleString('th-TH'), sub: overdueCount ? `มีของค้างคืน ${overdueCount} วัน` : 'ไม่มีของค้างคืน', tone: overdueCount ? 'warn' : 'good' },
    ];

    box.innerHTML = cards.map((c) => `
      <div class="col-6 col-lg-3">
        <div class="cal-stat ${c.tone ? `cal-stat-${c.tone}` : ''}">
          <div class="cal-stat-value">${escapeHtml(c.value)}</div>
          <div class="cal-stat-label">${escapeHtml(c.label)}</div>
          <div class="cal-stat-sub">${escapeHtml(c.sub)}</div>
        </div>
      </div>`).join('') + (busiest ? `
      <div class="col-12">
        <div class="cal-stat-note">วันที่แน่นที่สุดของปี <button type="button" class="btn btn-sm btn-link p-0" data-cal-action="select" data-iso="${escapeHtml(busiest.iso)}">${escapeHtml(thDateLong(busiest.iso))}</button> — ${busiest.count} ใบจอง${busiest.soldOut ? ` · ของหมด ${busiest.soldOut} รายการ` : ''}</div>
      </div>` : '');
  }

  // ---- เรนเดอร์: คำอธิบายสี (คลิกเพื่อกรอง) -------------------------------
  function renderLegend() {
    const box = document.getElementById('calLegend');
    if (!box) return;
    if (!state.data || !state.data.ok || !state.knownPeople.length) { box.innerHTML = ''; return; }

    box.innerHTML = `
      <div class="cal-legend-title">สี = คนจอง (สีผูกถาวรกับแต่ละคน ไม่เปลี่ยนตามการรีเฟรช) · คลิกชื่อเพื่อดูเฉพาะคนนั้น</div>
      <div class="cal-legend-list">
        ${state.knownPeople.map((p) => {
          const active = state.personFilter === p.id;
          const dim = state.personFilter && !active;
          return `<button type="button" class="cal-legend-chip ${active ? 'is-active' : ''} ${dim ? 'is-dim' : ''}"
            data-cal-action="filter" data-person="${escapeHtml(p.id)}"
            style="--pc:${escapeHtml(colorOfPerson(p))};--pc-soft:${escapeHtml(softColorOfPerson(p))};--pc-ink:${escapeHtml(inkColorOfPerson(p))}"
            title="กรองเฉพาะ ${escapeHtml(p.name)} (${p.count} ใบจองในปี ${escapeHtml(String(thYear(state.anchorISO)))})">
            <span class="cal-legend-dot"></span>
            <span class="cal-legend-name">${escapeHtml(p.name)}</span>
            <span class="cal-legend-count">${p.count}</span>
          </button>`;
        }).join('')}
      </div>
      <div class="cal-legend-key">
        <span class="cal-key-item"><span class="cal-key-swatch cal-key-free"></span>ว่าง</span>
        <span class="cal-key-item"><span class="cal-key-swatch cal-key-multi"></span>หลายคนจองวันเดียวกัน (ช่องแบ่งสี)</span>
        <span class="cal-key-item"><span class="cal-key-swatch cal-key-full"></span>กรอบแดง = มีรายการถูกจองจนหมด</span>
        <span class="cal-key-item"><span class="cal-key-swatch cal-key-overdue"></span>กรอบแดงปรุ = มีของค้างคืน</span>
        <span class="cal-key-item"><span class="cal-key-swatch cal-key-today"></span>กรอบเหลือง = วันนี้</span>
      </div>`;
  }

  // ---- เรนเดอร์: ช่องวันหนึ่งช่อง (แสดงแค่สี + เลขวัน) ---------------------
  function dayCellClasses(iso, summary, extra) {
    const cls = ['cal-day', extra || ''];
    if (iso === todayISO()) cls.push('is-today');
    if (iso === state.selectedISO) cls.push('is-selected');
    if (!summary.bookingCount) cls.push('is-free');
    else if (summary.soldOutItems.length) cls.push('is-full');
    else cls.push('is-booked');
    if (summary.hasOverdue) cls.push('is-overdue');
    if (personIdsOf(summary).length > 1) cls.push('is-multi');
    if (state.personFilter && summary.bookingCount && !summary.personIds.includes(state.personFilter)) cls.push('is-dim');
    return cls.filter(Boolean).join(' ');
  }

  function dayCellHtml(iso, summary, extra) {
    const p = splitISO(iso);
    const titleParts = [thDateLong(iso)];
    if (!summary.bookingCount) titleParts.push('ว่าง — ยังไม่มีใบจอง');
    else {
      titleParts.push(`${summary.bookingCount} ใบจอง · ${summary.peopleCount} คน · ${summary.qtyTotal} ชิ้น`);
      summary.bookings.forEach((b) => titleParts.push(`${b.personName}: ${b.jobName}`));
      if (summary.soldOutItems.length) titleParts.push(`⚠ ของหมด ${summary.soldOutItems.length} รายการ: ${summary.soldOutItems.map((i) => i.itemName).join(', ')}`);
      if (summary.hasOverdue) titleParts.push('⧸ มีของค้างคืนยังไม่กลับคลัง');
    }
    const single = /mini/.test(String(extra || ''));
    return `<button type="button" class="${dayCellClasses(iso, summary, extra)}"
        data-cal-action="select" data-iso="${escapeHtml(iso)}"
        aria-label="${escapeHtml(titleParts.join(' — '))}"
        title="${escapeHtml(titleParts.join('\n'))}">
        <span class="cal-day-num">${p.d}</span>
        ${dayDotsHtml(summary, { single })}
      </button>`;
  }

  // ---- เรนเดอร์: มุมมองเดือน = รางเลื่อน 12 เดือน --------------------------
  function monthPaneHtml(year, month0) {
    const first = isoOf(year, month0 + 1, 1);
    const gridStart = addDays(first, -dateOf(first).getDay());
    const cells = [];

    for (let i = 0; i < dateOf(first).getDay(); i += 1) {
      cells.push('<span class="cal-day is-blank"></span>');
    }
    const daysInMonth = new Date(year, month0 + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = isoOf(year, month0 + 1, day);
      cells.push(dayCellHtml(iso, daySummary(iso), ''));
    }
    while (cells.length % 7 !== 0) cells.push('<span class="cal-day is-blank"></span>');

    const bookedDays = Object.keys(state.data ? state.data.days : {})
      .filter((iso) => { const q = splitISO(iso); return q.y === year && q.m === month0; }).length;

    return `
      <section class="cal-pane" data-month="${month0}" data-year="${year}" aria-label="${escapeHtml(monthLabel(year, month0))}">
        <header class="cal-pane-head">
          <span class="cal-pane-month">${escapeHtml(TH_MONTHS_LONG[month0])}</span>
          <span class="cal-pane-year">${year + 543}</span>
          <span class="cal-pane-count">${bookedDays ? `มีจอง ${bookedDays} วัน` : 'ว่างทั้งเดือน'}</span>
        </header>
        <div class="cal-dow-row">
          ${TH_DOW_SHORT.map((d) => `<span>${escapeHtml(d)}</span>`).join('')}
        </div>
        <div class="cal-pane-grid">${cells.join('')}</div>
      </section>`;
  }

  function renderMonthTrack() {
    const year = splitISO(state.anchorISO).y;
    const panes = [];
    for (let m = 0; m < 12; m += 1) panes.push(monthPaneHtml(year, m));
    return panes.join('');
  }

  // ---- เรนเดอร์: มุมมองปี (ภาพรวมย่อ 12 เดือน) -----------------------------
  function renderYear() {
    const year = splitISO(state.anchorISO).y;
    const blocks = [];

    for (let m = 0; m < 12; m += 1) {
      const first = isoOf(year, m + 1, 1);
      const daysInMonth = new Date(year, m + 1, 0).getDate();
      const cells = [];
      for (let i = 0; i < dateOf(first).getDay(); i += 1) cells.push('<span class="cal-day cal-day-mini is-blank"></span>');
      for (let day = 1; day <= daysInMonth; day += 1) {
        const iso = isoOf(year, m + 1, day);
        cells.push(dayCellHtml(iso, daySummary(iso), 'cal-day-mini'));
      }
      const bookedDays = Object.keys(state.data.days)
        .filter((iso) => { const q = splitISO(iso); return q.y === year && q.m === m; }).length;

      blocks.push(`
        <div class="cal-mini">
          <div class="cal-mini-head">
            <span class="cal-mini-month">${escapeHtml(TH_MONTHS_SHORT[m])}</span>
            <span class="cal-mini-year">${year + 543}</span>
            <button type="button" class="cal-mini-open" data-cal-action="open-month" data-month="${m}" data-year="${year}"
              title="เปิดดู ${escapeHtml(monthLabel(year, m))} แบบเต็ม">${bookedDays ? `${bookedDays} วัน` : 'ว่าง'}</button>
          </div>
          <div class="cal-mini-dow">
            ${TH_DOW_SHORT.map((d) => `<span>${escapeHtml(d)}</span>`).join('')}
          </div>
          <div class="cal-mini-grid">${cells.join('')}</div>
        </div>`);
    }

    return `
      <div class="cal-year-hint">
        ภาพรวมทั้งปี ${year + 543} — แต่ละช่องคือหนึ่งวัน สีคือคนจอง
        กดปุ่มเดือนมุมขวาบนของช่องเพื่อดูเดือนนั้นแบบเต็ม หรือกดวันที่เพื่อดูใบงาน
      </div>
      ${blocks.join('')}`;
  }

  function renderGrid() {
    const wrap = document.getElementById('calGrid');
    const track = document.getElementById('calTrack');
    const yearGrid = document.getElementById('calYearGrid');
    const loading = document.getElementById('calLoading');
    if (!wrap || !track || !yearGrid || !loading) return;

    const hasData = !!state.data && state.data.ok === true;

    loading.hidden = !(state.loading || !hasData);
    if (state.loading) loading.textContent = 'กำลังโหลดข้อมูลปฏิทิน…';
    else if (!hasData) {
      loading.textContent = state.lastError ? state.lastError.short : 'ยังไม่มีข้อมูล';
      loading.classList.add('cal-loading-error');
    } else loading.classList.remove('cal-loading-error');

    track.hidden = state.view !== 'month' || !hasData;
    yearGrid.hidden = state.view !== 'year' || !hasData;
    wrap.className = `cal-grid-wrap cal-view-${state.view}`;

    if (!hasData) { track.innerHTML = ''; yearGrid.innerHTML = ''; return; }
    if (state.view === 'month') {
      track.innerHTML = renderMonthTrack();
      // จำปีไว้ให้ scrollToAnchorMonth / syncAnchorToTrack หาแผงที่ถูกต้องได้
      track.setAttribute('data-year', String(splitISO(state.anchorISO).y));
    } else {
      yearGrid.innerHTML = renderYear();
    }
  }

  // ---- เลื่อนรางให้เดือนที่ดูอยู่มากลางจอ -----------------------------------
  let suppressSync = false;
  let syncTimer = null;

  function scrollToAnchorMonth(smooth) {
    const track = document.getElementById('calTrack');
    if (!track || track.hidden) return;
    const p = splitISO(state.anchorISO);
    const pane = track.querySelector(`.cal-pane[data-month="${p.m}"]`);
    if (!pane) return;
    suppressSync = true;
    const target = pane.offsetLeft - Math.max((track.clientWidth - pane.clientWidth) / 2, 0);
    if (smooth && typeof track.scrollTo === 'function') {
      track.scrollTo({ left: Math.max(target, 0), behavior: 'smooth' });
      setTimeout(() => { suppressSync = false; }, 620);
    } else {
      track.scrollLeft = Math.max(target, 0);
      setTimeout(() => { suppressSync = false; }, 40);
    }
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncAnchorToTrack, 140);
  }

  // เลื่อนรางด้วยมือ → ให้หัวข้อและปุ่มเลื่อนตามเดือนที่อยู่กลางจอ
  function syncAnchorToTrack() {
    const track = document.getElementById('calTrack');
    if (!track || track.hidden) return;
    const panes = track.querySelectorAll('.cal-pane');
    if (!panes.length) return;
    const center = track.scrollLeft + track.clientWidth / 2;
    let best = null;
    let bestDist = Infinity;
    panes.forEach((pane) => {
      const mid = pane.offsetLeft + pane.clientWidth / 2;
      const dist = Math.abs(mid - center);
      if (dist < bestDist) { bestDist = dist; best = pane; }
    });
    if (!best) return;
    const year = Number(best.getAttribute('data-year'));
    const month = Number(best.getAttribute('data-month'));
    const iso = isoOf(year, month + 1, 1);
    if (iso !== addMonths(state.anchorISO, 0)) {
      state.anchorISO = iso;
      renderToolbar();
    }
  }

  // ---- เรนเดอร์: แผงใบงาน ---------------------------------------------------
  function jobCardHtml(b) {
    const person = personById(b.personId);
    const dim = state.personFilter && String(b.personId) !== state.personFilter;
    const pieces = (b.items || []).reduce((sum, it) => sum + Math.max(Number(it.quantity || 0), 0), 0);
    return `
      <article class="cal-job ${dim ? 'is-dim' : ''}"
        style="--pc:${escapeHtml(colorOfPerson(person))};--pc-soft:${escapeHtml(softColorOfPerson(person))};--pc-ink:${escapeHtml(inkColorOfPerson(person))}">
        <header class="cal-job-head">
          <span class="cal-job-dot"></span>
          <span class="cal-job-person">${escapeHtml(b.personName || person.name || 'ไม่ระบุชื่อ')}</span>
          <span class="cal-status cal-status-${escapeHtml(String(b.status || 'reserved'))}">${escapeHtml(STATUS_LABEL[b.status] || b.status || 'จองไว้')}</span>
        </header>
        <div class="cal-job-title">${escapeHtml(b.jobName || 'ไม่ระบุชื่องาน')}</div>
        ${b.jobLocation ? `<div class="cal-job-loc">📍 ${escapeHtml(b.jobLocation)}</div>` : ''}
        <table class="cal-job-items">
          <tbody>
            ${(b.items || []).map((it) => {
              const qty = Math.max(Number(it.quantity || 0) - Number(it.returnedQuantity || it.returned_quantity || 0), 0);
              return `<tr>
                <td class="cal-job-item-name">${escapeHtml(it.itemName || `#${it.itemId}`)}</td>
                <td class="cal-job-item-qty">${qty} ชิ้น</td>
                <td class="cal-job-item-stock">${it.stock === null || it.stock === undefined ? '<span class="cal-unknown">ไม่ระบุจำนวน</span>' : `มี ${escapeHtml(String(it.stock))}`}</td>
              </tr>`;
            }).join('') || '<tr><td colspan="3" class="cal-empty-line">ไม่มีรายการในใบนี้</td></tr>'}
          </tbody>
        </table>
        <footer class="cal-job-foot">
          <span>${(b.items || []).length} รายการ · ${pieces} ชิ้น</span>
          <span class="cal-job-code">${escapeHtml(String(b.id || '').slice(-6).toUpperCase())}</span>
        </footer>
        ${b.note ? `<div class="cal-job-note">📝 ${escapeHtml(b.note)}</div>` : ''}
      </article>`;
  }

  function dayTotalTableHtml(s) {
    if (!s.items.length) return '';
    const rows = s.items.slice().sort((a, b) => {
      if (a.soldOut !== b.soldOut) return a.soldOut ? -1 : 1;
      if (a.stockUnknown !== b.stockUnknown) return a.stockUnknown ? 1 : -1;
      const ra = a.available === null ? 9999 : a.available;
      const rb = b.available === null ? 9999 : b.available;
      return ra - rb || String(a.itemName).localeCompare(String(b.itemName), 'th');
    });
    return `
      <div class="cal-total">
        <div class="cal-total-title">รวมทุกใบจองของวันนั้น — ของเหลือเท่าไหร่</div>
        <div class="cal-total-note">วันนี้มี ${s.peopleCount} คนจอง ยอดด้านล่างหักของทุกใบแล้ว จึงเห็นจริงว่าเหลือให้คนอื่นอีกเท่าไหร่</div>
        <div class="table-responsive">
          <table class="table table-sm cal-total-table">
            <thead>
              <tr><th>รายการ</th><th class="text-end">มี</th><th class="text-end">ติดจอง</th><th class="text-end">เหลือ</th><th>สถานะ</th><th>ใครจอง</th></tr>
            </thead>
            <tbody>
              ${rows.map((r) => `<tr class="${r.soldOut ? 'row-sold-out' : ''} ${r.stockUnknown ? 'row-unknown' : ''}">
                <td>${escapeHtml(r.itemName)}</td>
                <td class="text-end">${r.stock === null ? '—' : escapeHtml(String(r.stock))}</td>
                <td class="text-end">${r.booked}</td>
                <td class="text-end"><strong>${r.available === null ? '—' : r.available}</strong></td>
                <td>${r.stockUnknown
                  ? '<span class="cal-tag cal-tag-unknown">ยังไม่ระบุจำนวน — จองไม่ได้</span>'
                  : r.soldOut
                    ? '<span class="cal-tag cal-tag-full">หมดแล้ว</span>'
                    : r.available !== null && r.stock !== null && r.available <= Math.max(1, Math.floor(r.stock * 0.25))
                      ? '<span class="cal-tag cal-tag-tight">เหลือน้อย</span>'
                      : '<span class="cal-tag cal-tag-ok">ยังเหลือ</span>'}</td>
                <td class="cal-total-who">${r.people.map((pid) => `<i class="cal-who-dot" style="background:${escapeHtml(colorOf(pid))}" title="${escapeHtml(personById(pid).name || pid)}"></i>`).join('')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // ---- ใครกดจองได้บ้าง (อ่านจาก AdminAuth — ไม่เดา ไม่เปิดให้กดแล้วพัง) -------
  function bookingCapability() {
    const A = typeof window !== 'undefined' ? window.AdminAuth : null;
    if (!A || typeof A.isLoggedIn !== 'function') {
      return { ready: false, isAdmin: false, reason: 'ยังโหลดระบบ sign in ไม่ได้', href: 'admin.html' };
    }
    let loggedIn = false;
    let role = '';
    let member = null;
    try { loggedIn = !!A.isLoggedIn(); } catch (e) { loggedIn = false; }
    try { role = String(A.getRole() || ''); } catch (e) { role = ''; }
    try { member = A.getMember ? A.getMember() : null; } catch (e) { member = null; }

    if (!loggedIn) return { ready: false, isAdmin: false, reason: 'ต้อง sign in ก่อนจองอุปกรณ์', href: 'admin.html' };
    if (!role) return { ready: false, isAdmin: false, reason: 'ยังไม่ทราบสิทธิ์ของบัญชีนี้', href: 'admin.html' };
    if (!member || !member.id) {
      return { ready: false, isAdmin: role === 'admin', reason: 'ไม่พบบัญชีของคุณในตาราง members — ให้ admin เพิ่มรายชื่อก่อน', href: 'admin.html' };
    }
    return { ready: true, isAdmin: role === 'admin', reason: '', href: '' };
  }

  function bookDayButtonHtml(iso) {
    const cap = bookingCapability();
    const demoMode = !state.provider || state.provider.id !== 'live';
    if (!cap.ready) {
      return `<a class="btn btn-outline-dark btn-sm" href="${escapeHtml(cap.href)}"
        title="${escapeHtml(cap.reason)}">จองของวันนี้ — ต้อง sign in</a>`;
    }
    const title = demoMode
      ? 'ปฏิทินด้านบนกำลังแสดงข้อมูลตัวอย่าง แต่ใบจองนี้จะบันทึกลงฐานข้อมูลจริง'
      : 'เปิดฟอร์มสร้างใบจองของวันนั้น';
    return `<button type="button" class="btn btn-dark btn-sm" data-cal-action="book-day" data-iso="${escapeHtml(iso)}"
      title="${escapeHtml(title)}">จองของวันนี้</button>`;
  }

  function selectedDayHtml(s) {
    const shown = visibleBookings(s);
    return `
      <div class="cal-detail-head">
        <div>
          <div class="cal-detail-date">${escapeHtml(thDateLong(s.iso))}</div>
          <div class="cal-detail-meta">
            ${s.bookingCount ? `${s.bookingCount} ใบงาน · ${s.peopleCount} คน · ${s.itemCount} รายการ · ${s.qtyTotal} ชิ้น` : 'ไม่มีใบจองวันนี้ — ของว่างทั้งหมด'}
          </div>
        </div>
        <div class="cal-detail-actions">
          ${bookDayButtonHtml(s.iso)}
          <a class="btn btn-outline-dark btn-sm" href="inventory.html">Inventory วันนี้</a>
          <button type="button" class="btn btn-outline-secondary btn-sm" data-cal-action="close-detail">ปิด</button>
        </div>
      </div>

      ${s.bookingCount && !shown.length ? '<div class="cal-empty-line">วันนี้ไม่มีใบงานของคนที่คุณกรองไว้</div>' : ''}
      <div class="cal-job-grid">${shown.map(jobCardHtml).join('')}</div>
      ${s.bookingCount > shown.length && state.personFilter ? `<div class="cal-detail-more">วันนั้นมีอีก ${s.bookingCount - shown.length} ใบงานของคนอื่น — <button type="button" class="btn btn-sm btn-link p-0" data-cal-action="clear-filter">ดูทุกคน</button></div>` : ''}
      ${dayTotalTableHtml(s)}
      ${state.unknownStockCount ? `<div class="cal-unknown-note">ℹ️ คลังนี้มีอีก <strong>${state.unknownStockCount}</strong> รายการที่ยังไม่ระบุจำนวนในสต็อก → จองไม่ได้ ต้องให้ admin เติมจำนวนก่อน</div>` : ''}`;
  }

  function rangeSummaryHtml() {
    const isos = Object.keys(state.data.days).sort();
    const soldOutByDay = isos.map((iso) => ({ iso, s: daySummary(iso) }))
      .filter((x) => x.s.soldOutItems.length)
      .sort((a, b) => b.s.soldOutItems.length - a.s.soldOutItems.length)
      .slice(0, 8);

    const itemHits = new Map();
    isos.forEach((iso) => {
      daySummary(iso).soldOutItems.forEach((it) => {
        const key = `${it.itemType}:${it.itemId}`;
        if (!itemHits.has(key)) itemHits.set(key, { itemName: it.itemName, days: 0 });
        itemHits.get(key).days += 1;
      });
    });
    const hotItems = [...itemHits.values()].sort((a, b) => b.days - a.days).slice(0, 8);

    const upcoming = isos.filter((iso) => dayDiff(todayISO(), iso) >= 0).slice(0, 12);

    return `
      <div class="cal-detail-head">
        <div>
          <div class="cal-detail-date">ภาพรวม ${escapeHtml(rangeTitle())}</div>
          <div class="cal-detail-meta">กดวันที่บนปฏิทินเพื่อดูใบงานของวันนั้น</div>
        </div>
      </div>

      <div class="cal-columns">
        <div class="cal-block">
          <div class="cal-block-title">🔴 วันที่ของจะหมด</div>
          ${soldOutByDay.length ? `<ul class="cal-list">${soldOutByDay.map((x) => `
            <li><button type="button" class="cal-link" data-cal-action="select" data-iso="${escapeHtml(x.iso)}">${escapeHtml(thDateShort(x.iso))}</button>
              <span class="cal-list-sub">${x.s.soldOutItems.length} รายการหมด · ${x.s.bookingCount} ใบงาน · ${escapeHtml(x.s.soldOutItems.slice(0, 2).map((i) => i.itemName).join(', '))}${x.s.soldOutItems.length > 2 ? ' …' : ''}</span></li>`).join('')}</ul>`
            : '<div class="cal-empty-line">ไม่มีวันไหนที่ของถูกจองจนหมด</div>'}
        </div>

        <div class="cal-block">
          <div class="cal-block-title">🔥 อุปกรณ์ที่ถูกจองจนหมดบ่อยที่สุด</div>
          ${hotItems.length ? `<ul class="cal-list">${hotItems.map((i) => `
            <li><span class="cal-list-main">${escapeHtml(i.itemName)}</span><span class="cal-list-sub">หมด ${i.days} วันในปี ${escapeHtml(String(thYear(state.anchorISO)))}</span></li>`).join('')}</ul>`
            : '<div class="cal-empty-line">ยังไม่มีรายการไหนถูกจองจนหมด</div>'}
        </div>

        <div class="cal-block">
          <div class="cal-block-title">📅 วันถัดไปที่มีการจอง</div>
          ${upcoming.length ? `<div class="cal-day-chips">${upcoming.map((iso) => {
            const s = daySummary(iso);
            return `<button type="button" class="cal-day-chip ${s.soldOutItems.length ? 'is-full' : ''}" data-cal-action="select" data-iso="${escapeHtml(iso)}"
              title="${escapeHtml(`${thDateLong(iso)} — ${s.bookingCount} ใบงาน`)}">
              <span class="cal-day-chip-date">${escapeHtml(thDateShort(iso))}</span>
              <span class="cal-day-chip-dots">${s.personIds.slice(0, 4).map((id) => `<i style="background:${escapeHtml(colorOf(id))}"></i>`).join('')}</span>
              <span class="cal-day-chip-count">${s.bookingCount}</span>
            </button>`;
          }).join('')}</div>` : '<div class="cal-empty-line">ยังไม่มีใบจองล่วงหน้า</div>'}
        </div>
      </div>`;
  }

  function renderDetail() {
    const box = document.getElementById('calDetail');
    if (!box) return;

    if (state.loading || !state.data || !state.data.ok) {
      box.innerHTML = '';
      box.hidden = true;
      return;
    }

    box.hidden = false;
    box.innerHTML = state.selectedISO ? selectedDayHtml(daySummary(state.selectedISO)) : rangeSummaryHtml();
  }

  // ---- เรนเดอร์ทั้งหมด ------------------------------------------------------
  function renderAll() {
    renderBanner();
    renderToolbar();
    renderStageArrows();
    renderStats();
    renderLegend();
    renderGrid();
    renderDetail();
  }

  // ---- การควบคุม ------------------------------------------------------------
  function setView(view) {
    if (!['month', 'year'].includes(view)) return;
    state.view = view;
    renderAll();
    if (view === 'month') scrollToAnchorMonth(false);
  }

  function step(direction) {
    if (state.view === 'year') {
      state.anchorISO = addYears(state.anchorISO, direction);
      ensureData();
      return;
    }
    const next = addMonths(state.anchorISO, direction);
    const yearChanged = splitISO(next).y !== splitISO(state.anchorISO).y;
    state.anchorISO = next;
    if (yearChanged) ensureData();          // ข้ามปี → โหลดข้อมูลปีใหม่
    else { renderAll(); scrollToAnchorMonth(true); }
  }

  function goToday() {
    state.anchorISO = todayISO();
    state.selectedISO = todayISO();
    if (state.view === 'year') { ensureData(); return; }
    renderAll();
    scrollToAnchorMonth(true);
  }

  function goTo(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return;
    const yearChanged = splitISO(iso).y !== splitISO(state.anchorISO).y;
    state.anchorISO = iso;
    state.selectedISO = iso;
    if (yearChanged || state.view === 'year') ensureData();
    else { renderAll(); scrollToAnchorMonth(true); }
  }

  function selectDay(iso) {
    state.selectedISO = iso;
    if (splitISO(iso).y !== splitISO(state.anchorISO).y) { state.anchorISO = iso; ensureData(); return; }
    renderAll();
    const detail = document.getElementById('calDetail');
    if (detail && typeof detail.scrollIntoView === 'function') {
      detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function closeDetail() {
    state.selectedISO = null;
    renderAll();
  }

  function setFilter(personId) {
    state.personFilter = state.personFilter === personId ? null : personId;
    renderAll();
  }

  function clearFilter() {
    state.personFilter = null;
    renderAll();
  }

  function openMonth(month, year) {
    state.view = 'month';
    state.anchorISO = isoOf(Number(year), Number(month) + 1, 1);
    if (splitISO(state.anchorISO).y !== (state.data && state.data.year)) ensureData();
    else { renderAll(); scrollToAnchorMonth(true); }
  }

  async function setProvider(provider) {
    if (!provider) return;
    state.provider = provider;
    state.yearCache.clear();
    state.data = null;
    state.lastError = null;
    state.hueById.clear();
    document.querySelectorAll('[data-cal-source]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-cal-source') === provider.id);
    });
    await ensureData();
  }

  // ---- ผูกเหตุการณ์ --------------------------------------------------------
  // เปิดฟอร์มสร้างใบจองจริงของวันนั้น แล้วให้ปฏิทินดึงข้อมูลใหม่เมื่อบันทึกเสร็จ
  function openBookingForm(iso) {
    const F = typeof window !== 'undefined' ? window.BookingForm : null;
    if (!F || typeof F.open !== 'function') {
      state.lastError = {
        short: 'ยังโหลดฟอร์มจองไม่ได้',
        detail: 'window.BookingForm ไม่มีอยู่ — js/booking-form.js ยังไม่ได้ถูกโหลดในหน้านี้',
        hint: 'ตรวจว่า booking.html มี <script src="js/booking-form.js"> อยู่ก่อน js/booking-calendar.js',
      };
      renderAll();
      return Promise.resolve(false);
    }
    const demoMode = !state.provider || state.provider.id !== 'live';
    return F.open({
      date: iso,
      demoContext: demoMode,
      onSaved: () => { refresh(); },
    });
  }

  // ล้างแคชแล้วดึงข้อมูลปีนั้นใหม่ — เรียกหลังบันทึก/ยกเลิกใบจอง
  function refresh() {
    state.yearCache.clear();
    state.hueById.clear();
    return ensureData();
  }

  function bindEvents() {
    let justDragged = false;

    // ลากแล้วปล่อย = ไม่ใช่การคลิก (กันกดวันผิดตอนลากเลื่อนราง)
    document.addEventListener('click', (event) => {
      if (justDragged) {
        justDragged = false;
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);

    document.addEventListener('click', (event) => {
      const el = event.target.closest ? event.target.closest('[data-cal-action]') : null;
      if (!el) return;
      const action = el.getAttribute('data-cal-action');
      const iso = el.getAttribute('data-iso');
      if (action === 'select' && iso) { event.preventDefault(); selectDay(iso); }
      else if (action === 'open-month') { event.preventDefault(); openMonth(el.getAttribute('data-month'), el.getAttribute('data-year')); }
      else if (action === 'filter') { event.preventDefault(); setFilter(el.getAttribute('data-person')); }
      else if (action === 'clear-filter') { event.preventDefault(); clearFilter(); }
      else if (action === 'close-detail') { event.preventDefault(); closeDetail(); }
      else if (action === 'book-day' && iso) { event.preventDefault(); openBookingForm(iso); }
    });

    const on = (id, type, handler, opts) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(type, handler, opts);
    };

    on('calViewMonth', 'click', () => setView('month'));
    on('calViewYear', 'click', () => setView('year'));
    on('calPrev', 'click', () => step(-1));
    on('calNext', 'click', () => step(1));
    // ลูกศรใหญ่ข้างปฏิทิน — ทำหน้าที่เดียวกับ ‹ › ในแถบเครื่องมือ แต่เห็นชัดกว่า
    on('calPrevMonth', 'click', () => step(-1));
    on('calNextMonth', 'click', () => step(1));
    on('calToday', 'click', () => goToday());
    on('calJump', 'change', (e) => goTo(e.target.value));

    document.querySelectorAll('[data-cal-source]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const which = btn.getAttribute('data-cal-source');
        if (which === 'live' && typeof window !== 'undefined' && window.BookingLiveProvider) setProvider(window.BookingLiveProvider);
        else if (which === 'demo' && typeof window !== 'undefined' && window.BookingDemoProvider) setProvider(window.BookingDemoProvider);
      });
    });

    // --- รางเลื่อน: ลากด้วยเมาส์ / หมุนล้อ / จอสัมผัส ---
    const track = document.getElementById('calTrack');
    if (track) {
      let drag = null;

      track.addEventListener('scroll', () => {
        if (suppressSync) return;
        scheduleSync();
      });

      track.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        drag = { x: event.clientX, left: track.scrollLeft, moved: false };
      });

      track.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const dx = event.clientX - drag.x;
        if (Math.abs(dx) > 5) {
          drag.moved = true;
          suppressSync = true;
          track.scrollLeft = drag.left - dx;
          track.classList.add('is-dragging');
        }
      });

      const endDrag = () => {
        if (drag && drag.moved) {
          justDragged = true;
          setTimeout(() => { justDragged = false; }, 0);
          track.classList.remove('is-dragging');
          setTimeout(() => { suppressSync = false; syncAnchorToTrack(); }, 120);
        }
        drag = null;
      };
      track.addEventListener('pointerup', endDrag);
      track.addEventListener('pointercancel', endDrag);
      track.addEventListener('pointerleave', endDrag);

      // หมุนล้อเมาส์ → เลื่อนรางแนวนอน (แต่ปล่อยหน้าเลื่อนต่อเมื่อสุดรางแล้ว)
      track.addEventListener('wheel', (event) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        const max = track.scrollWidth - track.clientWidth;
        if (max <= 0) return;
        if ((track.scrollLeft <= 0 && event.deltaY < 0) || (track.scrollLeft >= max - 1 && event.deltaY > 0)) return;
        event.preventDefault();
        suppressSync = true;
        track.scrollLeft += event.deltaY;
        scheduleSync();
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => { suppressSync = false; syncAnchorToTrack(); }, 180);
      }, { passive: false });
    }

    // ลูกศรซ้าย/ขวา เลื่อนเดือนได้ · T = วันนี้
    document.addEventListener('keydown', (event) => {
      const tag = String((event.target && event.target.tagName) || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 't' || event.key === 'T') goToday();
      else if (event.key === 'Escape') closeDetail();
    });
  }

  function init(options = {}) {
    const provider = options.provider || (typeof window !== 'undefined' ? window.BookingDemoProvider : null);
    state.provider = provider || null;
    state.view = ['month', 'year'].includes(options.view) ? options.view : 'month';
    state.anchorISO = /^\d{4}-\d{2}-\d{2}$/.test(String(options.today || '')) ? options.today : todayISO();
    state.selectedISO = null;
    bindEvents();
    document.querySelectorAll('[data-cal-source]').forEach((btn) => {
      btn.classList.toggle('active', state.provider && btn.getAttribute('data-cal-source') === state.provider.id);
    });
    return ensureData();
  }

  return {
    init,
    setView,
    setProvider,
    goTo,
    goToday,
    selectDay,
    closeDetail,
    openMonth,
    openBookingForm,
    refresh,
    // เปิดให้เทสต์เรียกดูได้
    _state: state,
    _helpers: {
      isoOf, toISO, addDays, addMonths, addYears, splitISO, dayDiff,
      thDateLong, thDateShort, thYear, monthLabel,
      hueAt, hueFromKey, hueOfPerson, colorOf, colorOfPerson, shortName, escapeHtml,
      summarizeDay, dayDotsHtml, conicStyle, personIdsOf, dayCellHtml, monthPaneHtml,
      rangeTitle, todayISO, renderStageArrows, renderYear, MAX_DOTS,
      bookingCapability, bookDayButtonHtml,
    },
  };
})();

if (typeof window !== 'undefined') window.BookingCalendar = BookingCalendar;
