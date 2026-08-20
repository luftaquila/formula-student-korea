import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { waitForCompetitionAuthentication } from "../e2e/global-setup.mjs";

describe("E2E Competition authentication readiness", () => {
  it("polls the protected endpoint until remote authentication succeeds", async () => {
    const requests = [];
    const sleeps = [];

    await waitForCompetitionAuthentication({
      maxRetries: 3,
      intervalMs: 25,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: requests.length === 2 };
      },
      sleep: async (ms) => sleeps.push(ms),
      log: () => {},
    });

    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/competition\/api\/v1\/logs\?limit=1$/);
    assert.match(requests[0].options.headers.Cookie, /^fsk_session=/);
    assert.deepEqual(sleeps, [25]);
  });

  it("fails after the bounded number of unsuccessful checks", async () => {
    let requests = 0;
    let sleeps = 0;

    await assert.rejects(
      waitForCompetitionAuthentication({
        maxRetries: 3,
        intervalMs: 0,
        fetchImpl: async () => {
          requests += 1;
          throw new Error("temporary failure");
        },
        sleep: async () => { sleeps += 1; },
        log: () => {},
      }),
      /did not become ready in time/,
    );

    assert.equal(requests, 3);
    assert.equal(sleeps, 2);
  });
});
