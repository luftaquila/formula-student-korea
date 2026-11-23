// Every SMS starts with the deployment's short name and the competition year.
//
// SENS rejects an SMS above 90 bytes (ASCII 1 byte, Korean 2 bytes). The longest
// queue message with a three-digit entry and a two-digit rank leaves this much
// room for the short name, so a deployment that sends queue SMS must fit in it.
export const SMS_SHORT_NAME_MAX_BYTES = 8;

export function smsByteLength(text) {
  return [...String(text)].reduce((bytes, char) => bytes + (char.codePointAt(0) <= 0x7f ? 1 : 2), 0);
}

export function smsPrefix(shortName, year) {
  return `[${shortName} ${year}]\n`;
}

export function inspectionLastCallSms({ shortName, year, num, inspection }) {
  return `${smsPrefix(shortName, year)}${num}번 ${inspection} 검차 지금 즉시 입차하세요.\n미입차시 취소 페널티가 부여됩니다.`;
}

export function inspectionQueueRankSms({ shortName, year, num, inspection, rank }) {
  return `${smsPrefix(shortName, year)}엔트리 ${num}번 ${inspection} 검차 대기 순서 ${rank}번입니다.\n검차장 앞에서 대기하세요.`;
}

export function registrationQueueRankSms({ shortName, year, num, rank }) {
  return `${smsPrefix(shortName, year)}엔트리 ${num}번 등록 대기 ${rank}번째입니다. 등록 데스크 근처에서 대기하세요.`;
}

export function smsTestMessage(shortName, year) {
  return `${smsPrefix(shortName, year)}SMS 전송 테스트입니다.`;
}
