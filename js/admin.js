document.addEventListener('DOMContentLoaded', async () => {
  const lockScreen = document.getElementById('adminLockScreen');
  const app = document.getElementById('adminApp');
  const loginForm = document.getElementById('adminLoginForm');
  const emailInput = document.getElementById('adminEmailInput');
  const passwordInput = document.getElementById('adminPasswordInput');
  const loginStatus = document.getElementById('adminLoginStatus');
  const status = document.getElementById('adminStatus');

  const verifyModal = document.getElementById('verifyStatusModal')
    ? bootstrap.Modal.getOrCreateInstance(document.getElementById('verifyStatusModal'))
    : null;
  const hiddenModal = document.getElementById('hiddenItemsModal')
    ? bootstrap.Modal.getOrCreateInstance(document.getElementById('hiddenItemsModal'))
    : null;
  const itemModal = document.getElementById('adminItemModal')
    ? bootstrap.Modal.getOrCreateInstance(document.getElementById('adminItemModal'))
    : null;

  function showStatus(message, ok = true) {
    if (!status) return;
    status.className = (ok ? 'text-success' : 'text-danger') + ' small';
    status.textContent = message;
    clearTimeout(window.__adminStatusTimer);
    window.__adminStatusTimer = setTimeout(() => {
      status.textContent = '';
    }, 3500);
  }

  async function refreshData() {
    await Promise.all([
      DB.load(),
      AccessoryStore.load(),
      VerificationStore.load(),
    ]);
  }

  async function syncAccessoryNameAcrossFixturesAsync(oldName, newName, compatibleIds = []) {
    const updatedFixtures = DB.getAll().map((fixture) => {
      let accessories = Array.isArray(fixture.accessories) ? [...fixture.accessories] : [];
      if (oldName) accessories = accessories.filter((item) => item !== oldName);
      if (newName && compatibleIds.includes(Number(fixture.id))) accessories.push(newName);
      accessories = [...new Set(accessories)];
      return {
        ...fixture,
        accessories,
        compatibleText: accessories.join(' '),
      };
    });

    await DB.replaceAll(updatedFixtures);
  }

  function renderVerificationList(filterStatus = 'all') {
    const listEl = document.getElementById('verifyList');
    const labelEl = document.getElementById('verifyFilterLabel');
    const modalTitle = document.getElementById('verifyModalTitle');
    if (!listEl || !labelEl || !modalTitle) return;

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

    const el = document.getElementById('adminDataSummary');
    if (el) {
      el.textContent = `Fixtures ${fixtures.length} รายการ · Accessories ${accessories.length} รายการ · Hidden ${hiddenFixtures + hiddenAccessories} รายการ`;
    }
  }

  async function renderHiddenList() {
    const listEl = document.getElementById('hiddenItemsList');
    if (!listEl) return;

    await Promise.all([DB.load(), AccessoryStore.load()]);

    const fixtureHidden = DB.getAll().filter((item) => item.hidden);
    const accessoryHidden = AccessoryStore.getAll().filter((item) => item.hidden);

    const allHidden = [
      ...fixtureHidden.map((item) => ({
        kind: 'fixture',
        id: item.id,
        type: 'Fixture',
        label: `${item.brand} ${item.model}`,
        link: `fixture.html?id=${item.id}`
      })),
      ...accessoryHidden.map((item) => ({
        kind: 'accessory',
        id: item.id,
        type: 'Accessory',
        label: `${item.name}${item.brand ? ` (${item.brand})` : ''}`,
        link: 'accessories.html'
      }))
    ];

    const hiddenCountEl = document.getElementById('hiddenCount');
    if (hiddenCountEl) hiddenCountEl.textContent = allHidden.length;

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

        try {
          if (kind === 'fixture') {
            await DB.update(id, { hidden: false });
          } else {
            await AccessoryStore.update(id, { hidden: false });
          }

          showStatus('ยกเลิกซ่อนรายการแล้ว');
          await renderHiddenList();
          await renderDataSummary();
        } catch (err) {
          console.error(err);
          showStatus('ยกเลิกซ่อนไม่สำเร็จ', false);
        }
      });
    });
  }

  function bindFixtureCreateForm() {
    const formId = 'adminFixtureCreateForm';
    const form = document.getElementById(formId);
    const cancelBtn = document.getElementById(`${formId}-cancel`);
    const statusEl = document.getElementById(`${formId}-status`);
    if (!form) return;

    function recalc() {
      const unitsPerSet = Math.max(Number(form.elements.unitsPerSet?.value) || 0, 0);
      const setCount = Math.max(Number(form.elements.setCountInStock?.value) || 0, 0);
      if (unitsPerSet > 0 && setCount > 0) {
        form.elements.stockCount.value = unitsPerSet * setCount;
      }
    }

    ['unitsPerSet', 'setCountInStock'].forEach((name) => {
      form.elements[name]?.addEventListener('input', recalc);
    });

    cancelBtn?.addEventListener('click', () => itemModal?.hide());

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      try {
        const { patch, reserved, inUse } = normalizeFixturePatchFromForm(form);
        let savedItem = await DB.create(patch);
        savedItem = await DB.updateInventory(savedItem.id, { reserved, inUse });

        if (statusEl) statusEl.textContent = 'เพิ่มรายการแล้ว';
        itemModal?.hide();
        await renderDataSummary();
        await renderHiddenList();
        showStatus(`เพิ่ม Fixture ${savedItem?.brand || ''} ${savedItem?.model || ''}`.trim() + ' แล้ว');
      } catch (err) {
        console.error(err);
        if (statusEl) statusEl.textContent = 'เพิ่มรายการไม่สำเร็จ';
        showStatus('เพิ่ม Fixture ไม่สำเร็จ', false);
      }
    });
  }

  function bindAccessoryCreateForm() {
    const formId = 'adminAccessoryCreateForm';
    const form = document.getElementById(formId);
    const cancelBtn = document.getElementById(`${formId}-cancel`);
    const statusEl = document.getElementById(`${formId}-status`);
    if (!form) return;

    cancelBtn?.addEventListener('click', () => itemModal?.hide());

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      try {
        const patch = {
          name: form.elements.name.value.trim() || null,
          brand: form.elements.brand.value.trim() || null,
          category: form.elements.category.value.trim() || null,
          stock: form.elements.stock.value.trim() || null,
          pdfPage: form.elements.pdfPage.value.trim() === '' ? null : Number(form.elements.pdfPage.value.trim()),
          image: form.elements.image.value.trim() || null,
          compatibleWith: form.elements.compatibleWith.value
            .split(',')
            .map((item) => Number(item.trim()))
            .filter(Boolean),
        };

        const savedItem = await AccessoryStore.create(patch);
        await syncAccessoryNameAcrossFixturesAsync(null, savedItem?.name || null, savedItem?.compatibleWith || []);

        if (statusEl) statusEl.textContent = 'เพิ่มรายการแล้ว';
        itemModal?.hide();
        await renderDataSummary();
        await renderHiddenList();
        showStatus(`เพิ่ม Accessory ${savedItem?.name || ''} แล้ว`);
      } catch (err) {
        console.error(err);
        if (statusEl) statusEl.textContent = 'เพิ่มรายการไม่สำเร็จ';
        showStatus('เพิ่ม Accessory ไม่สำเร็จ', false);
      }
    });
  }

  function openAddFixtureModal() {
    const titleEl = document.getElementById('adminItemModalTitle');
    const bodyEl = document.getElementById('adminItemModalBody');
    if (!titleEl || !bodyEl) return;

    titleEl.textContent = 'เพิ่ม Fixture ใหม่';
    bodyEl.innerHTML = fixtureEditorHtml({}, 'adminFixtureCreateForm', {
      isCreate: true,
      title: 'เพิ่ม Fixture ใหม่',
      submitLabel: 'เพิ่ม Fixture'
    });

    bindFixtureCreateForm();
    itemModal?.show();
  }

  function openAddAccessoryModal() {
    const titleEl = document.getElementById('adminItemModalTitle');
    const bodyEl = document.getElementById('adminItemModalBody');
    if (!titleEl || !bodyEl) return;

    titleEl.textContent = 'เพิ่ม Accessory ใหม่';
    bodyEl.innerHTML = accessoryEditorHtml({}, 'adminAccessoryCreateForm', {
      isCreate: true,
      title: 'เพิ่ม Accessory ใหม่',
      submitLabel: 'เพิ่ม Accessory'
    });

    bindAccessoryCreateForm();
    itemModal?.show();
  }

  async function showApp() {
    const ok = await AdminAuth.refresh();
    if (!ok) {
      if (lockScreen) lockScreen.style.display = 'block';
      if (app) app.style.display = 'none';
      return;
    }

    if (lockScreen) lockScreen.style.display = 'none';
    if (app) app.style.display = 'block';

    await refreshData();

    const summary = VerificationStore.getSummary();
    if (summary) {
      const totalEl = document.getElementById('verifyTotal');
      const verifiedEl = document.getElementById('verifyVerified');
      const partialEl = document.getElementById('verifyPartial');
      const pendingEl = document.getElementById('verifyPending');
      const metaEl = document.getElementById('verifyMetaText');

      if (totalEl) totalEl.textContent = summary.totalFixtures ?? '-';
      if (verifiedEl) verifiedEl.textContent = summary.statuses?.verified ?? '-';
      if (partialEl) partialEl.textContent = summary.statuses?.partially_verified ?? '-';
      if (pendingEl) pendingEl.textContent = summary.statuses?.pending ?? '-';
      if (metaEl) {
        metaEl.textContent = `อัปเดตล่าสุด ${summary.generatedAt} · ตรวจโดย ${summary.verifiedBy} · แหล่งอ้างอิง ${summary.sourceCount} แหล่ง`;
      }
    }

    document.querySelectorAll('.verify-filter-btn').forEach((btn) => {
      if (btn.dataset.bound === 'yes') return;
      btn.dataset.bound = 'yes';
      btn.addEventListener('click', () => {
        renderVerificationList(btn.dataset.status);
        verifyModal?.show();
      });
    });

    const hiddenBtn = document.getElementById('hiddenItemsBtn');
    if (hiddenBtn && hiddenBtn.dataset.bound !== 'yes') {
      hiddenBtn.dataset.bound = 'yes';
      hiddenBtn.addEventListener('click', async () => {
        await renderHiddenList();
        hiddenModal?.show();
      });
    }

    const addFixtureBtn = document.getElementById('addFixtureBtn');
    if (addFixtureBtn && addFixtureBtn.dataset.bound !== 'yes') {
      addFixtureBtn.dataset.bound = 'yes';
      addFixtureBtn.addEventListener('click', openAddFixtureModal);
    }

    const addAccessoryBtn = document.getElementById('addAccessoryBtn');
    if (addAccessoryBtn && addAccessoryBtn.dataset.bound !== 'yes') {
      addAccessoryBtn.dataset.bound = 'yes';
      addAccessoryBtn.addEventListener('click', openAddAccessoryModal);
    }

    await renderHiddenList();
    await renderDataSummary();
  }

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!emailInput || !passwordInput) {
      loginStatus.textContent = 'admin.html ยังเป็นฟอร์มเก่า';
      return;
    }

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

  await AdminAuth.ready;

  if (AdminAuth.isUnlocked()) {
    await showApp();
  }

  document.getElementById('adminLogoutBtn')?.addEventListener('click', async () => {
    await AdminAuth.lock();
    location.reload();
  });

  document.getElementById('exportFixturesBtn')?.addEventListener('click', async () => {
    try {
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
    } catch (err) {
      console.error(err);
      showStatus('Export Fixtures ไม่สำเร็จ', false);
    }
  });

  document.getElementById('exportAccessoriesBtn')?.addEventListener('click', async () => {
    try {
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
    } catch (err) {
      console.error(err);
      showStatus('Export Accessories ไม่สำเร็จ', false);
    }
  });

  document.getElementById('resetAllDataBtn')?.addEventListener('click', () => {
    showStatus('โหมด Supabase ไม่รองรับ reset local แบบเดิมแล้ว', false);
  });
});
