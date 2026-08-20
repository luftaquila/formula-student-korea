import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);

// The registration lookup and the inspection queue status page are the two public
// "내 순번 조회" screens and must stay one component: same submit button, same
// spacing, same realtime rank block. That is now enforced by a single shared
// stylesheet rather than by comparing duplicated declarations in both views.
const SHARED_SELECTORS = [
  ".status-grid",
  ".input-row",
  ".entry-input",
  ".team-display",
  ".team-badge",
  ".team-badge.error",
  ".team-badge.placeholder",
  ".btn-block",
  ".result-card",
  ".result-body",
  ".result-display",
  ".result-row",
  ".result-name",
  ".result-rank",
  ".result-suffix",
  ".result-total",
];

async function read(path) {
  return readFile(new URL(path, repoRoot), "utf8");
}

function scopedStyles(source) {
  const start = source.indexOf("<style");
  return start < 0 ? "" : source.slice(start);
}

test("both public lookup screens load the shared lookup stylesheet", async () => {
  const [registrationEntry, queueEntry] = await Promise.all([
    read("registration/web/src/main.js"),
    read("queue/web/src/styles/main.css"),
  ]);

  assert.match(registrationEntry, /@shared\/styles\/lookup-status\.css/);
  assert.match(queueEntry, /@shared\/styles\/lookup-status\.css/);
});

test("the shared lookup stylesheet owns every rule the two screens share", async () => {
  const shared = await read("shared/styles/lookup-status.css");

  for (const selector of SHARED_SELECTORS) {
    const rule = new RegExp(`\\.queue-status\\s+${selector.replace(/\./g, "\\.")}\\s*[,{]`);
    assert.match(shared, rule, `${selector} must be defined in the shared stylesheet`);
  }
  // Scoping every rule under the page root keeps kiosk and record screens, which
  // reuse names like .team-badge at a different size, untouched.
  for (const line of shared.split("\n")) {
    const selectorLine = line.trim();
    if (!selectorLine.endsWith("{") || selectorLine.startsWith("@") || selectorLine.startsWith("/*")) continue;
    assert.match(selectorLine, /^\.queue-status\b/, `unscoped rule in the shared stylesheet: ${selectorLine}`);
  }
});

test("neither lookup view redefines a shared rule locally", async () => {
  const [lookup, status] = await Promise.all([
    read("registration/web/src/views/Lookup.vue"),
    read("queue/web/src/views/QueueStatus.vue"),
  ]);

  for (const source of [lookup, status]) {
    const styles = scopedStyles(source);
    for (const selector of SHARED_SELECTORS) {
      const rule = new RegExp(`(^|[\\s,}])${selector.replace(/\./g, "\\.")}\\s*[,{]`, "m");
      assert.doesNotMatch(styles, rule, `${selector} belongs to shared/styles/lookup-status.css`);
    }
  }
});

test("both lookup submit buttons are full-width primary buttons with the search icon", async () => {
  const [lookup, status] = await Promise.all([
    read("registration/web/src/views/Lookup.vue"),
    read("queue/web/src/views/QueueStatus.vue"),
  ]);

  for (const source of [lookup, status]) {
    assert.match(source, /class="btn btn-primary btn-block"/);
    assert.match(source, /<svg viewBox="0 0 24 24"[^>]*>\s*<circle cx="11" cy="11" r="8" \/>/);
    // No .form-group wrapper: the team label sits one 1rem gap above the button.
    assert.doesNotMatch(source, /class="form-group"/);
  }
});
