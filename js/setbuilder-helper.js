// setbuilder-helper.js - shared localStorage helpers for current set

const CURRENT_SET_KEY = "lighting_db_current_set_v2";

function readCurrentSet() {
  try {
    return JSON.parse(localStorage.getItem(CURRENT_SET_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function writeCurrentSet(items) {
  localStorage.setItem(CURRENT_SET_KEY, JSON.stringify(items));
}

function addFixtureToCurrentSet(id, qty = 1) {
  const items = readCurrentSet();
  const existing = items.find((item) => Number(item.id) === Number(id));
  if (existing) existing.qty += qty;
  else items.push({ id: Number(id), qty: qty });
  writeCurrentSet(items);
  return items;
}

function removeFixtureFromCurrentSet(id) {
  const items = readCurrentSet().filter((item) => Number(item.id) !== Number(id));
  writeCurrentSet(items);
  return items;
}

function clearCurrentSet() {
  writeCurrentSet([]);
}
