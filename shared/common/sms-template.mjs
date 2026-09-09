export function smsPrefix(year) {
  return `[FSK ${year}]\n`;
}

export function inspectionLastCallSms({ year, num, inspection }) {
  return `${smsPrefix(year)}${num}번 ${inspection} 검차 지금 즉시 입차하세요.\n미입차시 취소 페널티가 부여됩니다.`;
}

export function inspectionQueueRankSms({ year, num, inspection, rank }) {
  return `${smsPrefix(year)}엔트리 ${num}번 ${inspection} 검차 대기 순서 ${rank}번입니다.\n검차장 앞에서 대기하세요.`;
}

export function registrationQueueRankSms({ year, num, rank }) {
  return `${smsPrefix(year)}엔트리 ${num}번 등록 대기 ${rank}번째입니다. 등록 데스크 근처에서 대기하세요.`;
}

export function smsTestMessage(year) {
  return `${smsPrefix(year)}SMS 전송 테스트입니다.`;
}
