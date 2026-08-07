// 서비스 간 통신 URL의 단일 소스.
//
// compose와 k3s 매니페스트가 같은 DNS 이름·포트를 쓰므로 이 상수는 모든 배포에서
// 정확하다. 배포 설정에 URL을 중복 정의하면 한쪽만 갱신되는 드리프트가 생기는데,
// 호출부가 env 존재 여부로 대상을 거르던 탓에 그 드리프트가 "조용한 기능 소실"로
// 나타났다 — entry의 lifecycle 팬아웃 대상 셋(inspection/score/traffic)이 k3s
// 매니페스트에서 누락돼 팀 비활성화가 해당 서비스에 영구히 전달되지 않았다.
// 기본값을 코드에 두면 설정 누락 자체가 불가능해진다.
//
// 트레이드오프(불변식이 아니라 의도된 선택): 이 상수는 애플리케이션이 자기 네트워크 토폴로지를
// 코드에 새기는 것 — 단일 네임스페이스 flat DNS, 평문 HTTP, 고정 포트를 전제한다. 네임스페이스가
// 갈리거나 서비스 메시·mTLS로 주소 체계가 바뀌면 매니페스트 한 줄이 아니라 앱 코드 수정 + 전
// 이미지 재빌드가 된다. 게다가 그때는 *틀린* 기본값이 기본값 없음보다 나쁘다 — 부팅 실패 대신
// 엉뚱한 대상에 성공적으로 연결되기 때문이다. 아래 env override가 그 탈출구를 열어둔다.
//
// "배포 설정의 URL은 정보를 전달하지 않았다"는 근거는 **전체 스택을 띄우는 배포**에만
// 해당한다. 부분 스택에서는 env가 실제로 정보였다 — 같은 클러스터의 `apps/ev`는 auth와
// queue만 띄우면서 auth의 LOG_SERVICES를 "queue:..." 하나로 좁혀 놨다. 그 배포는 별도
// 저장소에서 빌드되므로 여기서 깨지는 건 없지만, 이 파일의 전제가 어디까지 유효한지는
// 명시해 둔다: logAggregationTargets()가 레지스트리에서 파생되므로, 부분 스택으로 이
// 코드를 쓰면 없는 서비스로 집계를 시도해 logs.aggregate_failed가 영구히 쌓인다.
// 키를 추가하면 그 서비스는 자동으로 로그 집계 대상이 된다(logAggregationTargets).
// 따라서 여기 등록하는 서비스는 `/api/logs`를 제공해야 한다 — 아니면 로그 뷰어에
// 영구적인 logs.aggregate_failed가 남는다.
const SERVICE_URLS = {
  auth: "http://auth:9100",
  entry: "http://entry:9200",
  queue: "http://queue:9300",
  inspection: "http://inspection:9400",
  traffic: "http://traffic:9500",
  score: "http://score:9600",
  documents: "http://documents:9700",
  email: "http://email:9900",
  course: "http://course:10000",
  calendar: "http://calendar:11000",
};

// `<NAME>_SERVER` env는 override 전용이다. 테스트(임시 포트의 mock 서버)와 컨테이너
// 밖 로컬 실행에서만 쓰이며, 설정하지 않아도 컨테이너 배포는 정상 동작한다.
// env는 호출 시점에 읽는다 — 테스트가 app 팩토리 호출 직전에 env를 설정한다.
export function serviceUrl(name) {
  const url = process.env[`${name.toUpperCase()}_SERVER`] || SERVICE_URLS[name];
  if (!url) throw new Error(`Unknown service: ${name}`);
  return url;
}

// auth의 로그 뷰어가 집계하는 원격 대상. auth 자신은 로컬 DB를 직접 조회하므로 뺀다.
// 같은 이유로 코드에 둔다 — 배포 설정에 서비스 목록을 중복 정의하면 새 서비스를 한쪽에만
// 추가했을 때 그 서비스 로그가 뷰어에서 조용히 사라진다.
export function logAggregationTargets() {
  return Object.fromEntries(
    Object.keys(SERVICE_URLS)
      .filter((name) => name !== "auth")
      .map((name) => [name, serviceUrl(name)]),
  );
}
