export const RULE_DOCUMENTS = Object.freeze(["formula-technical", "formula-competition"]);
export const RULE_REF_STATUSES = Object.freeze(["verified", "needs_review", "no_direct_rule"]);
export const EMPTY_RULE_REFS = Object.freeze({ status: "needs_review", references: Object.freeze([]) });
export const DEFAULT_RULES_BASE_URL = "https://luftaquila.github.io/fsk-rules/";

const RULE_KEY_PATTERN = /^formula-(technical|competition)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CLAUSE_ID_PATTERN = /^formula-(technical|competition)-[a-z0-9-]+$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DOCUMENT_TAG_PATTERN = /^formula-(technical|competition)-\d{4}-r[1-9]\d*$/;
const SITE_TAG_PATTERN = /^site-\d{8}\.[1-9]\d*$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

function isIsoDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export class RuleCatalogError extends Error {
  constructor(message, code = "RULE_CATALOG_INVALID", cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "RuleCatalogError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}에 허용되지 않은 필드가 있습니다: ${key}`);
  }
}

function documentForRuleKey(ruleKey) {
  if (ruleKey.startsWith("formula-technical.")) return "formula-technical";
  if (ruleKey.startsWith("formula-competition.")) return "formula-competition";
  return null;
}

export function validateRuleRefs(value, { edition } = {}) {
  if (!isPlainObject(value)) throw new Error("rule_refs는 객체여야 합니다.");
  assertExactKeys(value, new Set(["status", "references"]), "rule_refs");
  if (!RULE_REF_STATUSES.includes(value.status)) throw new Error("올바르지 않은 규정 연결 상태입니다.");
  if (!Array.isArray(value.references)) throw new Error("rule_refs.references는 배열이어야 합니다.");
  if (value.references.length > 20) throw new Error("한 문항에는 규정을 최대 20개까지 연결할 수 있습니다.");
  if (value.status === "verified" && value.references.length === 0) {
    throw new Error("검증된 연결에는 하나 이상의 규정이 필요합니다.");
  }
  if (value.status === "no_direct_rule" && value.references.length !== 0) {
    throw new Error("직접 대응 규정 없음 상태에는 규정을 연결할 수 없습니다.");
  }
  if (value.status !== "verified" && value.status !== "needs_review" && value.references.length) {
    throw new Error("이 상태에는 규정을 연결할 수 없습니다.");
  }

  const seen = new Set();
  const references = value.references.map((ref) => {
    if (!isPlainObject(ref)) throw new Error("규정 참조는 객체여야 합니다.");
    assertExactKeys(ref, new Set([
      "edition", "document", "rule_key", "clause_id", "citation", "source_hash", "release_tag",
    ]), "규정 참조");
    if (!Number.isInteger(ref.edition) || ref.edition < 2000) throw new Error("올바르지 않은 규정 연도입니다.");
    if (edition !== undefined && ref.edition !== edition) throw new Error("문항 연도와 규정 연도가 다릅니다.");
    if (!RULE_DOCUMENTS.includes(ref.document)) throw new Error("올바르지 않은 규정 문서입니다.");
    if (typeof ref.rule_key !== "string" || !RULE_KEY_PATTERN.test(ref.rule_key)) throw new Error("올바르지 않은 rule_key입니다.");
    if (documentForRuleKey(ref.rule_key) !== ref.document) throw new Error("rule_key의 문서 접두사가 일치하지 않습니다.");
    if (typeof ref.clause_id !== "string" || !CLAUSE_ID_PATTERN.test(ref.clause_id)
      || !ref.clause_id.startsWith(`${ref.document}-`)) throw new Error("올바르지 않은 clause_id입니다.");
    if (typeof ref.citation !== "string" || ref.citation.trim().length < 3 || ref.citation.length > 200) {
      throw new Error("올바르지 않은 규정 인용 표기입니다.");
    }
    if (typeof ref.source_hash !== "string" || !HASH_PATTERN.test(ref.source_hash)) throw new Error("올바르지 않은 규정 내용 해시입니다.");
    if (ref.release_tag !== undefined && (typeof ref.release_tag !== "string" || !DOCUMENT_TAG_PATTERN.test(ref.release_tag)
      || !ref.release_tag.startsWith(`${ref.document}-${ref.edition}-r`))) {
      throw new Error("올바르지 않은 규정 release_tag입니다.");
    }
    if (seen.has(ref.rule_key)) throw new Error("같은 규정을 중복 연결할 수 없습니다.");
    seen.add(ref.rule_key);
    return {
      edition: ref.edition,
      document: ref.document,
      rule_key: ref.rule_key,
      clause_id: ref.clause_id,
      citation: ref.citation.trim(),
      source_hash: ref.source_hash,
      ...(ref.release_tag !== undefined ? { release_tag: ref.release_tag } : {}),
    };
  });
  return { status: value.status, references };
}

export function parseStoredRuleRefs(raw, edition) {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); }
    catch { throw new Error("저장된 rule_refs JSON이 손상되었습니다."); }
  }
  return validateRuleRefs(value, { edition });
}

export function serializeRuleRefs(value, edition) {
  return JSON.stringify(validateRuleRefs(value, { edition }));
}

export function refsFromRules(status, rules) {
  return validateRuleRefs({
    status,
    references: rules.map((rule) => ({
      edition: rule.edition,
      document: rule.document,
      rule_key: rule.rule_key,
      clause_id: rule.clause_id,
      citation: rule.citation,
      source_hash: rule.content_hash,
      release_tag: rule.release_tag,
    })),
  }, { edition: rules[0]?.edition });
}

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new RuleCatalogError("RULES_BASE_URL이 올바른 URL이 아닙니다."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new RuleCatalogError("규정집 URL은 HTTP(S)여야 합니다.");
  if (url.username || url.password || url.search || url.hash) throw new RuleCatalogError("규정집 기본 URL에 인증정보, 쿼리, 해시를 사용할 수 없습니다.");
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return url;
}

function resolveCatalogPath(base, path, label) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.startsWith("/") || path.includes("..")) {
    throw new RuleCatalogError(`${label} 경로가 안전하지 않습니다.`);
  }
  let resolved;
  try { resolved = new URL(path, base); }
  catch { throw new RuleCatalogError(`${label} 경로가 올바르지 않습니다.`); }
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)
    || resolved.username || resolved.password || resolved.search || resolved.hash) {
    throw new RuleCatalogError(`${label} 경로가 규정집 범위를 벗어났습니다.`);
  }
  return resolved;
}

async function readJson(fetchImpl, url, { timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response?.ok) throw new RuleCatalogError(`규정 카탈로그가 HTTP ${response?.status ?? "오류"}를 반환했습니다.`, "RULE_CATALOG_UNAVAILABLE");
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new RuleCatalogError("규정 카탈로그 응답이 너무 큽니다.");
    let body;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new RuleCatalogError("규정 카탈로그 응답이 너무 큽니다.");
        }
        chunks.push(Buffer.from(value));
      }
      body = Buffer.concat(chunks, size);
    } else {
      const value = await response.arrayBuffer();
      if (value.byteLength > maxBytes) throw new RuleCatalogError("규정 카탈로그 응답이 너무 큽니다.");
      body = Buffer.from(value);
    }
    try { return JSON.parse(body.toString("utf8")); }
    catch { throw new RuleCatalogError("규정 카탈로그 JSON이 올바르지 않습니다."); }
  } catch (error) {
    if (error instanceof RuleCatalogError) throw error;
    const code = error?.name === "AbortError" ? "RULE_CATALOG_TIMEOUT" : "RULE_CATALOG_UNAVAILABLE";
    throw new RuleCatalogError(code === "RULE_CATALOG_TIMEOUT" ? "규정 카탈로그 요청 시간이 초과되었습니다." : "규정 카탈로그에 연결할 수 없습니다.", code, error);
  } finally {
    clearTimeout(timeout);
  }
}

function validateDeployment(value) {
  if (!isPlainObject(value)) throw new RuleCatalogError("규정 매니페스트 배포 정보가 올바르지 않습니다.");
  assertExactKeys(value, new Set(["site_tag", "source_commit"]), "규정 매니페스트 배포 정보");
  if ((value.site_tag !== null && (typeof value.site_tag !== "string" || !SITE_TAG_PATTERN.test(value.site_tag)))
    || typeof value.source_commit !== "string" || !COMMIT_PATTERN.test(value.source_commit)) {
    throw new RuleCatalogError("규정 매니페스트 배포 정보 필드가 올바르지 않습니다.");
  }
  return { site_tag: value.site_tag, source_commit: value.source_commit };
}

function validateManifest(value, base) {
  if (!isPlainObject(value) || value.schema_version !== 2 || !Number.isInteger(value.latest_edition)
    || value.latest_edition < 2000
    || !Array.isArray(value.documents)) throw new RuleCatalogError("규정 매니페스트 스키마가 올바르지 않습니다.");
  assertExactKeys(value, new Set(["schema_version", "latest_edition", "deployment", "documents"]), "규정 매니페스트");
  const deployment = validateDeployment(value.deployment);
  const seen = new Set();
  const documents = value.documents.map((doc) => {
    if (!isPlainObject(doc)) throw new RuleCatalogError("규정 매니페스트 문서가 올바르지 않습니다.");
    assertExactKeys(doc, new Set([
      "edition", "revision", "version", "release_tag", "document_digest",
      "document", "title", "short_title", "effective_date", "web_path", "pdf_path", "index_path", "source",
    ]), "규정 매니페스트 문서");
    if (!Number.isInteger(doc.edition) || doc.edition < 2000 || !RULE_DOCUMENTS.includes(doc.document)
      || typeof doc.title !== "string" || !doc.title.trim()
      || typeof doc.short_title !== "string" || !doc.short_title.trim() || !isIsoDate(doc.effective_date)) {
      throw new RuleCatalogError("규정 매니페스트 문서 메타데이터가 올바르지 않습니다.");
    }
    if (!Number.isInteger(doc.revision) || doc.revision < 1
      || doc.version !== `${doc.edition}-r${doc.revision}`
      || doc.release_tag !== `${doc.document}-${doc.version}`
      || typeof doc.document_digest !== "string" || !HASH_PATTERN.test(doc.document_digest)) {
      throw new RuleCatalogError("규정 매니페스트 문서 버전 정보가 올바르지 않습니다.");
    }
    if (!isPlainObject(doc.source)) throw new RuleCatalogError("규정 매니페스트 출처가 올바르지 않습니다.");
    assertExactKeys(doc.source, new Set(["status", "post_id", "published_date", "post_url", "pdf_hash"]), "규정 매니페스트 출처");
    if (doc.source.status !== "verified" || !Number.isInteger(doc.source.post_id)
      || !isIsoDate(doc.source.published_date)
      || typeof doc.source.post_url !== "string" || !doc.source.post_url.startsWith("https://www.ksae.org/jajak/bbs/")
      || !HASH_PATTERN.test(doc.source.pdf_hash)) {
      throw new RuleCatalogError("규정 매니페스트 출처 필드가 올바르지 않습니다.");
    }
    const key = `${doc.edition}:${doc.document}`;
    if (seen.has(key)) throw new RuleCatalogError("규정 매니페스트에 문서가 중복되었습니다.");
    seen.add(key);
    return {
      ...doc,
      webUrl: resolveCatalogPath(base, doc.web_path, "web_path"),
      pdfUrl: resolveCatalogPath(base, doc.pdf_path, "pdf_path"),
      indexUrl: resolveCatalogPath(base, doc.index_path, "index_path"),
    };
  });
  return { deployment, documents };
}

function validateIndex(value, manifestDoc) {
  if (!isPlainObject(value) || value.schema_version !== 2 || value.edition !== manifestDoc.edition
    || value.document !== manifestDoc.document || !Array.isArray(value.rules)) {
    throw new RuleCatalogError("규정 인덱스 스키마 또는 문서 정보가 올바르지 않습니다.");
  }
  assertExactKeys(value, new Set(["schema_version", "edition", "document", "rules"]), "규정 인덱스");
  const ids = new Set();
  const keys = new Set();
  const rules = [];
  for (const rule of value.rules) {
    if (!isPlainObject(rule)) throw new RuleCatalogError("규정 인덱스 항목이 올바르지 않습니다.");
    assertExactKeys(rule, new Set([
      "id", "year", "edition", "document", "citation", "text", "href", "content_hash", "rule_key",
    ]), "규정 인덱스 항목");
    if (rule.year !== manifestDoc.edition || rule.edition !== manifestDoc.edition || rule.document !== manifestDoc.document
      || typeof rule.id !== "string" || !CLAUSE_ID_PATTERN.test(rule.id) || !rule.id.startsWith(`${rule.document}-`)
      || typeof rule.citation !== "string" || rule.citation.trim().length < 3
      || typeof rule.text !== "string" || !rule.text.trim()
      || rule.href !== `#${rule.id}` || !HASH_PATTERN.test(rule.content_hash)) {
      throw new RuleCatalogError("규정 인덱스 항목 필드가 올바르지 않습니다.");
    }
    if (ids.has(rule.id)) throw new RuleCatalogError("규정 인덱스에 조항 ID가 중복되었습니다.");
    ids.add(rule.id);
    if (rule.rule_key === undefined) continue;
    if (!RULE_KEY_PATTERN.test(rule.rule_key) || documentForRuleKey(rule.rule_key) !== rule.document) {
      throw new RuleCatalogError("규정 인덱스의 rule_key가 올바르지 않습니다.");
    }
    if (keys.has(rule.rule_key)) throw new RuleCatalogError("규정 인덱스에 rule_key가 중복되었습니다.");
    keys.add(rule.rule_key);
    rules.push({
      edition: rule.edition,
      document: rule.document,
      rule_key: rule.rule_key,
      clause_id: rule.id,
      citation: rule.citation.trim(),
      text: rule.text.trim(),
      href: rule.href,
      content_hash: rule.content_hash,
      release_tag: manifestDoc.release_tag,
      url: new URL(`${manifestDoc.webUrl.pathname}${rule.href}`, manifestDoc.webUrl.origin).href,
    });
  }
  return rules;
}

export function createRulesCatalog({
  baseUrl = DEFAULT_RULES_BASE_URL,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  ttlMs = 10 * 60 * 1000,
  timeoutMs = 3000,
  maxBytes = 5 * 1024 * 1024,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("rulesFetch가 필요합니다.");
  const base = normalizeBaseUrl(baseUrl);
  const cache = new Map();
  const inflight = new Map();

  async function load(edition, { force = false } = {}) {
    if (!Number.isInteger(edition) || edition < 2000) throw new RuleCatalogError("올바르지 않은 규정 연도입니다.");
    const cached = cache.get(edition);
    if (!force && cached && cached.expires > now()) return cached.value;
    if (inflight.has(edition)) return inflight.get(edition);
    const pending = (async () => {
      try {
        const manifestValue = await readJson(fetchImpl, resolveCatalogPath(base, "rules-manifest.json", "매니페스트"), { timeoutMs, maxBytes });
        const manifest = validateManifest(manifestValue, base);
        const documents = manifest.documents.filter((doc) => doc.edition === edition);
        if (!documents.length) throw new RuleCatalogError(`${edition}년 규정 카탈로그가 없습니다.`, "RULE_CATALOG_NOT_FOUND");
        const indexValues = await Promise.all(documents.map((doc) => readJson(fetchImpl, doc.indexUrl, { timeoutMs, maxBytes })));
        const rules = indexValues.flatMap((index, i) => validateIndex(index, documents[i]));
        const byKey = new Map();
        for (const rule of rules) {
          if (byKey.has(rule.rule_key)) throw new RuleCatalogError("문서 간 rule_key가 중복되었습니다.");
          byKey.set(rule.rule_key, rule);
        }
        const value = Object.freeze({
          edition,
          rules: Object.freeze(rules),
          byKey,
          deployment: Object.freeze(manifest.deployment),
          documents: Object.freeze(documents.map((doc) => Object.freeze({
            document: doc.document,
            revision: doc.revision,
            version: doc.version,
            release_tag: doc.release_tag,
            document_digest: doc.document_digest,
          }))),
        });
        cache.set(edition, { value, expires: now() + ttlMs });
        return value;
      } catch (error) {
        if (error instanceof RuleCatalogError) throw error;
        throw new RuleCatalogError(error?.message || "규정 카탈로그 검증에 실패했습니다.", "RULE_CATALOG_INVALID", error);
      }
    })().finally(() => inflight.delete(edition));
    inflight.set(edition, pending);
    return pending;
  }

  return {
    baseUrl: base.href,
    load,
    clear(edition) { edition == null ? cache.clear() : cache.delete(edition); },
  };
}

export function resolveRuleKeys(catalog, ruleKeys) {
  if (!Array.isArray(ruleKeys) || ruleKeys.length > 20) throw new Error("rule_keys는 최대 20개인 배열이어야 합니다.");
  const unique = [...new Set(ruleKeys)];
  if (unique.length !== ruleKeys.length || unique.some((key) => typeof key !== "string" || !RULE_KEY_PATTERN.test(key))) {
    throw new Error("rule_keys가 올바르지 않거나 중복되었습니다.");
  }
  return unique.map((key) => {
    const rule = catalog.byKey.get(key);
    if (!rule) throw new Error(`규정 카탈로그에서 rule_key를 찾을 수 없습니다: ${key}`);
    return rule;
  });
}

export function transitionRuleRefs(source, targetCatalog) {
  const parsed = validateRuleRefs(source);
  if (parsed.status === "no_direct_rule") return { status: "no_direct_rule", references: [], reason: "no_direct_rule" };
  if (parsed.status !== "verified") return { status: "needs_review", references: [], reason: "source_needs_review" };
  const targetRules = [];
  for (const ref of parsed.references) {
    const current = targetCatalog.byKey.get(ref.rule_key);
    if (!current) return { status: "needs_review", references: [], reason: "rule_key_missing" };
    targetRules.push(current);
  }
  const changed = parsed.references.some((ref, index) => ref.source_hash !== targetRules[index].content_hash);
  const status = changed ? "needs_review" : "verified";
  return { ...refsFromRules(status, targetRules), reason: changed ? "content_changed" : "verified" };
}
