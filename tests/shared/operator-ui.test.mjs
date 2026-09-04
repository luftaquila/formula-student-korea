import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function templateOf(source) {
  const start = source.indexOf("<template>");
  const end = source.lastIndexOf("</template>");
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

test("queue booth entry and exit actions require confirmation with their team", async () => {
  const source = await readFile(new URL("../../queue/web/src/views/AdminPanel.vue", import.meta.url), "utf8");

  assert.match(source, /입차 확인\\n#\$\{num\}/);
  assert.match(source, /출차 확인\\n#\$\{booth\.occupied_by\}/);
  assert.match(source, /if \(!confirm\(`\$\{currentTabName\.value\}\$\{boothNum\} 입차 확인/);
  assert.match(source, /if \(!confirm\(`\$\{currentTabName\.value\}\$\{boothNum\} 출차 확인/);
});

test("inspection category PASS and FAIL changes require confirmation", async () => {
  const source = await readFile(new URL("../../inspection/web/src/views/SheetDetail.vue", import.meta.url), "utf8");

  assert.match(source, /const action = newVal \? `\$\{newVal\} 상태로 변경` : `\$\{current\} 상태 해제`/);
  assert.match(source, /if \(!confirm\(`"\$\{categoryName\}" 카테고리를 \$\{action\}하시겠습니까\?`\)\) return/);
});

test("account list combines email and account name in one column", async () => {
  const source = await readFile(new URL("../../auth/web/src/views/Manage.vue", import.meta.url), "utf8");
  const table = templateOf(source).match(/<table class="data-table users-table">([\s\S]*?)<\/table>/)?.[1] || "";

  assert.match(source, /return accountName \? `\$\{user\.email\} \(\$\{accountName\}\)` : user\.email/);
  assert.match(table, /<th class="col-account sortable"[^>]*>계정/);
  assert.match(table, /<td class="col-account">\{\{ formatAccountIdentity\(user\) \}\}<\/td>/);
  assert.doesNotMatch(table, /class="col-email"|class="col-name"/);
});

test("occupied booth controls can pause and resume the shared inspection timer", async () => {
  const adminSource = await readFile(new URL("../../queue/web/src/views/AdminPanel.vue", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../../queue/web/src/api.js", import.meta.url), "utf8");
  const publicSource = await readFile(new URL("../../queue/web/src/views/QueueStatus.vue", import.meta.url), "utf8");
  const registrationSource = await readFile(new URL("../../queue/web/src/views/Register.vue", import.meta.url), "utf8");
  const timerSource = await readFile(new URL("../../queue/web/src/composables/useBoothTimers.js", import.meta.url), "utf8");
  const timerFormatSource = await readFile(new URL("../../queue/web/src/booth-timer.js", import.meta.url), "utf8");

  assert.match(apiSource, /export async function setBoothTimerPaused\(type, boothNum, paused\)/);
  assert.match(adminSource, /@click="toggleBoothTimerAction\(booth\)"/);
  assert.match(adminSource, /booth\.timer_paused_at \? "재개" : "중단"/);
  assert.match(adminSource, /'booth-paused': booth\.timer_paused_at/);
  assert.match(adminSource, /badge badge-danger">일시중단/);
  assert.match(publicSource, /'booth-paused': booth\.active && booth\.timer_paused_at/);
  assert.match(publicSource, /booth-status-tag paused">일시중단/);
  assert.match(publicSource, /\.booth-elapsed-paused[\s\S]*?color: var\(--accent-danger/);
  assert.match(registrationSource, /'booth-paused': booth\.active && booth\.timer_paused_at/);
  assert.match(registrationSource, /booth-card-status paused">일시중단/);
  assert.match(registrationSource, /\.booth-card-elapsed-paused[\s\S]*?color: var\(--accent-danger/);
  assert.match(timerSource, /booth\.timer_paused_at/);
  assert.match(timerFormatSource, /booth\.timer_paused_ms/);
});

test("inspection booth cards wrap at four columns without horizontal scrolling", async () => {
  const source = await readFile(new URL("../../queue/web/src/views/AdminPanel.vue", import.meta.url), "utf8");
  const boothCardsRule = source.match(/\.booth-cards\s*\{([^}]*)\}/)?.[1] || "";
  const boothCardRule = source.match(/\.booth-card\s*\{([^}]*)\}/)?.[1] || "";

  assert.match(boothCardsRule, /display:\s*grid/);
  assert.match(boothCardsRule, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(boothCardsRule, /overflow-x:\s*auto/);
  assert.match(boothCardRule, /min-width:\s*0/);
});
