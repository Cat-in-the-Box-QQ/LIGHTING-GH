function isAdminUnlocked() {
  return typeof AdminAuth !== 'undefined' && AdminAuth.isUnlocked();
}

// เวอร์ชันเดิมใช้ window.prompt ให้กรอก PIN แต่ระบบ login เปลี่ยนเป็น
// Supabase email + password แล้ว จึงพาไปหน้า admin แทน
async function promptAdminUnlock() {
  if (isAdminUnlocked()) return true;
  if (window.confirm('ต้องเข้าสู่ระบบ Admin ก่อนแก้ไขข้อมูล\nตกลงเพื่อไปหน้า Admin?')) {
    window.location.href = 'admin.html';
  }
  return false;
}

// แสดง error จากการบันทึกลง Supabase ให้ผู้ใช้เห็นแทนที่จะเงียบหาย
function describeSaveError(err) {
  const msg = (err && err.message) || String(err || '');
  if (/Failed to fetch|NetworkError|fetch failed/i.test(msg)) {
    return 'บันทึกไม่สำเร็จ: เชื่อมต่อ Supabase ไม่ได้ (ตรวจเน็ตแล้วลองใหม่)';
  }
  if (/row-level security|42501|permission denied/i.test(msg)) {
    return 'บันทึกไม่สำเร็จ: RLS ใน Supabase ไม่อนุญาตให้เขียนข้อมูล (ต้องเพิ่ม policy)';
  }
  if (/does not exist|42P01|42703/i.test(msg)) {
    return 'บันทึกไม่สำเร็จ: ตารางหรือคอลัมน์ใน Supabase ไม่ครบ (ดู supabase/schema.sql)';
  }
  return 'บันทึกไม่สำเร็จ: ' + msg;
}

function editorEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fixtureFieldReferenceHtml(fixtureId, fieldName) {
  if (typeof VerificationStore === 'undefined' || !fixtureId || !fieldName) return '';
  const sources = VerificationStore.getFieldSources(fixtureId, fieldName) || [];
  if (!sources.length) return '';
  const links = sources
    .map((source) => `<a href="${source.url}" target="_blank" rel="noopener">${source.title}</a>`)
    .join(' · ');
  return `<div class="field-reference-row small text-muted">อ้างอิง: ${links}</div>`;
}

function specRowHtml(label, value, fixtureId = null, fieldName = null) {
  const reference = fixtureId && fieldName ? fixtureFieldReferenceHtml(fixtureId, fieldName) : '';
  return `<div class="spec-row"><span>${label}</span><span>${value}</span></div>${reference}`;
}

function fixtureVerificationHtml(fixtureId) {
  if (typeof VerificationStore === 'undefined') return '';
  const log = VerificationStore.getLogByFixtureId(fixtureId);
  if (!log) return '<div class="small text-muted">ไม่มีข้อมูล verification</div>';

  const statusColor = log.verificationStatus === 'verified'
    ? 'text-success'
    : (log.verificationStatus === 'partially_verified' ? 'text-warning' : 'text-danger');

  const sources = (log.sourceIds || []).map((id) => {
    const source = VerificationStore.getSourceById(id);
    if (!source) return `<li>${id}</li>`;
    return `<li><a href="${source.url}" target="_blank" rel="noopener">${source.title}</a></li>`;
  }).join('');

  const changes = (log.changes || []).slice(0, 8).map((change) => `
    <li><strong>${change.field}</strong>: <code>${change.old}</code> → <code>${change.new}</code></li>
  `).join('');

  return `
    <div class="filter-panel mt-3 print-hidden">
      <h6 class="mb-2">Verification Status</h6>
      <div class="small ${statusColor} mb-2"><strong>${log.verificationStatus}</strong></div>
      <div class="small text-muted mb-2">${log.notes || '-'}</div>
      <div class="small mb-2"><strong>Checked:</strong> ${log.verificationDate || '-'} · ${log.verifiedBy || '-'}</div>
      <div class="small mb-1"><strong>Sources</strong></div>
      ${sources ? `<ul class="small mb-2">${sources}</ul>` : `<div class="small text-muted mb-2">ไม่มี source</div>`}
      <div class="small mb-1"><strong>Changes</strong></div>
      ${changes ? `<ul class="small mb-0">${changes}</ul>` : `<div class="small text-muted">ไม่มีรายการเปลี่ยนแปลง</div>`}
    </div>`;
}

function fixtureEditorHtml(fixture = {}, formId = 'fixtureEditorForm', options = {}) {
  const isCreate = !!options.isCreate;
  const title = options.title || (isCreate ? 'เพิ่ม Fixture ใหม่' : 'แก้ไขข้อมูล Fixture');
  const submitLabel = options.submitLabel || (isCreate ? 'เพิ่มรายการ' : 'บันทึก');

  return `
    <div class="editor-form-shell print-hidden">
      <h5 class="mb-3">${editorEscape(title)}</h5>
      <form id="${formId}">
        <div class="row g-3">
          <div class="col-md-6"><label class="form-label small mb-0">Brand</label><input class="form-control" name="brand" value="${editorEscape(fixture.brand)}"></div>
          <div class="col-md-6"><label class="form-label small mb-0">Model</label><input class="form-control" name="model" value="${editorEscape(fixture.model || (isCreate ? 'New Item' : ''))}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">Category</label><input class="form-control" name="category" value="${editorEscape(fixture.category)}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">Power (W)</label><input type="number" step="0.01" class="form-control" name="power" value="${editorEscape(fixture.power ?? '')}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">Weight (kg)</label><input type="number" step="0.001" class="form-control" name="weight" value="${editorEscape(fixture.weight ?? '')}"></div>
          <div class="col-md-6"><label class="form-label small mb-0">Lux</label><input class="form-control" name="lux" value="${editorEscape(fixture.lux)}"></div>
          <div class="col-md-6"><label class="form-label small mb-0">Lumens</label><input class="form-control" name="lumens" value="${editorEscape(fixture.lumens ?? '')}"></div>
          <div class="col-md-6"><label class="form-label small mb-0">Beam</label><input class="form-control" name="beam" value="${editorEscape(fixture.beam)}"></div>
          <div class="col-md-6"><label class="form-label small mb-0">Wireless</label><input class="form-control" name="wireless" value="${editorEscape(fixture.wireless)}"></div>
          <div class="col-md-6"><label class="form-label small mb-0">Battery</label><input class="form-control" name="battery" value="${editorEscape(fixture.battery)}"></div>
          <div class="col-md-6"><label class="form-label small mb-0">White Light</label><input class="form-control" name="whiteLight" value="${editorEscape(fixture.whiteLight)}"></div>
          <div class="col-md-6"><label class="form-label small mb-0">Color</label><input class="form-control" name="color" value="${editorEscape(fixture.color)}"></div>
          <div class="col-md-3">
            <label class="form-label small mb-0">Color Tag</label>
            <select class="form-select" name="colorTagStyle">
              <option value="" ${!fixture.colorTagStyle ? 'selected' : ''}>อัตโนมัติ</option>
              <option value="black" ${fixture.colorTagStyle === 'black' ? 'selected' : ''}>สีดำ</option>
              <option value="rainbow" ${fixture.colorTagStyle === 'rainbow' ? 'selected' : ''}>สีรุ้ง</option>
            </select>
          </div>
          <div class="col-md-3"><label class="form-label small mb-0">IP</label><input class="form-control" name="ip" value="${editorEscape(fixture.ip)}"></div>
          <div class="col-md-3"><label class="form-label small mb-0">PDF Page</label><input type="number" class="form-control" name="pdfPage" value="${editorEscape(fixture.pdfPage ?? '')}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">Stock Count</label><input type="number" class="form-control" name="stockCount" value="${editorEscape(fixture.stockCount ?? '')}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">Units / Set</label><input type="number" class="form-control" name="unitsPerSet" value="${editorEscape(fixture.unitsPerSet ?? '')}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">Set Count</label><input type="number" class="form-control" name="setCountInStock" value="${editorEscape(fixture.setCountInStock ?? '')}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">Reserved</label><input type="number" class="form-control" name="reserved" value="${editorEscape(fixture.reserved ?? 0)}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">In Use</label><input type="number" class="form-control" name="inUse" value="${editorEscape(fixture.inUse ?? 0)}"></div>
          <div class="col-md-4"><label class="form-label small mb-0">Stock Note</label><input class="form-control" name="stockNote" value="${editorEscape(fixture.stockNote)}"></div>
          <div class="col-md-12"><label class="form-label small mb-0">Dimensions</label><input class="form-control" name="dimensions" value="${editorEscape(fixture.dimensions)}"></div>
          <div class="col-md-12"><label class="form-label small mb-0">Accessories</label><textarea class="form-control" name="accessories" rows="3">${editorEscape(Array.isArray(fixture.accessories) ? fixture.accessories.join(', ') : '')}</textarea></div>
          <div class="col-md-12"><label class="form-label small mb-0">Image</label><input class="form-control" name="image" value="${editorEscape(fixture.image || (isCreate ? 'images/page-014.jpg' : ''))}"></div>
        </div>
        <div class="d-flex gap-2 flex-wrap mt-3 align-items-center">
          <button class="btn btn-dark btn-sm" type="submit">${editorEscape(submitLabel)}</button>
          <button class="btn btn-outline-secondary btn-sm" type="button" id="${formId}-cancel">ปิด</button>
          <span id="${formId}-status" class="small text-success"></span>
        </div>
      </form>
    </div>`;
}

function normalizeFixturePatchFromForm(form) {
  const patch = {
    brand: form.elements.brand.value.trim() || null,
    model: form.elements.model.value.trim() || null,
    category: form.elements.category.value.trim() || null,
    power: form.elements.power.value === '' ? null : Number(form.elements.power.value),
    weight: form.elements.weight.value === '' ? null : Number(form.elements.weight.value),
    lux: form.elements.lux.value.trim() || null,
    lumens: form.elements.lumens.value.trim() === '' ? null : form.elements.lumens.value.trim(),
    beam: form.elements.beam.value.trim() || null,
    wireless: form.elements.wireless.value.trim() || null,
    battery: form.elements.battery.value.trim() || null,
    whiteLight: form.elements.whiteLight.value.trim() || null,
    color: form.elements.color.value.trim() || null,
    colorTagStyle: form.elements.colorTagStyle.value.trim() || null,
    ip: form.elements.ip.value.trim() || null,
    pdfPage: form.elements.pdfPage.value === '' ? null : Number(form.elements.pdfPage.value),
    stockCount: form.elements.stockCount.value === '' ? null : Number(form.elements.stockCount.value),
    unitsPerSet: form.elements.unitsPerSet.value === '' ? null : Number(form.elements.unitsPerSet.value),
    setCountInStock: form.elements.setCountInStock.value === '' ? null : Number(form.elements.setCountInStock.value),
    stockNote: form.elements.stockNote.value.trim() || null,
    dimensions: form.elements.dimensions.value.trim() || null,
    image: form.elements.image.value.trim() || null,
    accessories: form.elements.accessories.value.split(',').map((item) => item.trim()).filter(Boolean),
  };

  if (patch.unitsPerSet && patch.setCountInStock) {
    patch.stockCount = patch.unitsPerSet * patch.setCountInStock;
    patch.stockNote = `${patch.setCountInStock} sets of ${patch.unitsPerSet}`;
  }

  if (patch.stockCount != null) {
    patch.stock = `${patch.stockCount} Piece${patch.stockCount === 1 ? '' : 's'}${patch.stockNote ? ` (${patch.stockNote})` : ''}`;
  }

  const reserved = Math.max(Number(form.elements.reserved.value) || 0, 0);
  const inUse = Math.max(Number(form.elements.inUse.value) || 0, 0);
  patch.reserved = reserved;
  patch.inUse = inUse;
  patch.remaining = Math.max((Number(patch.stockCount) || 0) - reserved - inUse, 0);

  return { patch, reserved, inUse };
}

async function removeFixtureFromAccessoryCompatibility(fixtureId) {
  if (typeof AccessoryStore === 'undefined') return;
  const affected = AccessoryStore.getAll().filter((accessory) => {
    const compatibleWith = Array.isArray(accessory.compatibleWith) ? accessory.compatibleWith.map(Number) : [];
    return compatibleWith.includes(Number(fixtureId));
  });
  for (const accessory of affected) {
    const compatibleWith = Array.isArray(accessory.compatibleWith) ? accessory.compatibleWith.map(Number) : [];
    await AccessoryStore.update(accessory.id, {
      compatibleWith: compatibleWith.filter((id) => Number(id) !== Number(fixtureId)),
    });
  }
}

async function deleteFixtureAndRelations(fixtureId) {
  const current = DB.getById(fixtureId);
  if (!current) return false;
  await removeFixtureFromAccessoryCompatibility(fixtureId);
  return await DB.remove(fixtureId);
}

function bindFixtureEditor(formId, fixtureId, onSaved, options = {}) {
  const form = document.getElementById(formId);
  const status = document.getElementById(`${formId}-status`);
  const cancelBtn = document.getElementById(`${formId}-cancel`);
  const isCreate = !!options.isCreate || fixtureId == null;

  function recalc() {
    const unitsPerSet = Math.max(Number(form.elements.unitsPerSet.value) || 0, 0);
    const setCount = Math.max(Number(form.elements.setCountInStock.value) || 0, 0);
    if (unitsPerSet > 0 && setCount > 0) {
      form.elements.stockCount.value = unitsPerSet * setCount;
    }
  }

  ['unitsPerSet', 'setCountInStock'].forEach((name) => {
    form.elements[name]?.addEventListener('input', recalc);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    if (status) { status.className = 'small text-muted'; status.textContent = 'กำลังบันทึก...'; }

    try {
      const { patch, reserved, inUse } = normalizeFixturePatchFromForm(form);

      let savedItem;
      if (isCreate) {
        savedItem = await DB.create(patch);
        await DB.updateInventory(savedItem.id, { reserved, inUse });
        savedItem = DB.getById(savedItem.id) || savedItem;
        if (status) { status.className = 'small text-success'; status.textContent = 'เพิ่มรายการแล้ว'; }
        if (typeof onSaved === 'function') await onSaved({ action: 'created', item: savedItem });
        return;
      }

      await DB.update(fixtureId, patch);
      await DB.updateInventory(fixtureId, { reserved, inUse });
      savedItem = DB.getById(fixtureId);
      if (status) { status.className = 'small text-success'; status.textContent = 'บันทึกแล้ว'; }
      if (typeof onSaved === 'function') await onSaved({ action: 'saved', item: savedItem });
    } catch (err) {
      console.error('บันทึก fixture ไม่สำเร็จ:', err);
      if (status) {
        status.className = 'small text-danger';
        status.textContent = describeSaveError(err);
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
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
