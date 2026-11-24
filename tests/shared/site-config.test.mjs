import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  DEFAULT_OG_IMAGE_ALT, SITE_DEFAULTS, browserSiteConfig, parseSiteConfig, renderEnvConfig,
} from "../../shared/common/site-config.js";
import { SITE_FEATURE_NAMES, parseSiteFeatures } from "../../shared/common/site-features.js";

const BASE_ENV = Object.freeze({
  SITE_NAME: "Example Student Korea",
  SITE_SHORT_NAME: "ESK",
  PUBLIC_URL: "https://esk.example.org",
  FEATURES: "entry,documents,email",
  SITE_LINKS: "[]",
});

test("an unconfigured deployment is the Formula Student Korea service with every feature", () => {
  const site = parseSiteConfig({});
  assert.equal(site.name, "Formula Student Korea");
  assert.equal(site.shortName, "FSK");
  assert.equal(site.publicUrl, "https://fsk.luftaquila.io");
  assert.deepEqual(site.features, SITE_FEATURE_NAMES);
  assert.deepEqual(site.links.map(({ name }) => name),
    ["에너지미터", "공지 알림봇", "자작차 AI 챗봇", "대회 규정집", "자작자동차포럼"]);
  assert.equal(site.ogImage, null);
  assert.equal(site.ogImageAlt, DEFAULT_OG_IMAGE_ALT);

  // Empty and blank values are unset, as an empty ConfigMap entry would be.
  const blank = Object.fromEntries(Object.keys(SITE_DEFAULTS).map((key) => [key, "  "]));
  const fromBlank = parseSiteConfig({ ...blank, SITE_OG_IMAGE: "" });
  assert.deepEqual(browserSiteConfig(fromBlank), browserSiteConfig(site));
  assert.equal(fromBlank.publicUrl, site.publicUrl);
});

test("a deployment overrides its identity and features", () => {
  const site = parseSiteConfig(BASE_ENV);
  assert.equal(site.name, "Example Student Korea");
  assert.equal(site.shortName, "ESK");
  assert.equal(site.publicUrl, "https://esk.example.org");
  assert.deepEqual(site.features, ["entry", "documents", "email"]);
  assert.deepEqual(site.links, []);
  assert.equal(site.has("documents"), true);
  assert.equal(site.has("queue"), false);
  assert.throws(() => site.has("queues"), /Unknown feature: queues/);
  assert.ok(Object.isFrozen(site) && Object.isFrozen(site.features));

  // Variables left unset keep their own defaults.
  const named = parseSiteConfig({ SITE_NAME: "EV Student Korea", SITE_SHORT_NAME: "EV" });
  assert.equal(named.name, "EV Student Korea");
  assert.deepEqual(named.features, SITE_FEATURE_NAMES);
});

test("the link-preview image is replaced by an absolute URL and described by the site name", () => {
  const site = parseSiteConfig({ ...BASE_ENV, SITE_OG_IMAGE: "https://cdn.example.org/esk.png" });
  assert.equal(site.ogImage, "https://cdn.example.org/esk.png");
  assert.equal(site.ogImageAlt, "Example Student Korea");
  for (const value of ["/og-image.png", "ftp://cdn.example.org/esk.png", "https://user:pw@cdn.example.org/a.png"]) {
    assert.throws(() => parseSiteConfig({ ...BASE_ENV, SITE_OG_IMAGE: value }), /SITE_OG_IMAGE/, value);
  }
});

test("PUBLIC_URL is a bare http(s) origin", () => {
  assert.equal(parseSiteConfig({ ...BASE_ENV, PUBLIC_URL: "http://localhost:9000/" }).publicUrl,
    "http://localhost:9000");
  for (const value of ["esk.example.org", "ftp://esk.example.org", "https://esk.example.org/hub",
    "https://user:pass@esk.example.org", "https://esk.example.org/?a=1"]) {
    assert.throws(() => parseSiteConfig({ ...BASE_ENV, PUBLIC_URL: value }), /PUBLIC_URL/, value);
  }
});

test("features are validated against the catalog and its dependencies", () => {
  assert.deepEqual(parseSiteFeatures(" email , entry,registration,entry "), ["entry", "registration", "email"]);
  assert.deepEqual(parseSiteFeatures(SITE_FEATURE_NAMES.join(",")), SITE_FEATURE_NAMES);
  assert.throws(() => parseSiteFeatures("entry,inspections"), /unknown features: inspections/);
  assert.throws(() => parseSiteFeatures("registration"),
    /registration requires entry; registration requires email/);
  assert.throws(() => parseSiteFeatures("entry,score,inspection"), /score requires traffic/);
  assert.throws(() => parseSiteFeatures(" , "), /at least one feature/);
});

test("queue SMS keeps the short name within the SMS byte budget", () => {
  const sms = { ...BASE_ENV, FEATURES: "entry,registration,email" };
  assert.equal(parseSiteConfig({ ...sms, SITE_SHORT_NAME: "자율주행" }).shortName, "자율주행");
  assert.equal(parseSiteConfig({ ...sms, SITE_SHORT_NAME: "ABCDEFGH" }).shortName, "ABCDEFGH");
  assert.throws(() => parseSiteConfig({ ...sms, SITE_SHORT_NAME: "자율주행K" }), /8 SMS bytes/);
  // Without queue SMS, email subjects and titles accept longer names.
  assert.equal(parseSiteConfig({ ...BASE_ENV, SITE_SHORT_NAME: "자율주행 포뮬러" }).shortName, "자율주행 포뮬러");
});

test("menu links are validated and keep their order", () => {
  const links = [
    { name: " 에너지미터 ", href: "https://meter.example.org/", icon: "energy" },
    { name: "규정집", href: "/rules/" },
  ];
  const site = parseSiteConfig({ ...BASE_ENV, SITE_LINKS: JSON.stringify(links) });
  assert.deepEqual(site.links, [
    { name: "에너지미터", href: "https://meter.example.org/", icon: "energy" },
    { name: "규정집", href: "/rules/", icon: null },
  ]);

  const invalid = [
    ["{", /JSON array/],
    ['{"name":"x"}', /JSON array/],
    ['["x"]', /SITE_LINKS\[0\] must be an object/],
    ['[{"name":"","href":"/x"}]', /name must be a non-empty string/],
    ['[{"name":"x","href":"javascript:alert(1)"}]', /href must be/],
    ['[{"name":"x","href":"//evil.example"}]', /href must be/],
    ['[{"name":"x","href":"/x","icon":"rocket"}]', /icon must be a known navigation icon/],
    ['[{"name":"x","url":"/x"}]', /unknown keys: url/],
  ];
  for (const [value, pattern] of invalid) {
    assert.throws(() => parseSiteConfig({ ...BASE_ENV, SITE_LINKS: value }), pattern, value);
  }
});

test("env-config.js gives browsers the public site fields and the test flag", () => {
  const env = {
    ...BASE_ENV,
    SITE_NAME: 'A "quoted" </script> name',
    SITE_LINKS: '[{"name":"Rules","href":"https://rules.example.org"}]',
    TEST_SERVER: "true",
  };
  const window = {};
  vm.runInNewContext(renderEnvConfig(env), { window });
  assert.equal(window.__TEST_SERVER__, true);
  // The script runs in another realm; compare its data, not its prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(window.__SITE__)), browserSiteConfig(parseSiteConfig(env)));
  assert.deepEqual(Object.keys(window.__SITE__), ["name", "shortName", "features", "links"]);
  assert.equal(window.__SITE__.name, 'A "quoted" </script> name');

  const production = {};
  vm.runInNewContext(renderEnvConfig({ ...BASE_ENV, TEST_SERVER: "false" }), { window: production });
  assert.equal(production.__TEST_SERVER__, false);
  assert.throws(() => renderEnvConfig({ ...BASE_ENV, FEATURES: "entry,maps" }), /unknown features: maps/);

  // Without any site variables the browser receives the defaults.
  const unconfigured = {};
  vm.runInNewContext(renderEnvConfig({}), { window: unconfigured });
  assert.deepEqual(JSON.parse(JSON.stringify(unconfigured.__SITE__)), browserSiteConfig(parseSiteConfig({})));
});
