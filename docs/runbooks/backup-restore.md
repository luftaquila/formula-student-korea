# Competition Backup and Restore Contract

Test and live run as separate k3s clusters managed by `/srv/k3s`. The scheduled jobs
use the Competition image's `create-k3s-backup.mjs` to create and validate the FSK
archive before publishing it:

- `lufthafen` writes timestamped test archives below
  `/mnt/hdd/backups/k3s/fsk/`.
- `luftwolke` atomically publishes the live archive below the dated
  `/srv/backups/` directory on `lufthafen`.

The Compose-oriented `make backup` and `make restore` commands here are not k3s
procedures. There is no supported k3s restore until `/srv/k3s` implements and
restore-tests every restore gate below for the target environment.

## Required backup unit

A backup must contain exactly one coordinated application state:

- `competition.db` and its Documents upload tree
- Auth, Calendar, Course, and Email SQLite databases
- an exact manifest identifying every required database
- FileBrowser's mounted payload when present; its private database remains outside
  the Competition consistency contract

The Competition database and uploads are one consistency unit. Quiesce Competition
or use another reviewed mechanism that prevents database metadata and copied files
from diverging. Use SQLite's online backup API for live databases; do not copy only
the main database file while WAL writes can continue.

## Backup gates

Before publishing an archive:

1. Validate the exact database manifest and complete schemas.
2. Run SQLite integrity and foreign-key checks.
3. Validate canonical `competition_team` references.
4. Reject missing, escaping, or symlinked referenced uploads.
5. Verify the archive can be read and record its hash, source environment, and
   creation time.

Any missing member or failed check rejects the backup. Never modify a source database
to make validation pass.

## Restore gates

1. Extract into a private staging directory without touching live data.
2. Run all backup gates against the staged state.
3. Stop the k3s writers only after staging passes.
4. Replace the complete coordinated unit, with a reviewed rollback path for a
   partial filesystem failure.
5. Restart through the `/srv/k3s` workflow and verify readiness, authenticated
   reads, a current KST-year mutation, historical read-only behavior, and referenced
   uploads.

Validation must fail closed before any live artifact is replaced. Never restore one
Competition module or one supporting database independently.
