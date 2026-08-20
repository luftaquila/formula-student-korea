import { SERVICE_NAMES } from "./service-names.js";

// 배포되는 프로세스의 주소만 둔다. Entry/Queue/Registration/Inspection/Traffic/Score/Documents는
// Competition 안의 논리 모듈이며 독립 서비스 주소나 포트를 갖지 않는다.
const SERVICE_PORTS = {
  auth: 9100,
  competition: 9200,
  calendar: 11000,
  course: 10000,
  email: 9900,
};
export const RUNTIME_SERVICE_NAMES = Object.freeze(Object.keys(SERVICE_PORTS));

// compose·k3s 모두 서비스 이름이 곧 DNS 이름이므로 이름에서 URL을 만든다.
const SERVICE_URLS = Object.fromEntries(
  Object.entries(SERVICE_PORTS).map(([name, port]) => [name, `http://${name}:${port}`]),
);

export { SERVICE_NAMES };

// 리슨 포트의 단일 소스. 각 서비스 index.mjs가 자기 PORT 상수를 중복 정의하면
// 여기(inter-service URL)와 어긋나는 드리프트가 가능하다 — 부팅 블록은 이걸 쓴다.
export function servicePort(name) {
  const port = SERVICE_PORTS[name];
  if (!port) throw new Error(`Unknown service: ${name}`);
  return port;
}

// `<NAME>_SERVER` env는 override 전용이다. 테스트(임시 포트의 mock 서버)와 컨테이너
// 밖 로컬 실행에서만 쓰이며, 설정하지 않아도 컨테이너 배포는 정상 동작한다.
// env는 호출 시점에 읽는다 — 테스트가 app 팩토리 호출 직전에 env를 설정한다.
export function serviceUrl(name) {
  const url = process.env[`${name.toUpperCase()}_SERVER`] || SERVICE_URLS[name];
  if (!url) throw new Error(`Unknown service: ${name}`);
  return url;
}

// 집계기가 경로 규칙을 다시 추론하지 않도록 실제 로그 엔드포인트를 반환한다.
// 논리 모듈 이름은 유지하지만 Competition 모듈은 하나의 런타임으로 향한다.
export function logAggregationTargets() {
  const competitionModules = {
    entry: "",
    queue: "queue",
    registration: "registration",
    inspection: "inspection",
    traffic: "traffic",
    score: "score",
    documents: "documents",
  };
  return Object.fromEntries(
    SERVICE_NAMES
      .filter((name) => name !== "auth")
      .map((name) => [
        name,
        Object.hasOwn(competitionModules, name)
          ? `${serviceUrl("competition")}/competition/api/v1${competitionModules[name] ? `/${competitionModules[name]}` : ""}/logs`
          : `${serviceUrl(name)}/api/logs`,
      ]),
  );
}
