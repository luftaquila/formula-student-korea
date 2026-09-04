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

function manifest(overrides = {}, deployment = { site_tag: "site-20260904-v1", source_commit: SOURCE_COMMIT }) {
  return {
    schema_version: 2,
    latest_edition: 2026,
    deployment,
    documents: [{
      edition: 2026,
      revision: 2,
      version: "2026-v2",
      release_tag: "formula-technical-2026-v2",
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
  it("ships a fully reviewed 2026 template with unique stable field keys and schema-valid references", () => {
    const template = JSON.parse(fs.readFileSync(new URL("../../.github/inspection-template-2026.json", import.meta.url)));
    const items = template.flatMap(category => category.subcategories.flatMap(subcategory =>
      subcategory.groups.flatMap(group => group.items)));
    assert.equal(items.length, 403);
    assert.deepEqual(template.map(category => ({
      name: category.name,
      items: category.subcategories.flatMap(subcategory => subcategory.groups.flatMap(group => group.items)).length,
    })), [
      { name: "코너웨이트", items: 9 },
      { name: "섀시", items: 137 },
      { name: "내연", items: 50 },
      { name: "축전지", items: 85 },
      { name: "전기", items: 117 },
      { name: "틸팅", items: 1 },
      { name: "우천", items: 1 },
      { name: "소음", items: 2 },
      { name: "제동", items: 1 },
    ]);
    assert.equal(new Set(items.map(item => item.field_key)).size, items.length);
    for (const item of items) assert.doesNotThrow(() => validateRuleRefs(item.rule_refs, { edition: 2026 }));
    const mapped = items.filter(item => item.rule_refs.status === "verified");
    const noDirectRule = items.filter(item => item.rule_refs.status === "no_direct_rule");
    assert.equal(mapped.length, 382);
    assert.equal(noDirectRule.length, 21);
    assert.equal(mapped.flatMap(item => item.rule_refs.references).length, 470);
    assert.ok(items.every(item => item.rule_refs.references.length <= 3), "at most three references per question");
    assert.ok(mapped.every(item => item.rule_refs.references.every(ref => ref.release_tag?.endsWith("-2026-v1"))),
      "references were resolved against the 2026-v1 releases");
    assert.ok(mapped.every(item => item.rule_refs.references.length > 0));
    assert.ok(noDirectRule.every(item => item.rule_refs.references.length === 0));
    assert.equal(items.some(item => item.rule_refs.status === "needs_review"), false,
      "the shipped mappings have completed explicit human verification");
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
    assert.deepEqual(loaded.deployment, { site_tag: "site-20260904-v1", source_commit: SOURCE_COMMIT });
    assert.deepEqual(loaded.documents, [{
      document: "formula-technical", revision: 2, version: "2026-v2",
      release_tag: "formula-technical-2026-v2", document_digest: DOC_DIGEST,
    }]);
    const rule = loaded.byKey.get("formula-technical.brake-light");
    assert.equal(rule.release_tag, "formula-technical-2026-v2");
    assert.equal(transitionRuleRefs({ status: "verified", references: [{
      edition: 2026, document: "formula-technical", rule_key: "formula-technical.brake-light",
      clause_id: "formula-technical-10-9", citation: "제10조 9항", source_hash: HASH_A,
    }] }, loaded).references[0].release_tag, "formula-technical-2026-v2");

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
      manifest({ version: "2026-v3" }),
      manifest({ release_tag: "formula-competition-2026-v2" }),
      manifest({ document_digest: "sha256:short" }),
      manifest({}, { site_tag: "20260904", source_commit: SOURCE_COMMIT }),
      manifest({}, { site_tag: "site-20260904.1", source_commit: SOURCE_COMMIT }),
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

  it("accepts the current v1 document and site release identities", async () => {
    const current = manifest({
      revision: 1,
      version: "2026-v1",
      release_tag: "formula-technical-2026-v1",
    }, { site_tag: "site-20260904-v1", source_commit: SOURCE_COMMIT });
    const loaded = await createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      fetchImpl: fixtureFetch({ manifestValue: current }),
    }).load(2026);

    assert.equal(loaded.deployment.site_tag, "site-20260904-v1");
    assert.equal(loaded.documents[0].version, "2026-v1");
    assert.equal(loaded.documents[0].release_tag, "formula-technical-2026-v1");
  });

  it("accepts a stored release_tag only for the reference's own document and edition", () => {
    const reference = {
      edition: 2026, document: "formula-technical", rule_key: "formula-technical.brake-light",
      clause_id: "formula-technical-10-9", citation: "제10조 9항", source_hash: HASH_A,
    };
    assert.equal(validateRuleRefs({ status: "verified", references: [{ ...reference, release_tag: "formula-technical-2026-v2" }] })
      .references[0].release_tag, "formula-technical-2026-v2");
    assert.equal("release_tag" in validateRuleRefs({ status: "verified", references: [reference] }).references[0], false);
    for (const release_tag of [
      "formula-competition-2026-v2",
      "formula-technical-2025-v2",
      "formula-technical-2026-v0",
      "formula-technical-2026-r2",
      "v2",
    ]) {
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

    // A forced refresh must fetch again even while an unforced load is still in flight.
    const [plain, forced] = await Promise.all([catalog.load(2026), catalog.load(2026, { force: true })]);
    assert.equal(calls.length, 6);
    assert.equal(plain.rules.length, forced.rules.length);
  });

  it("does not let an older load overwrite a completed forced refresh", async () => {
    let resolveOldIndex;
    let oldIndexRequested;
    const oldIndexStarted = new Promise(resolve => { oldIndexRequested = resolve; });
    let indexCalls = 0;
    const catalog = createRulesCatalog({
      baseUrl: "https://example.test/fsk-rules/",
      fetchImpl: async (url) => {
        if (String(url).endsWith("rules-manifest.json")) return jsonResponse(manifest());
        indexCalls += 1;
        if (indexCalls === 1) {
          oldIndexRequested();
          return new Promise(resolve => { resolveOldIndex = resolve; });
        }
        return jsonResponse(index([rule({
          id: "formula-technical-12-1",
          href: "#formula-technical-12-1",
          citation: "제12조 1항",
          text: "새 규정 내용",
          content_hash: HASH_B,
        })]));
      },
    });

    const olderLoad = catalog.load(2026);
    await oldIndexStarted;
    const refreshed = await catalog.load(2026, { force: true });
    assert.equal(refreshed.byKey.get("formula-technical.brake-light").content_hash, HASH_B);

    resolveOldIndex(jsonResponse(index([rule()])));
    await olderLoad;

    const cached = await catalog.load(2026);
    assert.equal(cached.byKey.get("formula-technical.brake-light").content_hash, HASH_B,
      "the most recently started load owns the cache even if an older request finishes last");
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
