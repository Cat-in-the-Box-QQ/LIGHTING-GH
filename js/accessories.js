document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([DB.load(), AccessoryStore.load(), AdminAuth.ready]);

  let accessories = AccessoryStore.getAll();
  let page = 1;
  const listEl = document.getElementById('accessoryGrid');
  const resultEl = document.getElementById('accessoryResult');
  const adminInfoEl = document.getElementById('accessoryAdminInfo');
  const actionStatusEl = document.getElementById('accessoryActionStatus');
  const searchEl = document.getElementById('accessorySearch');
  const catEl = document.getElementById('accessoryCategory');
  const sortEl = document.getElementById('accessorySort');
  const pageSizeEl = document.getElementById('accessoryPageSize');
  const paginationEl = document.getElementById('accessoryPagination');
  const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('accessoryModal'));
  const editorModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('accessoryEditorModal'));

  const categories = [...new Set(accessories.map((a) => a.category).filter(Boolean))].sort();
  categories.forEach((category) => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    catEl.appendChild(option);
  });

  function flashStatus(message, ok = true) {
    actionStatusEl.className = `small inline-status mb-3 ${ok ? 'text-success' : 'text-danger'}`;
    actionStatusEl.textContent = message;
    clearTimeout(window.__accessoryStatusTimer);
    window.__accessoryStatusTimer = setTimeout(() => {
      actionStatusEl.textContent = '';
    }, 3000);
  }

  async function reloadData() {
    await Promise.all([DB.load(), AccessoryStore.load()]);
    accessories = AccessoryStore.getAll();
  }

  function currentPageSize() {
    const value = pageSizeEl?.value || '12';
    return value === 'all' ? null : Number(value);
  }

  function fixtureNames(ids) {
    return ids
      .map((id) => DB.getById(id))
      .filter(Boolean)
      .map((item) => `${item.brand} ${item.model}`);
  }

  function adminUnlocked() {
    return typeof AdminAuth !== 'undefined' && AdminAuth.isUnlocked();
  }

  function sortAccessories(items) {
    const sortBy = sortEl.value;
    const arr = [...items];
    if (sortBy === 'name_desc') {
      arr.sort((a, b) => String(b.name || '').localeCompare(String(a.name || '')));
    } else if (sortBy === 'brand_asc') {
      arr.sort((a, b) => String(a.brand || '').localeCompare(String(b.brand || '')) || String(a.name || '').localeCompare(String(b.name || '')));
    } else if (sortBy === 'brand_desc') {
      arr.sort((a, b) => String(b.brand || '').localeCompare(String(a.brand || '')) || String(a.name || '').localeCompare(String(b.name || '')));
    } else if (sortBy === 'stock_desc') {
      arr.sort((a, b) => getStockCount(b) - getStockCount(a) || String(a.name || '').localeCompare(String(b.name || '')));
    } else if (sortBy === 'stock_asc') {
      arr.sort((a, b) => getStockCount(a) - getStockCount(b) || String(a.name || '').localeCompare(String(b.name || '')));
    } else {
      arr.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    }
    return arr;
  }

  function renderPagination(totalPages) {
    paginationEl.innerHTML = '';
    const pageSize = currentPageSize();
    if (!pageSize || totalPages <= 1) return;

    for (let i = 1; i <= totalPages; i++) {
      const li = document.createElement('li');
      li.className = 'page-item' + (i === page ? ' active' : '');
      li.innerHTML = `<a class="page-link" href="#">${i}</a>`;
      li.addEventListener('click', (e) => {
        e.preventDefault();
        page = i;
        render();
      });
      paginationEl.appendChild(li);
    }
  }

  async function openAccessoryEditor(accessoryId) {
    const accessory = AccessoryStore.getById(accessoryId);
    if (!accessory) return;

    document.getElementById('accessoryEditorTitle').textContent = `แก้ไข Accessory · ${accessory.name}`;
    document.getElementById('accessoryEditorBody').innerHTML = accessoryEditorHtml(accessory, 'modalAccessoryEditor');

    bindAccessoryEditor('modalAccessoryEditor', Number(accessoryId), async ({ item }) => {
      await reloadData();
      render();
      editorModal.hide();
      if (item) {
        showDetail(item.id);
        flashStatus(`บันทึก ${item.name} แล้ว`);
      }
    }, {
      onCancel: () => editorModal.hide(),
    });

    editorModal.show();
  }

  async function toggleAccessoryHidden(accessoryId) {
    const current = AccessoryStore.getById(accessoryId);
    if (!current) return;
    const nextHidden = !current.hidden;
    try {
      await AccessoryStore.update(accessoryId, { hidden: nextHidden });
    } catch (err) {
      flashStatus(describeSaveError(err), false);
      return;
    }
    await reloadData();
    render();
    modal.hide();
    flashStatus(nextHidden ? `ซ่อน ${current.name} แล้ว` : `ยกเลิกซ่อน ${current.name} แล้ว`);
  }

  async function deleteAccessory(accessoryId) {
    const current = AccessoryStore.getById(accessoryId);
    if (!current) return;
    if (!window.confirm(`ลบ Accessory “${current.name}” ใช่หรือไม่?`)) return;
    try {
      await deleteAccessoryAndRelations(accessoryId);
    } catch (err) {
      flashStatus(describeSaveError(err), false);
      return;
    }
    await reloadData();
    render();
    editorModal.hide();
    modal.hide();
    flashStatus(`ลบ ${current.name} แล้ว`);
  }

  async function addAccessoryToSet(id, qty = 1) {
    const acc = AccessoryStore.getById(id);
    if (!acc) return;
    // เก็บ accessory ในชุดด้วย key ขึ้นต้น a เพื่อไม่ให้ชน id ของ fixture
    addFixtureToCurrentSet(`a${id}`, qty);
    flashStatus(`เพิ่ม ${acc.name} จำนวน ${qty} เข้าชุดแล้ว`);
  }

  function renderAdminArea(accessoryId) {
    const area = document.getElementById('accessoryAdminArea');
    if (!area) return;
    area.innerHTML = '';

    if (adminUnlocked()) {
      const accessory = AccessoryStore.getById(accessoryId);
      area.innerHTML = `
        <div class="d-flex gap-2 flex-wrap justify-content-end w-100">
          <button type="button" id="accessoryEditBtn" class="btn btn-outline-danger btn-sm">แก้ไข</button>
          <button type="button" id="accessoryHideBtn" class="btn btn-outline-warning btn-sm">${accessory.hidden ? 'ยกเลิกซ่อน' : 'ซ่อน'}</button>
          <button type="button" id="accessoryDeleteBtn" class="btn btn-outline-danger btn-sm">ลบ</button>
        </div>`;

      document.getElementById('accessoryEditBtn').addEventListener('click', () => openAccessoryEditor(Number(accessoryId)));
      document.getElementById('accessoryHideBtn').addEventListener('click', () => toggleAccessoryHidden(Number(accessoryId)));
      document.getElementById('accessoryDeleteBtn').addEventListener('click', () => deleteAccessory(Number(accessoryId)));
    }
  }

  function showDetail(id) {
    const item = AccessoryStore.getById(id);
    if (!item) return;
    const compatible = fixtureNames(item.compatibleWith || []);
    document.getElementById('accessoryTitle').textContent = item.name;
    document.getElementById('accessoryBody').innerHTML = `
      <div class="spec-row"><span>Brand</span><span>${item.brand || '-'}</span></div>
      <div class="spec-row"><span>Category</span><span>${item.category ? badgesHtmlFromCommaList(item.category, 'bg-dark') : '-'}</span></div>
      <div class="spec-row"><span>Status</span><span>${item.hidden ? 'Hidden' : 'Visible'}</span></div>
      <div class="spec-row"><span>Stock</span><span>${item.stock || '-'}</span></div>
      <div class="filter-panel mt-3">
        <h6 class="mb-2">ใช้กับอุปกรณ์</h6>
        ${compatible.length
          ? `<ul class="mb-0 small">${compatible.map((name) => `<li>${name}</li>`).join('')}</ul>`
          : `<div class="text-muted small">ยังไม่ระบุ fixture ที่ใช้ร่วมกัน</div>`}
      </div>`;
    renderAdminArea(id);

    // ผูกปุ่ม + และ + ชุด ใน footer ของ popup accessory
    const accQty = document.getElementById('accessoryDetailQtyInput');
    const accAddBtn = document.getElementById('accessoryDetailAddBtn');
    const accAddSetBtn = document.getElementById('accessoryDetailAddSetBtn');
    const acc = AccessoryStore.getById(id);

    if (accQty) accQty.value = 1;

    if (accAddBtn) {
      accAddBtn.onclick = () => addAccessoryToSet(id, Math.max(Number(accQty && accQty.value) || 1, 1));
    }

    if (accAddSetBtn) {
      const showSet = hasSetOption(acc);
      accAddSetBtn.style.display = showSet ? 'inline-flex' : 'none';
      accAddSetBtn.onclick = () => {
        const setUnits = getUnitsPerSet(acc) || 1;
        const setCount = Math.max(Number(accQty && accQty.value) || 1, 1);
        addAccessoryToSet(id, setUnits * setCount);
        flashStatus(`เพิ่ม ${acc.name} จำนวน ${setCount} ชุดแล้ว`);
      };
    }

    modal.show();
  }

  function render() {
    const q = (searchEl.value || '').trim().toLowerCase();
    const category = catEl.value;
    let filtered = visibleItems(accessories, adminUnlocked()).filter((item) => {
      const compatibleText = fixtureNames(item.compatibleWith || []).join(' ');
      const hay = `${item.name} ${item.brand || ''} ${item.category || ''} ${compatibleText}`.toLowerCase();
      if (q && !hay.includes(q)) return false;
      if (category && !hasCommaTag(item.category, category)) return false;
      return true;
    });

    filtered = sortAccessories(filtered);

    resultEl.textContent = `พบ ${filtered.length} รายการ`;
    adminInfoEl.textContent = adminUnlocked()
      ? 'Admin mode active: มีปุ่มแก้ไข / ซ่อน / ลบ ใน popup รายละเอียด'
      : 'หากต้องการแก้ไข Accessories ให้ปลดล็อกผ่านหน้า Admin ก่อน';
    listEl.innerHTML = '';

    if (!filtered.length) {
      listEl.innerHTML = '<div class="col-12"><div class="alert alert-warning">ไม่พบ accessory ตามคำค้น</div></div>';
      renderPagination(1);
      return;
    }

    const pageSize = currentPageSize();
    const totalPages = pageSize ? Math.max(Math.ceil(filtered.length / pageSize), 1) : 1;
    if (page > totalPages) page = totalPages;
    const start = pageSize ? (page - 1) * pageSize : 0;
    const pageItems = pageSize ? filtered.slice(start, start + pageSize) : filtered;

    pageItems.forEach((item) => {
      const compatible = fixtureNames(item.compatibleWith || []);
      const col = document.createElement('div');
      col.className = 'col-6 col-lg-4';
      col.innerHTML = `
        <div class="filter-panel h-100 accessory-card" role="button" data-id="${item.id}">
          <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
            <strong>${item.name}</strong>
            <div class="d-flex gap-1 flex-wrap">
              <span class="badge bg-light text-dark border">Accessory</span>
              ${item.hidden ? `<span class="badge bg-danger">Hidden</span>` : ''}
            </div>
          </div>
          <div class="small text-muted mb-1">${item.brand || '-'}</div>
          <div class="d-flex flex-wrap gap-1 mb-2">${item.category ? badgesHtmlFromCommaList(item.category, 'bg-dark') : ''}</div>
          <div class="small mb-2">${item.stock || 'ไม่ระบุ stock'}</div>
          <div class="small"><strong>ใช้กับ:</strong> ${compatible.length ? compatible.join(', ') : 'ยังไม่ระบุ'}</div>
          ${adminUnlocked() ? `<div class="small text-danger mt-2">Admin: คลิกเพื่อแก้ไข / ซ่อน / ลบ</div>` : ''}
        </div>`;
      listEl.appendChild(col);
    });

    listEl.querySelectorAll('.accessory-card').forEach((card) => {
      card.addEventListener('click', () => showDetail(card.dataset.id));
    });

    renderPagination(totalPages);
  }

  [searchEl, catEl, sortEl, pageSizeEl].forEach((el) => {
    el.addEventListener('input', () => { page = 1; render(); });
    el.addEventListener('change', () => { page = 1; render(); });
  });

  render();
});
