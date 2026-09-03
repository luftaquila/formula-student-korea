# Inspection Rule Links Rollout and Operation

Inspection items link to rulebook clauses through `sheet_template.rule_refs`. Links are
resolved at request time against the fsk-rules catalog published on GitHub Pages; nothing
is stored except the stable `rule_key`, the resolving `release_tag`, and the clause
metadata copied from the catalog at verification time.

## Prerequisites

- `RULES_BASE_URL` points at the catalog origin (`/srv/k3s` configmaps, both clusters).
  The catalog is fetched with a 3 s timeout, a 5 MB cap, and a ten-minute cache. It is
  not part of readiness: an outage disables rule links and the chief endpoints only.
- The catalog must serve `rules-manifest.json` schema v2 with `deployment.site_tag`
  and per-document `release_tag`. A v1 manifest is rejected and every rule endpoint
  returns `503 RULE_CATALOG_UNAVAILABLE`.

## First rollout of a year

1. Deploy the Competition image that contains the feature together with the configmap
   change. The `rule_refs` column is added on startup with `needs_review` for every item.
2. A chief opens 템플릿 관리 and runs `규정 연결 가져오기` with the current template export
   (`.github/inspection-template-2026.json` for 2026). The import only touches
   `rule_refs`; it fails as a whole unless the file's `field_key` set matches the stored
   template exactly, and it never replaces template rows or answers.
3. The shipped candidates are all `needs_review`, so no `?` button opens yet. The chief
   verifies each item: pick the clause(s), save as `verified`, or mark `직접 대응 규정 없음`.
   Items with no normative clause (weights, contact data, recorded values without a
   limit) stay without references.
4. Export the template afterwards and commit the JSON so the verified state is versioned.

## When fsk-rules publishes a new release

A new document revision (`formula-*-2026-rN`) or site tag changes the catalog:

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
| `409 RULE_REFERENCE_CHANGED` / `RULE_REFERENCE_MISSING` on `/sheet/rule-link` | Stored verified reference no longer matches the catalog | Run `재검증`, then re-verify the item |
| `500 INVALID_STORED_RULE_REFS` | Stored JSON fails validation | Restore the item's `rule_refs` from the last template export; do not hand-edit clause ids or hashes |
