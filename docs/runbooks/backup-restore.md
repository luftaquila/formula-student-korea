# Competition Backup and Restore Runbook

Competition data is one consistency unit: the SQLite database and Documents upload tree. Auth, Calendar, Course, and Email are required members of the coordinated database set. FileBrowser remains an external service; this procedure preserves its mounted file tree but does not inspect, quiesce, back up, or restore its private bbolt database. A migration report may be retained beside a backup as audit evidence, but backup and restore do not bind database identity to that report.

## Backup

```bash
make backup
make backup DEST=/mnt/nas
```

`scripts/backup.sh` briefly stops `fsk-competition` while copying the database and uploads, then resumes it on every exit only when the script stopped it. If the Competition writer was stopped outside Podman, the operator must explicitly set `FSK_BACKUP_ASSUME_QUIESCED=1`. The FileBrowser file-tree copy is an external-service payload copy and does not claim database/tree point-in-time consistency.

Before publishing an archive, the script requires the fixed Competition/Auth/Calendar/Course/Email database manifest and performs read-only, fail-closed validation of their complete runtime schemas (columns, defaults, constraints, foreign keys, indexes, and triggers), `integrity_check`, `foreign_key_check`, canonical team references, and every file referenced by `submission_file`. Referenced paths must remain below the upload root and resolve to non-symlink regular files. Missing databases or unsafe references reject the backup. Unreferenced Documents files are not part of the logical dataset and startup cleanup removes them.

Retain command output, archive hash, creation time, source environment, and restore-test evidence.

## Restore

```bash
make restore ZIP=backups/fsk-backup-YYYYMMDD-HHMMSS.zip
```

Restore extracts into a private staging directory and requires the exact database manifest before running the same Competition, support-service, and upload validation ahead of stopping any live service. Validation failure leaves live data untouched, and a missing required database can never retain a newer live database beside restored Competition state. After validation, it stops the stack and replaces each staged required database and included file tree. A failed staged rename restores the original live set from `.bak`.

## Post-restore verification

1. Verify Competition starts and `/health/ready` succeeds.
2. Check each module's flat `/health` endpoint.
3. Run SQLite `integrity_check`, `foreign_key_check`, and the canonical-reference audit.
4. Verify every referenced upload is readable.
5. Verify historical years are readable and immutable.
6. Verify a representative current KST-year write and authenticated document download.
7. Record the restored archive and verification evidence.

This runbook restores Competition backups. To return to the legacy application, use the rollback procedure in the cutover runbook: stop Competition, restore the coordinated pre-cutover legacy backup, and deploy the recorded legacy Git revision.
