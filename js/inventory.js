// inventory.js - expandable inventory view with accessories under each item

document.addEventListener('DOMContentLoaded', async () => {
  // BookingStore.load() ไม่ throw — ถ้ายังไม่ได้รัน SQL ของระบบจอง
  // ตารางนี้จะถอยกลับไปใช้คอลัมน์ reserved/in_use เดิม (ซึ่งยังเป็น 0 ทุกแถว)
  await Promise.all([DB.load(), AccessoryStore.load(), BookingStore.load()]);

  const fixtures = visibleItems(DB.getAll().filter((item) => inferItemType(item) !== 'accessory'), false);
  const accessories = AccessoryStore.getAll();
  const tbody = document.getElementById('inventoryBody');
  const searchInput = document.getElementById('inventorySearch');
  const typeInput = document.getElementById('inventoryType');
  const expanded = new Set();
  const bookingStatusEl = document.getElementById('inventoryBookingStatus');

  // บอกให้รู้ว่าเลข Reserved/In Use/Remaining มาจากไหน
  // ถ้ายังไม่ได้รัน SQL ของระบบจอง ตารางจะถอยไปใช้คอลัมน์กรอกมือเดิม (เป็น 0 ทุกแถว)
  // ซึ่งถ้าไม่บอกไว้ ผู้ใช้จะเข้าใจผิดว่า "ไม่มีคนจองเลย"
  function renderBookingStatus() {
    if (!bookingStatusEl) return;
    const st = (typeof BookingStore !== 'undefined') ? BookingStore.status() : null;
    if (st && st.isSupabase) {
      const c = BookingStore.counts();
      bookingStatusEl.className = 'small mb-3 text-muted';
      bookingStatusEl.textContent = 'ยอดจองอ่านจากระบบจองจริง'
        + ` — วันนี้มีของติดจอง ${c.withBooking} รายการ`
        + (c.outNow ? ` · จ่ายออกจากคลังแล้ว ${c.outNow} รายการ` : '')
        + (c.unknownStock ? ` · ยังมี ${c.unknownStock} รายการที่ไม่ระบุจำนวน (จองไม่ได้)` : '');
    } else {
      bookingStatusEl.className = 'small mb-3 text-warning';
      bookingStatusEl.textContent = '⚠️ ยังอ่านยอดจองจากระบบจองไม่ได้ — คอลัมน์ ติดจอง/จ่ายออก/เหลือ'
        + ' จะแสดงค่าที่กรอกมือไว้เดิม (ส่วนใหญ่เป็น 0) ไม่ใช่ยอดจองจริง'
        + (st && st.error ? ` (${st.error})` : '');
    }
  }

  function accessoryRecordsForFixture(fixture) {
    const byName = new Map();

    const directNames = Array.isArray(fixture.accessories) ? fixture.accessories : [];
    directNames.forEach((name) => {
      const key = String(name).trim().toLowerCase();
      if (!key) return;
      if (!byName.has(key)) {
        const match = accessories.find((a) => String(a.name || '').trim().toLowerCase() === key);
        byName.set(key, match || {
          id: `virtual-${fixture.id}-${key}`,
          name,
          brand: fixture.brand,
          category: 'Accessory',
          stock: null,
          compatibleWith: [fixture.id]
        });
      }
    });

    accessories.forEach((acc) => {
      if ((acc.compatibleWith || []).includes(Number(fixture.id))) {
        const key = String(acc.name || '').trim().toLowerCase();
        if (!byName.has(key)) byName.set(key, acc);
      }
    });

    return [...byName.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }

  function render() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const type = typeInput.value;

    const visibleRows = fixtures.filter((f) => {
      const accText = (Array.isArray(f.accessories) ? f.accessories.join(' ') : '').toLowerCase();
      const hay = `${f.id} ${f.brand} ${f.model} ${f.category || ''} ${accText}`.toLowerCase();
      const accList = accessoryRecordsForFixture(f);
      if (q && !hay.includes(q) && !accList.some((acc) => `${acc.name} ${acc.brand || ''}`.toLowerCase().includes(q))) return false;
      if (type === 'accessory' && accList.length === 0) return false;
      if (type && type !== 'accessory' && inferItemType(f) !== type) return false;
      return true;
    });

    tbody.innerHTML = '';

    visibleRows.forEach((f) => {
      const available = getStockCount(f);
      // ยอดจริงจากระบบจอง (view v_item_availability) — ก้อนเดียวกับที่ trigger ใช้ตัดสินว่าจองเกินไหม
      // คอลัมน์ f.reserved / f.inUse ของเดิมเป็นค่ากรอกมือและยังเป็น 0 ทุกแถว จึงใช้เป็นทางถอยเท่านั้น
      const booking = (typeof BookingStore !== 'undefined') ? BookingStore.get('fixture', f.id) : null;
      const reserved = booking ? booking.reserved : Number(f.reserved || 0);
      const inUse = booking ? booking.outCount : Number(f.inUse || 0);
      const remaining = (booking && booking.available !== null)
        ? booking.available
        : Math.max(available - reserved - inUse, 0);
      const accList = accessoryRecordsForFixture(f);
      const hasAccessories = accList.length > 0;
      const isOpen = expanded.has(Number(f.id));

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          ${hasAccessories ? `<button class="btn btn-sm btn-outline-dark inventory-toggle" data-id="${f.id}">${isOpen ? '▾' : '▸'}</button>` : ''}
        </td>
        <td>${f.brand}</td>
        <td>
          <div><strong>${f.model}</strong></div>
          <div class="small text-muted">${f.category || '-'} · ${itemTypeLabel(f)}${f.stockNote ? ` · ${f.stockNote}` : ''}</div>
        </td>
        <td>${available}</td>
        <td>${reserved}</td>
        <td>${inUse}</td>
        <td class="fw-bold">${remaining}</td>
      `;
      tbody.appendChild(tr);

      if (hasAccessories) {
        const detailTr = document.createElement('tr');
        detailTr.className = 'inventory-detail-row';
        detailTr.style.display = isOpen ? '' : 'none';
        detailTr.innerHTML = `
          <td colspan="7">
            <div class="inventory-accessory-box">
              <div class="small text-muted mb-2"><strong>Accessories ของ ${f.brand} ${f.model}</strong></div>
              <ul class="inventory-accessory-list mb-0">
                ${accList.map((acc) => {
                  // accessory บางแถวเป็น "virtual" (มาจากชื่อใน fixture.accessories ไม่มี id จริง)
                  // BookingStore.get() จะคืน null ให้เอง จึงขึ้นแค่ข้อความเปล่า ไม่พัง
                  const accBooking = bookingLineHtml('accessory', acc.id);
                  return `
                  <li>
                    <strong>${acc.name}</strong>
                    <span class="text-muted">${acc.brand ? ` · ${acc.brand}` : ''}${acc.category ? ` · ${acc.category}` : ''}${acc.stock ? ` · stock ${acc.stock}` : ''}</span>
                    ${accBooking ? `<span class="ms-2">${accBooking}</span>` : ''}
                  </li>
                `;
                }).join('')}
              </ul>
            </div>
          </td>
        `;
        tbody.appendChild(detailTr);
      }
    });

    tbody.querySelectorAll('.inventory-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        render();
      });
    });
  }

  searchInput.addEventListener('input', render);
  typeInput.addEventListener('change', render);
  renderBookingStatus();
  render();
});
