// inventory.js - expandable inventory view with accessories under each item

document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([DB.load(), AccessoryStore.load()]);

  const fixtures = visibleItems(DB.getAll().filter((item) => inferItemType(item) !== 'accessory'), false);
  const accessories = AccessoryStore.getAll();
  const tbody = document.getElementById('inventoryBody');
  const searchInput = document.getElementById('inventorySearch');
  const typeInput = document.getElementById('inventoryType');
  const expanded = new Set();

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
      const reserved = Number(f.reserved || 0);
      const inUse = Number(f.inUse || 0);
      const remaining = Math.max(available - reserved - inUse, 0);
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
                ${accList.map((acc) => `
                  <li>
                    <strong>${acc.name}</strong>
                    <span class="text-muted">${acc.brand ? ` · ${acc.brand}` : ''}${acc.category ? ` · ${acc.category}` : ''}${acc.stock ? ` · stock ${acc.stock}` : ''}</span>
                  </li>
                `).join('')}
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
  render();
});
