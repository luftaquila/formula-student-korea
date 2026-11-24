import assert from "node:assert/strict";
import test from "node:test";

import {
  SMS_SHORT_NAME_MAX_BYTES,
  inspectionLastCallSms,
  inspectionQueueRankSms,
  registrationQueueRankSms,
  smsByteLength,
  smsPrefix,
  smsTestMessage,
} from "../../shared/common/sms-template.mjs";
import { INSPECTIONS } from "../../competition/modules/queue/server/constants.mjs";

test("SMS content starts with the deployment's short name and year", () => {
  assert.equal(smsPrefix("FSK", 2026), "[FSK 2026]\n");
  assert.equal(smsPrefix("EV", 2027), "[EV 2027]\n");
});

test("inspection last-call SMS fits the provider limit for a three-digit entry", () => {
  const content = inspectionLastCallSms({ shortName: "FSK", year: 2026, num: 999, inspection: "축전지" });

  assert.equal(
    content,
    "[FSK 2026]\n999번 축전지 검차 지금 즉시 입차하세요.\n미입차시 취소 페널티가 부여됩니다.",
  );
  assert.equal(smsByteLength(content), 85);
});

test("every runtime SMS template uses the same year-prefixed first line", () => {
  const messages = [
    inspectionQueueRankSms({ shortName: "FSK", year: 2026, num: 999, inspection: "축전지", rank: 10 }),
    registrationQueueRankSms({ shortName: "FSK", year: 2026, num: 999, rank: 10 }),
    smsTestMessage("FSK", 2026),
  ];

  assert.deepEqual(messages, [
    "[FSK 2026]\n엔트리 999번 축전지 검차 대기 순서 10번입니다.\n검차장 앞에서 대기하세요.",
    "[FSK 2026]\n엔트리 999번 등록 대기 10번째입니다. 등록 데스크 근처에서 대기하세요.",
    "[FSK 2026]\nSMS 전송 테스트입니다.",
  ]);
});

test("the longest allowed short name keeps every queue SMS within 90 bytes", () => {
  const shortName = "가".repeat(SMS_SHORT_NAME_MAX_BYTES / 2);
  assert.equal(smsByteLength(shortName), SMS_SHORT_NAME_MAX_BYTES);
  const messages = [
    registrationQueueRankSms({ shortName, year: 2026, num: 999, rank: 99 }),
    smsTestMessage(shortName, 2026),
    ...Object.values(INSPECTIONS).flatMap((inspection) => [
      inspectionLastCallSms({ shortName, year: 2026, num: 999, inspection }),
      inspectionQueueRankSms({ shortName, year: 2026, num: 999, inspection, rank: 99 }),
    ]),
  ];
  assert.ok(messages.every((message) => smsByteLength(message) <= 90),
    messages.map((message) => `${smsByteLength(message)} ${message}`).join("\n"));
  const longest = Math.max(...messages.map(smsByteLength));
  assert.equal(longest, 90, "the budget leaves no unused bytes");
});
