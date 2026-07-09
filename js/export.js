// export.js - small helpers for CSV / JSON download in static app

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadTextFile(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadCsvRows(filename, rows) {
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  downloadTextFile(filename, csv, "text/csv;charset=utf-8");
}
