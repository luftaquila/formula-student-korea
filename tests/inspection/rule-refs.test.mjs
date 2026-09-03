import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createRulesCatalog,
  parseStoredRuleRefs,
  transitionRuleRefs,
  validateRuleRefs,
} from "../../inspection/lib/rule-refs.mjs";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const PDF_HASH = `sha256:${"c".repeat(64)}`;

const SOURCE_COMMIT = "a".repeat(40);
const DOC_DIGEST = `sha256:${"d".repeat(64)}`;

function manifest(overrides = {}, deployment = { site_tag: "site-20260904.1", source_commit: SOURCE_COMMIT }) {
  return {
    schema_version: 2,
    latest_edition: 2026,
    deployment,
    documents: [{
      edition: 2026,
      revision: 2,
      version: "2026-r2",
      release_tag: "formula-technical-2026-r2",
      document_digest: DOC_DIGEST,
      document: "formula-technical",
      title: "차량기술규정",
      short_title: "기술",
      effective_date: "2026-01-01",
      web_path: "2026/formula-technical/",
      pdf_path: "2026/formula-technical/rules.pdf",
      index_path: "2026/formula-technical/rules-index.json",
      source: {
        status: "verified",
        post_id: 1,
        published_date: "2026-01-01",
        post_url: "https://www.ksae.org/jajak/bbs/?number=1",
        pdf_hash: PDF_HASH,
      },
      ...overrides,
    }],
  };
}

function index(rules = []) {
  return { schema_version: 2, edition: 2026, document: "formula-technical", rules };
}

function rule(overrides = {}) {
  return {
    id: "formula-technical-10-9",
    year: 2026,
    edition: 2026,
    document: "formula-technical",
    citation: "제10조 9항",
    text: "제동등을 장착해야 한다.",
    href: "#formula-technical-10-9",
    content_hash: HASH_A,
    rule_key: "formula-technical.brake-light",
    ...overrides,
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function fixtureFetch({ manifestValue = manifest(), indexValue = index([rule()]), calls = [] } = {}) {
  return async (url) => {
    calls.push(String(url));
    return String(url).endsWith("rules-manifest.json") ? jsonResponse(manifestValue) : jsonResponse(indexValue);
  };
}

describe("inspection rule references", () => {
  it("ships a 2026 template with unique stable field keys and schema-valid references", () => {
    const template = JSON.parse(fs.readFileSync(new URL("../../.github/inspection-template-2026.json", import.meta.url)));
    const items = template.flatMap(category => category.subcategories.flatMap(subcategory =>
      subcategory.groups.flatMap(group => group.items)));
    assert.equal(items.length, 333);
    assert.equal(new Set(items.map(item => item.field_key)).size, items.length);
    for (const item of items) assert.doesNotThrow(() => validateRuleRefs(item.rule_refs, { edition: 2026 }));
    const mapped = items.filter(item => item.rule_refs.references.length);
    assert.ok(mapped.length > 0, "the shipped template carries clause candidates");
    assert.ok(items.every(item => item.rule_refs.references.length <= 3), "at most three candidates per question");
    assert.ok(mapped.every(item => item.rule_refs.references.every(ref => ref.release_tag?.endsWith("-2026-r2"))),
      "candidates were resolved against the 2026-r2 releases");
    assert.equal(items.every(item => item.rule_refs.status === "needs_review"), true,
      "candidate mappings require explicit human verification");
  });

  it("validates status invariants, document prefixes, editions, and duplicate keys", () => {
    assert.throws(() => validateRuleRefs({ status: "verified", references: [] }), /하나 이상의 규정/);
    assert.throws(() => validateRuleRefs({ status: "no_direct_rule", references: [rule()] }), /연결할 수 없습니다/);
    assert.throws(() => validateRuleRefs({
      status: "verified",
      references: [{
        edition: 2026,
        document: "formula-competition",
        rule_key: "formula-technical.brake-light",
        clause_id: "formula-competition-1",
        citation: "제1조",
        source_hash: HASH_A,
      }],
    }), /접두사/);
    assert.throws(() => parseStoredRuleRefs("not-json", 2026), /손상/);
  });

  it("loads only keyed rules and builds a URL inside the configured Pages base", async () => {
    const catalog = createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      fetchImpl: fixtureFetch({ indexValue: index([
        rule({ id: "formula-technical-1", href: "#formula-technical-1", citation: "제1조", rule_key: undefined }),
        rule(),
      ]) }),
    });
    const loaded = await catalog.load(2026);
    assert.equal(loaded.rules.length, 1);
    assert.equal(loaded.byKey.get("formula-technical.brake-light").url,
      "https://example.test/fsk-rules/2026/formula-technical/#formula-technical-10-9");
  });

  it("requires manifest v2 with deployment and release metadata and exposes it", async () => {
    const loaded = await createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      fetchImpl: fixtureFetch(),
    }).load(2026);
    assert.deepEqual(loaded.deployment, { site_tag: "site-20260904.1", source_commit: SOURCE_COMMIT });
    assert.deepEqual(loaded.documents, [{
      document: "formula-technical", revision: 2, version: "2026-r2",
      release_tag: "formula-technical-2026-r2", document_digest: DOC_DIGEST,
    }]);
    const rule = loaded.byKey.get("formula-technical.brake-light");
    assert.equal(rule.release_tag, "formula-technical-2026-r2");
    assert.equal(transitionRuleRefs({ status: "verified", references: [{
      edition: 2026, document: "formula-technical", rule_key: "formula-technical.brake-light",
      clause_id: "formula-technical-10-9", citation: "제10조 9항", source_hash: HASH_A,
    }] }, loaded).references[0].release_tag, "formula-technical-2026-r2");

    const legacy = manifest();
    legacy.schema_version = 1;
    delete legacy.deployment;
    for (const doc of legacy.documents) {
      for (const key of ["revision", "version", "release_tag", "document_digest"]) delete doc[key];
    }
    await assert.rejects(createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      fetchImpl: fixtureFetch({ manifestValue: legacy }),
    }).load(2026), /스키마가 올바르지 않습니다/);

    for (const broken of [
      manifest({ version: "2026-r3" }),
      manifest({ release_tag: "formula-competition-2026-r2" }),
      manifest({ document_digest: "sha256:short" }),
      manifest({}, { site_tag: "20260904", source_commit: SOURCE_COMMIT }),
      manifest({}, { site_tag: null, source_commit: "not-a-sha" }),
    ]) {
      await assert.rejects(createRulesCatalog({
        baseUrl: "https://example.test/fsk-rules/",
        fetchImpl: fixtureFetch({ manifestValue: broken }),
      }).load(2026), /올바르지 않습니다/);
    }
    const unreleased = manifest({}, { site_tag: null, source_commit: SOURCE_COMMIT });
    assert.equal((await createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      fetchImpl: fixtureFetch({ manifestValue: unreleased }),
    }).load(2026)).deployment.site_tag, null);
  });

  it("accepts a stored release_tag only for the reference's own document and edition", () => {
    const reference = {
      edition: 2026, document: "formula-technical", rule_key: "formula-technical.brake-light",
      clause_id: "formula-technical-10-9", citation: "제10조 9항", source_hash: HASH_A,
    };
    assert.equal(validateRuleRefs({ status: "verified", references: [{ ...reference, release_tag: "formula-technical-2026-r2" }] })
      .references[0].release_tag, "formula-technical-2026-r2");
    assert.equal("release_tag" in validateRuleRefs({ status: "verified", references: [reference] }).references[0], false);
    for (const release_tag of ["formula-competition-2026-r2", "formula-technical-2025-r2", "formula-technical-2026-r0", "r2"]) {
      assert.throws(() => validateRuleRefs({ status: "verified", references: [{ ...reference, release_tag }] }), /release_tag/);
    }
  });

  it("rejects path escapes and duplicate stable keys", async () => {
    const escaped = createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      fetchImpl: fixtureFetch({ manifestValue: manifest({ index_path: "../secret.json" }) }),
    });
    await assert.rejects(escaped.load(2026), /안전하지 않습니다/);

    const duplicate = createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      fetchImpl: fixtureFetch({ indexValue: index([rule(), rule({ id: "formula-technical-11", href: "#formula-technical-11" })]) }),
    });
    await assert.rejects(duplicate.load(2026), /rule_key가 중복/);
  });

  it("caches validated catalogs, singleflights concurrent reads, and refreshes explicitly", async () => {
    const calls = [];
    const catalog = createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      fetchImpl: fixtureFetch({ calls }),
    });
    await Promise.all([catalog.load(2026), catalog.load(2026)]);
    assert.equal(calls.length, 2);
    await catalog.load(2026);
    assert.equal(calls.length, 2);
    await catalog.load(2026, { force: true });
    assert.equal(calls.length, 4);
  });

  it("times out an unresponsive catalog request", async () => {
    const catalog = createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      timeoutMs: 5,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    });
    await assert.rejects(catalog.load(2026), error => error.code === "RULE_CATALOG_TIMEOUT");
  });

  it("stops reading a catalog response that exceeds the configured byte limit", async () => {
    const catalog = createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      maxBytes: 10,
      fetchImpl: async () => new Response("x".repeat(11), { status: 200 }),
    });
    await assert.rejects(catalog.load(2026), /응답이 너무 큽니다/);
  });

  it("keeps a renumbered rule verified only when its content hash is unchanged", async () => {
    const stable = await createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      fetchImpl: fixtureFetch({ indexValue: index([rule({ id: "formula-technical-12-1", href: "#formula-technical-12-1", citation: "제12조 1항" })]) }),
    }).load(2026);
    const source = {
      status: "verified",
      references: [{
        edition: 2025,
        document: "formula-technical",
        rule_key: "formula-technical.brake-light",
        clause_id: "formula-technical-9-4",
        citation: "제9조 4항",
        source_hash: HASH_A,
      }],
    };
    const moved = transitionRuleRefs(source, stable);
    assert.equal(moved.status, "verified");
    assert.equal(moved.references[0].clause_id, "formula-technical-12-1");

    const changedCatalog = { ...stable, byKey: new Map(stable.byKey) };
    changedCatalog.byKey.set("formula-technical.brake-light", {
      ...stable.byKey.get("formula-technical.brake-light"), content_hash: HASH_B,
    });
    assert.equal(transitionRuleRefs(source, changedCatalog).status, "needs_review");
  });
});
