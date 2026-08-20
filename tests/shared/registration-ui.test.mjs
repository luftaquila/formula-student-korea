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
