import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import { createSmsClient } from "../../shared/sms-client.mjs";

process.env.INTERNAL_SECRET = "test-internal-secret";

const CONFIG = Object.freeze({
  naver_cloud_access_key: "access-key",
  naver_cloud_secret_key: "secret-key",
  naver_cloud_sms_service_id: "service-id",
  phone_number_sms_sender: "0212345678",
});

const clients = [];

function client(options) {
  const created = createSmsClient({ refreshMs: 60_000, ...options });
  clients.push(created);
  return created;
}

afterEach(() => {
  while (clients.length) clearTimeout(clients.pop().timer);
});

describe("shared SMS client", () => {
  it("retains a last-known-good config on transient failure and clears it on an incomplete 200", async () => {
    const warnings = [];
    const responses = [
      () => Promise.reject(new Error("email unavailable")),
      () => Promise.resolve({ ok: true, json: async () => ({ ...CONFIG, naver_cloud_secret_key: "" }) }),
    ];
    const sms = client({
      smsConfig: CONFIG,
      fetchImpl: () => responses.shift()(),
      logger: { warn: (...args) => warnings.push(args) },
    });

    assert.equal(sms.isAvailable(), true);
    assert.equal(await sms.loadConfig(), false);
    assert.equal(sms.isAvailable(), true, "a transient Email outage must preserve the last config");
    assert.equal(await sms.loadConfig(), false);
    assert.equal(sms.isAvailable(), false, "an incomplete authoritative response clears stale credentials");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][1], "sms.config_fetch");
  });

  it("signs and sends the Naver SENS request through the injected transport", async () => {
    let requestOptions;
    let requestBody;
    const smsRequest = (options, callback) => {
      requestOptions = options;
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.write = (body) => { requestBody = body; };
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 202;
        callback(response);
        queueMicrotask(() => {
          response.emit("data", "accepted");
          response.emit("end");
        });
      };
      return request;
    };
    const sms = client({ smsConfig: CONFIG, smsRequest });

    assert.deepEqual(await sms.send("01012345678", "test message"), {
      status: 202,
      response: "accepted",
    });
    assert.equal(requestOptions.hostname, "sens.apigw.ntruss.com");
    assert.equal(requestOptions.path, "/sms/v2/services/service-id/messages");
    const timestamp = requestOptions.headers["x-ncp-apigw-timestamp"];
    const expectedSignature = crypto.createHmac("sha256", CONFIG.naver_cloud_secret_key)
      .update(`POST ${requestOptions.path}\n${timestamp}\n${CONFIG.naver_cloud_access_key}`)
      .digest("base64");
    assert.equal(requestOptions.headers["x-ncp-apigw-signature-v2"], expectedSignature);
    assert.deepEqual(JSON.parse(requestBody), {
      type: "SMS",
      from: CONFIG.phone_number_sms_sender,
      content: "test message",
      messages: [{ to: "01012345678" }],
    });
  });

  it("rejects a timed-out transport exactly once with an auditable code", async () => {
    const smsRequest = () => {
      const request = new EventEmitter();
      request.setTimeout = (_timeout, callback) => callback();
      request.destroy = () => request.emit("error", new Error("destroyed"));
      request.write = () => {};
      request.end = () => {};
      return request;
    };
    const sms = client({ smsConfig: CONFIG, smsRequest });
    await assert.rejects(sms.send("01012345678", "test"), (error) => error.code === "SMS_TIMEOUT");
  });
});
