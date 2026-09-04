<script setup>
import { ref, onMounted, onBeforeUnmount, computed } from "vue";
import { useRoute } from "vue-router";
import { fetchSheetTemplate } from "../api";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { ruleDocumentLabel } from "../utils/rule-text";

const route = useRoute();
const year = computed(() => Number(route.query.year) || currentCompetitionYear());
const template = ref([]);
const loading = ref(true);
const error = ref(false);
let previousTheme = null;

onMounted(async () => {
  previousTheme = document.documentElement.getAttribute("data-theme");
  document.documentElement.setAttribute("data-theme", "light");

  try {
    template.value = (await fetchSheetTemplate(year.value)).filter(c => c.pdf_include !== 0);
  } catch (e) {
    error.value = true;
  }
  loading.value = false;
});

onBeforeUnmount(() => {
  if (previousTheme) {
    document.documentElement.setAttribute("data-theme", previousTheme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
});

function print() {
  window.print();
}

// 인쇄물은 팀에게 전달되는 공식 검차표라서 검증된 인용만 찍는다. 검토 중/대응 없음은 표시하지 않는다.
function ruleCitation(item) {
  const refs = item.rule_refs;
  if (!refs || refs.status !== "verified") return "";
  return refs.references
    .map(ref => `${ruleDocumentLabel(ref.document)} ${ref.citation}`)
    .join(" · ");
}

import { subNum, grpNum, itemNum, getChecktableConfig, isPdfItem } from "../utils/sheet-helpers";
</script>

<template>
  <div class="print-page">
    <div v-if="loading" class="print-loading">Loading...</div>
    <div v-else-if="error" class="print-loading">데이터를 가져올 수 없습니다.</div>
    <template v-else>
      <button class="print-btn no-print" @click="print">인쇄</button>

      <div
        v-for="(cat, ci) in template"
        :key="cat.id"
        class="page"
        :class="{ 'page-break': ci > 0 }"
      >
        <h1 class="page-title">{{ year }} FSK Technical Inspection Form ({{ cat.name }})</h1>

        <div class="info-section">
          <div class="info-left">
            <span class="info-label">엔트리 :</span>
            <span class="info-space short"></span>
            <span class="info-label">학교 / 팀 :</span>
          </div>
          <div class="info-right">
            <span class="info-label">검차 위원 :</span>
            <span class="info-space sign"></span>
            <span class="info-sign">(서명)</span>
          </div>
        </div>

        <table class="sheet-table">
          <thead>
            <tr>
              <th class="col-item">항목</th>
              <th class="col-pf">PASS</th>
              <th class="col-pf">FAIL</th>
              <th class="col-pf">N/A</th>
              <th class="col-remarks">비고</th>
            </tr>
          </thead>
          <template v-for="(sub, si) in cat.subcategories" :key="sub.id">
            <tbody>
              <tr class="sub-header-row">
                <td colspan="5" class="td-sub-header">{{ subNum(si) }} - {{ sub.name }}<span v-if="sub.remarks" class="sub-remarks"> — {{ sub.remarks }}</span></td>
              </tr>
            </tbody>

            <tbody v-for="(grp, gi) in sub.groups" :key="grp.id" class="grp-tbody">
              <tr class="grp-header-row">
                <td colspan="5" class="td-grp-header">
                  {{ grpNum(gi) }}. {{ grp.name }}<span v-if="grp.remarks" class="grp-remarks"> — {{ grp.remarks }}</span>
                </td>
              </tr>

              <template v-for="(item, ii) in grp.items" :key="item.id">
                <tr v-if="isPdfItem(item)" class="item-row">
                  <template v-if="item.answer_type === 'checktable'">
                    <td :colspan="5" class="td-item-name td-checktable">
                      <span class="item-num">{{ itemNum(ii) }}</span> {{ item.name }}
                      <span v-if="ruleCitation(item)" class="rule-citation">{{ ruleCitation(item) }}</span>
                      <table class="checktable-print" v-if="getChecktableConfig(item).columns.length">
                        <thead>
                          <tr>
                            <th></th>
                            <th v-for="col in getChecktableConfig(item).columns" :key="col">{{ col }}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="row in getChecktableConfig(item).rows" :key="row">
                            <td class="ct-row-header">{{ row }}</td>
                            <td v-for="col in getChecktableConfig(item).columns" :key="col" class="ct-cell">☐</td>
                          </tr>
                        </tbody>
                      </table>
                    </td>
                  </template>
                  <template v-else>
                    <td class="td-item-name">
                      <span class="item-num">{{ itemNum(ii) }}</span> {{ item.name }}
                    </td>
                    <template v-if="item.answer_type === 'passfail'">
                      <td class="td-pf"></td>
                      <td class="td-pf"></td>
                      <td class="td-pf"></td>
                    </template>
                    <template v-else>
                      <td class="td-value" colspan="3">
                        <span v-if="item.unit" class="unit-label">{{ item.unit }}</span>
                      </td>
                    </template>
                    <td class="td-remarks">
                      <span>{{ item.remarks }}</span>
                      <span v-if="ruleCitation(item)" class="rule-citation">{{ ruleCitation(item) }}</span>
                    </td>
                  </template>
                </tr>
              </template>
            </tbody>
          </template>
        </table>


      </div>
    </template>
  </div>
</template>

<style scoped>
.print-page {
  background: white;
  color: black;
  font-family: "Noto Sans KR", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 9pt;
  line-height: 1.5;
}

.print-loading {
  padding: 3rem;
  text-align: center;
  font-size: 1.25rem;
  color: #666;
}

.print-btn {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 1000;
  padding: 10px 24px;
  background: #5e6ad2;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
}

.print-btn:hover {
  background: #4f5bc4;
}

.page {
  width: 210mm;
  min-height: 297mm;
  margin: 0 auto;
  padding: 14mm 18mm 20mm;
  position: relative;
  background: white;
}

.page-break {
  page-break-before: always;
}

.page-title {
  font-size: 14pt;
  font-weight: 700;
  text-align: center;
  margin-bottom: 14pt;
}

/* Info section */
.info-section {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 16pt 0 20pt;
}

.info-left,
.info-right {
  display: flex;
  align-items: baseline;
  gap: 6pt;
}

.info-label {
  font-weight: 600;
  font-size: 9.5pt;
  white-space: nowrap;
}

.info-space.short {
  display: inline-block;
  width: 40pt;
}

.info-space.sign {
  display: inline-block;
  width: 80pt;
}

.info-sign {
  font-size: 9pt;
  white-space: nowrap;
}

/* Table */
.sheet-table {
  width: 100%;
  border-collapse: collapse;
  border: 1.5px solid #000;
  font-size: 8pt;
  table-layout: fixed;
}

.sheet-table th,
.sheet-table td {
  border: 0.75px solid #000;
  padding: 3pt 5pt;
  vertical-align: middle;
}

.sheet-table thead th {
  background: #f0f0f0;
  font-weight: 700;
  text-align: center;
  font-size: 8.5pt;
  padding: 4pt 5pt;
}

.col-item { /* auto - fills remaining space */ }
.col-pf { width: 32pt; text-align: center; }
.col-remarks { width: 120pt; }

/* Group tbody */
.grp-tbody {
  break-inside: avoid;
}


/* Subcategory header */

.sub-header-row td {
  background: #d0d0d0;
  border-top: 2px solid #000;
}

.td-sub-header {
  font-weight: 800;
  font-size: 9pt;
  padding: 4pt 6pt;
}

.sub-remarks {
  font-weight: 400;
  color: #555;
  font-size: 7.5pt;
}

/* Group header */
.td-grp-header {
  font-weight: 700;
  font-size: 8pt;
  padding: 3pt 6pt 3pt 14pt;
  background: #f0f0f0;
}

.grp-remarks {
  font-weight: 400;
  color: #555;
  font-size: 7.5pt;
}

/* Item */
.td-item-name {
  font-size: 8pt;
  padding-left: 24pt;
  white-space: pre-wrap;
  word-break: keep-all;
  overflow-wrap: break-word;
}

.td-pf {
  text-align: center;
}

.td-value {
  text-align: right;
  padding-right: 6pt;
}

.td-remarks {
  font-size: 7.5pt;
  color: #333;
}

.rule-citation {
  display: block;
  margin-top: 1pt;
  color: #555;
  font-size: 6.5pt;
}

.unit-label {
  font-size: 7.5pt;
  color: #444;
}

/* Checktable print */
.td-checktable {
  padding: 4pt 6pt;
}

.checktable-print {
  width: auto;
  border-collapse: collapse;
  font-size: 7.5pt;
  margin-top: 3pt;
}

.checktable-print th,
.checktable-print td {
  border: 0.75px solid #000;
  padding: 2pt 4pt;
  text-align: center;
  white-space: nowrap;
}

.checktable-print th {
  background: #f0f0f0;
  font-weight: 700;
  font-size: 7pt;
}

.ct-row-header {
  font-weight: 600;
  text-align: left !important;
  background: #f8f8f8;
  font-size: 7pt;
}

.ct-cell {
  font-size: 8pt;
  width: 20pt;
}

/* Screen: separate pages visually */
@media screen {
  .print-page {
    background: #e5e7eb;
    padding: 20px 0;
  }

  .page {
    box-shadow: 0 2px 12px rgba(0,0,0,0.15);
    margin-bottom: 20px;
  }
}

/* Print styles */
@media print {
  .no-print { display: none !important; }
  .print-page { background: white; padding: 0; }
  .page { width: 100%; margin: 0; padding: 10mm 15mm 15mm; box-shadow: none; min-height: auto; }
  .page-break { page-break-before: always; }

  .sheet-table { border-collapse: separate; border-spacing: 0; border: none; }
  .sub-header-row td { border-top-width: 1.25px; }
}
</style>
