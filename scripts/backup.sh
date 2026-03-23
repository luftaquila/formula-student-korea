#!/usr/bin/env bash
#
# FSK 전체 데이터 백업
#
# 사용법:
#   ./scripts/backup.sh                   # ./backups/ 에 저장
#   ./scripts/backup.sh /path/to/dir      # 지정 디렉토리에 저장
#
# 백업 대상:
#   - 7개 서비스 SQLite DB (online backup API 사용)
#   - FileBrowser DB 및 파일
#   - 제출 서류 파일 (documents/data/uploads)
#   - 규정집 파일 (rules/data)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_NAME="fsk-backup-$TIMESTAMP"
TMPDIR="$(mktemp -d)"

trap 'rm -rf "$TMPDIR"' EXIT

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
  "entry:entry/data/entry.db"
  "queue:queue/data/queue.db"
  "inspection:inspection/data/sheet.db"
  "traffic:traffic/data/traffic.db"
  "score:score/data/score.db"
  "documents:documents/data/documents.db"
)

for entry in "${SQLITE_DBS[@]}"; do
  name="${entry%%:*}"
  dbpath="$ROOT/${entry#*:}"

  if [ ! -f "$dbpath" ]; then
    echo "  skip: $name (DB 없음)"
    continue
  fi

  echo "  backup: $name"
  sqlite3 "$dbpath" ".backup '$TMPDIR/db/$name.db'"
done

# FileBrowser DB (BoltDB — 파일 복사)
FB_DB="$ROOT/filebrowser/data/database.db"
if [ -f "$FB_DB" ]; then
  echo "  backup: filebrowser"
  cp "$FB_DB" "$TMPDIR/db/filebrowser.db"
fi

# --- 2) 파일 데이터 백업 ---
# 제출 서류
if [ -d "$ROOT/documents/data/uploads" ]; then
  echo "  backup: documents/uploads"
  mkdir -p "$TMPDIR/documents"
  cp -a "$ROOT/documents/data/uploads" "$TMPDIR/documents/uploads"
fi

# FileBrowser 파일
if [ -d "$ROOT/filebrowser/data/files" ]; then
  echo "  backup: filebrowser/files"
  mkdir -p "$TMPDIR/filebrowser"
  cp -a "$ROOT/filebrowser/data/files" "$TMPDIR/filebrowser/files"
fi

# 규정집
if [ -d "$ROOT/rules/data" ]; then
  echo "  backup: rules/data"
  cp -a "$ROOT/rules/data" "$TMPDIR/rules"
fi

# --- 3) ZIP 생성 ---
mkdir -p "$DEST"
ZIPFILE="$DEST/$BACKUP_NAME.zip"

(cd "$TMPDIR" && zip -qr "$ZIPFILE" .)

SIZE=$(du -h "$ZIPFILE" | cut -f1)
echo ""
echo "=== 백업 완료: $ZIPFILE ($SIZE) ==="
