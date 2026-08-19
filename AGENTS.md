# Agent Working Agreements

- Report findings, progress, and results to the user in Korean.
- Preserve unrelated user changes and use focused, reviewable commits.
- Add or update deterministic tests for every behavior change. Do not use fixed sleeps for API or SSE synchronization.
- Treat `competition_team.id` as the stable team identity and `competition_team` as the only team source of truth.
- Use `Asia/Seoul` for competition-year decisions. Allow reads for any year and mutations only for the current KST year; do not add draft/finalize, roster snapshots, numeric roster versions, or soft-delete inference.
- Keep Competition modules in one runtime. Do not add standalone legacy profiles, compatibility APIs, live roster propagation, team-list copies, HTTP fan-out, lifecycle outboxes, reconciliation, or reverse migration.
- Keep Inspection stale-write protection value-based: compare the caller's last-read value, reject mismatches without persistence, and do not add numeric answer/memo versions or local-storage drafts.
- Clean Documents orphan uploads synchronously before readiness. Do not add a background file-delete job, and copy only database-referenced uploads during legacy migration.
- Never mutate migration source databases. Migration, backup, and restore validation must fail closed before publishing or replacing artifacts.
- Log every successful mutation and every business, database, or integration failure with enough before/after context to audit destructive changes.
- Pull request titles, descriptions, and comments must be written in English.

See [CONTRIBUTING.md](CONTRIBUTING.md) for commands, testing, and logging details.
