const DB = (() => {
  let fixtures = [];

  function normalizeAccessories(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  function mapRowToFixture(row) {
    const accessories = normalizeAccessories(row.accessories);
    return {
      id: Number(row.id),
      brand: row.brand || '',
      model: row.model || '',
      category: row.category || '',
      type: row.type || 'fixture',
      power: row.power ?? null,
      powerRaw: row.power_raw ?? null,
      weight: row.weight ?? null,
      weightRaw: row.weight_raw ?? null,
      lux: row.lux ?? null,
      lumens: row.lumens ?? null,
      beam: row.beam ?? null,
      wireless: row.wireless ?? null,
      whiteLight: row.white_light ?? null,
      color: row.color ?? null,
      ip: row.ip ?? null,
      battery: row.battery ?? null,
      stock: row.stock ?? null,
      stockCount: row.stock_count ?? 0,
      stockNote: row.stock_note ?? null,
      unitsPerSet: row.units_per_set ?? null,
      setCountInStock: row.set_count_in_stock ?? null,
      dimensions: row.dimensions ?? null,
      image: row.image ?? null,
      pdfPage: row.pdf_page ?? null,
      reserved: row.reserved ?? 0,
      inUse: row.in_use ?? 0,
      remaining: row.remaining ?? 0,
      accessories,
      compatibleText: row.compatible_text || accessories.join(' '),
      hidden: !!row.hidden,
    };
  }

  function mapPatchToRow(patch = {}) {
    const row = {};

    if ('brand' in patch) row.brand = patch.brand || null;
    if ('model' in patch) row.model = patch.model || null;
    if ('category' in patch) row.category = patch.category || null;
    if ('type' in patch) row.type = patch.type || 'fixture';
    if ('power' in patch) row.power = patch.power ?? null;
    if ('powerRaw' in patch) row.power_raw = patch.powerRaw ?? null;
    if ('weight' in patch) row.weight = patch.weight ?? null;
    if ('weightRaw' in patch) row.weight_raw = patch.weightRaw ?? null;
    if ('lux' in patch) row.lux = patch.lux ?? null;
    if ('lumens' in patch) row.lumens = patch.lumens ?? null;
    if ('beam' in patch) row.beam = patch.beam ?? null;
    if ('wireless' in patch) row.wireless = patch.wireless ?? null;
    if ('whiteLight' in patch) row.white_light = patch.whiteLight ?? null;
    if ('color' in patch) row.color = patch.color ?? null;
    if ('ip' in patch) row.ip = patch.ip ?? null;
    if ('battery' in patch) row.battery = patch.battery ?? null;
    if ('stock' in patch) row.stock = patch.stock ?? null;
    if ('stockCount' in patch) row.stock_count = patch.stockCount ?? 0;
    if ('stockNote' in patch) row.stock_note = patch.stockNote ?? null;
    if ('unitsPerSet' in patch) row.units_per_set = patch.unitsPerSet ?? null;
    if ('setCountInStock' in patch) row.set_count_in_stock = patch.setCountInStock ?? null;
    if ('dimensions' in patch) row.dimensions = patch.dimensions ?? null;
    if ('image' in patch) row.image = patch.image ?? null;
    if ('pdfPage' in patch) row.pdf_page = patch.pdfPage ?? null;
    if ('reserved' in patch) row.reserved = patch.reserved ?? 0;
    if ('inUse' in patch) row.in_use = patch.inUse ?? 0;
    if ('remaining' in patch) row.remaining = patch.remaining ?? 0;
    if ('hidden' in patch) row.hidden = !!patch.hidden;

    if ('accessories' in patch) {
      const accessories = normalizeAccessories(patch.accessories);
      row.accessories = accessories;
      row.compatible_text =
        'compatibleText' in patch
          ? (patch.compatibleText || accessories.join(' '))
          : accessories.join(' ');
    } else if ('compatibleText' in patch) {
      row.compatible_text = patch.compatibleText || '';
    }

    return row;
  }

  async function load() {
    const { data, error } = await window.sb
      .from('fixtures')
      .select('*')
      .order('id', { ascending: true });

    if (error) throw error;

    fixtures = (data || []).map(mapRowToFixture);
    return getAll();
  }

  function getAll() {
    return [...fixtures];
  }

  function getById(id) {
    return fixtures.find((item) => Number(item.id) === Number(id)) || null;
  }

  async function create(initial = {}) {
    const payload = {
      model: 'New Item',
      type: 'fixture',
      stockCount: 0,
      reserved: 0,
      inUse: 0,
      remaining: 0,
      accessories: [],
      compatibleText: '',
      hidden: false,
      ...initial,
    };

    const row = mapPatchToRow(payload);

    const { data, error } = await window.sb
      .from('fixtures')
      .insert(row)
      .select()
      .single();

    if (error) throw error;

    const mapped = mapRowToFixture(data);
    fixtures.push(mapped);
    fixtures.sort((a, b) => Number(a.id) - Number(b.id));
    return mapped;
  }

  async function update(id, patch) {
    const row = mapPatchToRow(patch);

    const { data, error } = await window.sb
      .from('fixtures')
      .update(row)
      .eq('id', Number(id))
      .select()
      .single();

    if (error) throw error;

    const mapped = mapRowToFixture(data);
    const idx = fixtures.findIndex((item) => Number(item.id) === Number(id));
    if (idx !== -1) {
      fixtures[idx] = mapped;
    } else {
      fixtures.push(mapped);
    }
    fixtures.sort((a, b) => Number(a.id) - Number(b.id));
    return mapped;
  }

  async function updateInventory(id, patch) {
    const current = getById(id);
    if (!current) return null;

    const reserved = Math.max(Number(patch.reserved ?? current.reserved ?? 0) || 0, 0);
    const inUse = Math.max(Number(patch.inUse ?? current.inUse ?? 0) || 0, 0);
    const stockCount = Number(current.stockCount || 0);
    const remaining = Math.max(stockCount - reserved - inUse, 0);

    return update(id, { reserved, inUse, remaining });
  }

  async function remove(id) {
    const { error } = await window.sb
      .from('fixtures')
      .delete()
      .eq('id', Number(id));

    if (error) throw error;

    fixtures = fixtures.filter((item) => Number(item.id) !== Number(id));
    return true;
  }

  async function duplicate(id) {
    const source = getById(id);
    if (!source) return null;

    const copy = JSON.parse(JSON.stringify(source));
    delete copy.id;
    copy.model = `${copy.model} Copy`;
    return create(copy);
  }

  async function replaceAll(newFixtures) {
    const rows = (newFixtures || []).map((item) => {
      const row = mapPatchToRow(item);
      row.id = Number(item.id);
      row.model = item.model || 'New Item';
      row.type = item.type || 'fixture';
      row.compatible_text =
        item.compatibleText ||
        (Array.isArray(item.accessories) ? item.accessories.join(' ') : '');
      row.accessories = normalizeAccessories(item.accessories);
      return row;
    });

    const { error } = await window.sb
      .from('fixtures')
      .upsert(rows, { onConflict: 'id' });

    if (error) throw error;

    await load();
    return getAll();
  }

  function persist() {
    console.warn('DB.persist() is not used in Supabase mode');
  }

  function resetToOriginal() {
    console.warn('DB.resetToOriginal() is disabled in Supabase mode');
  }

  function exportJson() {
    return JSON.stringify(fixtures, null, 2);
  }

  function brands() {
    return [...new Set(fixtures.map((item) => item.brand).filter(Boolean))].sort();
  }

  function categories() {
    return [...new Set(fixtures.map((item) => item.category).filter(Boolean))].sort();
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
