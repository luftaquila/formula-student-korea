#!/usr/bin/env bash
#
# FSK 전체 데이터 복구
#
# 사용법:
#   ./scripts/restore.sh backups/fsk-backup-20260323-120000.zip
#
# 복구 절차:
#   1. 모든 서비스 중지
#   2. 기존 DB/파일을 .bak 으로 보존
#   3. 백업 데이터 복원
#   4. 서비스 재시작
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${PROFILE:-production}"

if [ $# -lt 1 ] || [ ! -f "$1" ]; then
  echo "사용법: $0 <백업 zip 파일>" >&2
  exit 1
fi

ZIPFILE="$(realpath "$1")"
TMPDIR="$(mktemp -d)"

trap 'rm -rf "$TMPDIR"' EXIT

echo "=== FSK 복구 시작: $(basename "$ZIPFILE") ==="

# --- 1) 서비스 중지 ---
echo "  서비스 중지 중..."
(cd "$ROOT" && podman compose --profile "$PROFILE" down) 2>/dev/null || true

# --- 2) 백업 파일 추출 ---
echo "  백업 파일 추출 중..."
unzip -qo "$ZIPFILE" -d "$TMPDIR"

# --- 3) DB 복원 ---
SERVICES=(
  "auth:auth/data/auth.db"
  "entry:entry/data/entry.db"
  "queue:queue/data/queue.db"
  "inspection:inspection/data/sheet.db"
  "traffic:traffic/data/traffic.db"
  "score:score/data/score.db"
  "documents:documents/data/documents.db"
  "filebrowser:filebrowser/data/database.db"
)

for entry in "${SERVICES[@]}"; do
  name="${entry%%:*}"
  dbpath="$ROOT/${entry#*:}"
  backup_db="$TMPDIR/db/$name.db"

  if [ ! -f "$backup_db" ]; then
    echo "  skip: $name (백업에 없음)"
    continue
  fi

  echo "  restore: $name"
  mkdir -p "$(dirname "$dbpath")"

  if [ -f "$dbpath" ]; then
    mv "$dbpath" "$dbpath.bak"
    rm -f "$dbpath-shm" "$dbpath-wal"
  fi

  cp "$backup_db" "$dbpath"
done

# --- 4) 파일 데이터 복원 ---
# 제출 서류
if [ -d "$TMPDIR/documents/uploads" ]; then
  echo "  restore: documents/uploads"
  target="$ROOT/documents/data/uploads"
  [ -d "$target" ] && mv "$target" "$target.bak"
  mkdir -p "$(dirname "$target")"
  cp -a "$TMPDIR/documents/uploads" "$target"
fi

# FileBrowser 파일
if [ -d "$TMPDIR/filebrowser/files" ]; then
  echo "  restore: filebrowser/files"
  target="$ROOT/filebrowser/data/files"
  [ -d "$target" ] && mv "$target" "$target.bak"
  mkdir -p "$(dirname "$target")"
  cp -a "$TMPDIR/filebrowser/files" "$target"
fi

# 규정집
if [ -d "$TMPDIR/rules" ]; then
  echo "  restore: rules/data"
  target="$ROOT/rules/data"
  [ -d "$target" ] && mv "$target" "$target.bak"
  cp -a "$TMPDIR/rules" "$target"
fi

# --- 5) 서비스 재시작 ---
echo "  서비스 재시작 중..."
(cd "$ROOT" && podman compose --profile "$PROFILE" up -d --force-recreate)
(cd "$ROOT" && podman compose --profile "$PROFILE" restart caddy) 2>/dev/null || true

echo ""
echo "=== 복구 완료 ==="
echo "  기존 데이터는 .bak 으로 보존되었습니다."
echo "  확인 후 .bak 파일을 삭제하세요:"
echo "    find $ROOT -name '*.db.bak' -o -name '*.bak' -type d | head -20"
