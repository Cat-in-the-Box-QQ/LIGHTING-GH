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

  // ---------------- เข้าโหมด admin ----------------
  let appBound = false;

  async function showApp() {
    if (lockScreen) lockScreen.style.display = 'none';
    if (app) app.style.display = 'block';

    const who = document.getElementById('adminUserEmail');
    if (who) who.textContent = AdminAuth.getEmail() || '';

    await refreshData();

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
        if (result.ok) {
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

  if (AdminAuth.isUnlocked()) {
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
