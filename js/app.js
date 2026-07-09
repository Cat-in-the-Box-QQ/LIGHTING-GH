// app.js - dashboard (index.html) logic

document.addEventListener("DOMContentLoaded", async () => {
  const fixtures = await DB.load();

  const totalStockPieces = fixtures.reduce((sum, f) => sum + getStockCount(f), 0);
  const rgbCount = fixtures.filter((f) => inferItemType(f) === "fixture" && isRgbFixture(f)).length;

  document.getElementById("statTotal").textContent = fixtures.length;
  document.getElementById("statBrands").textContent = DB.brands().length;
  document.getElementById("statStock").textContent = totalStockPieces;
  document.getElementById("statRgb").textContent = rgbCount;

  const byBrand = {};
  const byType = {};

  fixtures.forEach((f) => {
    if (!byBrand[f.brand]) byBrand[f.brand] = { count: 0, stock: 0 };
    byBrand[f.brand].count += 1;
    byBrand[f.brand].stock += getStockCount(f);

    const type = itemTypeLabel(f);
    if (!byType[type]) byType[type] = { count: 0, stock: 0 };
    byType[type].count += 1;
    byType[type].stock += getStockCount(f);
  });

  const brandList = document.getElementById("brandBreakdown");
  brandList.innerHTML = "";
  Object.keys(byBrand).sort().forEach((brand) => {
    const info = byBrand[brand];
    const li = document.createElement("li");
    li.className = "list-group-item d-flex justify-content-between align-items-center";
    li.innerHTML = `
      <div>
        <strong>${brand}</strong>
        <div class="small text-muted">${info.count} รายการ · stock ${info.stock}</div>
      </div>
      <a href="equipment.html?brand=${encodeURIComponent(brand)}" class="btn btn-sm btn-outline-dark">ดู</a>
    `;
    brandList.appendChild(li);
  });

  const typeList = document.getElementById("typeBreakdown");
  typeList.innerHTML = "";
  Object.keys(byType).forEach((type) => {
    const info = byType[type];
    const li = document.createElement("li");
    li.className = "list-group-item d-flex justify-content-between align-items-center";
    li.innerHTML = `
      <div>
        <strong>${type}</strong>
        <div class="small text-muted">${info.count} รายการ · stock ${info.stock}</div>
      </div>
      <a href="equipment.html?type=${encodeURIComponent(type.toLowerCase())}" class="btn btn-sm btn-outline-dark">ดู</a>
    `;
    typeList.appendChild(li);
  });
});
