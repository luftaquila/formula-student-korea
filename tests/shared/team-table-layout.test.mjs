import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const targets = [
  ["entry/web/src/components/EntryTable.vue", "entry/web/src/App.vue", "entry-team-type-filter", "tests/e2e/entry/sticky-columns.spec.mjs"],
  ["score/web/src/views/ScoreBoard.vue", null, "score-board-type-filter", "tests/e2e/score/dashboard.spec.mjs"],
  ["score/web/src/views/PublicScoreBoard.vue", null, "score-public-type-filter", "tests/e2e/score/public-board.spec.mjs"],
  ["score/web/src/views/EnduranceInput.vue", null, "score-endurance-type-filter", "tests/e2e/score/endurance.spec.mjs"],
  ["documents/web/src/views/AdminDashboard.vue", null, "documents-admin-type-filter", "tests/e2e/documents/admin-dashboard.spec.mjs"],
  ["documents/web/src/views/AdminSessionDetail.vue", null, "documents-session-type-filter", "tests/e2e/documents/admin-download.spec.mjs"],
  ["queue/web/src/views/Priority.vue", null, "queue-priority-type-filter", "tests/e2e/queue/priority.spec.mjs"],
  ["queue/web/src/views/StatsPage.vue", null, "queue-stats-type-filter", "tests/e2e/queue/stats.spec.mjs"],
];

test("all eight team tables use the shared responsive layout contract", async () => {
  for (const [layoutPath, , , e2ePath] of targets) {
    const source = await readFile(layoutPath, "utf8");
    const e2e = await readFile(e2ePath, "utf8");
    assert.match(source, /useTableHeadBand/, `${layoutPath} must pin its header to the page`);
    assert.match(source, /team-table-head-band/, `${layoutPath} must render the pinned header band`);
    assert.match(source, /team-table-scroll/, `${layoutPath} must keep horizontal scrolling local to the table`);
    assert.match(source, /team-table(?:\s|\")/, `${layoutPath} must opt into shared table styles`);
    assert.match(source, /team-entry-summary/, `${layoutPath} must render the compact mobile identity`);
    assert.match(source, />\s*엔트리(?:\s|<)/, `${layoutPath} must label the identity column as 엔트리`);
    assert.doesNotMatch(source, /StickyFreezeLine|useStickyColumns|data-sticky-cols/);
    assert.match(e2e, /expectCompactTeamIdentity/, `${e2ePath} must verify the rendered identity width`);
  }
});

test("each team table persists its own vehicle type selection", async () => {
  for (const [layoutPath, filterPath, storageKey] of targets) {
    const source = await readFile(filterPath || layoutPath, "utf8");
    assert.match(source, /usePersistentTypeFilters/);
    assert.ok(source.includes(storageKey), `${filterPath || layoutPath} must use ${storageKey}`);
  }
});

test("shared styles combine identity columns at every viewport without a nested vertical table viewport", async () => {
  const source = await readFile("shared/styles/layout.css", "utf8");
  assert.match(source, /\.team-table-card\s*{[^}]*overflow:\s*clip/is);
  assert.match(source, /\.team-table-body\s*{[^}]*overflow:\s*visible\s*!important/is);
  assert.match(source, /\.team-table:not\(\.team-table-desktop-split\)\s*{[^}]*display:\s*inline-table[^}]*width:\s*auto\s*!important[^}]*min-width:\s*0\s*!important/is);
  assert.match(source, /\.team-table:not\(\.team-table-desktop-split\) th,[\s\S]*\.team-table:not\(\.team-table-desktop-split\) td\s*{[^}]*width:\s*auto\s*!important/is);
  assert.match(source, /\.team-table \.col-univ,[\s\S]*\.team-table \.col-type\s*{\s*display:\s*none/is);
  assert.match(source, /\.team-table \.col-num\s*{[^}]*width:\s*auto\s*!important/is);
  assert.match(source, /@media \(max-width:\s*640px\)[\s\S]*\.team-table \.col-num\s*{[^}]*width:\s*auto\s*!important/is);
  assert.match(source, /@media \(max-width:\s*640px\)[\s\S]*\.team-table\s*{[^}]*display:\s*inline-table[^}]*min-width:\s*0\s*!important/is);
  assert.match(source, /@media \(max-width:\s*640px\)[\s\S]*\.team-table th,[\s\S]*\.team-table td\s*{[^}]*width:\s*auto\s*!important/is);
  assert.doesNotMatch(source, /\.team-table \.col-num\s*{[^}]*(?:132|144)px/is);
  assert.match(source, /\.team-table\.team-table-desktop-split \.col-univ,[\s\S]*display:\s*table-cell/is);
  assert.match(source, /\.team-table th:not\(\.col-num\)[\s\S]*min-width:\s*96px/is);
  assert.match(source, /\.team-entry-summary\s*{[^}]*display:\s*grid[^}]*width:\s*max-content/is);
  assert.match(source, /\.team-mobile-entry-type\s*{[^}]*display:\s*inline-flex\s*!important/is);
  assert.match(source, /\.team-mobile-entry-name\s*{[^}]*font-weight:\s*500/is);
  assert.doesNotMatch(source, /\.team-mobile-entry-univ,[\s\S]*\.team-mobile-entry-name\s*{[^}]*text-overflow:\s*ellipsis/is);
  assert.match(source, /\.team-table tr > \.col-num\s*{[^}]*text-align:\s*left\s*!important/is);
  const entry = await readFile("entry/web/src/components/EntryTable.vue", "utf8");
  assert.match(entry, /team-table-desktop-split/);
  const inspection = await readFile("inspection/web/src/views/SheetTeamList.vue", "utf8");
  assert.match(inspection, /<colgroup>[\s\S]*sheet-table-col-entry[\s\S]*sheet-table-col-result[\s\S]*<\/colgroup>/is);
  assert.match(inspection, /\.sheet-table\s*{[^}]*table-layout:\s*auto/is);
  assert.doesNotMatch(inspection, /<(?:th|td)[^>]*class="col-(?:team|type)"/is);
  assert.match(inspection, /:data-team-type="entry\.type \|\| ''"/);
  assert.match(inspection, /getStickyHeaderCellStyle\(index \+ 1\)/);
  assert.match(await readFile("tests/e2e/inspection/summary.spec.mjs", "utf8"), /expectCompactTeamIdentity/);
  assert.match(inspection, /\.sheet-table \.col-num,[\s\S]*width:\s*1%/is);
  assert.doesNotMatch(inspection, /MOBILE_ENTRY_COLUMN_WIDTH|mobileTableWidth|--mobile-table-width/);
  assert.doesNotMatch(inspection, /\.mobile-entry-univ,[\s\S]*\.mobile-entry-team\s*{[^}]*text-overflow:\s*ellipsis/is);
});

test("pinned headers retain application styles and ignore hidden columns", async () => {
  const source = await readFile("shared/useTableHeadBand.js", "utf8");
  assert.match(source, /clone\.dataset\.tableHeadCopy = ""/);
  assert.match(source, /clone\.appendChild\(head\.cloneNode\(true\)\)/);
  assert.doesNotMatch(source, /removeAttribute\("class"\)/);
  assert.match(source, /getComputedStyle\(cell\)\.display !== "none"/);
  assert.match(source, /clone\.style\.setProperty\("width", `\$\{tableWidth\}px`, "important"\)/);
  assert.match(source, /clone\.style\.setProperty\("min-width", `\$\{tableWidth\}px`, "important"\)/);
  assert.match(source, /clone\.style\.setProperty\("max-width", `\$\{tableWidth\}px`, "important"\)/);
  assert.match(source, /scroller\.scrollLeft \/ sourceMax/);
  assert.match(source, /sourceTop < bandTop - 0\.5 \? "auto" : "none"/);
});

test("document submission timestamps render date and time on separate lines", async () => {
  const dashboard = await readFile("documents/web/src/views/AdminDashboard.vue", "utf8");
  const detail = await readFile("documents/web/src/views/AdminSessionDetail.vue", "utf8");
  assert.match(dashboard, /session-date date-time-lines/);
  assert.match(dashboard, /cell-time date-time-lines/);
  assert.match(dashboard, /\.session-link\s*{[^}]*display:\s*block/is);
  assert.match(dashboard, /\.session-date\.date-time-lines\s*{[^}]*display:\s*grid/is);
  assert.match(detail, /column-header-lines/);
  assert.match(detail, /aria-label="제출 일시"/);
  assert.match(detail, />제출<\/span>\s*<span>일시/);
  assert.match(detail, /formatDateLines\(t\.submission\.submitted_at\)\.time/);
});
