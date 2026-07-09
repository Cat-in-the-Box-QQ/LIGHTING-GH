// power.js - power / current calculations for Set Builder

function totalPower(items) {
  // items: [{fixture, qty}]
  return items.reduce((sum, it) => sum + (it.fixture.power || 0) * it.qty, 0);
}

function currentAt(voltage, watts) {
  if (!voltage) return 0;
  return watts / voltage;
}
