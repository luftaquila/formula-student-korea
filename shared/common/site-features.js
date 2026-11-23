// Features a deployment can enable through FEATURES, each with the features it
// needs. A deployment names its whole set explicitly; nothing is enabled by
// default and an unknown name or a missing dependency rejects the set.
//
// This file is bundled into browsers and must stay free of Node-only APIs.
const definitions = [
  // Competition team roster (/entry). Every Competition module reads it.
  ["entry", []],
  // Registration desk queue, its kiosk, and the public lookup at /queue.
  ["registration", ["entry", "email"]],
  // Inspection booth queue and its public board at /queue.
  ["queue", ["entry", "email"]],
  ["inspection", ["entry"]],
  ["traffic", ["entry"]],
  ["score", ["entry", "inspection", "traffic"]],
  ["documents", ["entry", "email"]],
  // Supporting runtimes deployed next to Competition.
  ["course", []],
  ["calendar", []],
  ["files", []],
  ["energymeter", []],
  // Email/SMS provider settings and delivery. Registration, Queue, and
  // Documents send through it.
  ["email", []],
];

export const SITE_FEATURES = Object.freeze(Object.fromEntries(
  definitions.map(([name, requires]) => [name, Object.freeze([...requires])]),
));

export const SITE_FEATURE_NAMES = Object.freeze(definitions.map(([name]) => name));

for (const [name, requires] of definitions) {
  for (const required of requires) {
    if (!Object.hasOwn(SITE_FEATURES, required)) {
      throw new Error(`Feature ${name} requires unknown feature ${required}`);
    }
  }
}

export function isSiteFeature(name) {
  return Object.hasOwn(SITE_FEATURES, name);
}

// Parses a comma-separated FEATURES value into the catalog order.
export function parseSiteFeatures(raw) {
  const requested = String(raw ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (!requested.length) throw new Error("FEATURES must name at least one feature");

  const unknown = requested.filter((name) => !isSiteFeature(name));
  if (unknown.length) throw new Error(`FEATURES has unknown features: ${unknown.join(", ")}`);

  const enabled = new Set(requested);
  const missing = [];
  for (const name of enabled) {
    for (const required of SITE_FEATURES[name]) {
      if (!enabled.has(required)) missing.push(`${name} requires ${required}`);
    }
  }
  if (missing.length) throw new Error(`FEATURES is missing dependencies: ${missing.join("; ")}`);

  return Object.freeze(SITE_FEATURE_NAMES.filter((name) => enabled.has(name)));
}
