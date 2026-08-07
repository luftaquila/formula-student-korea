// 서비스 이름 목록 — **브라우저 번들에 들어간다**(auth 로그 뷰어의 서비스 필터).
//
// 이 파일에는 Node 전용 API를 절대 넣지 말 것. `process.env` 읽기 한 줄이면 로그 뷰어가
// 모듈 로드 시점에 `ReferenceError: process is not defined`로 죽는다. 레지스트리 본체
// (`services.mjs`)는 Node 전용이므로, 양쪽이 공유해야 하는 이 배열만 떼어 두어 "브라우저에서
// 안전해야 한다"는 제약이 한눈에 확인되는 크기의 파일에 머물게 한다.
//
// 순서는 로그 뷰어 드롭다운 표시 순서다.
export const SERVICE_NAMES = Object.freeze([
  "auth",
  "entry",
  "queue",
  "inspection",
  "traffic",
  "score",
  "documents",
  "calendar",
  "course",
  "email",
]);
