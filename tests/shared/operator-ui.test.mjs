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

  assert.match(source, /return accountName \? `\$\{user\.email\}\(\$\{accountName\}\)` : user\.email/);
  assert.match(table, /<th class="col-account sortable"[^>]*>계정/);
  assert.match(table, /<td class="col-account">\{\{ formatAccountIdentity\(user\) \}\}<\/td>/);
  assert.doesNotMatch(table, /class="col-email"|class="col-name"/);
});
