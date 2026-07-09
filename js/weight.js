// weight.js - weight calculations for Set Builder

function totalWeight(items) {
  return items.reduce((sum, it) => sum + (it.fixture.weight || 0) * it.qty, 0);
}
