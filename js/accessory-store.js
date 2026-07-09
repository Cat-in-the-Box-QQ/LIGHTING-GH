const AccessoryStore = (() => {
  let accessories = [];

  function mapRowToAccessory(row) {
    return {
      id: Number(row.id),
      name: row.name || '',
      brand: row.brand || '',
      category: row.category || 'Accessory',
      stock: row.stock || null,
      image: row.image || '',
      pdfPage: row.pdf_page ?? null,
      compatibleWith: Array.isArray(row.compatible_with)
        ? row.compatible_with.map(Number).filter(Boolean)
        : [],
      hidden: !!row.hidden,
    };
  }

  function mapPatchToRow(patch = {}) {
    const row = {};

    if ('name' in patch) row.name = patch.name || null;
    if ('brand' in patch) row.brand = patch.brand || null;
    if ('category' in patch) row.category = patch.category || 'Accessory';
    if ('stock' in patch) row.stock = patch.stock || null;
    if ('image' in patch) row.image = patch.image || null;
    if ('pdfPage' in patch) row.pdf_page = patch.pdfPage ?? null;
    if ('compatibleWith' in patch) {
      row.compatible_with = Array.isArray(patch.compatibleWith)
        ? patch.compatibleWith.map(Number).filter(Boolean)
        : [];
    }
    if ('hidden' in patch) row.hidden = !!patch.hidden;

    return row;
  }

  async function load() {
    const { data, error } = await window.sb
      .from('accessories')
      .select('*')
      .order('id', { ascending: true });

    if (error) throw error;

    accessories = (data || []).map(mapRowToAccessory);
    return getAll();
  }

  function getAll() {
    return [...accessories];
  }

  function getById(id) {
    return accessories.find((item) => Number(item.id) === Number(id)) || null;
  }

  async function create(initial = {}) {
    const row = mapPatchToRow({
      name: 'New Accessory',
      category: 'Accessory',
      compatibleWith: [],
      hidden: false,
      ...initial,
    });

    const { data, error } = await window.sb
      .from('accessories')
      .insert(row)
      .select()
      .single();

    if (error) throw error;

    const mapped = mapRowToAccessory(data);
    accessories.push(mapped);
    accessories.sort((a, b) => Number(a.id) - Number(b.id));
    return mapped;
  }

  async function update(id, patch) {
    const row = mapPatchToRow(patch);

    const { data, error } = await window.sb
      .from('accessories')
      .update(row)
      .eq('id', Number(id))
      .select()
      .single();

    if (error) throw error;

    const mapped = mapRowToAccessory(data);
    const idx = accessories.findIndex((item) => Number(item.id) === Number(id));
    if (idx !== -1) {
      accessories[idx] = mapped;
    } else {
      accessories.push(mapped);
    }
    accessories.sort((a, b) => Number(a.id) - Number(b.id));
    return mapped;
  }

  async function remove(id) {
    const { error } = await window.sb
      .from('accessories')
      .delete()
      .eq('id', Number(id));

    if (error) throw error;

    accessories = accessories.filter((item) => Number(item.id) !== Number(id));
    return true;
  }

  async function replaceAll(newItems) {
    const rows = (newItems || []).map((item) => {
      const row = mapPatchToRow(item);
      row.id = Number(item.id);
      row.name = item.name || 'New Accessory';
      row.category = item.category || 'Accessory';
      return row;
    });

    const { error } = await window.sb
      .from('accessories')
      .upsert(rows, { onConflict: 'id' });

    if (error) throw error;

    await load();
    return getAll();
  }

  function resetToOriginal() {
    console.warn('AccessoryStore.resetToOriginal() is disabled in Supabase mode');
  }

  function exportJson() {
    return JSON.stringify(accessories, null, 2);
  }

  return {
    load,
    getAll,
    getById,
    create,
    update,
    remove,
    replaceAll,
    resetToOriginal,
    exportJson
  };
})();
