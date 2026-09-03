import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { TEST_USERS, getAuthCookie, BASE_URL } from "./auth.mjs";

const headers = (role = "admin") => ({
  "Content-Type": "application/json",
  Cookie: getAuthCookie(role),
});

async function api(method, path, body, role = "admin", expectedStatus = 200) {
  const opts = { method, headers: headers(role) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  if (res.status !== expectedStatus) {
    const detail = await res.text();
    throw new Error(`[seed] ${method} ${path}: expected ${expectedStatus}, got ${res.status}: ${detail}`);
  }
  return res;
}

export async function seedUsers() {
  // Admin is auto-created via ADMIN_EMAIL env var.
  // Create every non-bootstrap test user.
  for (const [profile, user] of Object.entries(TEST_USERS)) {
    if (profile === "admin") continue;
    const created = await api("POST", "/auth/api/users", { email: user.email, role: user.role }, "admin", 201);
    const { id } = await created.json();
    if (user.role === "official" && user.grants.length > 0) {
      await api("PUT", `/auth/api/users/${id}/access`, {
        expectedRevision: 0,
        grants: user.grants,
      });
    }
  }
  // Extra student for documents admin dropdown test (student-team mapping)
  await api("POST", "/auth/api/users", { email: "e2e-student2@test.com", role: "student" }, "admin", 201);
}

export async function seedVehicleTypes() {
  const year = currentCompetitionYear();
  await api("POST", `/competition/api/v1/vehicle-types?year=${year}`, { name: "EV" }, "admin", 201);
  await api("POST", `/competition/api/v1/vehicle-types?year=${year}`, { name: "CV" }, "admin", 201);
}

async function canonicalEntry(entry, year) {
  const types = await (await api("GET", `/competition/api/v1/vehicle-types?year=${year}`)).json();
  return {
    number: entry.num,
    university: entry.univ,
    name: entry.team,
    vehicleTypeId: types.find((type) => type.name === entry.type)?.id ?? null,
  };
}

export async function seedEntries() {
  const year = currentCompetitionYear();
  const entries = [
    { num: 1, univ: "서울대학교", team: "SNU Racing", type: "EV" },
    { num: 2, univ: "한양대학교", team: "ACES", type: "EV" },
    { num: 3, univ: "성균관대학교", team: "SKKU Racing", type: "CV" },
    { num: 10, univ: "KAIST", team: "RUN", type: "EV" },
    { num: 20, univ: "고려대학교", team: "KURF", type: "CV" },
    { num: 30, univ: "부산대학교", team: "PNU Racing", type: "EV" },
    { num: 31, univ: "연세대학교", team: "Yonsei Racing", type: "CV" },
    { num: 32, univ: "중앙대학교", team: "CAU Speed", type: "EV" },
  ];
  for (const entry of entries) {
    await api("POST", `/competition/api/v1/teams?year=${year}`, await canonicalEntry(entry, year), "admin", 201);
  }
}

export async function seedInspectionEntries() {
  const year = currentCompetitionYear();
  const entries = [
    { num: 7, univ: "검차검증대학교", team: "Validation Team", type: "EV" },
    { num: 28, univ: "검차신뢰성대학교", team: "Reliability Team", type: "EV" },
    { num: 98, univ: "검차권한대학교", team: "RBAC Team", type: "CV" },
  ];
  for (const entry of entries) {
    await api("POST", `/competition/api/v1/teams?year=${year}`, await canonicalEntry(entry, year), "admin", 201);
  }
}

export async function seedQueueEntries() {
  const year = currentCompetitionYear();
  const entries = [
    { num: 95, univ: "E2E Queue Status", team: "Queue Status", type: "EV" },
    { num: 96, univ: "E2E Queue State", team: "Queue State", type: "EV" },
    { num: 97, univ: "E2E Queue Booth", team: "Queue Booth", type: "EV" },
  ];
  for (const entry of entries) {
    await api("POST", `/competition/api/v1/teams?year=${year}`, await canonicalEntry(entry, year), "admin", 201);
  }
}

export async function seedCrossServiceEntries() {
  const year = currentCompetitionYear();
  const entry = {
    num: 800,
    univ: "코너웨이트대학교",
    team: "Corner Weight",
    type: "EV",
  };
  await api("POST", `/competition/api/v1/teams?year=${year}`, await canonicalEntry(entry, year), "admin", 201);
}

export async function seedInspectionTemplate() {
  const year = currentCompetitionYear();
  const template = [
    {
      name: "전기 검차",
      remarks: "전기 시스템 검사",
      pdf_include: 1,
      subcategories: [
        {
          name: "배터리",
          remarks: "",
          groups: [
            {
              name: "배터리 팩",
              remarks: "",
              items: [
                { name: "절연 저항 측정", answer_type: "number", unit: "MΩ" },
                { name: "전압 확인", answer_type: "passfail" },
                { name: "고정 상태", answer_type: "passfail" },
                { name: "시리얼 넘버", answer_type: "text" },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "샤시 검차",
      remarks: "차체 구조 검사",
      pdf_include: 1,
      subcategories: [
        {
          name: "프레임",
          remarks: "",
          groups: [
            {
              name: "롤바",
              remarks: "",
              items: [
                { name: "높이 측정", answer_type: "number", unit: "mm" },
                { name: "용접 상태", answer_type: "passfail" },
                { name: "점검 체크리스트", answer_type: "checktable", remarks: '{"columns":["증빙자료","현장확인"],"rows":["사전검토","현장검토"]}' },
              ],
            },
          ],
        },
      ],
    },
  ];
  await api("POST", "/competition/api/v1/inspection/sheet/template/import", { year, template }, "admin", 201);
}

export async function seedDocuments() {
  const year = currentCompetitionYear();
  // Map student user to team 1
  await api("POST", "/competition/api/v1/documents/admin/student-teams", {
    email: TEST_USERS.student.email,
    team_num: 1,
    year,
  }, "operationsManager", 201);

  // Create a submission session
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000); // yesterday
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // next week
  const lateEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000); // day after end

  const fmt = (d) => d.toISOString().slice(0, 16).replace("T", " ");

  await api("POST", "/competition/api/v1/documents/admin/sessions", {
    name: "E2E 테스트 세션",
    notice: "테스트용 제출 세션입니다.",
    start_at: fmt(start),
    end_at: fmt(end),
    late_end_at: fmt(lateEnd),
    max_file_size: 10485760,
    allowed_extensions: "pdf,docx,xlsx",
    year,
    teams: [1, 2, 3],
  }, "operationsManager", 201);
}

export async function seedAll() {
  await seedSelected(["users", "vehicle-types", "entries", "inspection", "documents"]);
}

const seeders = {
  users: ["users", seedUsers],
  "vehicle-types": ["vehicle types", seedVehicleTypes],
  entries: ["entries", seedEntries],
  "inspection-entries": ["inspection-only entries", seedInspectionEntries],
  "queue-entries": ["queue-only entries", seedQueueEntries],
  "cross-service-entries": ["cross-service-only entries", seedCrossServiceEntries],
  inspection: ["inspection template", seedInspectionTemplate],
  documents: ["documents", seedDocuments],
};

export async function seedSelected(names, { afterEach } = {}) {
  for (const name of names) {
    const seeder = seeders[name];
    if (!seeder) throw new Error(`[seed] Unknown seed group: ${name}`);
    const [label, run] = seeder;
    console.log(`[seed] Seeding ${label}...`);
    await run();
    await afterEach?.(name);
  }
  console.log("[seed] Seeding complete.");
}
