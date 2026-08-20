import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const webRoot = new URL("../../", import.meta.url);

// The registration lookup and the inspection queue status page are the two public
// "내 순번 조회" screens. They must stay visually interchangeable: same submit
// button, same spacing around it, and the same realtime rank typography.
const SHARED_SELECTORS = [
  "\\.btn-block",
  "\\.team-display",
  "\\.team-badge",
  "\\.team-badge\\.error",
  "\\.team-badge\\.placeholder",
  "\\.result-display",
  "\\.result-row",
  "\\.result-name",
  "\\.result-rank",
  "\\.result-row\\.placeholder \\.result-rank",
  "\\.result-suffix",
  "\\.result-total",
];

function declarations(source, selector) {
  const styles = source.slice(source.indexOf("<style"));
  const match = styles.match(new RegExp(`(^|[\\s}])${selector}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(match, `missing rule for ${selector.replace(/\\\\/g, "")}`);
  return match[2]
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .sort()
    .join("; ");
}

async function readSource(path) {
  return readFile(new URL(path, webRoot), "utf8");
}

test("the public lookup screens share one submit button and rank style", async () => {
  const [lookup, status] = await Promise.all([
    readSource("registration/web/src/views/Lookup.vue"),
    readSource("queue/web/src/views/QueueStatus.vue"),
  ]);

  for (const selector of SHARED_SELECTORS) {
    assert.equal(
      declarations(lookup, selector),
      declarations(status, selector),
      `${selector.replace(/\\/g, "")} differs between the registration and queue lookup pages`,
    );
  }
});

test("both lookup submit buttons are full-width primary buttons with the search icon", async () => {
  const [lookup, status] = await Promise.all([
    readSource("registration/web/src/views/Lookup.vue"),
    readSource("queue/web/src/views/QueueStatus.vue"),
  ]);

  for (const source of [lookup, status]) {
    assert.match(source, /class="btn btn-primary btn-block"/);
    assert.match(source, /<svg viewBox="0 0 24 24"[^>]*>\s*<circle cx="11" cy="11" r="8" \/>/);
    // No extra .form-group wrapper: the team label sits one 1rem gap above the button.
    assert.doesNotMatch(source, /class="form-group"/);
  }
});
