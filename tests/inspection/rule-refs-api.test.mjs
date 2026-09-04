import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanup,
  createClient,
  makeAuthCookie,
  setupTestEnv,
  startServer,
  stopServer,
  tmpDbPath,
  TRUST_JWT,
} from "../helpers/test-utils.mjs";
import { currentCompetitionYear } from "../../shared/competition-year.mjs";

setupTestEnv();

import { createInspectionApp } from "../../inspection/index.mjs";

const YEAR = currentCompetitionYear();
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const PDF_HASH = `sha256:${"c".repeat(64)}`;
const chiefCookie = makeAuthCookie({
  email: "rules-manager@test.com", name: "Rules Manager", role: "official",
  permissions: ["inspection.manage", "inspection.operate"],
});
const officialCookie = makeAuthCookie({
  email: "rules-operator@test.com", name: "Rules Operator", role: "official",
  permissions: ["inspection.operate"],
});

function catalogPayload(hash = HASH_A, clauseId = "formula-technical-10-9") {
  return {
    manifest: {
      schema_version: 2,
      latest_edition: YEAR,
      deployment: { site_tag: "site-20260904.1", source_commit: "a".repeat(40) },
      documents: [{
        edition: YEAR,
        revision: 2,
        version: `${YEAR}-r2`,
        release_tag: `formula-technical-${YEAR}-r2`,
        document_digest: `sha256:${"d".repeat(64)}`,
        document: "formula-technical",
        title: "차량기술규정",
        short_title: "기술",
        effective_date: `${YEAR}-01-01`,
        web_path: `${YEAR}/formula-technical/`,
        pdf_path: `${YEAR}/formula-technical/rules.pdf`,
        index_path: `${YEAR}/formula-technical/rules-index.json`,
        source: {
          status: "verified",
          post_id: 1,
          published_date: `${YEAR}-01-01`,
          post_url: "https://www.ksae.org/jajak/bbs/?number=1",
          pdf_hash: PDF_HASH,
        },
      }],
    },
    index: {
      schema_version: 2,
      edition: YEAR,
      document: "formula-technical",
      rules: [{
        id: clauseId,
        year: YEAR,
        edition: YEAR,
        document: "formula-technical",
        citation: clauseId.endsWith("10-9") ? "제10조 9항" : "제12조 1항",
        text: "제동등을 장착해야 한다.",
        href: `#${clauseId}`,
        content_hash: hash,
        rule_key: "formula-technical.brake-light",
      }],
    },
  };
}

let payload = catalogPayload();
let catalogUnavailable = false;
const rulesFetch = async (url) => {
  if (catalogUnavailable) throw new Error("injected catalog outage");
  return new Response(JSON.stringify(
    String(url).endsWith("rules-manifest.json") ? payload.manifest : payload.index,
  ), { status: 200, headers: { "content-type": "application/json" } });
};

let created;
let server;
let baseUrl;
let client;
let dbPath;
let ids;

before(async () => {
  dbPath = tmpDbPath();
  created = createInspectionApp({
    dbPath,
    validateUser: TRUST_JWT,
    rulesBaseUrl: "https://rules.test/fsk-rules/",
    rulesFetch,
  });
  const db = created.db;
  const category = db.prepare("INSERT INTO sheet_template (year, level, name) VALUES (?, 'category', '기술검차')").run(YEAR).lastInsertRowid;
  const subcategory = db.prepare("INSERT INTO sheet_template (year, level, parent_id, name) VALUES (?, 'subcategory', ?, '전기')").run(YEAR, category).lastInsertRowid;
  const group = db.prepare("INSERT INTO sheet_template (year, level, parent_id, name) VALUES (?, 'group', ?, '등화')").run(YEAR, subcategory).lastInsertRowid;
  const first = db.prepare("INSERT INTO sheet_template (year, level, parent_id, name, answer_type, field_key) VALUES (?, 'item', ?, '제동등', 'passfail', 'brake-light')").run(YEAR, group).lastInsertRowid;
  const second = db.prepare("INSERT INTO sheet_template (year, level, parent_id, name, answer_type, field_key) VALUES (?, 'item', ?, '운영 확인', 'text', 'operations-check')").run(YEAR, group).lastInsertRowid;
  db.prepare("INSERT INTO sheet_answer (year, team_num, item_id, value, memo) VALUES (?, 1, ?, 'PASS', 'keep')").run(YEAR, first);
  ids = { category, subcategory, group, first: Number(first), second: Number(second) };
  const started = await startServer(created.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  await stopServer(server);
  created.closeSse?.();
  created.db.close();
  cleanup(dbPath);
});

describe("inspection rule reference API", () => {
  it("allows officials to search the sanitized keyed catalog", async () => {
    const response = await client.get(`/api/sheet/rules/search?year=${YEAR}&q=%EC%A0%9C%EB%8F%99`, { cookie: officialCookie });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rules.length, 1);
    assert.equal(body.rules[0].rule_key, "formula-technical.brake-light");
    assert.equal("url" in body.rules[0], false);
  });

  it("requires inspection.manage and resolves authoritative metadata when linking an item", async () => {
    const denied = await client.put(`/api/sheet/template/${ids.first}/rule-refs`, {
      cookie: officialCookie,
      body: { status: "verified", rule_keys: ["formula-technical.brake-light"] },
    });
    assert.equal(denied.status, 403);

    const missingExpected = await client.put(`/api/sheet/template/${ids.first}/rule-refs`, {
      cookie: chiefCookie,
      body: { status: "verified", rule_keys: ["formula-technical.brake-light"] },
    });
    assert.equal(missingExpected.status, 400);

    const saved = await client.put(`/api/sheet/template/${ids.first}/rule-refs`, {
      cookie: chiefCookie,
      body: {
        expected_rule_refs: { status: "needs_review", references: [] },
        status: "verified",
        rule_keys: ["formula-technical.brake-light"],
        references: [{ clause_id: "https://evil.test/" }],
      },
    });
    assert.equal(saved.status, 200);
    const refs = await saved.json();
    assert.equal(refs.references[0].clause_id, "formula-technical-10-9");

    const tree = await (await client.get(`/api/sheet/template?year=${YEAR}`, { cookie: officialCookie })).json();
    assert.deepEqual(tree[0].subcategories[0].groups[0].items[0].rule_refs, refs);
  });

  it("rejects a stale rule-reference edit without overwriting the winner", async () => {
    const expected = JSON.parse(created.db.prepare("SELECT rule_refs FROM sheet_template WHERE id = ?").get(ids.first).rule_refs);
    const winner = await client.put(`/api/sheet/template/${ids.first}/rule-refs`, {
      cookie: chiefCookie,
      body: { expected_rule_refs: expected, status: "no_direct_rule", rule_keys: [] },
    });
    assert.equal(winner.status, 200);
    const current = await winner.json();

    const stale = await client.put(`/api/sheet/template/${ids.first}/rule-refs`, {
      cookie: chiefCookie,
      body: {
        expected_rule_refs: expected,
        status: "verified",
        rule_keys: ["formula-technical.brake-light"],
      },
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      code: "INSPECTION_STALE_WRITE",
      message: "다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 시도하세요.",
      current: { rule_refs: current },
    });
    assert.deepEqual(
      JSON.parse(created.db.prepare("SELECT rule_refs FROM sheet_template WHERE id = ?").get(ids.first).rule_refs),
      current,
    );

    const restored = await client.put(`/api/sheet/template/${ids.first}/rule-refs`, {
      cookie: chiefCookie,
      body: {
        expected_rule_refs: current,
        status: "verified",
        rule_keys: ["formula-technical.brake-light"],
      },
    });
    assert.equal(restored.status, 200);
  });

  it("redirects a verified unchanged key to the current Pages anchor", async () => {
    const response = await fetch(`${baseUrl}/api/sheet/rule-link/${ids.first}/0`, {
      headers: { cookie: officialCookie },
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"),
      `https://rules.test/fsk-rules/${YEAR}/formula-technical/#formula-technical-10-9`);
  });

  it("imports only rule references atomically by the exact field-key set", async () => {
    const template = [{
      name: "ignored structure name",
      export_note: "x".repeat(120 * 1024),
      subcategories: [{ name: "ignored", groups: [{ name: "ignored", items: [
        {
          field_key: "brake-light",
          rule_refs: {
            status: "verified",
            references: [{
              edition: YEAR,
              document: "formula-technical",
              rule_key: "formula-technical.brake-light",
              clause_id: "formula-technical-wrong",
              citation: "가짜 인용",
              source_hash: HASH_B,
            }],
          },
        },
        { field_key: "operations-check", rule_refs: { status: "no_direct_rule", references: [] } },
      ] }] }],
    }];
    const imported = await client.post("/api/sheet/template/rule-refs/import", {
      cookie: chiefCookie, body: { year: YEAR, template },
    });
    assert.equal(imported.status, 200);
    assert.deepEqual((await imported.json()).counts, { verified: 1, needs_review: 0, no_direct_rule: 1 });
    const stored = created.db.prepare("SELECT name, rule_refs FROM sheet_template WHERE id = ?").get(ids.first);
    assert.equal(stored.name, "제동등");
    assert.equal(JSON.parse(stored.rule_refs).references[0].source_hash, HASH_A);
    assert.deepEqual(created.db.prepare("SELECT value, memo FROM sheet_answer WHERE item_id = ?").get(ids.first), { value: "PASS", memo: "keep" });

    const incomplete = structuredClone(template);
    incomplete[0].subcategories[0].groups[0].items.pop();
    const rejected = await client.post("/api/sheet/template/rule-refs/import", {
      cookie: chiefCookie, body: { year: YEAR, template: incomplete },
    });
    assert.equal(rejected.status, 400);
    assert.equal(JSON.parse(created.db.prepare("SELECT rule_refs FROM sheet_template WHERE id = ?").get(ids.second).rule_refs).status, "no_direct_rule");
  });

  it("downgrades changed content during explicit revalidation and then denies redirect", async () => {
    payload = catalogPayload(HASH_B, "formula-technical-12-1");
    const response = await client.post("/api/sheet/template/rule-refs/revalidate", {
      cookie: chiefCookie, body: { year: YEAR },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.counts.changed, 1);
    const refs = JSON.parse(created.db.prepare("SELECT rule_refs FROM sheet_template WHERE id = ?").get(ids.first).rule_refs);
    assert.equal(refs.status, "needs_review");
    assert.equal(refs.references[0].clause_id, "formula-technical-12-1");

    const denied = await fetch(`${baseUrl}/api/sheet/rule-link/${ids.first}/0`, {
      headers: { cookie: officialCookie }, redirect: "manual",
    });
    assert.equal(denied.status, 409);
  });

  it("syncs only undecided targets by stable field key", async () => {
    const sourceRefs = {
      status: "verified",
      references: [{
        edition: YEAR - 1,
        document: "formula-technical",
        rule_key: "formula-technical.brake-light",
        clause_id: "formula-technical-9-4",
        citation: "제9조 4항",
        source_hash: HASH_B,
      }],
    };
    created.db.prepare(`INSERT INTO sheet_template
      (year, level, name, answer_type, field_key, rule_refs)
      VALUES (?, 'item', '이전 연도 운영 확인', 'text', 'operations-check', ?)`
    ).run(YEAR - 1, JSON.stringify(sourceRefs));
    created.db.prepare("UPDATE sheet_template SET rule_refs = ? WHERE id = ?")
      .run(JSON.stringify({ status: "needs_review", references: [] }), ids.second);

    const response = await client.post("/api/sheet/template/rule-refs/sync", {
      cookie: chiefCookie,
      body: { from_year: YEAR - 1, to_year: YEAR },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.counts.verified, 1);
    const synced = JSON.parse(created.db.prepare("SELECT rule_refs FROM sheet_template WHERE id = ?").get(ids.second).rule_refs);
    assert.equal(synced.status, "verified");
    assert.equal(synced.references[0].clause_id, "formula-technical-12-1");

    const again = await client.post("/api/sheet/template/rule-refs/sync", {
      cookie: chiefCookie,
      body: { from_year: YEAR - 1, to_year: YEAR },
    });
    assert.equal((await again.json()).counts.skipped_verified >= 1, true);
  });

  it("renders a readable page when a browser opens a link that is not verified", async () => {
    const db = created.db;
    const before = db.prepare("SELECT rule_refs FROM sheet_template WHERE id = ?").get(ids.second).rule_refs;
    db.prepare("UPDATE sheet_template SET rule_refs = ? WHERE id = ?")
      .run(JSON.stringify({ status: "needs_review", references: [] }), ids.second);
    try {
      const response = await client.get(`/api/sheet/rule-link/${ids.second}/0`, {
        cookie: officialCookie, headers: { accept: "text/html,application/xhtml+xml" },
      });
      assert.equal(response.status, 409);
      assert.match(response.headers.get("content-type"), /text\/html/);
      assert.match(await response.text(), /검토 중/);

      const api = await client.get(`/api/sheet/rule-link/${ids.second}/0`, { cookie: officialCookie });
      assert.equal(api.status, 409);
      assert.deepEqual(await api.json(), {
        code: "RULE_REFERENCE_NOT_VERIFIED", message: "이 문항의 규정 연결은 아직 검토 중입니다.",
      });
    } finally {
      db.prepare("UPDATE sheet_template SET rule_refs = ? WHERE id = ?").run(before, ids.second);
    }
  });

  it("accepts large bodies only on the import routes", async () => {
    const filler = "x".repeat(300 * 1024);
    const rejected = await client.post("/api/sheet/template/reorder", {
      cookie: chiefCookie, body: { items: [], filler },
    });
    assert.equal(rejected.status, 413);

    const parsed = await client.post("/api/sheet/template/rule-refs/import", {
      cookie: chiefCookie, body: { year: YEAR, template: [], filler },
    });
    assert.equal(parsed.status, 400, "the body was parsed and rejected by validation, not by size");
  });

  it("keeps stored data readable when one item's rule_refs is corrupt", async () => {
    const db = created.db;
    const before = db.prepare("SELECT rule_refs FROM sheet_template WHERE id = ?").get(ids.second).rule_refs;
    db.prepare("UPDATE sheet_template SET rule_refs = ? WHERE id = ?")
      .run(JSON.stringify({ status: "verified", references: [] }), ids.second);
    try {
      const response = await client.get(`/api/sheet/template?year=${YEAR}`, { cookie: officialCookie });
      assert.equal(response.status, 200);
      const items = (await response.json()).flatMap((category) => category.subcategories.flatMap((sub) => sub.groups.flatMap((group) => group.items)));
      assert.deepEqual(items.find((item) => item.id === ids.second).rule_refs, { status: "needs_review", references: [] });
      const warning = db.prepare(`SELECT detail FROM logs
        WHERE action = 'template.read' AND level = 'warn' ORDER BY id DESC LIMIT 1`).get();
      assert.equal(JSON.parse(warning.detail).item_id, ids.second);
    } finally {
      db.prepare("UPDATE sheet_template SET rule_refs = ? WHERE id = ?").run(before, ids.second);
    }
  });

  it("fails closed and audits an unavailable catalog without affecting readiness", async () => {
    catalogUnavailable = true;
    try {
      const response = await client.post("/api/sheet/template/rule-refs/revalidate", {
        cookie: chiefCookie, body: { year: YEAR },
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "RULE_CATALOG_UNAVAILABLE");
      const health = await client.get("/api/health");
      assert.equal(health.status, 200);
      const warning = created.db.prepare(`SELECT detail FROM logs
        WHERE action = 'template.rule_refs.revalidate' AND level = 'warn' ORDER BY id DESC LIMIT 1`).get();
      assert.equal(JSON.parse(warning.detail).phase, "rule_catalog");
    } finally {
      catalogUnavailable = false;
    }
  });

  it("follows stable keys when a template exported from another year is imported", async () => {
    // Pin the catalog the import will see: brake-light now lives at 제12조 1항 with HASH_B.
    payload = catalogPayload(HASH_B, "formula-technical-12-1");
    assert.equal((await client.post("/api/sheet/template/rule-refs/revalidate", { cookie: chiefCookie, body: { year: YEAR } })).status, 200);
    const reference = (source_hash) => ({
      edition: YEAR - 1, document: "formula-technical", rule_key: "formula-technical.brake-light",
      clause_id: "formula-technical-9-9", citation: "제9조 9항", source_hash,
    });
    const template = [{
      name: "기술검차", subcategories: [{ name: "전기", groups: [{ name: "등화", items: [
        { name: "제동등", answer_type: "passfail", field_key: "brake-light",
          rule_refs: { status: "verified", references: [reference(HASH_B)] } },
        { name: "제동등 면적", answer_type: "passfail", field_key: "brake-light-area",
          rule_refs: { status: "verified", references: [reference(HASH_A)] } },
        { name: "운영 확인", answer_type: "text", field_key: "operations-check",
          rule_refs: { status: "needs_review", references: [] } },
      ] }] }],
    }];
    const response = await client.post("/api/sheet/template/import", { cookie: chiefCookie, body: { year: YEAR, template } });
    assert.equal(response.status, 201);
    const stored = Object.fromEntries(created.db.prepare(
      "SELECT field_key, rule_refs FROM sheet_template WHERE year = ? AND level = 'item'",
    ).all(YEAR).map((row) => [row.field_key, JSON.parse(row.rule_refs)]));
    assert.equal(stored["brake-light"].status, "verified");
    assert.deepEqual(stored["brake-light"].references[0], {
      edition: YEAR, document: "formula-technical", rule_key: "formula-technical.brake-light",
      clause_id: "formula-technical-12-1", citation: "제12조 1항", source_hash: HASH_B,
      release_tag: `formula-technical-${YEAR}-r2`,
    }, "the renumbered clause is followed because its content hash is unchanged");
    // Changed content keeps the clause as a review candidate but never as verified.
    assert.equal(stored["brake-light-area"].status, "needs_review");
    assert.equal(stored["brake-light-area"].references[0].clause_id, "formula-technical-12-1");
    assert.equal(stored["brake-light-area"].references[0].source_hash, HASH_B);
    assert.deepEqual(stored["operations-check"], { status: "needs_review", references: [] });
  });
});
