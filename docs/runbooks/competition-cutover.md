# Competition Cutover Runbook

This is the one-time procedure for moving six stopped legacy databases into Competition. The migrator is the only current code that understands legacy schemas.

## Preconditions

1. Record the exact legacy Git revision used for rollback.
2. Create a coordinated, restore-tested backup of all six legacy databases and the Documents upload tree.
3. Stop Entry, Queue, Inspection, Traffic, Score, and Documents writers and keep them stopped.
4. Select six distinct source files. Migration validates their identities and service-specific schemas before creating a target.
5. Choose target database, report, and upload paths that do not exist.

## Migration

```bash
node competition/scripts/migrate.mjs \
  --target /target/competition.db \
  --entry /legacy/entry.db \
  --queue /legacy/queue.db \
  --inspection /legacy/sheet.db \
  --traffic /legacy/traffic.db \
  --score /legacy/score.db \
  --documents /legacy/documents.db \
  --source-uploads /legacy/uploads \
  --target-uploads /target/uploads
```

The migrator opens sources read-only, creates private snapshots, imports teams and vehicle types, binds operational rows to stable team IDs, clears transient Queue/Traffic state for already-inactive teams, and copies only uploads referenced by the Documents database. Unreferenced legacy files and symlinks are ignored.

Before publication it rechecks source data versions and hashes, validates the complete target schema, canonical references, `integrity_check`, `foreign_key_check`, and every referenced upload. Database, uploads, and audit report use create-if-absent publication. The report is retained as migration evidence but is not a runtime identity or startup dependency.

If migration fails, keep writers stopped. Investigate the error and backups, then remove only reviewed incomplete target artifacts. Never modify a source database to make migration pass.

## Deployment gates

1. Deploy only the Competition runtime for the six domains.
2. Verify `/health/live`, `/health/ready`, `/api/health`, and each module's flat `/health` endpoint.
3. Verify the schema validator, SQLite integrity, foreign keys, canonical team references, and referenced uploads.
4. Confirm current KST-year mutations work in Teams and all operational modules.
5. Confirm noncurrent-year mutations fail with `409 YEAR_READ_ONLY` while reads still work.
6. Confirm nested module `/api` paths, standalone module APIs, finalize/snapshot/version routes, and internal team lifecycle routes return `404`.
7. Test module SSE, Inspection stale-write rejection, in-process Score aggregation, auth, a real notification, backup, and restore on the test server.
8. Verify all six legacy deployments remain stopped and retain the pre-cutover backup and Git revision.
9. Promote only with explicit operator approval.

## Rollback

There is no reverse migration.

1. Stop Competition and prevent it from accepting more writes.
2. Restore the coordinated pre-cutover legacy databases and Documents upload tree.
3. Deploy the recorded legacy Git revision and its legacy deployment configuration.
4. Verify all legacy services against the restored data before reopening traffic.

Rollback intentionally discards Competition writes made after cutover. Never point a legacy service at the Competition database or independently restore only one legacy module.
