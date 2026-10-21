// power.js - power / current calculations for Set Builder

// กำลังไฟรวมที่ชุดนี้ "กิน" (วัตต์)
// แหล่งจ่ายไฟ เช่น แบตเตอรี่ V-Mount หรือ power station ไม่ใช่โหลด จึงไม่นำมารวม
// (เดิมรวมหมด ทำให้ EcoFlow DELTA Pro ถูกนับเป็นโหลด 3600 W ทั้งที่เป็นตัวจ่ายไฟ)
function totalPower(items) {
  // items: [{fixture, qty}]
  return (items || []).reduce((sum, it) => {
    if (!it || !it.fixture) return sum;
    const draw = typeof getPowerDraw === 'function'
      ? getPowerDraw(it.fixture)
      : (Number(it.fixture.power) || 0);
    return sum + draw * (Number(it.qty) || 0);
  }, 0);
}

// ความจุแบตเตอรี่รวมในชุด (Wh) — ใช้คำนวณว่าเลี้ยงโหลดได้นานแค่ไหน
function totalBatteryWh(items) {
  return (items || []).reduce((sum, it) => {
    if (!it || !it.fixture) return sum;
    const wh = typeof getBatteryWh === 'function' ? getBatteryWh(it.fixture) : null;
    return sum + (Number(wh) || 0) * (Number(it.qty) || 0);
  }, 0);
}

// จำนวนชิ้นที่เป็นแหล่งจ่ายไฟในชุด
function countPowerSources(items) {
  return (items || []).reduce((sum, it) => {
    if (!it || !it.fixture) return sum;
    if (typeof isPowerSource !== 'function' || !isPowerSource(it.fixture)) return sum;
    return sum + (Number(it.qty) || 0);
  }, 0);
}

function currentAt(voltage, watts) {
  if (!voltage) return 0;
  return watts / voltage;
}
