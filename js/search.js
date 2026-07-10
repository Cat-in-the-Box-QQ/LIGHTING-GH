// search.js - shared helpers for search/filter/sort/type handling

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function getStockCount(item) {
  if (item && Number.isFinite(Number(item.stockCount))) {
    return Number(item.stockCount);
  }
  const match = String(item?.stock || "").match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function inferItemType(item) {
  const explicit = normalizeText(item?.type);
  if (explicit) return explicit;

  const brand = normalizeText(item?.brand);
  const category = normalizeText(item?.category);
  const model = normalizeText(item?.model);

  if (brand === "dmx control" || category.includes("controller") || category.includes("transmitter")) {
    return "controller";
  }
  if (brand === "battery" || category === "battery" || category.includes("power station")) {
    return "power";
  }
  if (category.includes("accessory") || category.includes("lantern") || model.includes("dimmer") || brand === "chimera") {
    return "accessory";
  }
  return "fixture";
}

function itemTypeLabel(item) {
  const type = inferItemType(item);
  if (type === "controller") return "Controller";
  if (type === "power") return "Power";
  if (type === "accessory") return "Accessory";
  return "Fixture";
}

function isHiddenItem(item) {
  return !!item?.hidden;
}

function visibleItems(items, includeHidden = false) {
  return (items || []).filter((item) => includeHidden || !isHiddenItem(item));
}

function getUnitsPerSet(item) {
  if (item && Number.isFinite(Number(item.unitsPerSet)) && Number(item.unitsPerSet) > 1) {
    return Number(item.unitsPerSet);
  }
  const note = String(item?.stockNote || "");
  const match = note.match(/(\d+)\s+sets?\s+of\s+(\d+)/i);
  return match ? Number(match[2]) : null;
}

function hasSetOption(item) {
  return Number(getUnitsPerSet(item)) > 1;
}

function isBuildableItem(item) {
  return inferItemType(item) === "fixture";
}

function hasWireless(item) {
  return !!normalizeText(item?.wireless);
}

function hasCrmx(item) {
  const wireless = normalizeText(item?.wireless);
  return /crmx|lumenradio/.test(wireless);
}

function hasBattery(item) {
  return !!normalizeText(item?.battery);
}

function isRgbFixture(item) {
  const color = normalizeText(item?.color);
  return /(rgb|rgbw|rgbww|rgba|rgbaw|rgbma|rgblaw|rgbacl|rgbwa\+uv|rgb\+mint\+amber|full-rgb)/i.test(color);
}

function isBiColorFixture(item) {
  return /bi-?color/i.test(normalizeText(item?.color));
}

function filterFixtures(fixtures, filters) {
  return fixtures.filter((f) => {
    if (!filters?.includeHidden && isHiddenItem(f)) return false;
    const accessoryText = Array.isArray(f.accessories) ? f.accessories.join(' ') : '';
    const hay = [
      f.id,
      f.brand,
      f.model,
      f.category,
      f.type,
      f.color,
      f.whiteLight,
      f.wireless,
      f.ip,
      f.stock,
      f.dimensions,
      f.battery,
      f.compatibleText,
      accessoryText
    ].join(" ").toLowerCase();

    if (filters.q && !hay.includes(normalizeText(filters.q))) return false;
    if (filters.brand && f.brand !== filters.brand) return false;
    if (filters.category && f.category !== filters.category) return false;
    if (filters.type && inferItemType(f) !== filters.type) return false;
    if (filters.ip && f.ip !== filters.ip) return false;
    if (filters.wireless === "yes" && !hasWireless(f)) return false;
    if (filters.wireless === "no" && hasWireless(f)) return false;
    if (filters.wireless === "crmx" && !hasCrmx(f)) return false;
    if (filters.color === "rgb" && !isRgbFixture(f)) return false;
    if (filters.color === "bicolor" && !isBiColorFixture(f)) return false;
    if (filters.battery === "yes" && !hasBattery(f)) return false;
    if (filters.inStock === "yes" && getStockCount(f) <= 0) return false;
    if (filters.maxWeight && f.weight != null && f.weight > Number(filters.maxWeight)) return false;
    if (filters.maxPower && f.power != null && f.power > Number(filters.maxPower)) return false;
    return true;
  });
}

function buildAccessoriesCatalog(fixtures, baseAccessories = []) {
  const map = new Map();

  function keyOf(item) {
    return `${normalizeText(item.name || item.model)}__${normalizeText(item.brand)}`;
  }

  baseAccessories.forEach((item) => {
    const copy = JSON.parse(JSON.stringify(item));
    copy.compatibleWith = Array.isArray(copy.compatibleWith) ? copy.compatibleWith.slice() : [];
    map.set(keyOf(copy), copy);
  });

  fixtures.forEach((fixture) => {
    const list = Array.isArray(fixture.accessories) ? fixture.accessories : [];
    list.forEach((name) => {
      const key = `${normalizeText(name)}__${normalizeText(fixture.brand)}`;
      if (!map.has(key)) {
        map.set(key, {
          id: map.size + 1,
          name,
          brand: fixture.brand,
          category: 'Accessory',
          stock: null,
          image: fixture.image || '',
          pdfPage: fixture.pdfPage || null,
          compatibleWith: []
        });
      }
      const entry = map.get(key);
      if (!entry.compatibleWith.includes(fixture.id)) {
        entry.compatibleWith.push(fixture.id);
      }
    });
  });

  return [...map.values()]
    .map((item) => ({ ...item, compatibleWith: (item.compatibleWith || []).sort((a, b) => a - b) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.brand || '').localeCompare(String(b.brand || '')));
}

function sortFixtures(fixtures, sortBy) {
  const arr = [...fixtures];
  switch (sortBy) {
    case "brand_asc":
      arr.sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));
      break;
    case "brand_desc":
      arr.sort((a, b) => b.brand.localeCompare(a.brand) || a.model.localeCompare(b.model));
      break;
    case "model_desc":
      arr.sort((a, b) => b.model.localeCompare(a.model));
      break;
    case "power":
    case "power_asc":
      arr.sort((a, b) => (a.power ?? 0) - (b.power ?? 0) || a.model.localeCompare(b.model));
      break;
    case "power_desc":
      arr.sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || a.model.localeCompare(b.model));
      break;
    case "weight":
    case "weight_asc":
      arr.sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0) || a.model.localeCompare(b.model));
      break;
    case "weight_desc":
      arr.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.model.localeCompare(b.model));
      break;
    case "stock":
    case "stock_desc":
      arr.sort((a, b) => getStockCount(b) - getStockCount(a) || a.model.localeCompare(b.model));
      break;
    case "stock_asc":
      arr.sort((a, b) => getStockCount(a) - getStockCount(b) || a.model.localeCompare(b.model));
      break;
    case "model":
    case "model_asc":
      arr.sort((a, b) => a.model.localeCompare(b.model));
      break;
    default:
      break;
  }
  return arr;
}
