// database.js - loads fixtures.json and exposes helper functions
// Static app: data edits are stored in localStorage.

const DB = (function () {
  const STORAGE_KEY = "lighting_db_fixtures_v6";
  const INVENTORY_KEY = "lighting_db_inventory_v3";
  let fixtures = [];

  function loadInventoryMap() {
    try {
      return JSON.parse(localStorage.getItem(INVENTORY_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveInventoryMap(map) {
    localStorage.setItem(INVENTORY_KEY, JSON.stringify(map));
  }

  function normalizeAccessories(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  function mergeAccessoriesFromCatalog(baseFixtures, accessoriesCatalog) {
    const compatibilityMap = new Map();

    (accessoriesCatalog || []).forEach((accessory) => {
      const name = String(accessory.name || accessory.model || "").trim();
      if (!name) return;
      (accessory.compatibleWith || []).forEach((fixtureId) => {
        const id = Number(fixtureId);
        if (!compatibilityMap.has(id)) compatibilityMap.set(id, []);
        compatibilityMap.get(id).push(name);
      });
    });

    return (baseFixtures || []).map((fixture) => {
      const direct = normalizeAccessories(fixture.accessories);
      const linked = normalizeAccessories(compatibilityMap.get(Number(fixture.id)) || []);
      const merged = [...new Set([...direct, ...linked])];
      return {
        ...fixture,
        accessories: merged,
        compatibleText: merged.join(' '),
      };
    });
  }

  function applyInventoryState(items) {
    const inventory = loadInventoryMap();
    items.forEach((item) => {
      const entry = inventory[String(item.id)] || {};
      item.reserved = Number(entry.reserved || item.reserved || 0);
      item.inUse = Number(entry.inUse || item.inUse || 0);
      item.remaining = Math.max((Number(item.stockCount || 0)) - item.reserved - item.inUse, 0);
      item.accessories = normalizeAccessories(item.accessories);
      item.compatibleText = String(item.compatibleText || item.accessories.join(' '));
      item.hidden = !!item.hidden;
    });
    return items;
  }

  function mergeBaseWithOverrides(base, overrides) {
    const overrideMap = new Map((overrides || []).map((item) => [Number(item.id), item]));
    const merged = base.map((item) => {
      const override = overrideMap.get(Number(item.id));
      if (!override) return { ...item, accessories: normalizeAccessories(item.accessories), compatibleText: item.compatibleText || '' };

      const baseAccessories = normalizeAccessories(item.accessories);
      const overrideAccessories = Array.isArray(override.accessories) ? normalizeAccessories(override.accessories) : null;
      const mergedAccessories = overrideAccessories
        ? (overrideAccessories.length ? [...new Set([...baseAccessories, ...overrideAccessories])] : baseAccessories)
        : baseAccessories;

      return {
        ...item,
        ...override,
        accessories: mergedAccessories,
        compatibleText: mergedAccessories.join(' '),
      };
    });

    const baseIds = new Set(base.map((item) => Number(item.id)));
    (overrides || []).forEach((item) => {
      if (!baseIds.has(Number(item.id))) {
        const acc = normalizeAccessories(item.accessories);
        merged.push({ ...item, accessories: acc, compatibleText: acc.join(' ') });
      }
    });

    return merged;
  }

  async function load() {
    const overrides = localStorage.getItem(STORAGE_KEY);
    const [fixturesRes, accessoriesRes] = await Promise.all([
      fetch("data/fixtures.json", { cache: "no-store" }),
      fetch("data/accessories.json", { cache: "no-store" }).catch(() => null),
    ]);

    const baseFixtures = await fixturesRes.json();
    let accessoriesCatalog = [];
    try {
      accessoriesCatalog = accessoriesRes ? await accessoriesRes.json() : [];
    } catch (e) {
      accessoriesCatalog = [];
    }

    const base = mergeAccessoriesFromCatalog(baseFixtures, accessoriesCatalog);

    if (overrides) {
      try {
        const parsedOverrides = JSON.parse(overrides);
        fixtures = mergeBaseWithOverrides(base, parsedOverrides);
      } catch (e) {
        fixtures = base;
      }
    } else {
      fixtures = base;
    }

    applyInventoryState(fixtures);
    fixtures.sort((a, b) => Number(a.id) - Number(b.id));
    return fixtures;
  }

  function getAll() {
    return [...fixtures];
  }

  function getById(id) {
    return fixtures.find((f) => Number(f.id) === Number(id)) || null;
  }

  function nextId() {
    return fixtures.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
  }

  function update(id, patch) {
    const idx = fixtures.findIndex((f) => Number(f.id) === Number(id));
    if (idx === -1) return null;
    const accessories = patch.accessories !== undefined ? normalizeAccessories(patch.accessories) : normalizeAccessories(fixtures[idx].accessories);
    fixtures[idx] = {
      ...fixtures[idx],
      ...patch,
      accessories,
      compatibleText: accessories.join(' '),
    };
    applyInventoryState(fixtures);
    persist();
    return fixtures[idx];
  }

  function updateInventory(id, patch) {
    const map = loadInventoryMap();
    const key = String(id);
    const current = map[key] || { reserved: 0, inUse: 0 };
    map[key] = {
      reserved: Math.max(Number(patch.reserved ?? current.reserved) || 0, 0),
      inUse: Math.max(Number(patch.inUse ?? current.inUse) || 0, 0),
    };
    saveInventoryMap(map);
    applyInventoryState(fixtures);
    persist();
    return getById(id);
  }

  function create(initial = {}) {
    const item = {
      id: nextId(),
      brand: "",
      model: "New Item",
      category: "",
      type: "fixture",
      power: null,
      powerRaw: null,
      weight: null,
      weightRaw: null,
      lux: null,
      lumens: null,
      beam: null,
      wireless: null,
      whiteLight: null,
      color: null,
      ip: null,
      battery: null,
      stock: "0 Pieces",
      stockCount: 0,
      stockNote: null,
      unitsPerSet: null,
      setCountInStock: null,
      dimensions: null,
      image: "images/page-014.jpg",
      pdfPage: null,
      reserved: 0,
      inUse: 0,
      remaining: 0,
      accessories: [],
      compatibleText: '',
      hidden: false,
      ...initial,
    };
    item.accessories = normalizeAccessories(item.accessories);
    item.compatibleText = item.accessories.join(' ');
    fixtures.push(item);
    fixtures.sort((a, b) => Number(a.id) - Number(b.id));
    persist();
    return item;
  }

  function duplicate(id) {
    const source = getById(id);
    if (!source) return null;
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = nextId();
    copy.model = `${copy.model} Copy`;
    copy.accessories = normalizeAccessories(copy.accessories);
    copy.compatibleText = copy.accessories.join(' ');
    fixtures.push(copy);
    fixtures.sort((a, b) => Number(a.id) - Number(b.id));
    persist();
    return copy;
  }

  function remove(id) {
    const before = fixtures.length;
    fixtures = fixtures.filter((f) => Number(f.id) !== Number(id));
    const map = loadInventoryMap();
    delete map[String(id)];
    saveInventoryMap(map);
    if (fixtures.length !== before) {
      persist();
      return true;
    }
    return false;
  }

  function replaceAll(newFixtures) {
    fixtures = [...newFixtures].map((item) => {
      const accessories = normalizeAccessories(item.accessories);
      return { ...item, accessories, compatibleText: accessories.join(' ') };
    }).sort((a, b) => Number(a.id) - Number(b.id));
    applyInventoryState(fixtures);
    persist();
    return fixtures;
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fixtures));
  }

  function resetToOriginal() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(INVENTORY_KEY);
  }

  function exportJson() {
    return JSON.stringify(fixtures, null, 2);
  }

  function brands() {
    return [...new Set(fixtures.map((f) => f.brand).filter(Boolean))].sort();
  }

  function categories() {
    return [...new Set(fixtures.map((f) => f.category).filter(Boolean))].sort();
  }

  return {
    load,
    getAll,
    getById,
    update,
    updateInventory,
    create,
    duplicate,
    remove,
    replaceAll,
    persist,
    resetToOriginal,
    exportJson,
    brands,
    categories,
  };
})();
