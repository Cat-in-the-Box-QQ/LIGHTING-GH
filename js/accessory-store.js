// accessory-store.js - localStorage-backed accessory catalog for static app

const AccessoryStore = (() => {
  const STORAGE_KEY = 'lighting_db_accessories_v1';
  let accessories = [];

  async function load() {
    const res = await fetch('data/accessories.json', { cache: 'no-store' });
    const base = await res.json();
    const overrides = localStorage.getItem(STORAGE_KEY);

    if (overrides) {
      try {
        const parsed = JSON.parse(overrides);
        const map = new Map(parsed.map((item) => [Number(item.id), item]));
        accessories = base.map((item) => ({ ...item, ...(map.get(Number(item.id)) || {}) }));
        const baseIds = new Set(base.map((item) => Number(item.id)));
        parsed.forEach((item) => {
          if (!baseIds.has(Number(item.id))) accessories.push(item);
        });
      } catch (e) {
        accessories = base;
      }
    } else {
      accessories = base;
    }

    accessories = accessories.map((item) => ({
      ...item,
      compatibleWith: Array.isArray(item.compatibleWith) ? item.compatibleWith.map(Number).filter(Boolean) : [],
      hidden: !!item.hidden,
    })).sort((a, b) => Number(a.id) - Number(b.id));

    return accessories;
  }

  function getAll() {
    return [...accessories];
  }

  function getById(id) {
    return accessories.find((item) => Number(item.id) === Number(id)) || null;
  }

  function nextId() {
    return accessories.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accessories));
  }

  function create(initial = {}) {
    const item = {
      id: nextId(),
      name: 'New Accessory',
      brand: '',
      category: 'Accessory',
      stock: null,
      image: '',
      pdfPage: null,
      compatibleWith: [],
      hidden: false,
      ...initial,
    };
    accessories.push(item);
    accessories.sort((a, b) => Number(a.id) - Number(b.id));
    persist();
    return item;
  }

  function update(id, patch) {
    const idx = accessories.findIndex((item) => Number(item.id) === Number(id));
    if (idx === -1) return null;
    accessories[idx] = {
      ...accessories[idx],
      ...patch,
      compatibleWith: Array.isArray(patch.compatibleWith)
        ? patch.compatibleWith.map(Number).filter(Boolean)
        : accessories[idx].compatibleWith,
    };
    persist();
    return accessories[idx];
  }

  function remove(id) {
    const before = accessories.length;
    accessories = accessories.filter((item) => Number(item.id) !== Number(id));
    if (accessories.length !== before) {
      persist();
      return true;
    }
    return false;
  }

  function replaceAll(newItems) {
    accessories = [...newItems].map((item) => ({
      ...item,
      compatibleWith: Array.isArray(item.compatibleWith) ? item.compatibleWith.map(Number).filter(Boolean) : [],
    }));
    persist();
    return accessories;
  }

  function resetToOriginal() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function exportJson() {
    return JSON.stringify(accessories, null, 2);
  }

  return { load, getAll, getById, create, update, remove, replaceAll, resetToOriginal, exportJson };
})();
