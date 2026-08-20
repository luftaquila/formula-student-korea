import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  admins,
  getIcon,
  officials,
  resources,
  services,
} from "../../shared/nav-config.js";

const registrationRoot = new URL("../../registration/web/", import.meta.url);

async function readRegistrationSource(path) {
  return readFile(new URL(path, registrationRoot), "utf8");
}

function templateOf(source) {
  const start = source.indexOf("<template>");
  const end = source.lastIndexOf("</template>");
  return start >= 0 && end > start ? source.slice(start + "<template>".length, end) : "";
}

test("registration navigation uses distinct queue-style icons and concise labels", () => {
  const registration = services.find((item) => item.href === "/registration");
  const registrationAdmin = officials.find((item) => item.href === "/registration/manage");

  assert.equal(registration?.name, "등록 대기열");
  assert.equal(registrationAdmin?.name, "등록 대기 관리");
  assert.equal(getIcon(registration?.icon), "🎫");
  assert.equal(getIcon(registrationAdmin?.icon), "🎛️");

  const menuItems = [...services, ...resources, ...officials, ...admins];
  const otherIcons = menuItems
    .filter((item) => item !== registration && item !== registrationAdmin)
    .map((item) => getIcon(item.icon));
  assert.equal(otherIcons.includes(getIcon(registration.icon)), false);
  assert.equal(otherIcons.includes(getIcon(registrationAdmin.icon)), false);
});

test("registration pages do not expose service tabs or internal role names", async () => {
  const sources = await Promise.all([
    readRegistrationSource("src/App.vue"),
    readRegistrationSource("src/views/Lookup.vue"),
    readRegistrationSource("src/views/Register.vue"),
    readRegistrationSource("src/views/Manage.vue"),
  ]);
  const visibleMarkup = sources.map(templateOf).join("\n");

  assert.doesNotMatch(visibleMarkup, /학회/);
  assert.doesNotMatch(visibleMarkup, /(^|[^A-Za-z])(Chief|Official)([^A-Za-z]|$)/);
  assert.doesNotMatch(visibleMarkup, /registration-tabs/);
  assert.match(templateOf(sources[0]), /class="logo-icon"/);
  assert.match(templateOf(sources[0]), /FSK \{\{ getPageTitle\(\) \}\}/);
});

test("registration user interfaces stay on the current competition year", async () => {
  const [lookup, register] = await Promise.all([
    readRegistrationSource("src/views/Lookup.vue"),
    readRegistrationSource("src/views/Register.vue"),
  ]);

  assert.match(lookup, /currentCompetitionYear\(\)/);
  assert.match(register, /currentCompetitionYear\(\)/);
  assert.doesNotMatch(`${lookup}\n${register}`, /fetchYears|대회 연도|year-select/);
});

test("registration kiosk resets immediately without an interstitial guide or completion page", async () => {
  const register = await readRegistrationSource("src/views/Register.vue");
  const markup = templateOf(register);

  assert.doesNotMatch(markup, /등록 안내|대기 등록 완료|countdown|success-card/);
  assert.doesNotMatch(register, /resetTimer|countdownTimer|setInterval/);
  assert.match(register, /reset\(\);\s*success\(`/);
});

test("registration public screens expose only the total wait instead of other called teams", async () => {
  const lookup = await readRegistrationSource("src/views/Lookup.vue");
  const register = await readRegistrationSource("src/views/Register.vue");
  const markup = `${templateOf(lookup)}\n${templateOf(register)}`;

  assert.match(markup, /전체 대기/);
  assert.doesNotMatch(markup, /현재 호출된 엔트리가 없습니다|호출된 엔트리|status\.called/);
});

test("registration operations use a single-step completion flow without call state", async () => {
  const manage = await readRegistrationSource("src/views/Manage.vue");
  const lookup = await readRegistrationSource("src/views/Lookup.vue");
  const api = await readRegistrationSource("src/api.js");

  assert.match(templateOf(manage), />완료<\/button>/);
  assert.doesNotMatch(`${templateOf(manage)}\n${templateOf(lookup)}`, /호출 중|>호출<|바로 완료|호출됨|등록 차례입니다/);
  assert.doesNotMatch(api, /callRegistration|\/call/);
});

test("registration inputs resolve canonical teams immediately without status copy", async () => {
  const register = await readRegistrationSource("src/views/Register.vue");
  const lookup = await readRegistrationSource("src/views/Lookup.vue");
  const api = await readRegistrationSource("src/api.js");
  const markup = `${templateOf(register)}\n${templateOf(lookup)}`;

  assert.match(api, /fetchEntries/);
  assert.match(api, /fetchTeams/);
  assert.match(register, /computed\(\(\) => teams\.value/);
  assert.match(markup, /team\.univ/);
  assert.match(markup, /team\.team/);
  assert.doesNotMatch(register, /checking|lookupTimer|setTimeout|fetchTeam\(/);
  assert.doesNotMatch(api, /export const fetchTeam\b/);
  assert.doesNotMatch(markup, /엔트리 확인 중|이미 대기 중|확인됨|번호를 입력하면 학교와 팀을 확인합니다/);
});

test("registration forms prefill 010 and keep the queue-style minimal result", async () => {
  const register = await readRegistrationSource("src/views/Register.vue");
  const lookup = await readRegistrationSource("src/views/Lookup.vue");
  const markup = `${templateOf(register)}\n${templateOf(lookup)}`;

  assert.match(register, /const phone = ref\("010"\)/);
  assert.match(register, /phone\.value = "010"/);
  assert.match(lookup, /form = ref\(\{ num: "", phone: "010" \}\)/);
  assert.doesNotMatch(register, /\.submit-group[^}]*margin-top:\s*auto/);
  assert.doesNotMatch(markup, /엔트리와 연락처를 입력해 대기열에 등록하세요/);
  assert.doesNotMatch(templateOf(lookup), />대기 중<|다음 차례입니다|앞에 .*팀|result-details|다른 대기 조회|전화번호는 등록할 때|자동으로 업데이트/);
  assert.match(templateOf(lookup), /v-if="notFound \|\| error" class="lookup-message"/);
  assert.match(templateOf(lookup), /result\.position/);
});

test("registration settings use concise labels and a numeric notification rank", async () => {
  const manage = await readRegistrationSource("src/views/Manage.vue");
  const markup = templateOf(manage);

  assert.doesNotMatch(markup, /신규 신청을 열거나 닫습니다|설정한 사전 순번에 안내 문자를 발송합니다|이메일\/SMS 서비스에서 SENS 설정이 필요합니다|해당 순번이 된 팀에 한 번 안내합니다/);
  assert.doesNotMatch(markup, /<select|<option/);
  assert.match(markup, /type="number"/);
  assert.match(markup, /min="1"/);
  assert.match(markup, /max="10"/);
  assert.match(markup, /notifyRank: Number\(\$event\.target\.value\)/);
});
