// js/booking-form.js
// ---------------------------------------------------------------------------
// ฟอร์มสร้างใบจองจริง — บันทึกลงตาราง bookings / booking_items ผ่าน
// public.create_booking() (RPC ฝั่ง Supabase)
//
// กฎที่ฟอร์มนี้บังคับ (ตรงกับ trigger ฝั่ง SQL ทุกข้อ — บังคับสองชั้น ไม่ใช่
// เพื่อแทนกัน แต่เพื่อให้ผู้ใช้เห็นเหตุผลก่อนกดบันทึก):
//   * ต้อง sign in และมีแถวในตาราง members
//   * ต้องระบุชื่องาน
//   * ต้องมีอย่างน้อย 1 รายการ และแต่ละรายการ ≥ 1 ชิ้น
//   * จองเกินจำนวนที่มีไม่ได้ — เพดานคือ "เหลือวันนั้น" จากฐานข้อมูล
//   * ของที่ยังไม่ระบุจำนวน (stock = null) จองไม่ได้เลย (ต่างจาก "หมด")
//   * crew จองย้อนหลังไม่ได้ (admin เท่านั้น)
//   * crew จองในชื่อตัวเองเท่านั้น — ฟอร์มไม่เปิดให้เลือกผู้จอง
//
// ฟอร์มนี้ "ไม่เขียน" stock / stock_count เด็ดขาด — ยอดคงเหลือคำนวณจากใบจองเสมอ
// ---------------------------------------------------------------------------

const BookingForm = (() => {
  const MAX_QTY_PER_LINE = 999;

  let overlayEl = null;
  let st = null;          // สถานะของฟอร์มที่เปิดอยู่
  let resolveClosed = null;
  let closedPromise = null;

  // ---- ตัวช่วยเล็ก ๆ -------------------------------------------------------
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

  const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', ' กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

  function thDateLong(iso) {
    const p = String(iso || '').split('-').map(Number);
    if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return iso || '';
    return `${p[2]} ${THAI_MONTHS[p[1] - 1]} ${p[0] + 543}`;
  }

  function key(type, id) { return `${type}:${id}`; }

  function auth() { return typeof window !== 'undefined' ? window.AdminAuth : null; }
  function live() { return typeof window !== 'undefined' ? window.BookingLiveProvider : null; }

  function currentPerson() {
    const A = auth();
    if (!A) return null;
    let member = null;
    try { member = typeof A.getMember === 'function' ? A.getMember() : null; } catch (e) { member = null; }
    let role = '';
    try { role = typeof A.getRole === 'function' ? String(A.getRole() || '') : ''; } catch (e) { role = ''; }
    return {
      loggedIn: (() => { try { return !!A.isLoggedIn(); } catch (e) { return false; } })(),
      role,
      isAdmin: role === 'admin',
      id: member && member.id ? String(member.id) : '',
      name: (member && (member.full_name || member.fullName)) || (A.getMemberName ? A.getMemberName() : '') || '',
      code: (member && member.code) || (A.getMemberCode ? A.getMemberCode() : '') || '',
      hue: member && member.color_hue !== null && member.color_hue !== undefined ? num(member.color_hue, null) : null,
    };
  }

  // ---- สถานะของใบจองที่กำลังกรอก -------------------------------------------
  function newState(opts) {
    const o = opts || {};
    return {
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || '')) ? String(o.date) : '',
      jobName: String(o.jobName || ''),
      jobLocation: String(o.jobLocation || ''),
      note: String(o.note || ''),
      lines: new Map(),        // "fixture:12" -> {itemType,itemId,itemName,quantity,note}
      catalogue: [],           // ทั้งคลัง
      byKey: new Map(),
      avail: new Map(),        // "fixture:12" -> {stock,booked,available,stockUnknown}
      availOk: false,
      availError: null,
      loading: false,
      saving: false,
      message: null,           // {kind:'error'|'ok'|'info', text}
      query: '',
      tab: 'fixture',
      savedBookingId: null,
      // ปฏิทินที่เรียกฟอร์มมาอาจกำลังแสดงข้อมูลตัวอย่างอยู่ — ต้องบอกให้ชัด
      // ว่าใบจองนี้จะลงฐานข้อมูลจริง ไม่ใช่ลงข้อมูลตัวอย่าง
      demoContext: !!o.demoContext,
      onSaved: typeof o.onSaved === 'function' ? o.onSaved : null,
      onClose: typeof o.onClose === 'function' ? o.onClose : null,
    };
  }

  // ---- โหลดข้อมูลที่ต้องใช้ -------------------------------------------------
  async function loadAll() {
    const P = live();
    st.loading = true;
    render();

    if (!P) {
      st.loading = false;
      st.message = { kind: 'error', text: 'ยังโหลด js/booking-live.js ไม่ได้ — ฟอร์มจองใช้งานไม่ได้' };
      render();
      return;
    }

    try {
      const [catalogue, today] = await Promise.all([
        P.catalogue(true),
        P.bizToday ? P.bizToday() : Promise.resolve(st.date),
      ]);

      st.catalogue = Array.isArray(catalogue) ? catalogue : [];
      st.byKey = new Map(st.catalogue.map((c) => [key(c.itemType, c.itemId), c]));
      st.today = /^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) ? String(today) : '';
      if (!st.date) st.date = st.today || '';

      // รายการที่ถูกส่งมาจากหน้าอื่น (เช่นกด "จอง" ที่การ์ดอุปกรณ์) ต้องมีอยู่จริงในคลัง
      // ถ้าไม่มี (ของถูกลบ/ซ่อน) จะไม่เดา — แจ้งตรง ๆ ให้ผู้ใช้เลือกใหม่
      const unknown = [...st.lines.values()].filter((l) => !st.byKey.has(key(l.itemType, l.itemId)));
      if (unknown.length) {
        st.message = {
          kind: 'info',
          text: `มี ${unknown.length} รายการที่ไม่พบในคลังตอนนี้ (${unknown.map((u) => `${u.itemType} id ${u.itemId}`).join(', ')}) — ถูกลบออกจากระบบแล้ว จึงนำออกจากใบจอง`,
        };
        unknown.forEach((u) => st.lines.delete(key(u.itemType, u.itemId)));
      }

      await loadAvailability();
    } catch (err) {
      st.message = {
        kind: 'error',
        text: String((err && err.message) || err || 'โหลดข้อมูลคลังไม่สำเร็จ'),
      };
    } finally {
      st.loading = false;
      render();
    }
  }

  async function loadAvailability() {
    const P = live();
    if (!P || !st.date) { st.availOk = false; return; }
    const res = await P.availabilityForDay(st.date);
    if (res && res.ok) {
      st.avail = new Map(res.rows.map((r) => [key(r.itemType, r.itemId), r]));
      st.availOk = true;
      st.availError = null;
      // รายการในใบจองที่ตอนนี้เกินยอดที่เหลือ (เช่นเลื่อนวันมาวันอื่น) ต้องถูกตีกลับ
      st.lines.forEach((line, k) => {
        const max = maxQtyFor(line.itemType, line.itemId);
        if (max !== null && line.quantity > max) line.quantity = Math.max(max, 0);
        if (line.quantity < 1) st.lines.delete(k);
      });
    } else {
      st.availOk = false;
      st.avail = new Map();
      st.availError = (res && res.error && res.error.short) || 'ตรวจยอดคงเหลือจากฐานข้อมูลไม่ได้';
    }
  }

  // ---- แกนบริสุทธิ์ (ไม่แตะ state) — ชุดตรวจเรียกตรงได้ -----------------------
  // เพดานที่จองได้ของหนึ่งรายการ
  //   null = ยังไม่ระบุจำนวนในสต็อก -> จองไม่ได้เลย (ต่างจาก 0 = ถูกจองเต็ม)
  //   เลข  = จำนวนที่จองได้สูงสุด
  function maxQty(stock, availRow, hasAvail) {
    if (hasAvail && availRow) {
      if (availRow.stockUnknown || availRow.available === null || availRow.available === undefined) return null;
      return Math.min(Math.max(num(availRow.available, 0), 0), MAX_QTY_PER_LINE);
    }
    // ยังอ่านยอดรายวันไม่ได้ -> ถอยไปใช้จำนวนสต็อกทั้งคลัง (ฝั่ง server ยังตรวจซ้ำอยู่ดี)
    if (stock === null || stock === undefined) return null;
    return Math.min(Math.max(num(stock, 0), 0), MAX_QTY_PER_LINE);
  }

  function stockText(stock, availRow) {
    if (stock === null || stock === undefined) {
      return { cls: 'is-unknown', text: 'ยังไม่ระบุจำนวน — จองไม่ได้' };
    }
    if (availRow) {
      const booked = num(availRow.booked, 0);
      const avail = num(availRow.available, 0);
      return {
        cls: avail <= 0 ? 'is-out' : (avail <= 2 ? 'is-tight' : 'is-ok'),
        text: booked > 0 ? `มี ${stock} · ติดจอง ${booked} · เหลือ ${avail}` : `มี ${stock} · เหลือ ${avail}`,
      };
    }
    return { cls: 'is-ok', text: `มี ${stock}` };
  }

  // จำนวนที่รับได้จริงหลังผู้ใช้พิมพ์/กดปุ่ม — เกินเพดานเมื่อไรตีกลับที่เพดาน
  function clampQty(qty, max) {
    const n = num(qty, 0);
    if (n < 1) return 0;                 // 0 = เอาออกจากใบจอง
    if (max === null) return 0;          // ของไม่ระบุจำนวน -> มีไว้ในใบจองไม่ได้เลย
    return Math.min(n, max, MAX_QTY_PER_LINE);
  }

  // ---- ตัวห่อที่อ่านจาก state ของฟอร์มที่เปิดอยู่ ------------------------------
  function maxQtyFor(itemType, itemId) {
    const k = key(itemType, itemId);
    const a = st.avail.get(k);
    const c = st.byKey.get(k);
    return maxQty(c ? c.stock : null, st.availOk ? a : null, st.availOk);
  }

  function stockLabelFor(itemType, itemId) {
    const k = key(itemType, itemId);
    const a = st.availOk ? st.avail.get(k) : null;
    const c = st.byKey.get(k);
    return stockText(a ? a.stock : (c ? c.stock : null), a);
  }

  // ---- เพิ่ม/แก้รายการ -------------------------------------------------------
  function addLine(itemType, itemId, qty) {
    const k = key(itemType, itemId);
    const c = st.byKey.get(k);
    if (!c) {
      st.message = { kind: 'error', text: `ไม่พบ ${itemType} id ${itemId} ในคลัง — เลือกรายการจากรายชื่อด้านล่าง` };
      render();
      return false;
    }
    const max = maxQtyFor(itemType, itemId);
    if (max === null) {
      st.message = { kind: 'error', text: `${c.itemName} ยังไม่ระบุจำนวนในสต็อก จึงจองไม่ได้ — ให้ admin เติมจำนวนก่อน` };
      render();
      return false;
    }
    if (max <= 0) {
      st.message = { kind: 'error', text: `${c.itemName} ถูกจองเต็มจำนวนแล้วในวันที่ ${thDateLong(st.date)}` };
      render();
      return false;
    }
    const existing = st.lines.get(k);
    const want = num(qty, 1);
    const next = Math.min(Math.max(existing ? existing.quantity + want : want, 1), max);
    if (existing && existing.quantity >= max) {
      st.message = { kind: 'info', text: `${c.itemName} จองได้สูงสุด ${max} ชิ้นในวันที่ ${thDateLong(st.date)} แล้ว` };
      render();
      return false;
    }
    st.lines.set(k, {
      itemType: c.itemType,
      itemId: c.itemId,
      itemName: c.itemName,
      quantity: next,
      note: existing ? existing.note : '',
    });
    st.message = null;
    render();
    return true;
  }

  function setQty(itemType, itemId, qty) {
    const k = key(itemType, itemId);
    const line = st.lines.get(k);
    if (!line) return;
    const next = clampQty(qty, maxQtyFor(itemType, itemId));
    if (next < 1) st.lines.delete(k);
    else line.quantity = next;
    st.message = null;
    render();
  }

  function removeLine(itemType, itemId) {
    st.lines.delete(key(itemType, itemId));
    st.message = null;
    render();
  }

  // ---- บันทึก ---------------------------------------------------------------
  function validate() {
    const person = currentPerson();
    if (!person || !person.loggedIn) return 'ต้อง sign in ก่อนจองอุปกรณ์';
    if (!person.id) return 'ไม่พบบัญชีของคุณในตาราง members — ให้ admin เพิ่มรายชื่อก่อน';
    if (!st.date) return 'ต้องเลือกวันที่จอง';
    if (!person.isAdmin && st.today && st.date < st.today) {
      return `จองย้อนหลังไม่ได้ — วันนี้คือ ${thDateLong(st.today)} (admin เท่านั้นที่บันทึกย้อนหลังได้)`;
    }
    if (!st.jobName.trim()) return 'ต้องระบุชื่องาน';
    if (st.lines.size === 0) return 'ต้องเลือกอุปกรณ์อย่างน้อย 1 รายการ';

    const problems = [];
    st.lines.forEach((line) => {
      const max = maxQtyFor(line.itemType, line.itemId);
      if (max === null) problems.push(`${line.itemName} ยังไม่ระบุจำนวนในสต็อก จึงจองไม่ได้`);
      else if (line.quantity > max) problems.push(`${line.itemName} เหลือ ${max} ชิ้นในวันที่ ${thDateLong(st.date)} แต่ระบุมา ${line.quantity} ชิ้น`);
      else if (line.quantity < 1) problems.push(`${line.itemName} ต้องจองอย่างน้อย 1 ชิ้น`);
    });
    if (problems.length) return problems.join(' · ');
    return null;
  }

  async function submit() {
    if (st.saving) return;
    const problem = validate();
    if (problem) { st.message = { kind: 'error', text: problem }; render(); return; }

    const sb = typeof window !== 'undefined' ? window.sb : null;
    if (!sb || typeof sb.rpc !== 'function') {
      st.message = { kind: 'error', text: 'ยังเชื่อมต่อ Supabase ไม่ได้ — บันทึกใบจองไม่ได้' };
      render();
      return;
    }

    st.saving = true;
    st.message = { kind: 'info', text: 'กำลังบันทึกใบจอง…' };
    render();

    const payload = [...st.lines.values()].map((l) => ({
      item_type: l.itemType,
      item_id: l.itemId,
      item_name: l.itemName,     // ฝั่ง SQL ใช้ชื่อนี้ในข้อความ error เท่านั้น ไม่บันทึกทับคลัง
      quantity: l.quantity,
      note: l.note || '',
    }));

    try {
      const { data, error } = await sb.rpc('create_booking', {
        p_job_name: st.jobName.trim(),
        p_job_location: st.jobLocation.trim() || null,
        p_booking_date: st.date,
        p_note: st.note.trim() || null,
        p_items: payload,
      });

      if (error) throw error;

      st.savedBookingId = data ? String(data) : '';
      st.saving = false;
      st.message = {
        kind: 'ok',
        text: `บันทึกใบจองแล้ว — ${thDateLong(st.date)} · ${st.lines.size} รายการ · ${[...st.lines.values()].reduce((s, l) => s + l.quantity, 0)} ชิ้น`,
      };
      render();

      // ล้างแคชทุกชั้น แล้วให้ปฏิทินดึงใหม่ — ไม่งั้นยอดเดิมจะค้างอยู่บนจอ
      try { if (live() && live().resetCache) live().resetCache(); } catch (e) { /* ไม่เป็นไร */ }
      try {
        if (window.BookingStore && window.BookingStore.load) window.BookingStore.load({ force: true });
      } catch (e) { /* ไม่เป็นไร */ }

      if (st.onSaved) {
        try { st.onSaved({ id: st.savedBookingId, date: st.date, lines: [...st.lines.values()] }); } catch (e) { /* ไม่เป็นไร */ }
      }
      setTimeout(() => { close({ saved: true }); }, 1400);
    } catch (err) {
      st.saving = false;
      // ข้อความ error จาก trigger ฝั่ง SQL เป็นภาษาไทยที่อธิบายเหตุผลอยู่แล้ว — โชว์ตามนั้น
      const raw = String((err && (err.message || err.msg)) || err || 'ไม่ทราบสาเหตุ');
      st.message = {
        kind: 'error',
        text: /permission denied|42501/i.test(raw)
          ? 'บัญชีนี้ไม่มีสิทธิ์สร้างใบจอง — ต้อง sign in ด้วยบัญชี crew/admin ที่มีอยู่ในตาราง members'
          : raw,
      };
      // ยอดอาจเปลี่ยนเพราะมีคนจองตัดหน้า → ดึงยอดคงเหลือใหม่ก่อนให้แก้
      await loadAvailability();
      render();
    }
  }

  // ---- มุมมอง ---------------------------------------------------------------
  function filteredCatalogue() {
    const q = st.query.trim().toLowerCase();
    return st.catalogue.filter((c) => {
      if (c.itemType !== st.tab) return false;
      if (!q) return true;
      return String(c.itemName).toLowerCase().includes(q);
    });
  }

  function personBlock() {
    const p = currentPerson();
    if (!p || !p.loggedIn) {
      return `<div class="bk-who bk-who-anon">
        <div>ต้อง <strong>sign in</strong> ก่อนจองอุปกรณ์ — ใบจองจะผูกกับชื่อของคุณอัตโนมัติ</div>
        <a class="btn btn-sm btn-dark" href="admin.html">ไปที่หน้า Sign in</a>
      </div>`;
    }
    if (!p.role) {
      return `<div class="bk-who bk-who-anon">
        <div>ยังไม่ทราบสิทธิ์ของบัญชีนี้ — <strong>สร้างใบจองไม่ได้</strong> จนกว่า admin จะตั้งสิทธิ์ให้</div>
        <a class="btn btn-sm btn-dark" href="admin.html">ไปที่หน้า Sign in</a>
      </div>`;
    }
    if (!p.id) {
      return `<div class="bk-who bk-who-anon">
        <div><strong>ไม่พบบัญชีของคุณในตาราง members</strong> — ให้ admin เพิ่มรายชื่อก่อน จึงจะสร้างใบจองได้</div>
        <a class="btn btn-sm btn-dark" href="admin.html">กลับไปหน้า Sign in</a>
      </div>`;
    }
    const dot = p.hue !== null && p.hue !== undefined
      ? `<i class="bk-who-dot" style="background:hsl(${num(p.hue, 0)},62%,45%)"></i>` : '';
    return `<div class="bk-who">
      ${dot}<span class="bk-who-name">${esc(p.name || '(ไม่ระบุชื่อ)')}</span>
      <span class="bk-who-code">${esc(p.code)}</span>
      <span class="bk-who-role">${esc(p.role)}</span>
      <span class="bk-who-note">ผู้จองคือคุณ — เปลี่ยนแทนคนอื่นไม่ได้${p.isAdmin ? ' (สิทธิ์ admin จองย้อนหลังได้)' : ''}</span>
    </div>`;
  }

  function cartHtml() {
    if (st.lines.size === 0) {
      return `<div class="bk-cart-empty">ยังไม่ได้เลือกอุปกรณ์ — กด <strong>+</strong> จากรายชื่อด้านล่างเพื่อเพิ่มลงใบจอง</div>`;
    }
    const rows = [...st.lines.values()].map((l) => {
      const max = maxQtyFor(l.itemType, l.itemId);
      const s = stockLabelFor(l.itemType, l.itemId);
      const atMax = max !== null && l.quantity >= max;
      return `<tr data-bk-line="${esc(key(l.itemType, l.itemId))}">
        <td class="bk-cart-name">
          <span class="bk-cart-type">${l.itemType === 'accessory' ? 'อุปกรณ์เสริม' : 'อุปกรณ์'}</span>
          ${esc(l.itemName)}
          <span class="bk-stock ${esc(s.cls)}">${esc(s.text)}</span>
        </td>
        <td class="bk-cart-qty">
          <button type="button" class="bk-step" data-bk="dec" data-type="${esc(l.itemType)}" data-id="${esc(l.itemId)}" aria-label="ลด">−</button>
          <input type="number" class="bk-qty" value="${esc(l.quantity)}" min="1" max="${max === null ? MAX_QTY_PER_LINE : esc(max)}"
                 data-bk="qty" data-type="${esc(l.itemType)}" data-id="${esc(l.itemId)}" aria-label="จำนวน">
          <button type="button" class="bk-step" data-bk="inc" data-type="${esc(l.itemType)}" data-id="${esc(l.itemId)}"
                  ${atMax ? 'disabled' : ''} aria-label="เพิ่ม">+</button>
        </td>
        <td class="bk-cart-sum">${esc(l.quantity)} ชิ้น</td>
        <td class="bk-cart-del">
          <button type="button" class="bk-del" data-bk="del" data-type="${esc(l.itemType)}" data-id="${esc(l.itemId)}" aria-label="นำออก">✕</button>
        </td>
      </tr>`;
    }).join('');

    const totalQty = [...st.lines.values()].reduce((s, l) => s + l.quantity, 0);
    return `<table class="bk-cart">
      <thead><tr><th>รายการ</th><th>จำนวน</th><th>รวม</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th colspan="2">${st.lines.size} รายการ</th><th colspan="2">${esc(totalQty)} ชิ้น</th></tr></tfoot>
    </table>`;
  }

  function pickerHtml() {
    const list = filteredCatalogue();
    const counts = { fixture: 0, accessory: 0 };
    st.catalogue.forEach((c) => { counts[c.itemType] = (counts[c.itemType] || 0) + 1; });

    const rows = list.slice(0, 400).map((c) => {
      const max = maxQtyFor(c.itemType, c.itemId);
      const s = stockLabelFor(c.itemType, c.itemId);
      const line = st.lines.get(key(c.itemType, c.itemId));
      const blocked = max === null || max <= 0;
      return `<div class="bk-pick-row${line ? ' is-picked' : ''}${blocked ? ' is-blocked' : ''}">
        <span class="bk-pick-name" title="${esc(c.itemName)}">${esc(c.itemName)}</span>
        <span class="bk-stock ${esc(s.cls)}">${esc(s.text)}</span>
        ${line ? `<span class="bk-pick-in">ในใบจอง ${esc(line.quantity)}</span>` : ''}
        <button type="button" class="bk-add" data-bk="add" data-type="${esc(c.itemType)}" data-id="${esc(c.itemId)}"
                ${blocked ? 'disabled' : ''}
                title="${blocked ? (max === null ? 'ยังไม่ระบุจำนวนในสต็อก — จองไม่ได้' : 'ถูกจองเต็มแล้ววันนี้') : 'เพิ่มลงใบจอง'}">+</button>
      </div>`;
    }).join('');

    return `<div class="bk-picker">
      <div class="bk-picker-bar">
        <div class="btn-group btn-group-sm" role="group" aria-label="ประเภทของ">
          <button type="button" class="btn btn-outline-dark${st.tab === 'fixture' ? ' active' : ''}" data-bk="tab" data-tab="fixture">อุปกรณ์ (${counts.fixture})</button>
          <button type="button" class="btn btn-outline-dark${st.tab === 'accessory' ? ' active' : ''}" data-bk="tab" data-tab="accessory">อุปกรณ์เสริม (${counts.accessory})</button>
        </div>
        <input type="search" class="form-control form-control-sm bk-search" placeholder="ค้นหาชื่ออุปกรณ์…"
               value="${esc(st.query)}" data-bk="search" aria-label="ค้นหาอุปกรณ์">
      </div>
      <div class="bk-pick-list" data-bk="list">
        ${st.catalogue.length === 0
          ? `<div class="bk-pick-empty">ยังโหลดรายการจากคลังไม่ได้ — ต้อง sign in ก่อน</div>`
          : (list.length === 0 ? `<div class="bk-pick-empty">ไม่พบรายการที่ตรงกับ "${esc(st.query)}"</div>` : rows)}
      </div>
    </div>`;
  }

  function messageHtml() {
    if (!st.message) return '';
    const m = st.message;
    const cls = m.kind === 'ok' ? 'bk-msg-ok' : (m.kind === 'info' ? 'bk-msg-info' : 'bk-msg-err');
    return `<div class="bk-msg ${cls}" role="status">${esc(m.text)}</div>`;
  }

  function bodyHtml() {
    const p = currentPerson();
    const canEdit = !!(p && p.loggedIn && p.id);
    const minDate = p && p.isAdmin ? '' : esc(st.today || '');
    const totalQty = [...st.lines.values()].reduce((s, l) => s + l.quantity, 0);

    if (st.loading) {
      return `<div class="bk-loading">กำลังโหลดรายการจากคลัง…</div>`;
    }

    return `${personBlock()}
      ${st.demoContext ? `<div class="bk-msg bk-msg-info">ℹ️ ปฏิทินข้างบนกำลังแสดง <strong>ข้อมูลตัวอย่าง</strong> — แต่ใบจองนี้และยอดคงเหลือในฟอร์มนี้มาจาก <strong>ฐานข้อมูลจริง</strong> (สลับปุ่มมุมขวาบนเป็น "ข้อมูลจริง" เพื่อเห็นยอดตรงกัน)</div>` : ''}
      ${!st.availOk && st.availError ? `<div class="bk-msg bk-msg-info">⚠️ ${esc(st.availError)} — ฟอร์มจะยึดจำนวนสต็อกทั้งคลังเป็นเพดานชั่วคราว และฐานข้อมูลจะตรวจซ้ำอีกครั้งตอนบันทึก</div>` : ''}
      <div class="bk-fields">
        <label class="bk-field">
          <span class="bk-label">วันที่จอง <em>(ของกลับคลังอัตโนมัติหลังวันนี้อีก 1 วัน)</em></span>
          <input type="date" class="form-control form-control-sm" data-bk="date" value="${esc(st.date)}"
                 ${minDate ? `min="${minDate}"` : ''} ${canEdit ? '' : 'disabled'}>
          <span class="bk-hint">${st.date ? esc(thDateLong(st.date)) : 'ยังไม่ได้เลือกวัน'}</span>
        </label>
        <label class="bk-field">
          <span class="bk-label">ชื่องาน <em>(จำเป็น)</em></span>
          <input type="text" class="form-control form-control-sm" data-bk="job" value="${esc(st.jobName)}"
                 maxlength="160" placeholder="เช่น ถ่ายโฆษณา A — สตูดิโอ 2" ${canEdit ? '' : 'disabled'}>
        </label>
        <label class="bk-field">
          <span class="bk-label">สถานที่ / โลเคชัน</span>
          <input type="text" class="form-control form-control-sm" data-bk="loc" value="${esc(st.jobLocation)}"
                 maxlength="160" placeholder="เช่น กรุงเทพ / ต่างจังหวัด" ${canEdit ? '' : 'disabled'}>
        </label>
        <label class="bk-field bk-field-wide">
          <span class="bk-label">หมายเหตุ</span>
          <textarea class="form-control form-control-sm" data-bk="note" rows="2" maxlength="500"
                    placeholder="เช่น รับของวันก่อน 18:00" ${canEdit ? '' : 'disabled'}>${esc(st.note)}</textarea>
        </label>
      </div>

      <div class="bk-cols">
        <div class="bk-col-cart">
          <div class="bk-sec-title">รายการในใบจอง <span class="bk-badge">${st.lines.size} รายการ · ${esc(totalQty)} ชิ้น</span></div>
          ${cartHtml()}
        </div>
        <div class="bk-col-pick">
          <div class="bk-sec-title">เลือกจากคลัง <span class="bk-badge">${st.catalogue.length} รายการ</span></div>
          ${pickerHtml()}
        </div>
      </div>

      ${messageHtml()}`;
  }

  function footHtml() {
    const p = currentPerson();
    const canEdit = !!(p && p.loggedIn && p.id);
    return `<div class="bk-foot">
      <span class="bk-foot-note">${canEdit
        ? `บันทึกแล้วจะโผล่บนปฏิทินวันที่ ${st.date ? esc(thDateLong(st.date)) : '—'} ทันที`
        : 'sign in ก่อนจึงจะบันทึกได้'}</span>
      <button type="button" class="btn btn-sm btn-outline-dark" data-bk="close">ยกเลิก</button>
      <button type="button" class="btn btn-sm btn-dark" data-bk="submit"
              ${canEdit && !st.saving && !st.loading ? '' : 'disabled'}>
        ${st.saving ? 'กำลังบันทึก…' : 'บันทึกใบจอง'}
      </button>
    </div>`;
  }

  function render() {
    if (!overlayEl || !st) return;
    const body = overlayEl.querySelector('[data-bk-body]');
    const foot = overlayEl.querySelector('[data-bk-foot]');
    const title = overlayEl.querySelector('[data-bk-title]');
    if (title) title.textContent = st.savedBookingId ? 'บันทึกใบจองแล้ว' : 'สร้างใบจองอุปกรณ์';
    if (body) body.innerHTML = bodyHtml();
    if (foot) foot.innerHTML = footHtml();
  }

  // ---- ผูกเหตุการณ์ (delegate ทั้งแผง จึงไม่ต้องผูกใหม่ทุกครั้งที่ render) ----
  function bind() {
    overlayEl.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!t || typeof t.closest !== 'function') return;

      if (t.closest('[data-bk="close"]') || (t === overlayEl && overlayEl.dataset.backdropClose === '1')) {
        ev.preventDefault();
        close({ saved: false });
        return;
      }

      const el = t.closest('[data-bk]');
      if (!el) return;
      const action = el.getAttribute('data-bk');
      const type = el.getAttribute('data-type') || '';
      const id = Number(el.getAttribute('data-id'));

      if (action === 'add') { ev.preventDefault(); addLine(type, id, 1); }
      else if (action === 'inc') {
        ev.preventDefault();
        const line = st.lines.get(key(type, id));
        setQty(type, id, (line ? line.quantity : 0) + 1);
      } else if (action === 'dec') {
        ev.preventDefault();
        const line = st.lines.get(key(type, id));
        setQty(type, id, (line ? line.quantity : 1) - 1);
      } else if (action === 'del') { ev.preventDefault(); removeLine(type, id); }
      else if (action === 'tab') {
        ev.preventDefault();
        st.tab = el.getAttribute('data-tab') === 'accessory' ? 'accessory' : 'fixture';
        render();
      } else if (action === 'submit') { ev.preventDefault(); submit(); }
    });

    overlayEl.addEventListener('input', (ev) => {
      const el = ev.target;
      if (!el || !el.getAttribute) return;
      const action = el.getAttribute('data-bk');
      if (action === 'search') {
        st.query = String(el.value || '');
        // คงตำแหน่ง cursor: อัปเดตเฉพาะรายการ ไม่ render ทั้งแผง
        const list = overlayEl.querySelector('[data-bk="list"]');
        if (list) {
          const tmp = document.createElement('div');
          tmp.innerHTML = pickerHtml();
          const next = tmp.querySelector('[data-bk="list"]');
          if (next) list.innerHTML = next.innerHTML;
        }
        return;
      }
      if (action === 'job') { st.jobName = String(el.value || ''); return; }
      if (action === 'loc') { st.jobLocation = String(el.value || ''); return; }
      if (action === 'note') { st.note = String(el.value || ''); return; }
      if (action === 'qty') {
        const type = el.getAttribute('data-type');
        const id = Number(el.getAttribute('data-id'));
        const n = num(el.value, 0);
        const max = maxQtyFor(type, id);
        // พิมพ์เลขเองก็ต้องโดนเพดานเดียวกัน — เกินเมื่อไรตีกลับทันทีพร้อมบอกเหตุผล
        // (ต้องตั้งข้อความ "หลัง" setQty เพราะ setQty ล้างข้อความเก่าทิ้ง)
        if (max !== null && n > max) {
          const name = (st.byKey.get(key(type, id)) || {}).itemName || 'รายการนี้';
          setQty(type, id, max);
          st.message = {
            kind: 'error',
            text: max <= 0
              ? `${name} ถูกจองเต็มจำนวนแล้วในวันที่ ${thDateLong(st.date)}`
              : `${name} เหลือ ${max} ชิ้นในวันที่ ${thDateLong(st.date)} — ตั้งได้ไม่เกินนี้`,
          };
          render();
        } else {
          setQty(type, id, n);
        }
      }
    });

    overlayEl.addEventListener('change', async (ev) => {
      const el = ev.target;
      if (!el || el.getAttribute('data-bk') !== 'date') return;
      const v = String(el.value || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      const p = currentPerson();
      if (p && !p.isAdmin && st.today && v < st.today) {
        st.message = { kind: 'error', text: `จองย้อนหลังไม่ได้ — วันนี้คือ ${thDateLong(st.today)}` };
        st.date = st.today;
        render();
        await loadAvailability();
        render();
        return;
      }
      st.date = v;
      st.loading = true;
      render();
      await loadAvailability();
      st.loading = false;
      st.message = st.message || { kind: 'info', text: `ตรวจยอดคงเหลือของวันที่ ${thDateLong(v)} แล้ว` };
      render();
    });

    overlayEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close({ saved: false }); }
      // Enter ในช่องกรอก = บันทึก (ยกเว้น textarea)
      if (ev.key === 'Enter' && ev.target && ev.target.tagName !== 'TEXTAREA'
          && ev.target.getAttribute && ['job', 'loc'].includes(ev.target.getAttribute('data-bk'))) {
        ev.preventDefault();
        submit();
      }
    });
  }

  // ---- เปิด/ปิด -------------------------------------------------------------
  // Promise ที่ resolve ตอนฟอร์มถูกปิด (คืน {saved, bookingId})
  // open() เอง resolve ตอน "โหลดข้อมูลเสร็จและพร้อมกรอก" — คนเรียก await ได้เลย
  // (ได้ผลเป็น { closed } เพื่อไม่ให้ await open() ค้างไปถึงตอนปิด)
  function whenClosed() {
    if (!closedPromise) {
      closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
    }
    return closedPromise;
  }

  async function open(opts) {
    if (overlayEl && st) {
      // เปิดซ้ำ = เติมรายการต่อจากที่มี (ใช้ตอนกด "จองชุดนี้" หลายชุด)
      (opts && opts.items ? opts.items : []).forEach((it) => {
        const type = it.itemType === 'accessory' ? 'accessory' : 'fixture';
        const id = Number(it.itemId);
        st.lines.set(key(type, id), {
          itemType: type,
          itemId: id,
          itemName: it.itemName || `${type} id ${id}`,
          quantity: Math.max(num(it.quantity, 1), 1),
          note: it.note || '',
        });
      });
      if (opts && opts.date) st.date = String(opts.date);
      render();
      return { closed: whenClosed(), reopened: true };
    }

    st = newState(opts || {});
    (opts && opts.items ? opts.items : []).forEach((it) => {
      const type = it.itemType === 'accessory' ? 'accessory' : 'fixture';
      const id = Number(it.itemId);
      if (!Number.isFinite(id)) return;
      st.lines.set(key(type, id), {
        itemType: type,
        itemId: id,
        itemName: it.itemName || `${type} id ${id}`,
        quantity: Math.max(num(it.quantity, 1), 1),
        note: it.note || '',
      });
    });

    overlayEl = document.createElement('div');
    overlayEl.className = 'bk-backdrop';
    overlayEl.dataset.backdropClose = '1';
    overlayEl.innerHTML = `<div class="bk-panel" role="dialog" aria-modal="true" aria-labelledby="bkFormTitle">
      <div class="bk-head">
        <h3 id="bkFormTitle" data-bk-title>สร้างใบจองอุปกรณ์</h3>
        <button type="button" class="bk-x" data-bk="close" aria-label="ปิดฟอร์ม">×</button>
      </div>
      <div class="bk-body" data-bk-body></div>
      <div data-bk-foot></div>
    </div>`;
    document.body.appendChild(overlayEl);
    document.body.classList.add('bk-open');
    bind();
    render();
    const closed = whenClosed();
    await loadAll();
    // คืน object ไม่ใช่ promise ตรง ๆ — ถ้าคืน promise ของ "ตอนปิด" ผู้เรียกที่
    // await open() จะค้างจนกว่าผู้ใช้จะกดปิด ซึ่งไม่ใช่สิ่งที่คนเรียกอยากได้
    return { closed, reopened: false };
  }

  function close(result) {
    if (!overlayEl) return;
    const cb = st && st.onClose;
    const saved = !!(result && result.saved);
    const el = overlayEl;
    overlayEl = null;
    const state = st;
    st = null;
    const done = resolveClosed;
    resolveClosed = null;
    closedPromise = null;
    el.parentNode.removeChild(el);
    document.body.classList.remove('bk-open');
    if (cb && state) { try { cb({ saved, bookingId: state.savedBookingId || '' }); } catch (e) { /* ไม่เป็นไร */ } }
    if (done) done({ saved, bookingId: (state && state.savedBookingId) || '' });
  }

  function isOpen() { return !!overlayEl; }

  // อ่านรายการจาก URL: booking.html?book=fixture-12,accessory-3*4&date=2026-11-20
  //   fixture-12 / f-12 / f12 / 12      = อุปกรณ์ id 12 จำนวน 1
  //   accessory-3 / a-3 / a3            = อุปกรณ์เสริม id 3 จำนวน 1
  //   ต่อท้ายด้วย *N                     = ระบุจำนวน เช่น fixture-12*3
  // ใช้ให้หน้าอื่น (การ์ดอุปกรณ์ / Set Builder) ลิงก์มาเปิดฟอร์มพร้อมรายการที่ตั้งไว้
  const BOOK_TOKEN = /^(fixture|accessory|f|a)?[-:]?(\d+)(?:\*(\d+))?$/i;

  function itemsFromParam(raw) {
    return String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((token) => {
        const m = BOOK_TOKEN.exec(token);
        if (!m) return null;
        const kind = String(m[1] || '').toLowerCase();
        const id = Number(m[2]);
        if (!Number.isFinite(id) || id < 1) return null;
        const qty = m[3] ? Number(m[3]) : 1;
        return {
          itemType: kind === 'accessory' || kind === 'a' ? 'accessory' : 'fixture',
          itemId: id,
          quantity: Number.isFinite(qty) && qty > 0 ? Math.min(qty, MAX_QTY_PER_LINE) : 1,
        };
      })
      .filter(Boolean);
  }

  return {
    open,
    close,
    isOpen,
    whenClosed,
    itemsFromParam,
    thDateLong,
    shiftISO,
    // แกนบริสุทธิ์ — เปิดให้ชุดตรวจเรียกได้โดยไม่ต้องเปิดฟอร์ม/จำลอง DOM
    _internals: { maxQty, stockText, clampQty, itemsFromParam, esc, num, key, MAX_QTY_PER_LINE },
  };
})();

if (typeof window !== 'undefined') window.BookingForm = BookingForm;
