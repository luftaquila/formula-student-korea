import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../../shared/api-base.js", import.meta.url), "utf8"))
  .replace("import.meta.env.PROD", "false");
const { createApiClient } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("surfaces a structured API message while preserving its reason payload", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({
      message: "최신 미션을 다시 불러오세요.",
      reason: "occurrence_revision_mismatch",
    }),
  });
  const client = createApiClient("/api");
  await assert.rejects(client.request("/api/missions/1/remaining"), (error) => {
    assert.equal(error.message, "최신 미션을 다시 불러오세요.");
    assert.equal(error.status, 409);
    assert.equal(error.data.reason, "occurrence_revision_mismatch");
    return true;
  });
});

test("keeps plain-text API errors readable", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => "잘못된 요청입니다.",
  });
  const client = createApiClient("/api");
  await assert.rejects(client.request("/api/example"), /잘못된 요청입니다/);
});
