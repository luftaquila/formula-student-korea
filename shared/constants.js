export const ROLE_LEVELS = { student: 1, official: 2, chief: 3, admin: 4 };
// 경기 종목. "내구"는 단일 센서 멀티랩 라이브 타이밍 — 기록은 총합 시간 1건에 랩을 이어붙여
// 저장한다(EnduranceView/서버 기록 엔진). 단, score 서비스는 내구를 traffic 기록에서 제외하고
// score_endurance(수동 입력)로 별도 채점하므로 여기 추가해도 성적과는 연동되지 않는다.
export const EVENT_TYPES = ["가속", "스키드패드", "오토크로스", "내구"];
// 경기 결과 판정. null은 정상 완주를 뜻하며, 이 세 값은 Traffic의 시도별 판정과
// Score의 내구 팀 판정이 같은 철자/의미를 공유하도록 단일 소스로 둔다.
export const RESULT_STATUSES = Object.freeze(["DNS", "DNF", "DSQ"]);
// 차량 유형 색상. entry 백엔드 검증과 프론트 색상 선택기가 공유.
export const VEHICLE_COLORS = ["blue", "green", "orange", "purple", "red", "teal"];
