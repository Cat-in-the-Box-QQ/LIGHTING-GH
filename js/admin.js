// admin.js - หน้า Admin
// แก้จากเวอร์ชันเดิมที่พัง: ฟอร์มใน admin.html เป็น Email + Password แต่โค้ดไปหา
// element id 'adminPinInput' ที่ไม่มีอยู่ ทำให้ pinInput = null และโยน TypeError
// ทันทีที่กด submit -> เข้าหน้า admin ไม่ได้
//
// เวอร์ชันนี้: login ผ่าน Supabase Auth (email + password) เท่านั้น และแสดงสถานะ
// การเชื่อมต่อ Supabase ให้เห็นชัด ๆ ว่าตอนนี้ข้อมูลวิ่งจากที่ไหน

document.addEventListener('DOMContentLoaded', async () => {
  const lockScreen = document.getElementById('adminLockScreen');
  const app = document.getElementById('adminApp');
  const loginForm = document.getElementById('adminLoginForm');
  const emailInput = document.getElementById('adminEmailInput');
  const passwordInput = document.getElementById('adminPasswordInput');
  const loginBtn = document.getElementById('adminLoginBtn');
  const loginStatus = document.getElementById('adminLoginStatus');
  const status = document.getElementById('adminStatus');

  const verifyModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('verifyStatusModal'));
  const hiddenModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('hiddenItemsModal'));
  const itemModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('adminItemModal'));

  function showStatus(message, ok = true) {
    if (!status) return;
    status.className = (ok ? 'text-success' : 'text-danger') + ' small';
    status.textContent = message;
    clearTimeout(window.__adminStatusTimer);
    window.__adminStatusTimer = setTimeout(() => { status.textContent = ''; }, 5000);
  }

  function showLoginError(message, ok = false) {
    if (!loginStatus) return;
    loginStatus.className = 'small mt-2 ' + (ok ? 'text-success' : 'text-danger');
    loginStatus.textContent = message || '';
  }

  function setLoginBusy(busy) {
    if (loginBtn) {
      loginBtn.disabled = busy;
      loginBtn.textContent = busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ Admin';
    }
    if (emailInput) emailInput.disabled = busy;
    if (passwordInput) passwordInput.disabled = busy;
  }

  async function refreshData() {
    await Promise.all([DB.load(), AccessoryStore.load(), VerificationStore.load()]);
  }

  // ---------------- แผงสถานะ Supabase ----------------
  // แยกสถานะ "รายตาราง" เพราะ fixtures กับ accessories ต่อติดไม่พร้อมกันได้
  // (เช่น ตารางหนึ่งมีข้อมูล อีกตารางว่าง -> ตัวหนึ่งขึ้น supabase อีกตัว local)
  function tableStateLabel(st) {
    if (st.isSupabase) return '<span class="badge bg-success">ผ่านเน็ต · Supabase</span>';
    if (!st.tableExists && !st.reachable) return '<span class="badge bg-danger">เข้าไม่ได้</span>';
    if (st.tableExists && st.reachable) return '<span class="badge bg-warning text-dark">ตารางว่าง</span>';
    return '<span class="badge bg-warning text-dark">โหมด local (fallback)</span>';
  }

  function renderConnectionPanel() {
    const box = document.getElementById('supabaseStatusBox');
    if (!box) return;

    const db = DB.status();
    const acc = AccessoryStore.status();
    const diag = window.SB_DIAG || {};

    const allOnline = db.isSupabase && acc.isSupabase;
    const anyOnline = db.isSupabase || acc.isSupabase;

    const headline = allOnline
      ? '<span class="badge bg-success">เชื่อมต่อ Supabase ครบทุกตาราง</span>'
      : (anyOnline
        ? '<span class="badge bg-warning text-dark">เชื่อมต่อได้บางตาราง</span>'
        : '<span class="badge bg-danger">ไม่ได้เชื่อม Supabase · ใช้ข้อมูลในเครื่อง</span>');

    const explain = allOnline
      ? 'ข้อมูลวิ่งผ่านเน็ตจากฐานข้อมูลกลาง — แก้ไขแล้วซิงก์ทันทีทุกเครื่อง'
      : (anyOnline
        ? 'บางตารางยังใช้ข้อมูลในเครื่องอยู่ ดูรายละเอียดด้านล่าง'
        : 'ตอนนี้การแก้ไขถูกเก็บใน localStorage ของเครื่องนี้เท่านั้น (ไม่ซิงก์กับเครื่องอื่น)');

    const rows = [
      ['Project URL', diag.url || '-'],
      ['โหลด supabase-js จาก CDN', diag.libLoaded ? 'ผ่าน' : '<span class="text-danger">ไม่ผ่าน</span>'],
      ['สร้าง client', diag.clientReady ? 'ผ่าน' : '<span class="text-danger">ไม่ผ่าน</span>'],
      [`ตาราง <code>${db.table}</code>`, `${tableStateLabel(db)} <span class="text-muted">· ${db.fixtureCount} รายการ</span>`],
      [`ตาราง <code>${acc.table}</code>`, `${tableStateLabel(acc)} <span class="text-muted">· ${acc.count} รายการ</span>`],
    ];

    const errorText = db.error || acc.error || diag.error || null;

    box.innerHTML = `
      <div class="d-flex justify-content-between align-items-center gap-2 flex-wrap mb-2">
        <div class="small"><strong>การเชื่อมต่อ Supabase</strong> ${headline}</div>
        <div class="d-flex gap-2 flex-wrap">
          <button id="recheckSupabaseBtn" class="btn btn-outline-dark btn-sm" type="button">ตรวจซ้ำ</button>
          ${allOnline ? '' : '<button id="importToSupabaseBtn" class="btn btn-dark btn-sm" type="button">Import ข้อมูล local ขึ้น Supabase</button>'}
        </div>
      </div>
      <div class="small text-muted mb-2">${explain}</div>
      <table class="table table-sm small mb-2">
        <tbody>
          ${rows.map(([k, v]) => `<tr><th style="width:38%">${k}</th><td>${v}</td></tr>`).join('')}
        </tbody>
      </table>
      ${errorText
        ? `<div class="alert alert-warning small mb-2 py-2"><strong>หมายเหตุ:</strong> ${errorText}</div>`
        : ''}
      ${db.writeError || acc.writeError
        ? `<div class="alert alert-danger small mb-0 py-2"><strong>บันทึกไม่สำเร็จล่าสุด:</strong> ${db.writeError || acc.writeError}</div>`
        : ''}
    `;

    document.getElementById('recheckSupabaseBtn')?.addEventListener('click', async () => {
      await refreshData();
      renderConnectionPanel();
      await renderDataSummary();
      await renderHiddenList();
      showStatus('ตรวจการเชื่อมต่อซ้ำแล้ว');
    });

    document.getElementById('importToSupabaseBtn')?.addEventListener('click', async () => {
      if (!window.sb) {
        showStatus('Supabase client ไม่พร้อมใช้งาน — import ไม่ได้', false);
        return;
      }
      if (!window.confirm('จะเขียนข้อมูลจาก data/*.json ขึ้นตาราง Supabase (ทับรายการ id เดิม) ต่อหรือไม่?')) return;
      const btn = document.getElementById('importToSupabaseBtn');
      if (btn) { btn.disabled = true; btn.textContent = 'กำลัง import...'; }
      try {
        const fxCount = await DB.importLocalToSupabase();
        const accCount = await AccessoryStore.importLocalToSupabase();
        await refreshData();
        renderConnectionPanel();
        await renderDataSummary();
        await renderHiddenList();
        showStatus(`Import แล้ว: fixtures ${fxCount} รายการ, accessories ${accCount} รายการ`);
      } catch (err) {
        console.error(err);
        showStatus('Import ไม่สำเร็จ: ' + ((err && err.message) || err), false);
        renderConnectionPanel();
      }
    });
  }

  // ---------------- รายการ verification ----------------
  function renderVerificationList(filterStatus = 'all') {
    const listEl = document.getElementById('verifyList');
    const labelEl = document.getElementById('verifyFilterLabel');
    const modalTitle = document.getElementById('verifyModalTitle');
    const logs = VerificationStore.getAllLogs();
    const filtered = filterStatus === 'all'
      ? logs
      : logs.filter((item) => item.verificationStatus === filterStatus);

    const labels = {
      all: 'แสดงทั้งหมด',
      verified: 'รายการที่ Verified แล้ว',
      partially_verified: 'รายการที่ Partial',
      pending: 'รายการที่ Pending',
    };
    const label = labels[filterStatus] || 'แสดงทั้งหมด';
    if (labelEl) labelEl.textContent = label;
    if (modalTitle) modalTitle.textContent = label;

    if (!filtered.length) {
      listEl.innerHTML = '<div class="text-muted">ไม่พบรายการในสถานะนี้</div>';
      return;
    }

    listEl.innerHTML = filtered.map((item) => {
      const statusClass = item.verificationStatus === 'verified'
        ? 'text-success'
        : (item.verificationStatus === 'partially_verified' ? 'text-warning' : 'text-danger');
      return `
        <div class="spec-row" style="align-items:flex-start;">
          <div>
            <strong>${item.brand} ${item.model}</strong>
            <div class="small text-muted">ID ${item.id} · ${item.notes || '-'}</div>
          </div>
          <div style="text-align:right;">
            <div class="small ${statusClass}"><strong>${item.verificationStatus}</strong></div>
            <a class="small" href="fixture.html?id=${item.id}">เปิดหน้า detail</a>
          </div>
        </div>`;
    }).join('');
  }

  async function renderDataSummary() {
    const dbFixtures = DB.getAll();
    const acc = AccessoryStore.getAll();
    const hidden = dbFixtures.filter((i) => i.hidden).length + acc.filter((i) => i.hidden).length;
    const el = document.getElementById('adminDataSummary');
    if (el) {
      el.textContent = `Fixtures ${dbFixtures.length} รายการ · Accessories ${acc.length} รายการ · Hidden ${hidden} รายการ`;
    }
  }

  // ---------------- ทีมงานและสิทธิ์ ----------------
  // ทุกค่าในตารางนี้มาจากฐานข้อมูล จึงใช้ createElement/textContent ทั้งหมด
  // ไม่ร้อย innerHTML ตรง ๆ — ชื่อ/หมายเหตุเป็นข้อความที่คนอื่นพิมพ์ได้
  // ถ้าร้อยตรง ๆ จะเปิดช่อง XSS ให้คนที่ถูกเพิ่มเข้ามาในตาราง members
  //
  // โครง <table> ที่ไม่มีข้อมูลผู้ใช้ร้อยด้วย innerHTML ได้ (เป็น markup คงที่)
  //
  // สิทธิ์: admin เห็นทุกแถว + ปุ่มแก้ไข/ปิดใช้งาน
  //        crew เห็นแถวเดียวของตัวเอง + ปุ่มจองเท่านั้น
  // RLS กันไว้ที่ฐานข้อมูลอยู่แล้ว (crew อ่าน members ได้แค่แถวตัวเอง)
  // ตัวกรองข้างล่างจึงเป็นแค่ชั้น UI — กันโหมด local และกันเรนเดอร์ปุ่มที่กดแล้วจะ error
  function renderMembers() {
    const listEl = document.getElementById('memberList');
    const summaryEl = document.getElementById('memberSummary');
    const pendingBox = document.getElementById('memberPendingBox');
    const problemBox = document.getElementById('memberProblemBox');
    if (!listEl) return;

    const st = MemberStore.status();
    const viewerRole = AdminAuth.getRole();
    const viewerIsAdmin = viewerRole === 'admin';
    const viewerId = String((AdminAuth.getMember() || {}).id || '');
    const myEmail = String(AdminAuth.getEmail() || '').trim().toLowerCase();
    // "แถวของตัวเอง" เทียบทั้ง id และอีเมล — ในโหมด local แถวอาจไม่มี id ตรงกับ session
    const isSelfRow = (m) => (
      (!!viewerId && String(m.id) === viewerId)
      || (!!myEmail && String(m.email || '').trim().toLowerCase() === myEmail)
    );

    // เรียงสำหรับแสดงผล: คนที่ถูกปิดใช้งานขึ้นก่อน (นี่คือคิวที่ admin ต้องดู)
    // ตามด้วย admin ก่อน crew แล้วค่อยเรียงตามรหัส
    // ทำสำเนาเพราะ getAll() คืน array ภายใน — ห้าม sort ทับของ store
    // (store เรียงตาม code ไว้ให้ที่อื่นใช้ คงที่)
    //
    // ตัวเทียบต้องให้ "ค่าน้อย = ขึ้นก่อน" จึงจัดอันดับเป็นเลขแล้วลบกัน
    // (เขียนกลับด้านจะได้ลำดับตรงข้ามโดยไม่ error — เคยพลาดมาแล้ว)
    const inactiveRank = (m) => (m.active === true ? 1 : 0);
    const roleRank = (m) => (m.role === 'admin' ? 0 : 1);
    const all = [...MemberStore.getAll()].sort((a, b) => (
      inactiveRank(a) - inactiveRank(b)
      || roleRank(a) - roleRank(b)
      || String(a.code || '').localeCompare(String(b.code || ''))
    ));
    const visible = viewerIsAdmin ? all : all.filter(isSelfRow);

    // ---- แผงเตือนปัญหา ----
    const problems = [];
    if (!st.isSupabase) {
      problems.push('รายชื่อที่เห็นตอนนี้ไม่ใช่ข้อมูลจริง (โหมด local) — กด "ตรวจซ้ำ" เมื่อ Supabase กลับมาแล้ว');
    }
    if (st.error) problems.push(String(st.error));
    if (st.writeError) problems.push('บันทึกล่าสุดไม่สำเร็จ: ' + String(st.writeError));
    const missing = st.missingColumns || [];
    if (missing.length) {
      problems.push(`ตาราง ${st.table} ขาดคอลัมน์: ${missing.map((m) => m.column).join(', ')}`
        + ' — รัน supabase/migration-2026-11-13-member-admin.sql แล้วกด "ตรวจซ้ำ"');
    }
    if (problemBox) {
      problemBox.textContent = problems.join(' · ');
      problemBox.style.display = problems.length ? 'block' : 'none';
    }

    // ---- สรุปจำนวน ----
    if (summaryEl) {
      if (!viewerIsAdmin) {
        // crew เห็นแถวเดียวของตัวเอง — นับสรุปทั้งตารางไม่ได้ (RLS ไม่ส่งมา)
        summaryEl.textContent = visible.length
          ? 'นี่คือบัญชีของคุณ — สิทธิ์ crew ใช้จองอุปกรณ์ได้อย่างเดียว'
          : 'ไม่พบบัญชีของคุณในตาราง members — ให้ admin ตรวจสอบ';
      } else {
        summaryEl.textContent = st.isSupabase
          ? `admin ใช้งาน ${st.admin} คน · crew ใช้งาน ${st.crew} คน · ปิดใช้งาน ${st.inactive} คน · ทั้งหมด ${st.total} แถว`
          : `ยังไม่เชื่อมต่อกับ Supabase — แสดงข้อมูลจากเครื่องนี้เท่านั้น`;
      }
    }

    // ---- แถบเตือนบัญชีที่ถูกปิดใช้งาน (ของ admin เท่านั้น) ----
    // เดิมเป็นแถบ "รอยืนยัน" — เลิกใช้แล้วเพราะไม่มีขั้นอนุมัติ
    // (migration-2026-11-13b-no-approval.sql: แถวใหม่ active = true ใช้งานได้ทันที)
    const inactiveList = MemberStore.inactive();
    if (pendingBox) {
      if (viewerIsAdmin && inactiveList.length) {
        pendingBox.textContent = `มี ${inactiveList.length} บัญชีถูกปิดใช้งานไว้`
          + ' — บัญชีเหล่านี้ login ไม่ได้จนกว่าจะกด "เปิดใช้งาน" คืน';
        pendingBox.style.display = 'block';
      } else {
        pendingBox.style.display = 'none';
      }
    }

    // ---- ตาราง ----
    // crew เห็น 5 คอลัมน์ (ไม่มี สถานะ / จัดการ) เพราะเขาแก้ใครไม่ได้และเห็นแค่แถวตัวเอง
    // หัวตารางเป็น markup คงที่ทั้งหมด (ไม่มีข้อมูลผู้ใช้) จึงร้อย innerHTML ได้
    const colCount = viewerIsAdmin ? 7 : 5;
    listEl.innerHTML = `
      <table class="table table-sm align-middle mb-0">
        <thead>
          <tr>
            <th>รหัส</th>
            <th>ชื่อ</th>
            <th>อีเมล</th>
            <th>สิทธิ์</th>
            ${viewerIsAdmin ? '<th>สถานะ</th>' : ''}
            <th>จอง</th>
            ${viewerIsAdmin ? '<th class="text-end">จัดการ</th>' : ''}
          </tr>
        </thead>
        <tbody></tbody>
      </table>`;
    const tbody = listEl.querySelector('tbody');

    if (!visible.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = colCount;
      td.className = 'small text-muted py-3 text-center';
      if (!viewerIsAdmin) {
        td.textContent = 'ไม่พบบัญชีของคุณในตาราง members — ให้ admin ตรวจสอบ';
      } else {
        td.textContent = st.isSupabase
          ? 'ยังไม่มีทีมงานในตาราง members — สร้างบัญชีที่ Supabase → Authentication → Users แล้วกด "ตรวจซ้ำ"'
          : 'โหมด local ไม่มีรายชื่อทีมงานให้จัดการ';
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    visible.forEach((m) => {
      const tr = document.createElement('tr');
      const isSelf = isSelfRow(m);
      if (isSelf) tr.className = 'table-light';

      const cells = [
        m.code || '(ไม่มีรหัส)',
        (m.fullName || '-') + (isSelf ? '  ← คุณ' : ''),
        m.email || (m.authUid ? '(ไม่มีอีเมล)' : '(ยังไม่ผูกบัญชี)'),
      ];
      cells.forEach((text) => {
        const td = document.createElement('td');
        td.className = 'small';
        td.textContent = text;
        tr.appendChild(td);
      });

      // badge สิทธิ์
      const tdRole = document.createElement('td');
      const roleBadge = document.createElement('span');
      roleBadge.className = m.role === 'admin' ? 'badge bg-dark' : 'badge bg-light text-dark border';
      roleBadge.textContent = m.role;
      tdRole.appendChild(roleBadge);
      tr.appendChild(tdRole);

      // badge สถานะ — เฉพาะ admin (crew เห็นแค่แถวตัวเองซึ่งต้อง active อยู่แล้วจึง login ได้)
      if (viewerIsAdmin) {
        const tdActive = document.createElement('td');
        const activeBadge = document.createElement('span');
        activeBadge.className = m.active ? 'badge bg-success' : 'badge bg-danger';
        activeBadge.textContent = m.active ? 'ใช้งาน' : 'ปิดใช้งาน';
        tdActive.appendChild(activeBadge);
        tr.appendChild(tdActive);
      }

      // ปุ่มจอง — อยู่ท้ายชื่อของตัวเองตามที่ต้องการ
      // พาไปหน้าปฏิทินจอง (booking.html) ซึ่งเป็นที่เดียวที่ใช้สร้างใบจอง
      // ฝั่งโน้นจะเปิดโหมดข้อมูลจริงให้อัตโนมัติเพราะบัญชีนี้ sign in อยู่แล้ว
      const tdBook = document.createElement('td');
      tdBook.className = 'text-end';
      if (isSelf) {
        const bookBtn = document.createElement('a');
        bookBtn.className = 'btn btn-outline-dark btn-sm';
        bookBtn.href = 'booking.html?source=live';
        bookBtn.textContent = 'จอง';
        bookBtn.title = 'ไปที่ปฏิทินจอง — กดวันที่ แล้วกด "จองของวันนี้" เพื่อสร้างใบจองในชื่อของคุณ';
        tdBook.appendChild(bookBtn);
      } else {
        // แถวของคนอื่นไม่ใช่ของที่จะกดจองแทน
        tdBook.textContent = '—';
      }
      tr.appendChild(tdBook);

      // ปุ่มจัดการ — ของ admin เท่านั้น
      // crew ไม่มีสิทธิ์เขียนตาราง members (RLS ปฏิเสธ) จึงไม่เรนเดอร์ปุ่มให้กดแล้ว error
      if (viewerIsAdmin) {
        const tdBtn = document.createElement('td');
        tdBtn.className = 'text-end';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn btn-outline-dark btn-sm';
        editBtn.textContent = 'แก้ไข';
        editBtn.addEventListener('click', () => openMemberModal(String(m.id)));
        tdBtn.appendChild(editBtn);

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = m.active
          ? 'btn btn-outline-danger btn-sm ms-1'
          : 'btn btn-dark btn-sm ms-1';
        toggleBtn.textContent = m.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน';
        toggleBtn.addEventListener('click', async () => {
          const turningOff = m.active === true;
          if (turningOff) {
            const head = isSelf
              ? 'ปิดใช้งานบัญชีของคุณเอง?'
              : `ปิดใช้งาน ${m.fullName || m.code || 'สมาชิกรายนี้'}?`;
            const ok = window.confirm(
              head
              + '\n\nจะ login เข้าใช้สิทธิ์ใด ๆ ไม่ได้อีกจนกว่าจะกดเปิดใช้งานคืน'
              + '\n(ถ้าเป็น admin คนสุดท้าย ฐานข้อมูลจะปฏิเสธเพื่อไม่ให้ทุกคนถูกล็อกออก)'
            );
            if (!ok) return;
          }
          toggleBtn.disabled = true;
          try {
            await MemberStore.setActive(String(m.id), !turningOff);
            await refreshMembers();
            // ถ้าปิดใช้งานตัวเองสำเร็จ สิทธิ์ admin หายทันที ต้องโหลดหน้าใหม่
            if (turningOff && isSelf) location.reload();
          } catch (err) {
            console.error('เปลี่ยนสถานะสมาชิกไม่สำเร็จ:', err);
            // ข้อความจาก trigger protect_last_admin เป็นภาษาไทยอยู่แล้ว
            showStatus((err && err.message) || 'เปลี่ยนสถานะไม่สำเร็จ', false);
            toggleBtn.disabled = false;
          }
        });
        tdBtn.appendChild(toggleBtn);

        tr.appendChild(tdBtn);
      }

      tbody.appendChild(tr);
    });
  }

  function openMemberModal(memberId) {
    // crew ไม่ควรมาถึงที่นี่ (ปุ่มแก้ไขไม่ถูกเรนเดอร์ให้) — กันไว้เผื่อเรียกจาก console
    // เพราะถึงเปิดฟอร์มได้ RLS ก็ปฏิเสธตอนบันทึกอยู่ดี ดีกว่าให้กรอกเสร็จแล้ว error
    if (AdminAuth.getRole() !== 'admin') {
      showStatus('สิทธิ์ crew แก้ไขข้อมูลทีมงานไม่ได้ — ติดต่อ admin', false);
      return;
    }
    const m = MemberStore.getById(memberId);
    if (!m) {
      showStatus('ไม่พบสมาชิกรายนี้ — กด "ตรวจซ้ำ" แล้วลองใหม่', false);
      return;
    }
    document.getElementById('adminItemModalTitle').textContent = 'แก้ไขทีมงานและสิทธิ์';
    document.getElementById('adminItemModalBody').innerHTML = memberEditorHtml(m, 'adminMemberEditForm', {});
    // พารามิเตอร์ที่ 3 ต้องเป็นฟังก์ชัน onSaved (ไม่ใช่อ็อบเจ็กต์) —
    // ตาม pattern ของ bindAccessoryEditor/bindFixtureEditor
    // ถ้าส่ง { onSaved } ไป typeof !== 'function' จะทำให้บันทึกสำเร็จแต่ไม่ทำอะไรเงียบ ๆ
    bindMemberEditor('adminMemberEditForm', String(m.id), async ({ item }) => {
      itemModal.hide();
      await refreshMembers();
      showStatus(`บันทึกสิทธิ์ของ ${item?.fullName || item?.code || 'ทีมงาน'} แล้ว`);
    }, {
      onCancel: () => itemModal.hide(),
    });
    itemModal.show();
  }

  async function refreshMembers() {
    try {
      await MemberStore.load();
    } catch (err) {
      console.warn('โหลดรายชื่อทีมงานไม่สำเร็จ:', err);
    }
    renderMembers();
  }

  async function renderHiddenList() {
    const listEl = document.getElementById('hiddenItemsList');
    if (!listEl) return;

    const fixtureHidden = DB.getAll().filter((item) => item.hidden);
    const accessoryHidden = AccessoryStore.getAll().filter((item) => item.hidden);
    const allHidden = [
      ...fixtureHidden.map((item) => ({
        kind: 'fixture', id: item.id, type: 'Fixture',
        label: `${item.brand} ${item.model}`, link: `fixture.html?id=${item.id}`,
      })),
      ...accessoryHidden.map((item) => ({
        kind: 'accessory', id: item.id, type: 'Accessory',
        label: `${item.name}${item.brand ? ` (${item.brand})` : ''}`, link: 'accessories.html',
      })),
    ];

    const countEl = document.getElementById('hiddenCount');
    if (countEl) countEl.textContent = allHidden.length;

    if (!allHidden.length) {
      listEl.innerHTML = '<div class="text-muted">ไม่มีรายการที่ซ่อนอยู่</div>';
      return;
    }

    listEl.innerHTML = allHidden.map((item) => `
      <div class="spec-row" style="align-items:flex-start; gap:1rem">
        <div>
          <strong>${item.label}</strong>
          <div class="small text-muted">${item.type}</div>
        </div>
        <div style="text-align:right; display:flex; flex-direction:column; gap:.35rem; align-items:flex-end;">
          <span class="small text-danger"><strong>hidden</strong></span>
          <button class="btn btn-sm btn-outline-dark unhide-btn" data-kind="${item.kind}" data-id="${item.id}">ยกเลิกซ่อน</button>
          <a class="small" href="${item.link}">เปิดหน้า</a>
        </div>
      </div>`).join('');

    listEl.querySelectorAll('.unhide-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const kind = btn.dataset.kind;
        btn.disabled = true;
        try {
          if (kind === 'fixture') await DB.update(id, { hidden: false });
          else await AccessoryStore.update(id, { hidden: false });
          showStatus('ยกเลิกซ่อนรายการแล้ว');
          await refreshData();
          await renderHiddenList();
          await renderDataSummary();
        } catch (err) {
          console.error(err);
          btn.disabled = false;
          showStatus('ทำไม่สำเร็จ: ' + ((err && err.message) || err), false);
        }
      });
    });
  }

  // ---------------- เพิ่ม fixture / accessory ----------------
  function openAddFixtureModal() {
    document.getElementById('adminItemModalTitle').textContent = 'เพิ่ม Fixture ใหม่';
    document.getElementById('adminItemModalBody').innerHTML = fixtureEditorHtml({}, 'adminFixtureCreateForm', {
      isCreate: true,
      title: 'เพิ่ม Fixture ใหม่',
      submitLabel: 'เพิ่ม Fixture',
    });

    bindFixtureEditor('adminFixtureCreateForm', null, async ({ item }) => {
      itemModal.hide();
      await refreshData();
      renderConnectionPanel();
      await renderDataSummary();
      await renderHiddenList();
      showStatus(`เพิ่ม Fixture ${item?.brand || ''} ${item?.model || ''}`.trim() + ' แล้ว');
    }, {
      isCreate: true,
      onCancel: () => itemModal.hide(),
    });

    itemModal.show();
  }

  function openAddAccessoryModal() {
    document.getElementById('adminItemModalTitle').textContent = 'เพิ่ม Accessory ใหม่';
    document.getElementById('adminItemModalBody').innerHTML = accessoryEditorHtml({}, 'adminAccessoryCreateForm', {
      isCreate: true,
      title: 'เพิ่ม Accessory ใหม่',
      submitLabel: 'เพิ่ม Accessory',
    });

    bindAccessoryEditor('adminAccessoryCreateForm', null, async ({ item }) => {
      itemModal.hide();
      await refreshData();
      renderConnectionPanel();
      await renderDataSummary();
      await renderHiddenList();
      showStatus(`เพิ่ม Accessory ${item?.name || ''} แล้ว`);
    }, {
      isCreate: true,
      onCancel: () => itemModal.hide(),
    });

    itemModal.show();
  }

  // ---------------- แสดง/ซ่อนตามสิทธิ์ ----------------
  // crew login เข้าหน้านี้ได้ แต่เห็นเฉพาะแผง "ทีมงานและสิทธิ์" (แถวของตัวเอง)
  //
  // สำคัญ: การซ่อนนี้ไม่ใช่กำแพงความปลอดภัย — RLS ต่างหากที่เป็นกำแพงจริง
  // (crew อ่าน members ได้แค่แถวตัวเอง และเขียน fixtures/accessories/members ไม่ได้เลย)
  // ที่ซ่อนเพราะไม่อยากให้เห็นปุ่มที่กดแล้วจะ error และไม่ต้องโหลดข้อมูลที่เขาไม่ได้ใช้
  function applyRoleVisibility(isAdminViewer) {
    const setVisible = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? '' : 'none';
    };
    // แผงที่เป็นเครื่องมือ admin ล้วน ๆ
    // connectionPanel มีปุ่ม "Import ข้อมูล local ขึ้น Supabase" ซึ่งเป็นงานเขียน
    setVisible('connectionPanel', isAdminViewer);
    setVisible('verifyPanel', isAdminViewer);
    setVisible('tipsPanel', isAdminViewer);
    setVisible('dataPanel', isAdminViewer);
    // แผงจัดการใบจองเป็นงานเขียนล้วน ๆ (รับของ / ปักค้างคืน / ยกเลิก) ของ admin เท่านั้น
    setVisible('bookingAdminPanel', isAdminViewer);
    // ในแผงทีมงาน: วิธีเพิ่มคน + ปุ่มตรวจซ้ำ เป็นของ admin
    setVisible('memberAdminHint', isAdminViewer);
    setVisible('refreshMembersBtn', isAdminViewer);
    setVisible('memberCrewHint', !isAdminViewer);
  }

  // ---------------- เข้าหน้าหลัง login (admin เห็นทุกแผง / crew เห็นแผงเดียว) ----------------
  let appBound = false;

  async function showApp() {
    const myRole = AdminAuth.getRole();
    const isAdminViewer = myRole === 'admin';
    applyRoleVisibility(isAdminViewer);

    if (lockScreen) lockScreen.style.display = 'none';
    if (app) app.style.display = 'block';

    const who = document.getElementById('adminUserEmail');
    if (who) who.textContent = AdminAuth.getEmail() || '';

    // คำอธิบายใต้บัญชีต้องต่างกันตามสิทธิ์ — crew ไม่ได้เข้า "โหมด admin"
    const hintEl = document.getElementById('adminAppHint');
    if (hintEl) {
      hintEl.textContent = isAdminViewer
        ? ' · ตอนนี้ปุ่ม "แก้ไข / ซ่อน / ลบ" จะปรากฏในหน้า Detail ของอุปกรณ์และ Accessories'
        : ' · สิทธิ์ crew เห็นเฉพาะบัญชีของตัวเอง (ปุ่ม จอง จะพาไปหน้าปฏิทินจอง)';
    }

    // โชว์สิทธิ์ + รหัสประจำตัวจากตาราง members
    // ใช้ textContent/createElement ทั้งหมด เพราะค่ามาจากฐานข้อมูล
    // (ถ้าเอาไปร้อยเป็น innerHTML ตรง ๆ จะเปิดช่อง XSS)
    const roleEl = document.getElementById('adminUserRole');
    if (roleEl) {
      roleEl.textContent = '';
      if (myRole) {
        const badge = document.createElement('span');
        badge.className = 'badge bg-dark';
        const code = AdminAuth.getMemberCode();
        badge.textContent = code ? `${myRole} · ${code}` : String(myRole);
        roleEl.appendChild(badge);
      }
    }

    // เตือนเมื่อสิทธิ์มาจากทางออกฉุกเฉิน (อ่านตาราง members ไม่ได้)
    // ไม่งั้นผู้ใช้จะไม่รู้ตัวว่ายังไม่ได้รัน migration
    const warnEl = document.getElementById('adminRoleWarning');
    if (warnEl) {
      const roleError = AdminAuth.getRoleError();
      warnEl.textContent = roleError ? `⚠️ ${roleError}` : '';
      warnEl.style.display = roleError ? 'block' : 'none';
    }

    // ทีมงานและสิทธิ์ — โหลดเฉพาะตอน login แล้ว เพราะแผงนี้อยู่ใน adminApp
    // และ RLS ให้ crew อ่านได้แค่แถวของตัวเอง จึงไม่เสีย query ฟรีตอนยังไม่ login
    // crew ก็ต้องโหลด เพราะนี่คือแผงเดียวที่ crew เห็น
    await refreshMembers();

    // งานของ admin ล้วน ๆ — crew ข้ามไปเลย ไม่ต้องยิง query ที่เขาไม่มีสิทธิ์แก้
    // (แผงพวกนี้ถูกซ่อนไว้ใน applyRoleVisibility แล้ว)
    if (isAdminViewer) {
      await refreshData();

      // แผงจัดการใบจอง — โหลดเฉพาะ admin เพราะทุกปุ่มในแผงนี้เป็นงานเขียน
      // (crew อ่านใบจองของคนอื่นไม่เห็นอยู่แล้ว จึงโหลดไปก็เจอแต่ error)
      // ถ้ายังไม่ได้รัน migration แผงจะฟ้องตรง ๆ ว่าต้องรันไฟล์ไหน ไม่เงียบ
      if (window.BookingAdmin && typeof window.BookingAdmin.init === 'function') {
        try {
          await window.BookingAdmin.init();
        } catch (e) {
          // แผงจองพังต้องไม่ลากหน้า admin ทั้งหน้าพังตาม
          console.error('[booking-admin] init failed', e);
        }
      }

      const summary = VerificationStore.getSummary();
      if (summary) {
        const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value ?? '-'; };
        set('verifyTotal', summary.totalFixtures);
        set('verifyVerified', summary.statuses?.verified);
        set('verifyPartial', summary.statuses?.partially_verified);
        set('verifyPending', summary.statuses?.pending);
        const meta = document.getElementById('verifyMetaText');
        if (meta) {
          meta.textContent = `อัปเดตล่าสุด ${summary.generatedAt} · ตรวจโดย ${summary.verifiedBy} · แหล่งอ้างอิง ${summary.sourceCount} แหล่ง`;
        }
      }

      renderConnectionPanel();
      await renderHiddenList();
      await renderDataSummary();
    }

    if (appBound) return;
    appBound = true;

    document.querySelectorAll('.verify-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        renderVerificationList(btn.dataset.status);
        verifyModal.show();
      });
    });

    document.getElementById('hiddenItemsBtn')?.addEventListener('click', async () => {
      await refreshData();
      await renderHiddenList();
      hiddenModal.show();
    });

    document.getElementById('addFixtureBtn')?.addEventListener('click', openAddFixtureModal);
    document.getElementById('addAccessoryBtn')?.addEventListener('click', openAddAccessoryModal);

    document.getElementById('refreshMembersBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await refreshMembers();
        showStatus('โหลดรายชื่อทีมงานใหม่แล้ว');
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('adminLogoutBtn')?.addEventListener('click', async () => {
      await AdminAuth.signOut();
      location.reload();
    });

    document.getElementById('exportFixturesBtn')?.addEventListener('click', async () => {
      await DB.load();
      const blob = new Blob([DB.exportJson()], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'fixtures.edited.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showStatus('Export Fixtures JSON แล้ว');
    });

    document.getElementById('exportAccessoriesBtn')?.addEventListener('click', async () => {
      await AccessoryStore.load();
      const blob = new Blob([AccessoryStore.exportJson()], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'accessories.edited.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showStatus('Export Accessories JSON แล้ว');
    });

    document.getElementById('resetAllDataBtn')?.addEventListener('click', async () => {
      if (DB.isSupabase()) {
        showStatus('ปุ่มนี้ใช้ได้เฉพาะโหมด local — ตอนนี้ข้อมูลอยู่บน Supabase จึงไม่มีอะไรให้รีเซ็ต', false);
        return;
      }
      if (!window.confirm('รีเซ็ตข้อมูล local ทั้งหมดกลับไปเป็นค่าตั้งต้น?')) return;
      DB.resetToOriginal();
      AccessoryStore.resetToOriginal();
      showStatus('รีเซ็ตข้อมูล local แล้ว');
      setTimeout(() => location.reload(), 800);
    });
  }

  // ---------------- ฟอร์ม login ----------------
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      showLoginError('');
      setLoginBusy(true);
      try {
        const result = await AdminAuth.signIn(emailInput?.value, passwordInput?.value);
        // crew ก็เข้าหน้านี้ได้ (เห็นเฉพาะบัญชีตัวเอง + ปุ่มจอง) จึงไม่รอให้ result.ok
        // ซึ่ง admin-only — เช็คแค่ "login ผ่าน และมีสิทธิ์ในตาราง members"
        // role เป็น null เมื่อ active=false หรือไม่มีแถวในตาราง → ต้องค้างที่หน้า login
        const canEnter = result.ok || (!!result.loggedIn && !!result.role);
        if (canEnter) {
          showLoginError('เข้าสู่ระบบสำเร็จ กำลังโหลดข้อมูล...', true);
          await showApp();
        } else {
          showLoginError(result.error || 'เข้าสู่ระบบไม่สำเร็จ');
        }
      } catch (err) {
        console.error(err);
        showLoginError('เกิดข้อผิดพลาด: ' + ((err && err.message) || err));
      } finally {
        setLoginBusy(false);
      }
    });
  }

  // ---------------- ตอนเปิดหน้า ----------------
  await AdminAuth.ready;

  // เปิดหน้ามาแล้วมี session ค้างอยู่ → เข้าหน้าได้เลย
  // ต้องเช็ค isLoggedIn() ไม่ใช่ isUnlocked() เพราะ isUnlocked() เป็น admin-only
  // ไม่งั้น crew ที่ login ค้างไว้จะถูกดีดกลับมาหน้า login ทุกครั้งที่รีเฟรช
  // และต้องมี role ด้วย — role เป็น null เมื่อ active=false หรือไม่มีแถวในตาราง members
  if (AdminAuth.isLoggedIn() && AdminAuth.getRole()) {
    await showApp();
  } else {
    // โหลดข้อมูลไว้ก่อนเพื่อให้แผงสถานะ/ปุ่ม import ทำงานได้แม้ยังไม่ได้ login
    try {
      await refreshData();
    } catch (err) {
      console.warn('โหลดข้อมูลตอนเปิดหน้า admin ไม่สำเร็จ:', err);
    }
    const lastErr = AdminAuth.getLastError();
    if (lastErr) showLoginError(lastErr);
    if (!window.sb) {
      showLoginError('โหลด supabase-js ไม่สำเร็จ จึง login ด้วย Supabase ไม่ได้ — ตรวจเน็ตแล้วรีเฟรชหน้าใหม่');
    }
  }
});
