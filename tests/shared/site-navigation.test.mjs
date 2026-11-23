import assert from "node:assert/strict";
import test from "node:test";

import { administration, operations, resources, services, siteNavigation } from "../../shared/browser/nav-config.js";
import { parseSiteConfig } from "../../shared/common/site-config.js";
import { SITE_FEATURE_NAMES } from "../../shared/common/site-features.js";

function site(features, links) {
  return parseSiteConfig({
    SITE_NAME: "Example",
    SITE_SHORT_NAME: "EX",
    PUBLIC_URL: "https://example.org",
    FEATURES: features.join(","),
    SITE_LINKS: JSON.stringify(links || []),
  });
}

const hrefs = (items) => items.map(({ href }) => href);

test("a deployment with every feature keeps the whole menu", () => {
  const navigation = siteNavigation(site(SITE_FEATURE_NAMES));
  assert.deepEqual(navigation.services, services);
  assert.deepEqual(navigation.resources, resources);
  assert.deepEqual(navigation.operations, operations);
  assert.deepEqual(navigation.administration, administration);
});

test("items of disabled features leave the menu", () => {
  const registration = siteNavigation(site(["entry", "registration", "email"]));
  assert.deepEqual(hrefs(registration.services), ["/", "/queue"]);
  assert.deepEqual(registration.resources, []);
  assert.deepEqual(hrefs(registration.administration), ["/entry", "/email", "/auth/logs", "/auth"]);

  const documents = siteNavigation(site(["entry", "documents", "email"]));
  assert.deepEqual(hrefs(documents.services), ["/", "/documents"]);

  const calendarOnly = siteNavigation(site(["calendar"]));
  assert.deepEqual(hrefs(calendarOnly.resources), ["/calendar"]);
  assert.deepEqual(hrefs(calendarOnly.administration), ["/auth/logs", "/auth"]);
});

test("an unconfigured deployment keeps the FSK reference links after the calendar", () => {
  const navigation = siteNavigation(parseSiteConfig({}));
  assert.deepEqual(hrefs(navigation.resources), [
    "/calendar",
    "https://fsk-energymeter.luftaquila.io/",
    "https://ksae-notice.luftaquila.io",
    "https://ksae-qna.luftaquila.io",
    "https://luftaquila.github.io/fsk-rules/",
    "https://dnf.luftaquila.io",
  ]);
  assert.ok(navigation.resources.slice(1).every(({ external }) => external));
  assert.equal(navigation.resources.at(-1).icon, "forum");
});

test("deployment links follow the internal resources and open off-site links in a new tab", () => {
  const navigation = siteNavigation(site(["calendar"], [
    { name: "에너지미터", href: "https://meter.example.org/", icon: "energy" },
    { name: "규정", href: "/rules/" },
  ]));
  assert.deepEqual(navigation.resources.slice(1), [
    { name: "에너지미터", href: "https://meter.example.org/", icon: "energy", external: true },
    { name: "규정", href: "/rules/", icon: undefined, external: false },
  ]);
});
