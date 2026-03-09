import pdfMake from "pdfmake/build/pdfmake";

let fontsReady = false;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
}

async function ensureFonts() {
  if (fontsReady) return;

  const base = import.meta.env.PROD ? "/inspection" : "";
  const resp = await fetch(`${base}/fonts/NotoSansKR-Regular.ttf`);
  if (!resp.ok) throw new Error("폰트를 불러올 수 없습니다.");
  const buf = await resp.arrayBuffer();

  pdfMake.addVirtualFileSystem({
    "NotoSansKR-Regular.ttf": arrayBufferToBase64(buf),
  });
  pdfMake.fonts = {
    ...pdfMake.fonts,
    NotoSansKR: {
      normal: "NotoSansKR-Regular.ttf",
      bold: "NotoSansKR-Regular.ttf",
      italics: "NotoSansKR-Regular.ttf",
      bolditalics: "NotoSansKR-Regular.ttf",
    },
  };
  fontsReady = true;
}

const ANSWER_TYPE_LABEL = {
  passfail: "PASS/FAIL",
  number: "숫자",
  text: "텍스트",
};

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV"];
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

function roman(n) { return ROMAN[n] || String(n + 1); }
function alpha(n) { return String.fromCharCode(97 + n); }
function circled(n) { return CIRCLED[n] || `(${n + 1})`; }

export async function generateTemplatePdf(year, template) {
  await ensureFonts();

  const font = "NotoSansKR";
  const content = [];

  content.push({
    text: `FSK ${year} Inspection Sheet Template`,
    style: "title",
    margin: [0, 0, 0, 16],
  });

  const pdfTemplate = template.filter(cat => cat.pdf_include !== 0);
  for (let ci = 0; ci < pdfTemplate.length; ci++) {
    const cat = pdfTemplate[ci];

    content.push({
      text: `${roman(ci)}.  ${cat.name}`,
      style: "categoryHeader",
      margin: [0, ci > 0 ? 14 : 0, 0, 4],
    });

    for (let si = 0; si < (cat.subcategories || []).length; si++) {
      const sub = cat.subcategories[si];

      content.push({
        text: `${si + 1}.  ${sub.name}`,
        style: "subHeader",
        margin: [12, 8, 0, 2],
      });

      for (let gi = 0; gi < (sub.groups || []).length; gi++) {
        const grp = sub.groups[gi];

        const grpText = grp.remarks
          ? [{ text: `${alpha(gi)})  ${grp.name}`, style: "groupHeader" }, { text: ` — ${grp.remarks}`, style: "tdCellLight" }]
          : `${alpha(gi)})  ${grp.name}`;
        content.push({
          text: grpText,
          style: "groupHeader",
          margin: [24, 4, 0, 2],
        });

        if (grp.items?.length) {
          const tableBody = [
            [
              { text: "#", style: "thCell", alignment: "center" },
              { text: "항목", style: "thCell" },
              { text: "유형", style: "thCell", alignment: "center" },
              { text: "비고", style: "thCell" },
              { text: "결과", style: "thCell", alignment: "center" },
              { text: "메모", style: "thCell" },
            ],
          ];

          for (let ii = 0; ii < grp.items.length; ii++) {
            const item = grp.items[ii];
            tableBody.push([
              { text: circled(ii), style: "tdCell", alignment: "center" },
              { text: item.name, style: "tdCell" },
              { text: ANSWER_TYPE_LABEL[item.answer_type] || "", style: "tdCellLight", alignment: "center" },
              { text: item.remarks || "", style: "tdCellLight" },
              { text: "", style: "tdCell" },
              { text: "", style: "tdCell" },
            ]);
          }

          content.push({
            table: {
              headerRows: 1,
              widths: [24, "*", 54, "auto", 48, "*"],
              body: tableBody,
            },
            layout: {
              hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.5 : 0.25),
              vLineWidth: () => 0.25,
              hLineColor: () => "#cbd5e1",
              vLineColor: () => "#e2e8f0",
              paddingLeft: () => 4,
              paddingRight: () => 4,
              paddingTop: () => 3,
              paddingBottom: () => 3,
            },
            margin: [32, 0, 0, 4],
          });
        }
      }
    }
  }

  const docDefinition = {
    pageSize: "A4",
    pageMargins: [36, 36, 36, 36],
    defaultStyle: { font, fontSize: 9 },
    styles: {
      title: { fontSize: 16, bold: true, font },
      categoryHeader: { fontSize: 13, bold: true, font },
      subHeader: { fontSize: 11, bold: true, color: "#334155", font },
      groupHeader: { fontSize: 10, bold: true, color: "#475569", font },
      thCell: { fontSize: 7.5, bold: true, color: "#475569", font },
      tdCell: { fontSize: 8.5, font },
      tdCellLight: { fontSize: 8, color: "#64748b", font },
    },
    content,
  };

  await pdfMake.createPdf(docDefinition).download(`inspection_template_${year}.pdf`);
}
