// js/booking-admin.js
// ---------------------------------------------------------------------------
// แผงจัดการใบจองสำหรับ admin (อยู่ในหน้า admin.html)
//
// งานที่แผงนี้ทำให้เสร็จได้จากหน้าเว็บ (เดิมต้องทำผ่าน SQL Editor เท่านั้น)
//   1. คิว "ต้องตรวจของคืน"  — ใบที่เลยวันจองแล้วยังไม่ถูกปักว่าค้างคืน
//   2. รับของออกจากคลัง      — reserved  -> checked_out
//   3. ปักค้างคืน            — ของไม่กลับคลังจริง -> overdue (จะกินสต็อกทุกวัน)
//   4. บันทึกว่าคืนครบ       — rpc settle_booking() เติม returned_quantity ทุกรายการ
//                              แล้วปลด overdue -> ของกลับเข้าคลัง
//   5. ยกเลิกใบจอง           — -> cancelled (ไม่นับสต็อกอีก)
//   6. แก้วัน/ชื่องาน/สถานที่/หมายเหตุ และแก้จำนวนต่อรายการ
//   7. นับรายการที่ยังไม่ระบุจำนวนในสต็อก (= จองไม่ได้) พร้อมทางไปแก้
//
// ความปลอดภัย: แพงนี้ "ซ่อน" จาก crew เท่านั้น ไม่ใช่กำแพงจริง — กำแพงจริงคือ RLS
// และ trigger ฝั่งฐานข้อมูล (crew อ่านใบจองของคนอื่นไม่เห็น แก้ returned_quantity
// ไม่ได้ และเรียก settle_booking() ไม่ผ่าน)
//
// เว็บไม่คำนวณยอดคงเหลือเองเลย — อ่านจาก view/ฟังก์ชันก้อนเดียวกับที่ trigger
// ใช้ตัดสิน จึงไม่มีทางที่หน้าจอจะบอกอย่างหนึ่งแล้วฐานข้อมูลทำอีกอย่าง
// ---------------------------------------------------------------------------

const BookingAdmin = (() => {
  const STATUS_TH = {
    reserved: 'จองไว้',
    checked_out: 'จ่ายของแล้ว',
    overdue: 'ค้างคืน',
    cancelled: 'ยกเลิก',
  };
  const STATUS_CLASS = {
    reserved: 'is-reserved',
    checked_out: 'is-out',
    overdue: 'is-overdue',
    cancelled: 'is-cancelled',
  };
  const PAGE_SIZE = 200;      // กันดึงทั้งตารางลงมาในเบราว์เซอร์
  const AHEAD_DAYS = 7;       // โชว์ยอด 7 วันข้างหน้า

  let st = {
    ready: false,
    loading: false,
    saving: false,
    error: null,
    message: null,
    bookings: [],
    itemsByBooking: new Map(),
    membersById: new Map(),
    stale: [],
    ahead: [],
    todayISO: '',
    counts: { overdue: 0, stale: 0, todayItems: 0, todayQty: 0 },
    unknown: [],
    filter: { status: '', scope: 'upcoming' },
    editing: null,
  };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  function shiftISO(iso, days) {
    const p = String(iso || '').split('-').map(Number);
    if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return iso;
    const ms = Date.UTC(p[0], p[1] - 1, p[2]) + days * 86400000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

  function thDateShort(iso) {
    const p = String(iso || '').split('-').map(Number);
    if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return iso || '';
    return `${p[2]} ${THAI_MONTHS[p[1] - 1]} ${String(p[0] + 543).slice(-2)}`;
  }

  function statusTh(s) { return STATUS_TH[s] || s || '—'; }

  function hueOf(memberId) {
    const m = st.membersById.get(String(memberId || ''));
    const h = m && m.color_hue;
    return h === null || h === undefined ? null : num(h, null);
  }

  function personDot(memberId) {
    const m = st.membersById.get(String(memberId || ''));
    const name = (m && (m.full_name || m.code)) || 'ไม่ระบุชื่อ';
    const h = hueOf(memberId);
    const dot = h === null ? '' : `<i class="bkad-dot" style="background:hsl(${h},62%,45%)"></i>`;
    return `${dot}<span class="bkad-person">${esc(name)}</span>`;
  }

  function describeError(err) {
    const raw = String((err && (err.message || err.msg)) || err || 'ไม่ทราบสาเหตุ');
    if (/relation .* does not exist/i.test(raw)) {
      return `${raw} — ต้องรัน supabase/migration-2026-11-13d-booking-calendar.sql และ -13e-booking-admin.sql ก่อน`;
    }
    if (/function .* does not exist/i.test(raw)) {
      return `${raw} — ต้องรัน supabase/migration-2026-11-13d/-13e ก่อน (ยังไม่มีฟังก์ชันฝั่งฐานข้อมูล)`;
    }
    if (/permission denied|42501/i.test(raw)) {
      return 'บัญชีนี้ไม่มีสิทธิ์ทำงานนี้ — แผงจัดการใบจองเป็นของ admin เท่านั้น';
    }
    if (/jwt|token|401/i.test(raw)) return 'เซสชันหมดอายุ — กรุณา sign in ใหม่';
    return raw;
  }

  function client() { return typeof window !== 'undefined' ? window.sb : null; }

  // ---- โหลดข้อมูล -----------------------------------------------------------
  // จงใจยิงเป็น query แยกกัน (ไม่ใช้ embedded select) เพราะ predictable กว่า
  // และถ้าตารางไหนพังจะรู้ว่าพังตรงไหน ไม่ใช่ได้ error ก้อนเดียวที่เดายาก
  async function load() {
    const sb = client();
    if (!sb || typeof sb.from !== 'function') {
      st.error = 'ยังเชื่อมต่อ Supabase ไม่ได้ — ตรวจกล่อง "การเชื่อมต่อ Supabase" ด้านบนของหน้านี้';
      st.ready = false;
      render();
      return;
    }

    st.loading = true;
    st.error = null;
    render();

    try {
      const today = await (window.BookingLiveProvider && window.BookingLiveProvider.bizToday
        ? window.BookingLiveProvider.bizToday() : Promise.resolve(''));
      st.todayISO = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : '';

      const scopeUpcoming = st.filter.scope !== 'past';
      const todayKey = st.todayISO || '';

      // "วันนี้และล่วงหน้า" ต้องรวมใบที่ค้างคืนด้วยเสมอ — ใบพวกนั้นมีวันจองอยู่ในอดีต
      // ถ้ากรองตามวันอย่างเดียว admin จะมองไม่เห็นของที่ยังไม่กลับคลัง
      // ซึ่งเป็นรายการเดียวที่ต้องจัดการทุกวัน (คิว v_booking_stale ครอบเฉพาะ reserved/checked_out)
      let bookingsQuery = sb.from('bookings')
        .select('id,member_id,job_name,job_location,booking_date,status,group_ref,note,created_at,updated_at');
      bookingsQuery = scopeUpcoming
        ? (todayKey
          ? bookingsQuery.or(`booking_date.gte.${todayKey},status.eq.overdue`)
          : bookingsQuery)
        : (todayKey
          ? bookingsQuery.lt('booking_date', todayKey).neq('status', 'overdue')
          : bookingsQuery);

      const [bookingsRes, staleRes, aheadRes, overdueRes, membersRes] = await Promise.all([
        bookingsQuery
          .order('booking_date', { ascending: scopeUpcoming })
          .limit(PAGE_SIZE),
        sb.from('v_booking_stale').select('*').order('booking_date', { ascending: true }),
        st.todayISO
          ? sb.rpc('booking_day_flags_between', { d_from: st.todayISO, d_to: shiftISO(st.todayISO, AHEAD_DAYS - 1) })
          : Promise.resolve({ data: [], error: null }),
        sb.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'overdue'),
        sb.from('members').select('id,code,full_name,role,active,color_hue'),
      ]);

      if (bookingsRes.error) throw bookingsRes.error;
      if (staleRes.error && !/permission denied/i.test(String(staleRes.error.message || ''))) throw staleRes.error;
      if (membersRes.error) throw membersRes.error;
      // คิวตรวจของคืนและยอดล่วงหน้าเป็นตัวเสริม — พังได้โดยไม่ทำให้ทั้งแผงใช้ไม่ได้
      const softError = aheadRes.error || overdueRes.error || staleRes.error;

      st.bookings = Array.isArray(bookingsRes.data) ? bookingsRes.data : [];
      st.stale = Array.isArray(staleRes.data) ? staleRes.data : [];
      st.ahead = Array.isArray(aheadRes.data) ? aheadRes.data : [];

      st.membersById = new Map(
        (Array.isArray(membersRes.data) ? membersRes.data : []).map((m) => [String(m.id), m]),
      );

      // รายการของของแต่ละใบ — ยิงตาม id ที่ได้จากข้างบน (ไม่ฝัง join เพื่อให้ควบคุมได้)
      st.itemsByBooking = new Map();
      const ids = st.bookings.map((b) => String(b.id));
      st.stale.forEach((s) => { const k = String(s.id); if (!ids.includes(k)) ids.push(k); });
      if (ids.length) {
        const itemsRes = await sb.from('booking_items')
          .select('id,booking_id,item_type,item_id,quantity,returned_quantity,note')
          .in('booking_id', ids);
        if (itemsRes.error) throw itemsRes.error;
        (Array.isArray(itemsRes.data) ? itemsRes.data : []).forEach((it) => {
          const k = String(it.booking_id);
          if (!st.itemsByBooking.has(k)) st.itemsByBooking.set(k, []);
          st.itemsByBooking.get(k).push(it);
        });
      }

      const todayFlag = st.ahead.find((r) => String(r.day).slice(0, 10) === st.todayISO);
      st.counts = {
        overdue: num(overdueRes.count, 0),
        stale: st.stale.length,
        todayItems: todayFlag ? num(todayFlag.booked_items, 0) : 0,
        todayQty: 0,
      };

      // รายการที่ยังไม่ระบุจำนวน = จองไม่ได้ ต้องให้ admin เติม
      st.unknown = await unknownStockItems();

      st.ready = true;
      st.softError = softError ? describeError(softError) : null;
    } catch (err) {
      st.error = describeError(err);
      st.ready = false;
    } finally {
      st.loading = false;
      render();
    }
  }

  // อ่านรายการที่ยังไม่ระบุจำนวนจากแหล่งเดียวกับการ์ดอุปกรณ์ (BookingStore)
  // ถ้า BookingStore ยังไม่พร้อมก็ถอยไปอ่าน v_item_stock ตรง ๆ
  async function unknownStockItems() {
    try {
      const S = typeof window !== 'undefined' ? window.BookingStore : null;
      if (S && typeof S.unknownStockItems === 'function' && S.isReady && S.isReady()) {
        return S.unknownStockItems().map((r) => ({
          itemType: r.itemType, itemId: r.itemId, itemName: r.itemName,
        }));
      }
    } catch (e) { /* ถอยไปอ่านตรง */ }

    const sb = client();
    if (!sb) return [];
    const { data, error } = await sb.from('v_item_stock')
      .select('item_type,item_id,item_name')
      .is('stock', null);
    if (error) return [];
    return (Array.isArray(data) ? data : []).map((r) => ({
      itemType: r.item_type === 'accessory' ? 'accessory' : 'fixture',
      itemId: num(r.item_id),
      itemName: r.item_name || `${r.item_type} id ${r.item_id}`,
    }));
  }

  // ---- การกระทำ ------------------------------------------------------------
  async function setStatus(bookingId, status) {
    const labels = {
      checked_out: 'บันทึกว่าจ่ายของออกจากคลังแล้ว',
      overdue: 'ปักว่าเป็นของค้างคืน (จะกินสต็อกทุกวันจนกว่าจะบันทึกว่าคืนครบ)',
      cancelled: 'ยกเลิกใบจองนี้ (ของทั้งหมดกลับเข้าคลัง)',
      reserved: 'กลับเป็นสถานะจองไว้',
    };
    if (status === 'cancelled' || status === 'overdue') {
      const really = typeof window !== 'undefined' && window.confirm
        ? window.confirm(`${labels[status] || status}?\n\nกดตกลงเพื่อยืนยัน`)
        : true;
      if (!really) return false;
    }
    return run('update', async (sb) => {
      const { data, error } = await sb.from('bookings')
        .update({ status })
        .eq('id', bookingId)
        .select('id,status');
      if (error) throw error;
      return `${labels[status] || status} แล้ว`;
    });
  }

  async function settle(bookingId) {
    return run('settle', async (sb) => {
      const { data, error } = await sb.rpc('settle_booking', { p_booking_id: bookingId });
      if (error) throw error;
      const n = num(data, 0);
      return n > 0
        ? `บันทึกว่าคืนครบแล้ว — เติมจำนวนที่คืนให้ ${n} รายการ ของกลับเข้าคลังและพ้นสถานะค้างคืน`
        : 'ใบจองนี้บันทึกว่าคืนครบไว้อยู่แล้ว';
    });
  }

  async function saveEdit() {
    const draft = st.editing;
    if (!draft) return false;
    if (!String(draft.job_name || '').trim()) {
      st.message = { kind: 'error', text: 'ต้องระบุชื่องาน (job_name) ทุกใบจอง — ฐานข้อมูลจะปฏิเสธด้วย' };
      render();
      return false;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(draft.booking_date || ''))) {
      st.message = { kind: 'error', text: 'วันที่ไม่ถูกต้อง — ต้องเป็นรูปแบบ วววว-ดด-วว' };
      render();
      return false;
    }
    return run('edit', async (sb) => {
      const { error } = await sb.from('bookings')
        .update({
          job_name: String(draft.job_name).trim(),
          job_location: String(draft.job_location || '').trim() || null,
          booking_date: draft.booking_date,
          note: String(draft.note || '').trim() || null,
        })
        .eq('id', draft.id);
      if (error) throw error;

      // จำนวนต่อรายการ — ยิงทีละแถวเพราะแต่ละแถวมี trigger ตรวจสต็อกของตัวเอง
      // ถ้าแถวไหนถูกปฏิเสธ ทั้งชุดนี้จะหยุดและบอกตรง ๆ ว่าแถวไหนพัง
      for (const line of draft.lines) {
        const patch = {};
        if (Number.isFinite(num(line.quantity, NaN)) && num(line.quantity) !== num(line._quantity)) {
          patch.quantity = num(line.quantity);
        }
        if (Number.isFinite(num(line.returned_quantity, NaN)) && num(line.returned_quantity) !== num(line._returned_quantity)) {
          patch.returned_quantity = num(line.returned_quantity);
        }
        if (!Object.keys(patch).length) continue;
        const res = await sb.from('booking_items').update(patch).eq('id', line.id);
        if (res.error) throw new Error(`รายการ ${line.itemName || line.item_id}: ${res.error.message || res.error}`);
      }
      st.editing = null;
      return 'บันทึกการแก้ไขแล้ว';
    });
  }

  // รันงานเขียนหนึ่งอย่าง: ตั้งสถานะกำลังบันทึก -> ทำ -> ล้างแคช -> โหลดใหม่
  async function run(kind, fn) {
    const sb = client();
    if (!sb) { st.message = { kind: 'error', text: 'ยังเชื่อมต่อ Supabase ไม่ได้' }; render(); return false; }
    st.saving = true;
    st.message = { kind: 'info', text: 'กำลังบันทึก…' };
    render();
    try {
      const text = await fn(sb);
      st.message = { kind: 'ok', text };
      // ล้างแคชทุกชั้น — ไม่งั้นการ์ดอุปกรณ์และปฏิทินจะโชว์ยอดเดิมค้างอยู่
      try { if (window.BookingLiveProvider && window.BookingLiveProvider.resetCache) window.BookingLiveProvider.resetCache(); } catch (e) { /* ไม่เป็นไร */ }
      try { if (window.BookingStore && window.BookingStore.load) await window.BookingStore.load({ force: true }); } catch (e) { /* ไม่เป็นไร */ }
      try { if (window.BookingCalendar && window.BookingCalendar.refresh) window.BookingCalendar.refresh(); } catch (e) { /* ไม่เป็นไร */ }
      await load();
      return true;
    } catch (err) {
      st.message = { kind: 'error', text: describeError(err) };
      await load();
      return false;
    } finally {
      st.saving = false;
      render();
    }
  }

  function openEditor(bookingId) {
    const b = st.bookings.find((x) => String(x.id) === String(bookingId))
      || st.stale.find((x) => String(x.id) === String(bookingId));
    if (!b) {
      st.message = { kind: 'error', text: 'ไม่พบใบจองนี้ในรายการที่โหลดมา — กด "ตรวจซ้ำ" ก่อน' };
      render();
      return;
    }
    const lines = (st.itemsByBooking.get(String(b.id)) || []).map((it) => ({
      id: String(it.id),
      itemType: it.item_type,
      itemId: num(it.item_id),
      itemName: itemNameOf(it.item_type, it.item_id),
      quantity: num(it.quantity, 0),
      returned_quantity: num(it.returned_quantity, 0),
      _quantity: num(it.quantity, 0),
      _returned_quantity: num(it.returned_quantity, 0),
    }));
    st.editing = {
      id: String(b.id),
      job_name: b.job_name || '',
      job_location: b.job_location || '',
      booking_date: String(b.booking_date || '').slice(0, 10),
      note: b.note || '',
      status: b.status,
      lines,
    };
    st.message = null;
    render();
  }

  function itemNameOf(itemType, itemId) {
    const S = typeof window !== 'undefined' ? window.BookingStore : null;
    try {
      if (S && typeof S.get === 'function' && S.isReady && S.isReady()) {
        const row = S.get(itemType, itemId);
        if (row && row.itemName) return row.itemName;
      }
    } catch (e) { /* ใช้ชื่อสำรอง */ }
    return `${itemType === 'accessory' ? 'อุปกรณ์เสริม' : 'อุปกรณ์'} id ${itemId}`;
  }

  // ---- มุมมอง ---------------------------------------------------------------
  function actionsHtml(b) {
    const id = esc(b.id);
    const s = b.status;
    const busy = st.saving ? 'disabled' : '';
    const out = [];
    if (s === 'reserved') {
      out.push(`<button type="button" class="bkad-btn" data-bkad="checkout" data-id="${id}" ${busy} title="บันทึกว่าจ่ายของออกจากคลังแล้ว">รับของ</button>`);
    }
    if (s === 'reserved' || s === 'checked_out') {
      out.push(`<button type="button" class="bkad-btn is-warn" data-bkad="overdue" data-id="${id}" ${busy} title="ของไม่กลับคลังจริง — จะกินสต็อกทุกวันจนกว่าจะบันทึกว่าคืนครบ">ค้างคืน</button>`);
    }
    if (s === 'overdue') {
      out.push(`<button type="button" class="bkad-btn is-good" data-bkad="settle" data-id="${id}" ${busy} title="เติมจำนวนที่คืนทุกรายการ แล้วปลดสถานะค้างคืน — ของกลับเข้าคลัง">คืนครบแล้ว</button>`);
    }
    if (s !== 'cancelled') {
      out.push(`<button type="button" class="bkad-btn" data-bkad="edit" data-id="${id}" ${busy} title="แก้วัน ชื่องาน สถานที่ หมายเหตุ และจำนวนต่อรายการ">แก้ไข</button>`);
      out.push(`<button type="button" class="bkad-btn is-danger" data-bkad="cancel" data-id="${id}" ${busy} title="ยกเลิกใบจอง — ของทั้งหมดกลับเข้าคลัง">ยกเลิก</button>`);
    } else {
      out.push(`<span class="bkad-muted">ยกเลิกแล้ว — ของกลับเข้าคลังทั้งหมด</span>`);
    }
    return out.join('');
  }

  function linesSummaryHtml(bookingId) {
    const lines = st.itemsByBooking.get(String(bookingId)) || [];
    if (!lines.length) return '<span class="bkad-muted">ไม่มีรายการของ</span>';
    const qty = lines.reduce((s, it) => s + Math.max(num(it.quantity) - num(it.returned_quantity), 0), 0);
    const names = lines.map((it) => `${itemNameOf(it.item_type, it.item_id)} ×${num(it.quantity)}`);
    return `<span title="${esc(names.join('\n'))}">${lines.length} รายการ · คงค้าง ${qty} ชิ้น</span>`;
  }

  function staleHtml() {
    if (!st.stale.length) {
      return `<div class="bkad-empty">ไม่มีใบจองที่เลยวันแล้วค้างอยู่ — ของทุกใบกลับคลังครบ ✅</div>`;
    }
    const rows = st.stale.map((s) => `<tr>
      <td class="bkad-nowrap">${esc(thDateShort(String(s.booking_date || '').slice(0, 10)))}</td>
      <td class="bkad-nowrap"><strong>${num(s.days_past)} วัน</strong></td>
      <td>${personDot(s.member_code ? findMemberByCode(s.member_code) : s.member_id)}</td>
      <td>${esc(s.job_name || '(ไม่ระบุชื่องาน)')}${s.job_location ? `<div class="bkad-sub">${esc(s.job_location)}</div>` : ''}</td>
      <td class="bkad-nowrap">${linesSummaryHtml(s.id)}</td>
      <td class="bkad-nowrap"><span class="bkad-status ${STATUS_CLASS[s.status] || ''}">${esc(statusTh(s.status))}</span></td>
      <td class="bkad-actions">
        <button type="button" class="bkad-btn is-good" data-bkad="settle" data-id="${esc(s.id)}" ${st.saving ? 'disabled' : ''}
          title="ของกลับคลังครบแล้ว — เติม returned_quantity ทุกรายการ ใบนี้จะออกจากคิว">คืนครบแล้ว</button>
        <button type="button" class="bkad-btn is-warn" data-bkad="overdue" data-id="${esc(s.id)}" ${st.saving ? 'disabled' : ''}
          title="ของยังไม่กลับ — ปักเป็นค้างคืนเพื่อกันคนอื่นจองซ้ำ">ของไม่กลับ (ปักค้างคืน)</button>
      </td>
    </tr>`).join('');

    return `<div class="bkad-table-wrap"><table class="bkad-table">
      <thead><tr><th>วันที่จอง</th><th>เลยมา</th><th>ผู้จอง</th><th>งาน</th><th>รายการ</th><th>สถานะ</th><th>จัดการ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function findMemberByCode(code) {
    let found = null;
    st.membersById.forEach((m) => { if (!found && String(m.code) === String(code)) found = m.id; });
    return found || '';
  }

  function bookingsHtml() {
    const list = st.bookings.filter((b) => !st.filter.status || b.status === st.filter.status);
    if (!list.length) {
      return `<div class="bkad-empty">${st.bookings.length
        ? 'ไม่มีใบจองตรงตัวกรองที่เลือก'
        : 'ยังไม่มีใบจองในช่วงนี้ — ทีมงานสร้างใบจองได้ที่หน้าปฏิทินจอง'}</div>`;
    }
    const rows = list.map((b) => {
      const iso = String(b.booking_date || '').slice(0, 10);
      return `<tr class="${iso === st.todayISO ? 'is-today' : ''}">
        <td class="bkad-nowrap">${esc(thDateShort(iso))}${iso === st.todayISO ? ' <span class="bkad-today">วันนี้</span>' : ''}</td>
        <td>${personDot(b.member_id)}</td>
        <td>${esc(b.job_name || '(ไม่ระบุชื่องาน)')}${b.job_location ? `<div class="bkad-sub">${esc(b.job_location)}</div>` : ''}${b.note ? `<div class="bkad-sub">📝 ${esc(b.note)}</div>` : ''}</td>
        <td class="bkad-nowrap">${linesSummaryHtml(b.id)}</td>
        <td class="bkad-nowrap"><span class="bkad-status ${STATUS_CLASS[b.status] || ''}">${esc(statusTh(b.status))}</span></td>
        <td class="bkad-actions">${actionsHtml(b)}</td>
      </tr>`;
    }).join('');

    return `<div class="bkad-table-wrap"><table class="bkad-table">
      <thead><tr><th>วันที่</th><th>ผู้จอง</th><th>งาน / สถานที่</th><th>รายการ</th><th>สถานะ</th><th>จัดการ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function aheadHtml() {
    if (!st.ahead.length) return '';
    const cells = st.ahead.map((r) => {
      const iso = String(r.day || '').slice(0, 10);
      const soldOut = num(r.sold_out_items, 0);
      const od = num(r.overdue_count, 0);
      return `<div class="bkad-ahead-cell${soldOut ? ' is-full' : ''}${od ? ' is-overdue' : ''}${iso === st.todayISO ? ' is-today' : ''}">
        <span class="bkad-ahead-day">${esc(thDateShort(iso))}</span>
        <span class="bkad-ahead-n">${num(r.booking_count, 0)} ใบ</span>
        <span class="bkad-ahead-sub">${soldOut ? `ของหมด ${soldOut}` : 'ไม่มีการหมด'}${od ? ` · ค้างคืน ${od}` : ''}</span>
      </div>`;
    }).join('');
    return `<div class="bkad-ahead">${cells}</div>`;
  }

  function unknownHtml() {
    if (!st.unknown.length) {
      return `<div class="bkad-empty">ทุกรายการในคลังระบุจำนวนไว้แล้ว — จองได้ทุกชิ้น ✅</div>`;
    }
    const groups = { fixture: [], accessory: [] };
    st.unknown.forEach((u) => { (groups[u.itemType] || groups.fixture).push(u); });
    const list = (arr) => arr.slice(0, 40).map((u) => `<li>${esc(u.itemName)} <span class="bkad-sub">id ${esc(u.itemId)}</span></li>`).join('');
    const more = (arr) => (arr.length > 40 ? `<li class="bkad-sub">…และอีก ${arr.length - 40} รายการ</li>` : '');

    return `<div class="bkad-unknown">
      <p class="bkad-unknown-lead">รายการเหล่านี้ <strong>จองไม่ได้</strong> จนกว่าจะเติมจำนวน — เว็บจะขึ้น
        "ยังไม่ระบุจำนวน — จองไม่ได้" ซึ่งต่างจาก "ของหมด" ผู้ใช้จึงไม่เข้าใจผิด</p>
      ${groups.fixture.length ? `<div class="bkad-unknown-col">
        <div class="bkad-unknown-head">อุปกรณ์ ${groups.fixture.length} รายการ
          <a class="bkad-link" href="equipment.html" title="เปิดการ์ดของรายการนั้น แล้วกด แก้ไข เพื่อเติม Stock Count">ไปเติมจำนวน</a></div>
        <ul>${list(groups.fixture)}${more(groups.fixture)}</ul></div>` : ''}
      ${groups.accessory.length ? `<div class="bkad-unknown-col">
        <div class="bkad-unknown-head">อุปกรณ์เสริม ${groups.accessory.length} รายการ
          <a class="bkad-link" href="accessories.html" title="เปิดการ์ดของรายการนั้น แล้วกด แก้ไข เพื่อเติม Stock">ไปเติมจำนวน</a></div>
        <ul>${list(groups.accessory)}${more(groups.accessory)}</ul></div>` : ''}
    </div>`;
  }

  function editorHtml() {
    const d = st.editing;
    if (!d) return '';
    const lines = d.lines.map((l, i) => `<tr>
      <td>${esc(l.itemName)}</td>
      <td class="bkad-nowrap">${l.itemType === 'accessory' ? 'อุปกรณ์เสริม' : 'อุปกรณ์'} id ${esc(l.itemId)}</td>
      <td><input type="number" class="bkad-input" min="1" max="999" value="${esc(l.quantity)}" data-bkad="line-qty" data-i="${i}"></td>
      <td><input type="number" class="bkad-input" min="0" max="${esc(l.quantity)}" value="${esc(l.returned_quantity)}" data-bkad="line-ret" data-i="${i}"></td>
      <td class="bkad-nowrap">${Math.max(num(l.quantity) - num(l.returned_quantity), 0)} ชิ้น</td>
    </tr>`).join('');

    return `<div class="bkad-editor">
      <div class="bkad-editor-head">แก้ไขใบจอง <span class="bkad-status ${STATUS_CLASS[d.status] || ''}">${esc(statusTh(d.status))}</span>
        <button type="button" class="bkad-btn" data-bkad="close-editor" ${st.saving ? 'disabled' : ''}>ปิด</button></div>
      <div class="bkad-editor-grid">
        <label class="bkad-field"><span>วันที่จอง</span>
          <input type="date" class="bkad-input" value="${esc(d.booking_date)}" data-bkad="f-date"></label>
        <label class="bkad-field"><span>ชื่องาน (จำเป็น)</span>
          <input type="text" class="bkad-input" value="${esc(d.job_name)}" maxlength="160" data-bkad="f-job"></label>
        <label class="bkad-field"><span>สถานที่</span>
          <input type="text" class="bkad-input" value="${esc(d.job_location)}" maxlength="160" data-bkad="f-loc"></label>
        <label class="bkad-field bkad-field-wide"><span>หมายเหตุ</span>
          <textarea class="bkad-input" rows="2" maxlength="500" data-bkad="f-note">${esc(d.note)}</textarea></label>
      </div>
      <div class="bkad-table-wrap"><table class="bkad-table">
        <thead><tr><th>รายการ</th><th>รหัส</th><th>จำนวนที่จอง</th><th>คืนแล้ว</th><th>คงค้าง</th></tr></thead>
        <tbody>${lines || '<tr><td colspan="5" class="bkad-muted">ไม่มีรายการของ</td></tr>'}</tbody>
      </table></div>
      <div class="bkad-editor-foot">
        <span class="bkad-sub">การย้ายวันจะทำให้ฐานข้อมูลตรวจสต็อกของวันใหม่ทุกรายการ — ถ้าของไม่พอจะถูกปฏิเสธพร้อมบอกเหตุผล</span>
        <button type="button" class="bkad-btn is-dark" data-bkad="save-editor" ${st.saving ? 'disabled' : ''}>${st.saving ? 'กำลังบันทึก…' : 'บันทึกการแก้ไข'}</button>
      </div>
    </div>`;
  }

  function statsHtml() {
    const cards = [
      { n: st.counts.stale, label: 'ใบที่เลยวันแล้วยังไม่ได้ตรวจของคืน', cls: st.counts.stale ? 'is-warn' : 'is-good' },
      { n: st.counts.overdue, label: 'ใบที่ถูกปักว่าค้างคืน (กินสต็อกทุกวัน)', cls: st.counts.overdue ? 'is-bad' : 'is-good' },
      { n: st.counts.todayItems, label: `รายการที่ถูกจอง${st.todayISO ? 'วันนี้ (' + thDateShort(st.todayISO) + ')' : 'วันนี้'}`, cls: '' },
      { n: st.unknown.length, label: 'รายการที่ยังไม่ระบุจำนวน = จองไม่ได้', cls: st.unknown.length ? 'is-warn' : 'is-good' },
    ];
    return `<div class="bkad-stats">${cards.map((c) => `<div class="bkad-stat ${c.cls}">
      <strong>${esc(c.n)}</strong><span>${esc(c.label)}</span></div>`).join('')}</div>`;
  }

  function messageHtml() {
    if (!st.message) return '';
    const cls = st.message.kind === 'ok' ? 'bkad-msg-ok' : (st.message.kind === 'info' ? 'bkad-msg-info' : 'bkad-msg-err');
    return `<div class="bkad-msg ${cls}" role="status">${esc(st.message.text)}</div>`;
  }

  function render() {
    const wrap = typeof document !== 'undefined' ? document.getElementById('bookingAdminBody') : null;
    if (!wrap) return;

    const summary = document.getElementById('bookingAdminSummary');
    if (summary) {
      summary.textContent = st.loading ? 'กำลังโหลดใบจอง…'
        : (st.error ? 'ยังโหลดข้อมูลไม่ได้'
          : `โหลดแล้ว ${st.bookings.length} ใบจอง (แสดงสูงสุด ${PAGE_SIZE} ใบตามตัวกรอง)`);
    }

    if (!st.ready && !st.loading) {
      wrap.innerHTML = `<div class="bkad-msg bkad-msg-err">${esc(st.error || 'ยังโหลดข้อมูลไม่ได้')}</div>`;
      return;
    }

    const scopeBtn = (value, label) => `<button type="button" class="bkad-tab${st.filter.scope === value ? ' is-on' : ''}"
      data-bkad="scope" data-v="${value}">${label}</button>`;
    const statusBtn = (value, label) => `<button type="button" class="bkad-tab${st.filter.status === value ? ' is-on' : ''}"
      data-bkad="status" data-v="${value}">${label}</button>`;

    wrap.innerHTML = `${st.loading ? '<div class="bkad-msg bkad-msg-info">กำลังโหลด…</div>' : ''}
      ${messageHtml()}
      ${st.softError && !st.loading ? `<div class="bkad-msg bkad-msg-info">⚠️ บางส่วนโหลดไม่ได้: ${esc(st.softError)}</div>` : ''}
      ${statsHtml()}

      <div class="bkad-sec">
        <div class="bkad-sec-head"><h6>คิวต้องตรวจ — ของเลยวันแล้วยังไม่รู้ว่ากลับคลังหรือยัง</h6>
          <span class="bkad-sub">${st.counts.stale} ใบ</span></div>
        <p class="bkad-hint">ระบบคืนของอัตโนมัติเมื่อพ้นวันจอง แต่ถ้า<strong>ของไม่กลับมาจริง</strong> ระบบไม่มีทางรู้เอง
          ต้องกด <strong>ของไม่กลับ (ปักค้างคืน)</strong> เพื่อกันคนอื่นจองซ้ำ — ใบที่ค้างคืนจะกินสต็อกทุกวันจนกว่าจะกด <strong>คืนครบแล้ว</strong></p>
        ${staleHtml()}
      </div>

      <div class="bkad-sec">
        <div class="bkad-sec-head"><h6>ยอด ${AHEAD_DAYS} วันข้างหน้า</h6></div>
        ${aheadHtml()}
      </div>

      <div class="bkad-sec">
        <div class="bkad-sec-head"><h6>ใบจอง</h6>
          <div class="bkad-tabs">
            ${scopeBtn('upcoming', 'วันนี้และล่วงหน้า')}
            ${scopeBtn('past', 'ย้อนหลัง')}
            <span class="bkad-tab-sep"></span>
            ${statusBtn('', 'ทุกสถานะ')}
            ${statusBtn('reserved', 'จองไว้')}
            ${statusBtn('checked_out', 'จ่ายของแล้ว')}
            ${statusBtn('overdue', 'ค้างคืน')}
            ${statusBtn('cancelled', 'ยกเลิก')}
          </div>
        </div>
        ${bookingsHtml()}
      </div>

      ${editorHtml()}

      <div class="bkad-sec">
        <div class="bkad-sec-head"><h6>รายการที่ยังไม่ระบุจำนวนในสต็อก</h6>
          <span class="bkad-sub">${st.unknown.length} รายการ</span></div>
        ${unknownHtml()}
      </div>`;
  }

  // ---- ผูกเหตุการณ์ ---------------------------------------------------------
  function bind() {
    const root = typeof document !== 'undefined' ? document.getElementById('bookingAdminPanel') : null;
    if (!root || root.dataset.bkadBound === '1') return;
    root.dataset.bkadBound = '1';

    root.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!t || typeof t.closest !== 'function') return;
      const btn = t.closest('[data-bkad="refresh"]');
      if (btn) { ev.preventDefault(); st.message = null; load(); return; }

      const el2 = t.closest('[data-bkad]');
      if (!el2) return;
      const action = el2.getAttribute('data-bkad');
      const id = el2.getAttribute('data-id');

      if (action === 'scope') { st.filter.scope = el2.getAttribute('data-v') === 'past' ? 'past' : 'upcoming'; st.message = null; load(); }
      else if (action === 'status') { st.filter.status = el2.getAttribute('data-v') || ''; render(); }
      else if (action === 'checkout') { ev.preventDefault(); setStatus(id, 'checked_out'); }
      else if (action === 'overdue') { ev.preventDefault(); setStatus(id, 'overdue'); }
      else if (action === 'cancel') { ev.preventDefault(); setStatus(id, 'cancelled'); }
      else if (action === 'reserved') { ev.preventDefault(); setStatus(id, 'reserved'); }
      else if (action === 'settle') { ev.preventDefault(); settle(id); }
      else if (action === 'edit') { ev.preventDefault(); openEditor(id); }
      else if (action === 'close-editor') { ev.preventDefault(); st.editing = null; st.message = null; render(); }
      else if (action === 'save-editor') { ev.preventDefault(); saveEdit(); }
    });

    root.addEventListener('input', (ev) => {
      const t = ev.target;
      if (!t || !st.editing || !t.getAttribute) return;
      const action = t.getAttribute('data-bkad');
      if (action === 'f-date') { st.editing.booking_date = String(t.value || ''); return; }
      if (action === 'f-job') { st.editing.job_name = String(t.value || ''); return; }
      if (action === 'f-loc') { st.editing.job_location = String(t.value || ''); return; }
      if (action === 'f-note') { st.editing.note = String(t.value || ''); return; }
      if (action === 'line-qty' || action === 'line-ret') {
        const i = num(t.getAttribute('data-i'), -1);
        const line = st.editing.lines[i];
        if (!line) return;
        const v = num(t.value, 0);
        if (action === 'line-qty') line.quantity = Math.min(Math.max(v, 1), 999);
        else line.returned_quantity = Math.min(Math.max(v, 0), num(line.quantity, 0));
      }
    });
  }

  // เรียกจาก admin.js หลัง login สำเร็จและรู้ว่าเป็น admin
  async function init() {
    bind();
    await load();
  }

  function status() {
    return {
      ready: st.ready, loading: st.loading, saving: st.saving, error: st.error,
      bookings: st.bookings.length, stale: st.stale.length, unknown: st.unknown.length,
      counts: { ...st.counts },
    };
  }

  return {
    init,
    load,
    render,
    status,
    setStatus,
    settle,
    openEditor,
    saveEdit,
    // เปิดให้ชุดตรวจอ่าน/เซ็ตสถานะได้โดยไม่ต้องจำลองการคลิกทั้งแผง
    _state: st,
    _internals: { esc, num, shiftISO, thDateShort, statusTh, describeError, unknownStockItems, itemNameOf },
  };
})();

if (typeof window !== 'undefined') window.BookingAdmin = BookingAdmin;
