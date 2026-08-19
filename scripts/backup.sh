#!/usr/bin/env bash
#
# FSK 전체 데이터 백업
#
# 사용법:
#   ./scripts/backup.sh                   # ./backups/ 에 저장
#   ./scripts/backup.sh /path/to/dir      # 지정 디렉토리에 저장
#
# 백업 대상:
#   - Competition 통합 DB와 지원 서비스 SQLite DB (online backup API 사용)
#   - FileBrowser 관리 파일 트리 (외부 서비스의 비공개 DB는 제외)
#   - 제출 서류 파일 (competition/data/uploads)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/competition-uploads.sh"
DEST="${1:-$ROOT/backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_NAME="fsk-backup-$TIMESTAMP"
TMPDIR="$(mktemp -d)"
COMPETITION_RESUME=0
ARCHIVE_TMPDIR=""

resume_competition() {
  if [ "$COMPETITION_RESUME" = "1" ]; then
    echo "  resume: competition"
    podman start fsk-competition >/dev/null
    COMPETITION_RESUME=0
  fi
}

cleanup() {
  resume_competition || true
  if [ -n "$ARCHIVE_TMPDIR" ]; then rm -rf "$ARCHIVE_TMPDIR"; fi
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

mkdir -p "$DEST"
ZIPFILE="$DEST/$BACKUP_NAME.zip"
if [ -e "$ZIPFILE" ]; then
  echo "error: 백업 파일이 이미 존재합니다: $ZIPFILE" >&2
  exit 1
fi

# sqlite3 필수
if ! command -v sqlite3 &>/dev/null; then
  echo "error: sqlite3 CLI가 필요합니다. (apt install sqlite3)" >&2
  exit 1
fi

echo "=== FSK 백업 시작: $BACKUP_NAME ==="

# --- 1) SQLite DB 백업 (online backup API — WAL 안전) ---
mkdir -p "$TMPDIR/db"

SQLITE_DBS=(
  "auth:auth/data/auth.db"
  "calendar:calendar/data/calendar.db"
  "course:course/data/course.db"
  "email:email/data/email.db"
)

# The Competition DB and uploads form one logical unit. SQLite's online backup
# alone cannot make that unit consistent while submissions are running, so
# quiesce only this container for the short copy window.
COMPETITION_DB="$ROOT/competition/data/competition.db"
COMPETITION_REPORT="$COMPETITION_DB.migration.json"
if [ ! -f "$COMPETITION_DB" ] || [ -L "$COMPETITION_DB" ]; then
  echo "error: Competition DB가 없거나 일반 파일이 아닙니다: $COMPETITION_DB" >&2
  exit 1
fi
for entry in "${SQLITE_DBS[@]}"; do
  name="${entry%%:*}"
  dbpath="$ROOT/${entry#*:}"
  if [ ! -f "$dbpath" ] || [ -L "$dbpath" ]; then
    echo "error: 필수 지원 서비스 DB가 없거나 일반 파일이 아닙니다: $name ($dbpath)" >&2
    exit 1
  fi
done
if command -v podman >/dev/null 2>&1; then
  if [ "$(podman container inspect --format '{{.State.Running}}' fsk-competition 2>/dev/null || true)" = "true" ]; then
    echo "  quiesce: competition"
    podman stop --time 60 fsk-competition >/dev/null
    COMPETITION_RESUME=1
  elif ! podman container inspect fsk-competition >/dev/null 2>&1 \
    && [ "${FSK_BACKUP_ASSUME_QUIESCED:-0}" != "1" ]; then
    echo "error: fsk-competition 컨테이너 상태를 확인할 수 없습니다." >&2
    echo "       Competition writer를 직접 중지했다면 FSK_BACKUP_ASSUME_QUIESCED=1을 명시하세요." >&2
    exit 1
  fi
elif [ "${FSK_BACKUP_ASSUME_QUIESCED:-0}" != "1" ]; then
  echo "error: podman이 없어 Competition writer 중지 여부를 확인할 수 없습니다." >&2
  echo "       writer를 직접 중지했다면 FSK_BACKUP_ASSUME_QUIESCED=1을 명시하세요." >&2
  exit 1
fi

echo "  backup: competition"
sqlite3 "$COMPETITION_DB" ".backup '$TMPDIR/db/competition.db'"
[ ! -f "$COMPETITION_REPORT" ] || cp "$COMPETITION_REPORT" "$TMPDIR/db/competition.db.migration.json"
validate_competition_database "$TMPDIR/db/competition.db"
if [ -f "$TMPDIR/db/competition.db.migration.json" ]; then
  validate_competition_migration_report "$TMPDIR/db/competition.db.migration.json"
fi
COMPETITION_UPLOADS="$ROOT/competition/data/uploads"
# Preserve the runtime's lexical symlink policy. Validating only the copied
# tree could hide a symlink at the configured root itself.
if [ -e "$COMPETITION_UPLOADS" ] || [ -L "$COMPETITION_UPLOADS" ]; then
  validate_competition_uploads "$TMPDIR/db/competition.db" "$COMPETITION_UPLOADS"
fi
mkdir -p "$TMPDIR/competition/uploads"
if [ -d "$COMPETITION_UPLOADS" ]; then
  cp -a "$COMPETITION_UPLOADS/." "$TMPDIR/competition/uploads/"
fi
validate_competition_uploads "$TMPDIR/db/competition.db" "$TMPDIR/competition/uploads"
resume_competition

for entry in "${SQLITE_DBS[@]}"; do
  name="${entry%%:*}"
  dbpath="$ROOT/${entry#*:}"

  echo "  backup: $name"
  sqlite3 "$dbpath" ".backup '$TMPDIR/db/$name.db'"
  validate_support_sqlite_database "$name" "$TMPDIR/db/$name.db"
done
write_required_database_manifest "$TMPDIR/db"
validate_required_database_manifest "$TMPDIR/db"

# FileBrowser is an external service. Preserve only its mounted file payload;
# its private bbolt database and process lifecycle are outside this contract.
FB_FILES="$ROOT/filebrowser/data/files"
if [ -d "$FB_FILES" ]; then
  echo "  backup: filebrowser/files"
  mkdir -p "$TMPDIR/filebrowser"
  cp -a "$FB_FILES" "$TMPDIR/filebrowser/files"
fi

# --- 2) 파일 데이터 백업 ---
# 규정집 (restore.sh가 $TMPDIR/rules → rules/data 로 복원한다)
if [ -d "$ROOT/rules/data" ]; then
  echo "  backup: rules/data"
  cp -a "$ROOT/rules/data" "$TMPDIR/rules"
fi

# --- 3) ZIP 생성 ---
ARCHIVE_TMPDIR="$(mktemp -d "$DEST/.${BACKUP_NAME}.partial.XXXXXX")"
PARTIAL_ARCHIVE="$ARCHIVE_TMPDIR/$BACKUP_NAME.zip"
(cd "$TMPDIR" && zip -qr "$PARTIAL_ARCHIVE" .)
unzip -tq "$PARTIAL_ARCHIVE" >/dev/null

# The second existence check closes the long snapshot/compression window. GNU
# mv -n keeps a concurrently-created destination intact; a remaining source
# means publication was refused. Because both paths are under DEST, a successful
# rename is atomic on the destination filesystem.
if [ -e "$ZIPFILE" ]; then
  echo "error: 백업 파일이 이미 존재합니다: $ZIPFILE" >&2
  exit 1
fi
mv -n -- "$PARTIAL_ARCHIVE" "$ZIPFILE"
if [ -e "$PARTIAL_ARCHIVE" ]; then
  echo "error: 백업 파일이 동시에 생성되어 게시하지 못했습니다: $ZIPFILE" >&2
  exit 1
fi
rmdir "$ARCHIVE_TMPDIR"
ARCHIVE_TMPDIR=""

SIZE=$(du -h "$ZIPFILE" | cut -f1)
echo ""
echo "=== 백업 완료: $ZIPFILE ($SIZE) ==="
