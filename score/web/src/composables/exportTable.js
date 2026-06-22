/* 표 데이터를 CSV/XLSX로 내보낸다.
 * XLSX는 exceljs(동적 import)로 생성 — npm의 SheetJS(xlsx)는 알려진 취약점(CVE-2023-30533
 * prototype pollution / CVE-2024-22363 ReDoS)이 있고 npm 배포본이 방치돼 있어 사용하지 않는다.
 * traffic의 RecordView도 동일하게 exceljs를 쓴다. */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// { sheetName, fileBase, headers:[], rows:[[]], format:"csv"|"xlsx" }
export async function exportTable({ sheetName, fileBase, headers, rows, format }) {
  if (format === "csv") {
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    downloadBlob(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }), `${fileBase}.csv`);
    return;
  }
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  ws.addRows(rows);
  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${fileBase}.xlsx`,
  );
}
