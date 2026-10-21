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

// id เก็บเป็น string เสมอ
// fixture   -> "1", "2", ...
// accessory -> "a1", "a2", ...
function addFixtureToCurrentSet(id, qty = 1) {
  const items = readCurrentSet();
  const key = String(id);
  const existing = items.find((item) => String(item.id) === key);
  if (existing) existing.qty += qty;
  else items.push({ id: key, qty: qty });
  writeCurrentSet(items);
  return items;
}

function removeFixtureFromCurrentSet(id) {
  const items = readCurrentSet().filter((item) => String(item.id) !== String(id));
  writeCurrentSet(items);
  return items;
}

function clearCurrentSet() {
  writeCurrentSet([]);
}
