#!/usr/bin/env bash
#
# FSK 전체 데이터 복구
#
# 사용법:
#   ./scripts/restore.sh backups/fsk-backup-20260323-120000.zip
#
# 복구 절차:
#   1. 모든 서비스 중지
#   2. 백업 데이터를 라이브 위치 옆에 .new 로 전량 스테이징 (라이브 미변경)
#   3. 스테이징이 전부 성공하면 원자적으로 스왑 (라이브 → .bak, .new → 라이브)
#   4. 서비스 재시작
#
# 정합성: 복사(디스크 풀·권한 오류가 나는 지점)는 전부 2단계에서 .new 로만 이뤄지므로,
# 도중에 실패해도 라이브 원본은 손대지 않은 상태로 남는다. 3단계 스왑(빠른 rename) 중
# 실패하면 이미 끝난 스왑을 .bak 에서 자동 롤백하고 원본으로 서비스를 다시 올린다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/competition-uploads.sh"
PROFILE="${PROFILE:-production}"
# caddy 서비스는 프로파일별로 다르다 (production: caddy, local: caddy-local)
CADDY_SVC="caddy"; [ "$PROFILE" = "local" ] && CADDY_SVC="caddy-local"

if [ $# -lt 1 ] || [ ! -f "$1" ]; then
  echo "사용법: $0 <백업 zip 파일>" >&2
  exit 1
fi

ZIPFILE="$(realpath "$1")"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Read the central-directory listing to completion before searching it. With
# `set -o pipefail`, `unzip -Z1 | grep -q` can make unzip exit on SIGPIPE as
# soon as grep finds an early match, turning a valid large archive into a
# false negative.
ARCHIVE_ENTRIES="$TMPDIR/archive-entries.txt"
unzip -Z1 "$ZIPFILE" > "$ARCHIVE_ENTRIES"

# A legacy-only backup cannot be restored into the modular runtime by copying
# six unrelated DBs into place. It must first go through the reviewed,
# read-only-source Competition migration so stable team IDs and upload paths are
# created together. Reject it before stopping any running service.
if ! grep -Fxq "db/competition.db" "$ARCHIVE_ENTRIES"; then
  echo "error: Competition DB가 없는 레거시 백업입니다. 먼저 competition/scripts/migrate.mjs로 변환하세요." >&2
  rm -rf "$TMPDIR"
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 CLI가 필요합니다. (apt install sqlite3)" >&2
  rm -rf "$TMPDIR"
  exit 1
fi

# Validate the archive before stopping any service. A missing uploads tree is
# only safe when the restored DB has no file metadata; normalize that case to
# an explicit empty directory so stale live files are not retained.
echo "  백업 파일 사전 검증 중..."
unzip -qo "$ZIPFILE" -d "$TMPDIR"
validate_required_database_manifest "$TMPDIR/db"
validate_competition_database "$TMPDIR/db/competition.db"
if [ -f "$TMPDIR/db/competition.db.migration.json" ]; then
  validate_competition_migration_report "$TMPDIR/db/competition.db.migration.json"
fi
COMPETITION_FILE_ROWS=0
if [ "$(sqlite3 "$TMPDIR/db/competition.db" \
  "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='submission_file';")" -gt 0 ]; then
  COMPETITION_FILE_ROWS="$(sqlite3 "$TMPDIR/db/competition.db" "SELECT COUNT(*) FROM submission_file;")"
fi
if [ ! -d "$TMPDIR/competition/uploads" ]; then
  if [ "$COMPETITION_FILE_ROWS" -ne 0 ]; then
    echo "error: 제출 파일 메타데이터는 있지만 competition/uploads가 없는 백업입니다." >&2
    exit 1
  fi
  mkdir -p "$TMPDIR/competition/uploads"
fi
validate_competition_uploads "$TMPDIR/db/competition.db" "$TMPDIR/competition/uploads"

# Every database that can be swapped below must pass its own read-only
# preflight before compose down or any live path access.
for name in auth calendar course email; do
  support_db="$TMPDIR/db/$name.db"
  validate_support_sqlite_database "$name" "$support_db"
done

# 스왑 진행 추적: 첫 rename 직후부터 rollback 대상이다. 두 번째 rename이
# 실패해도 이미 .bak 으로 옮긴 원본을 반드시 복원해야 한다.
STAGED=()          # .new 로 준비된 라이브 경로들
SWAP_STARTED=()    # live 존재 여부를 기록한 뒤 swap을 시작한 경로들
SWAP_HAD_LIVE=()   # 같은 인덱스의 경로에 원본 live가 있었으면 1
ARMED=0            # 1인 동안의 오류만 데이터 롤백을 유발 (재시작 실패는 롤백 안 함)

rollback() {
  echo "  !! 복구 중 오류 — 원본으로 롤백합니다..." >&2
  # 시작한 스왑을 역순으로 되돌린다. 두 번째 rename 전 실패한 부분
  # 스왑도 포함하며, 원래 live가 없었던 경로는 다시 없는 상태로 둔다.
  local i dst
  for (( i=${#SWAP_STARTED[@]}-1; i>=0; i-- )); do
    dst="${SWAP_STARTED[$i]}"
    rm -rf "$dst" "$dst-shm" "$dst-wal" || true
    if [ "${SWAP_HAD_LIVE[$i]}" = "1" ]; then
      [ -e "$dst.bak" ] && mv "$dst.bak" "$dst" || true
    else
      rm -rf "$dst.bak" || true
    fi
  done
  # 스테이징만 되고 스왑 전인 .new 정리.
  for dst in "${STAGED[@]}"; do
    rm -rf "$dst.new" || true
  done
  echo "  원본 데이터를 유지했습니다. 서비스를 재시작합니다." >&2
  (cd "$ROOT" && podman compose --profile "$PROFILE" up -d) 2>/dev/null || true
}

on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$ARMED" = "1" ]; then rollback; fi
  rm -rf "$TMPDIR"
}
trap on_exit EXIT

echo "=== FSK 복구 시작: $(basename "$ZIPFILE") ==="

# --- 1) 서비스 중지 ---
echo "  서비스 중지 중..."
if ! (cd "$ROOT" && podman compose --profile "$PROFILE" down); then
  echo "error: 서비스 중지에 실패했습니다. 라이브 데이터는 변경하지 않았습니다." >&2
  exit 1
fi
RUNNING_SERVICES="$(cd "$ROOT" && podman compose --profile "$PROFILE" ps --services --filter status=running)"
if [ -n "$RUNNING_SERVICES" ]; then
  echo "error: 중지되지 않은 서비스가 있습니다. 라이브 데이터는 변경하지 않았습니다:" >&2
  printf '  %s\n' "$RUNNING_SERVICES" >&2
  exit 1
fi

# 라이브 옆에 .new 로 복사(스테이징). 실패하면 set -e + on_exit 롤백.
stage() {  # $1 = 원본 경로, $2 = 라이브 대상 경로
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  rm -rf "$dst.new"
  cp -a "$src" "$dst.new"
  STAGED+=("$dst")
}

# 원자적 스왑: 라이브 → .bak, .new → 라이브. rename 이라 빠르고 실패 창이 작다.
swap() {  # $1 = 라이브 대상 경로
  local dst="$1" had_live=0
  # 이전 실행이 남긴 .bak(특히 디렉토리: uploads 등)이 있으면 mv 가 그 안으로 중첩 이동해
  # 롤백 시 구조가 어긋난다. 이번 실행의 .bak 를 만들기 전에 잔존분을 먼저 지운다.
  rm -rf "$dst.bak"
  if [ -e "$dst" ]; then
    mv "$dst" "$dst.bak"
    had_live=1
  fi
  # From this point rollback owns the destination even if .new -> live fails.
  SWAP_STARTED+=("$dst")
  SWAP_HAD_LIVE+=("$had_live")
  # 구 DB 의 WAL/SHM 이 새 DB 에 잘못 붙는 것을 막는다(기존 동작과 동일).
  rm -f "$dst-shm" "$dst-wal"
  mv "$dst.new" "$dst"
}

SERVICES=(
  "auth:auth/data/auth.db"
  "competition:competition/data/competition.db"
  "calendar:calendar/data/calendar.db"
  "course:course/data/course.db"
  "email:email/data/email.db"
)

ARMED=1

# --- 2) 전량 스테이징 (라이브 미변경) ---
echo "  백업 데이터 스테이징 중..."
STAGE_LIST=()   # "라이브경로" 목록 (DB + 파일 디렉터리)

for entry in "${SERVICES[@]}"; do
  name="${entry%%:*}"
  dbpath="$ROOT/${entry#*:}"
  backup_db="$TMPDIR/db/$name.db"
  echo "  stage: $name"
  stage "$backup_db" "$dbpath"
  STAGE_LIST+=("$dbpath")
done

if [ -f "$TMPDIR/db/competition.db.migration.json" ]; then
  echo "  stage: competition migration report (audit only)"
  stage "$TMPDIR/db/competition.db.migration.json" "$ROOT/competition/data/competition.db.migration.json"
  STAGE_LIST+=("$ROOT/competition/data/competition.db.migration.json")
fi

# 파일 데이터: 제출 서류 / FileBrowser 파일 / 규정집
echo "  stage: competition/uploads"
stage "$TMPDIR/competition/uploads" "$ROOT/competition/data/uploads"
STAGE_LIST+=("$ROOT/competition/data/uploads")
if [ -d "$TMPDIR/filebrowser/files" ]; then
  echo "  stage: filebrowser/files"
  stage "$TMPDIR/filebrowser/files" "$ROOT/filebrowser/data/files"
  STAGE_LIST+=("$ROOT/filebrowser/data/files")
fi
if [ -d "$TMPDIR/rules" ]; then
  echo "  stage: rules/data"
  stage "$TMPDIR/rules" "$ROOT/rules/data"
  STAGE_LIST+=("$ROOT/rules/data")
fi

# --- 3) 원자적 스왑 (전부 스테이징 성공 후에만) ---
echo "  라이브 데이터로 스왑 중..."
for dst in "${STAGE_LIST[@]}"; do
  swap "$dst"
done

# 데이터 복구 완료 — 이후(재시작) 실패는 데이터 롤백을 유발하지 않는다.
ARMED=0

# --- 4) 서비스 재시작 ---
echo "  서비스 재시작 중..."
(cd "$ROOT" && podman compose --profile "$PROFILE" up -d --force-recreate)
(cd "$ROOT" && podman compose --profile "$PROFILE" restart "$CADDY_SVC") 2>/dev/null || true

echo ""
echo "=== 복구 완료 ==="
echo "  기존 데이터는 .bak 으로 보존되었습니다."
echo "  확인 후 .bak 파일을 삭제하세요:"
echo "    find \"$ROOT\" -name '*.bak'"
