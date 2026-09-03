export const HUMAN_ROLES = Object.freeze(["student", "official", "admin"]);

const definitions = [
  ["registration.operate", "등록 대기 운영", "등록 대기열 조회, 완료, 취소와 설정 조회"],
  ["registration.manage", "등록 대기 관리", "수동 접수와 등록 대기 설정 변경", ["registration.operate"]],
  ["queue.operate", "검차 대기 운영", "대기열, 페널티, 부스와 통계 운영"],
  ["queue.manage", "검차 대기 관리", "수동 접수, 우선순위, 초기화와 설정 변경", ["queue.operate"]],
  ["inspection.operate", "인스펙션 운영", "검차표 조회와 답변, 메모, 판정 입력"],
  ["inspection.manage", "인스펙션 관리", "검차표 템플릿 생성, 변경, 삭제와 가져오기", ["inspection.operate"]],
  ["documents.operate", "서류 검토", "서류 제출 현황과 제출 파일 검토"],
  ["documents.manage", "서류 관리", "제출 세션, 학생 매핑과 파일 변경·삭제", ["documents.operate"]],
  ["files.access", "파일 클라우드", "운영 파일 브라우저 접근"],
  ["calendar.manage", "일정 관리", "대회 일정 생성, 변경과 삭제"],
  ["course.operate", "코스 운영", "코스, 콘, 경로와 메모 편집"],
  ["course.manage", "코스 관리", "코스 스냅샷 복원과 코스 삭제", ["course.operate"]],
  ["rover.operate", "Rover 운영", "Rover, 카메라, GPS와 미션 운영", ["course.operate"]],
  ["traffic.operate", "계측 운영", "실시간 계측과 일반 기록 운영"],
  ["traffic.manage", "계측 관리", "계측 설정, 매핑과 전체 기록·로그 삭제", ["traffic.operate"]],
  ["score.operate", "성적 운영", "집계, 수동 점수와 내구 성적 입력"],
  ["score.manage", "성적 관리", "페널티, 설정과 성적 공개 변경", ["score.operate"]],
  ["entry.manage", "엔트리 관리", "팀과 차량 유형 관리"],
  ["messaging.operate", "메시지 운영", "이메일·SMS 발송, 테스트, 통계와 로그 조회"],
  ["audit.view", "감사 로그 조회", "서비스 감사 로그 조회"],
];

export const PERMISSION_DEFINITIONS = Object.freeze(definitions.map(([key, label, description, implies = []]) =>
  Object.freeze({ key, label, description, implies: Object.freeze(implies) })));

export const PERMISSION_KEYS = Object.freeze(PERMISSION_DEFINITIONS.map(({ key }) => key));
const permissionKeySet = new Set(PERMISSION_KEYS);

for (const permission of PERMISSION_DEFINITIONS) {
  for (const implied of permission.implies) {
    if (!permissionKeySet.has(implied)) throw new Error(`Unknown implied permission: ${implied}`);
  }
}

const permissionByKey = new Map(PERMISSION_DEFINITIONS.map((permission) => [permission.key, permission]));
const tieredControls = [
  ["registration", "등록 대기", "registration.operate", "registration.manage"],
  ["queue", "검차 대기", "queue.operate", "queue.manage"],
  ["inspection", "인스펙션", "inspection.operate", "inspection.manage"],
  ["documents", "서류", "documents.operate", "documents.manage"],
  ["traffic", "계측", "traffic.operate", "traffic.manage"],
];
const toggleControls = [
  ["course", "코스 관리", "course.manage", "코스 편집, 스냅샷 복원과 코스 삭제"],
  ["score", "성적 관리", "score.manage", "성적 입력, 페널티·배점 설정과 공개 관리"],
  ["files", "파일 클라우드", "files.access"],
  ["calendar", "일정 관리", "calendar.manage"],
  ["rover", "Rover 운영", "rover.operate", "Rover, 카메라, GPS와 미션 운영 (코스 운영 포함)"],
  ["entry", "엔트리 관리", "entry.manage"],
  ["messaging", "이메일/SMS 운영", "messaging.operate"],
  ["audit", "감사 로그 조회", "audit.view"],
];

export const ACCESS_CONTROL_DEFINITIONS = Object.freeze([
  ...tieredControls.map(([key, label, operatePermission, managePermission]) => Object.freeze({
    key,
    label,
    type: "tiered",
    operate: permissionByKey.get(operatePermission),
    manage: permissionByKey.get(managePermission),
  })),
  ...toggleControls.map(([key, label, permission, description]) => Object.freeze({
    key,
    label,
    type: "toggle",
    permission,
    description: description || permissionByKey.get(permission).description,
  })),
]);

export function isHumanRole(role) {
  return HUMAN_ROLES.includes(role);
}

export function assertPermissionKey(key) {
  if (!permissionKeySet.has(key)) throw new Error(`Unknown permission: ${key}`);
  return key;
}

export function normalizeAccessGrants(grants = []) {
  if (!Array.isArray(grants)) throw new Error("Permission grants must be an array");
  const normalized = new Set(grants.map(assertPermissionKey));
  for (const [, , operatePermission, managePermission] of tieredControls) {
    if (normalized.has(managePermission)) normalized.delete(operatePermission);
  }
  for (const service of ["course", "score"]) {
    if (normalized.delete(`${service}.operate`)) normalized.add(`${service}.manage`);
  }
  return [...normalized].sort();
}

export function expandPermissions(grants = []) {
  const effective = new Set(grants.map(assertPermissionKey));

  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of PERMISSION_DEFINITIONS) {
      if (!effective.has(definition.key)) continue;
      for (const implied of definition.implies) {
        if (!effective.has(implied)) {
          effective.add(implied);
          changed = true;
        }
      }
    }
  }
  return [...effective].sort();
}

export function accessCatalog() {
  return {
    roles: HUMAN_ROLES,
    permissions: PERMISSION_DEFINITIONS,
    accessControls: ACCESS_CONTROL_DEFINITIONS,
  };
}

export const DEVICE_SCOPES = Object.freeze(["kiosk.queue.register", "kiosk.registration.register"]);
const deviceScopeSet = new Set(DEVICE_SCOPES);

export const access = Object.freeze({
  authenticated: Object.freeze({ authenticated: true }),
  student: Object.freeze({ humanRoles: Object.freeze(["student"]) }),
  official: Object.freeze({ humanRoles: Object.freeze(["official", "admin"]) }),
  admin: Object.freeze({ humanRoles: Object.freeze(["admin"]) }),
  internal: Object.freeze({ internal: true }),
  deny: Object.freeze({ deny: true }),
  permission(key) {
    return Object.freeze({ permission: assertPermissionKey(key) });
  },
  device(scope) {
    if (!deviceScopeSet.has(scope)) throw new Error(`Unknown device scope: ${scope}`);
    return Object.freeze({ deviceScope: scope });
  },
  anyOf(...requirements) {
    return Object.freeze({ anyOf: Object.freeze(requirements) });
  },
});

export function principalHasPermission(principal, permission) {
  assertPermissionKey(permission);
  if (principal?.kind !== "human") return false;
  if (principal.role === "admin") return true;
  return principal.role === "official" && Array.isArray(principal.permissions)
    && principal.permissions.includes(permission);
}

export function authorizePrincipal(principal, requirement) {
  if (!requirement) return true;
  if (requirement.anyOf) return requirement.anyOf.some((item) => authorizePrincipal(principal, item));
  if (requirement.deny) return false;
  if (requirement.internal) return principal?.kind === "internal";
  if (requirement.authenticated) return principal?.kind === "human" && isHumanRole(principal.role);
  if (requirement.humanRoles) return principal?.kind === "human" && requirement.humanRoles.includes(principal.role);
  if (requirement.permission) return principalHasPermission(principal, requirement.permission);
  if (requirement.deviceScope) return principal?.kind === "device" && principal.scope === requirement.deviceScope;
  return false;
}
