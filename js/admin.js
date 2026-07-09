document.addEventListener('DOMContentLoaded', async () => {
  const lockScreen = document.getElementById('adminLockScreen');
  const app = document.getElementById('adminApp');
  const loginForm = document.getElementById('adminLoginForm');
  const emailInput = document.getElementById('adminEmailInput');
const passwordInput = document.getElementById('adminPasswordInput');
  const loginStatus = document.getElementById('adminLoginStatus');
  const status = document.getElementById('adminStatus');
  const verifyModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('verifyStatusModal'));
  const hiddenModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('hiddenItemsModal'));
  const itemModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('adminItemModal'));

  function showStatus(message, ok = true) {
    status.className = (ok ? 'text-success' : 'text-danger') + ' small';
    status.textContent = message;
    clearTimeout(window.__adminStatusTimer);
    window.__adminStatusTimer = setTimeout(() => { status.textContent = ''; }, 3500);
  }

  async function refreshData() {
    await Promise.all([DB.load(), AccessoryStore.load(), VerificationStore.load()]);
  }

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
      pending: 'รายการที่ Pending'
    };
    const label = labels[filterStatus] || 'แสดงทั้งหมด';
    labelEl.textContent = label;
    modalTitle.textContent = label;

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
    await Promise.all([DB.load(), AccessoryStore.load()]);
    const fixtures = DB.getAll();
    const accessories = AccessoryStore.getAll();
    const hiddenFixtures = fixtures.filter((item) => item.hidden).length;
    const hiddenAccessories = accessories.filter((item) => item.hidden).length;
    document.getElementById('adminDataSummary').textContent = `Fixtures ${fixtures.length} รายการ · Accessories ${accessories.length} รายการ · Hidden ${hiddenFixtures + hiddenAccessories} รายการ`;
  }

  async function renderHiddenList() {
    const listEl = document.getElementById('hiddenItemsList');
    await Promise.all([DB.load(), AccessoryStore.load()]);

    const fixtureHidden = DB.getAll().filter((item) => item.hidden);
    const accessoryHidden = AccessoryStore.getAll().filter((item) => item.hidden);
    const allHidden = [
      ...fixtureHidden.map((item) => ({ kind: 'fixture', id: item.id, type: 'Fixture', label: `${item.brand} ${item.model}`, link: `fixture.html?id=${item.id}` })),
      ...accessoryHidden.map((item) => ({ kind: 'accessory', id: item.id, type: 'Accessory', label: `${item.name}${item.brand ? ` (${item.brand})` : ''}`, link: 'accessories.html' }))
    ];

    document.getElementById('hiddenCount').textContent = allHidden.length;

    if (!allHidden.length) {
      listEl.innerHTML = '<div class="text-muted">ไม่มีรายการที่ซ่อนอยู่</div>';
      return;
    }

    listEl.innerHTML = allHidden.map((item) => `
      <div class="spec-row" style="align-items:flex-start; gap:1rem;">
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
        if (kind === 'fixture') {
          DB.update(id, { hidden: false });
        } else {
          AccessoryStore.update(id, { hidden: false });
        }
        showStatus('ยกเลิกซ่อนรายการแล้ว');
        await renderHiddenList();
        await renderDataSummary();
      });
    });
  }

  function openAddFixtureModal() {
    document.getElementById('adminItemModalTitle').textContent = 'เพิ่ม Fixture ใหม่';
    document.getElementById('adminItemModalBody').innerHTML = fixtureEditorHtml({}, 'adminFixtureCreateForm', {
      isCreate: true,
      title: 'เพิ่ม Fixture ใหม่',
      submitLabel: 'เพิ่ม Fixture'
    });

    bindFixtureEditor('adminFixtureCreateForm', null, async ({ item }) => {
      itemModal.hide();
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
      submitLabel: 'เพิ่ม Accessory'
    });

    bindAccessoryEditor('adminAccessoryCreateForm', null, async ({ item }) => {
      itemModal.hide();
      await renderDataSummary();
      await renderHiddenList();
      showStatus(`เพิ่ม Accessory ${item?.name || ''} แล้ว`);
    }, {
      isCreate: true,
      onCancel: () => itemModal.hide(),
    });

    itemModal.show();
  }

  async function showApp() {
    lockScreen.style.display = 'none';
    app.style.display = 'block';
    await refreshData();

    const summary = VerificationStore.getSummary();
    if (summary) {
      document.getElementById('verifyTotal').textContent = summary.totalFixtures ?? '-';
      document.getElementById('verifyVerified').textContent = summary.statuses?.verified ?? '-';
      document.getElementById('verifyPartial').textContent = summary.statuses?.partially_verified ?? '-';
      document.getElementById('verifyPending').textContent = summary.statuses?.pending ?? '-';
      document.getElementById('verifyMetaText').textContent = `อัปเดตล่าสุด ${summary.generatedAt} · ตรวจโดย ${summary.verifiedBy} · แหล่งอ้างอิง ${summary.sourceCount} แหล่ง`;
    }

    document.querySelectorAll('.verify-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        renderVerificationList(btn.dataset.status);
        verifyModal.show();
      });
    });

    await renderHiddenList();
    await renderDataSummary();

    document.getElementById('hiddenItemsBtn')?.addEventListener('click', async () => {
      await renderHiddenList();
      hiddenModal.show();
    });

    document.getElementById('addFixtureBtn')?.addEventListener('click', openAddFixtureModal);
    document.getElementById('addAccessoryBtn')?.addEventListener('click', openAddAccessoryModal);
  }

  loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await AdminAuth.unlock(
    emailInput.value.trim(),
    passwordInput.value
  );

  if (ok) {
    loginStatus.textContent = '';
    await showApp();
  } else {
    loginStatus.textContent = 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
  }
});

  if (AdminAuth.isUnlocked()) {
    await showApp();
  }

  document.getElementById('adminLogoutBtn')?.addEventListener('click', () => {
    AdminAuth.lock();
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

  document.getElementById('resetAllDataBtn')?.addEventListener('click', () => {
    if (!confirm('รีเซ็ตข้อมูล local ทั้งหมดกลับไปเป็นค่าตั้งต้น?')) return;
    DB.resetToOriginal();
    AccessoryStore.resetToOriginal();
    showStatus('รีเซ็ตข้อมูล local แล้ว');
    setTimeout(() => location.reload(), 800);
  });
});
