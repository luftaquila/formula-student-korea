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
PROFILE="${PROFILE:-production}"
# caddy 서비스는 프로파일별로 다르다 (production: caddy, local: caddy-local)
CADDY_SVC="caddy"; [ "$PROFILE" = "local" ] && CADDY_SVC="caddy-local"

if [ $# -lt 1 ] || [ ! -f "$1" ]; then
  echo "사용법: $0 <백업 zip 파일>" >&2
  exit 1
fi

ZIPFILE="$(realpath "$1")"
TMPDIR="$(mktemp -d)"

# 스왑 진행 추적: rollback 이 이미 교체한 항목만 원복하도록.
STAGED=()      # .new 로 준비된 라이브 경로들
SWAPPED=()     # 라이브 → .bak, .new → 라이브 까지 끝난 경로들
ARMED=0        # 1인 동안의 오류만 데이터 롤백을 유발 (재시작 실패는 롤백 안 함)

rollback() {
  echo "  !! 복구 중 오류 — 원본으로 롤백합니다..." >&2
  # 끝난 스왑을 역순으로 되돌린다: 새 데이터 제거 후 .bak 복원.
  local i dst
  for (( i=${#SWAPPED[@]}-1; i>=0; i-- )); do
    dst="${SWAPPED[$i]}"
    rm -rf "$dst" "$dst-shm" "$dst-wal" || true
    [ -e "$dst.bak" ] && mv "$dst.bak" "$dst" || true
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
(cd "$ROOT" && podman compose --profile "$PROFILE" down) 2>/dev/null || true

# --- 백업 파일 추출 ---
echo "  백업 파일 추출 중..."
unzip -qo "$ZIPFILE" -d "$TMPDIR"

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
  local dst="$1"
  # 이전 실행이 남긴 .bak(특히 디렉토리: uploads 등)이 있으면 mv 가 그 안으로 중첩 이동해
  # 롤백 시 구조가 어긋난다. 이번 실행의 .bak 를 만들기 전에 잔존분을 먼저 지운다.
  rm -rf "$dst.bak"
  [ -e "$dst" ] && mv "$dst" "$dst.bak"
  # 구 DB 의 WAL/SHM 이 새 DB 에 잘못 붙는 것을 막는다(기존 동작과 동일).
  rm -f "$dst-shm" "$dst-wal"
  mv "$dst.new" "$dst"
  SWAPPED+=("$dst")
}

SERVICES=(
  "auth:auth/data/auth.db"
  "entry:entry/data/entry.db"
  "queue:queue/data/queue.db"
  "inspection:inspection/data/sheet.db"
  "traffic:traffic/data/traffic.db"
  "score:score/data/score.db"
  "documents:documents/data/documents.db"
  "calendar:calendar/data/calendar.db"
  "course:course/data/course.db"
  "email:email/data/email.db"
  "filebrowser:filebrowser/data/database.db"
)

ARMED=1

# --- 2) 전량 스테이징 (라이브 미변경) ---
echo "  백업 데이터 스테이징 중..."
STAGE_LIST=()   # "라이브경로" 목록 (DB + 파일 디렉터리)

for entry in "${SERVICES[@]}"; do
  name="${entry%%:*}"
  dbpath="$ROOT/${entry#*:}"
  backup_db="$TMPDIR/db/$name.db"
  if [ ! -f "$backup_db" ]; then
    echo "  skip: $name (백업에 없음)"
    continue
  fi
  echo "  stage: $name"
  stage "$backup_db" "$dbpath"
  STAGE_LIST+=("$dbpath")
done

# 파일 데이터: 제출 서류 / FileBrowser 파일 / 규정집
if [ -d "$TMPDIR/documents/uploads" ]; then
  echo "  stage: documents/uploads"
  stage "$TMPDIR/documents/uploads" "$ROOT/documents/data/uploads"
  STAGE_LIST+=("$ROOT/documents/data/uploads")
fi
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
echo "    find \"$ROOT\" \\( -name '*.db.bak' -o \\( -type d -name '*.bak' \\) \\)"
