# Inspection Rule Links Rollout and Operation

Inspection links resolve `sheet_template.rule_refs` against the fsk-rules GitHub
Pages catalog. Stored references contain stable keys, the resolving release tag,
and verified clause metadata.

## Prerequisites

- `RULES_BASE_URL` points at the catalog origin (`/srv/k3s` configmaps, both clusters).
  The catalog is fetched with a 3 s timeout, a 5 MB cap, and a ten-minute cache. It is
  not part of readiness: an outage disables rule links and the chief endpoints only.
- The catalog must serve `rules-manifest.json` schema v2 with a
  `site-YYYYMMDD-vN` `deployment.site_tag` and per-document
  `formula-<document>-YYYY-vN` `release_tag`. Other release-name formats and a v1
  manifest are rejected, and every rule endpoint returns
  `503 RULE_CATALOG_UNAVAILABLE`.

## Import and verify references

1. In 템플릿 관리, run `규정 연결 가져오기` with the target year's template export.
   The import updates only `rule_refs` and requires an exact `field_key` match;
   a mismatch rejects the whole import without replacing template rows or answers.
2. Review every `needs_review` item. Verify matching clauses or mark items without
   a direct clause as `no_direct_rule` before use.
3. Export the reviewed template and version the JSON in Git.

## When fsk-rules publishes a new release

1. Run `재검증` for the year. Renumbered clauses with an unchanged `content_hash` keep
   `verified` and follow the new anchor; changed or missing clauses drop to
   `needs_review` and their `?` stops opening.
2. Review the `template.rule_refs.revalidate` audit entry: `counts.changed` and
   `counts.missing` list how much needs a chief, and `catalog_site_tag` /
   `catalog_releases` record which deployment was used.
3. Re-verify the dropped items in the UI. Nothing is promoted automatically.

Stable keys are never renamed in fsk-rules; a removed key is declared there in
`retired_rule_keys` and shows up here as `missing`.

## Next competition year

1. Copy the template to the new year. References are carried only when the same
   `field_key` exists, the `rule_key` still exists for the new edition, and the content
   hash is unchanged. Everything else starts as `needs_review`.
2. If the new edition's catalog was not published yet at copy time, run `동기화`
   (`from_year` → `to_year`) once it is; it fills only undecided target items.

## Failure signals

| Signal | Meaning | Action |
|--------|---------|--------|
| `503 RULE_CATALOG_UNAVAILABLE` on rule endpoints, `warn` log `rule_refs.search` / `rule_link.resolve` with `phase: rule_catalog` | Catalog unreachable, too large, slow, or failing schema validation | Check `RULES_BASE_URL`, the Pages deployment, and the manifest schema; the service itself stays healthy |
| `409 INSPECTION_STALE_WRITE` while editing one item's references | Another manager saved after this editor loaded the item | Reopen the item and retry against the winning value shown by the UI; the stale edit was not persisted |
| `409 RULE_REFERENCE_CHANGED` / `RULE_REFERENCE_MISSING` on `/sheet/rule-link` | Stored verified reference no longer matches the catalog | Run `재검증`, then re-verify the item |
| `500 INVALID_STORED_RULE_REFS` | Stored JSON fails validation | Restore the item's `rule_refs` from the last template export; do not hand-edit clause ids or hashes |
