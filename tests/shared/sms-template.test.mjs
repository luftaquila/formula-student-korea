import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectionLastCallSms,
  inspectionQueueRankSms,
  registrationQueueRankSms,
  smsPrefix,
  smsTestMessage,
} from "../../shared/sms-template.mjs";

function eucKrByteLength(value) {
  return [...value].reduce((bytes, character) => (
    bytes + (character.codePointAt(0) <= 0x7f ? 1 : 2)
  ), 0);
}

test("SMS content starts with a year-prefixed line", () => {
  assert.equal(smsPrefix(2026), "[FSK 2026]\n");
});

test("inspection last-call SMS fits the provider limit for a three-digit entry", () => {
  const content = inspectionLastCallSms({ year: 2026, num: 999, inspection: "축전지" });

  assert.equal(
    content,
    "[FSK 2026]\n999번 축전지 검차 지금 즉시 입차하세요.\n미입차시 취소 페널티가 부여됩니다.",
  );
  assert.equal(eucKrByteLength(content), 85);
  assert.ok(eucKrByteLength(content) <= 90);
});

test("every runtime SMS template uses the same year-prefixed first line", () => {
  const messages = [
    inspectionQueueRankSms({ year: 2026, num: 999, inspection: "축전지", rank: 10 }),
    registrationQueueRankSms({ year: 2026, num: 999, rank: 10 }),
    smsTestMessage(2026),
  ];

  assert.deepEqual(messages, [
    "[FSK 2026]\n엔트리 999번 축전지 검차 대기 순서 10번입니다.\n검차장 앞에서 대기하세요.",
    "[FSK 2026]\n엔트리 999번 등록 대기 10번째입니다. 등록 데스크 근처에서 대기하세요.",
    "[FSK 2026]\nSMS 전송 테스트입니다.",
  ]);
  assert.ok(messages.every((message) => eucKrByteLength(message) <= 90));
});
