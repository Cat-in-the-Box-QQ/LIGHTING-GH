if (typeof editorEscape === 'undefined') {
  function editorEscape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

function accessoryEditorHtml(accessory = {}, formId = 'accessoryEditorForm', options = {}) {
  const isCreate = !!options.isCreate;
  const title = options.title || (isCreate ? 'เพิ่ม Accessory ใหม่' : 'แก้ไข Accessory');
  const submitLabel = options.submitLabel || (isCreate ? 'เพิ่มรายการ' : 'บันทึก');
  const compatible = Array.isArray(accessory.compatibleWith) ? accessory.compatibleWith.join(', ') : '';

  return `
    <div class="editor-form-shell print-hidden">
      <h5 class="mb-3">${editorEscape(title)}</h5>
      <form id="${formId}">
        <div class="row g-3">
          <div class="col-md-6"><label class="form-label small mb-0">Name</label><input class="form-control" name="name" value="${editorEscape(accessory.name || (isCreate ? 'New Accessory' : ''))}"></div>
          <div class="col-md-6"><label class="form-label small mb-0">Brand</label><input class="form-control" name="brand" value="${editorEscape(accessory.brand)}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">Category</label><input class="form-control" name="category" value="${editorEscape(accessory.category || 'Accessory')}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">Stock</label><input class="form-control" name="stock" value="${editorEscape(accessory.stock)}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">PDF Page</label><input type="number" class="form-control" name="pdfPage" value="${editorEscape(accessory.pdfPage ?? '')}"></div>
          <div class="col-md-12"><label class="form-label small mb-0">Compatible Fixture IDs</label><input class="form-control" name="compatibleWith" value="${editorEscape(compatible)}"><div class="small text-muted mt-1">ใส่ id ของ fixture คั่นด้วย comma เช่น 28,29,30</div></div>
          <div class="col-md-12"><label class="form-label small mb-0">Image</label><input class="form-control" name="image" value="${editorEscape(accessory.image)}"></div>
        </div>
        <div class="d-flex gap-2 flex-wrap mt-3 align-items-center">
          <button class="btn btn-dark btn-sm" type="submit">${editorEscape(submitLabel)}</button>
          <button class="btn btn-outline-secondary btn-sm" type="button" id="${formId}-cancel">ปิด</button>
          <span id="${formId}-status" class="small text-success"></span>
        </div>
      </form>
    </div>`;
}

function syncAccessoryNameAcrossFixtures(oldName, newName, compatibleIds) {
  const updatedFixtures = DB.getAll().map((fixture) => {
    let accessories = Array.isArray(fixture.accessories) ? [...fixture.accessories] : [];
    if (oldName) accessories = accessories.filter((item) => item !== oldName);
    if (newName && compatibleIds.includes(Number(fixture.id))) accessories.push(newName);
    accessories = [...new Set(accessories)];
    return { ...fixture, accessories };
  });
  DB.replaceAll(updatedFixtures);
}

function deleteAccessoryAndRelations(accessoryId) {
  const current = AccessoryStore.getById(accessoryId);
  if (!current) return false;
  syncAccessoryNameAcrossFixtures(current.name || null, null, []);
  return AccessoryStore.remove(accessoryId);
}

function bindAccessoryEditor(formId, accessoryId, onSaved, options = {}) {
  const form = document.getElementById(formId);
  const status = document.getElementById(`${formId}-status`);
  const cancelBtn = document.getElementById(`${formId}-cancel`);
  const isCreate = !!options.isCreate || accessoryId == null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldItem = isCreate ? null : AccessoryStore.getById(accessoryId);
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

    let savedItem;
    if (isCreate) {
      savedItem = AccessoryStore.create(patch);
      syncAccessoryNameAcrossFixtures(null, savedItem?.name || null, savedItem?.compatibleWith || []);
      status.textContent = 'เพิ่มรายการแล้ว';
      if (typeof onSaved === 'function') onSaved({ action: 'created', item: savedItem });
      return;
    }

    savedItem = AccessoryStore.update(accessoryId, patch);
    syncAccessoryNameAcrossFixtures(oldItem?.name || null, savedItem?.name || null, savedItem?.compatibleWith || []);
    status.textContent = 'บันทึกแล้ว';
    if (typeof onSaved === 'function') onSaved({ action: 'saved', item: savedItem });
  });

  cancelBtn?.addEventListener('click', () => {
    if (typeof options.onCancel === 'function') options.onCancel();
  });

  return {
    close() {
      if (typeof options.onCancel === 'function') options.onCancel();
    }
  };
}
