#!/usr/bin/env bash

REQUIRED_DATABASE_NAMES=(competition auth calendar course email)

required_database_manifest_contents() {
  printf '%s\n' \
    'format=fsk-required-databases-v1' \
    'competition.db' \
    'auth.db' \
    'calendar.db' \
    'course.db' \
    'email.db'
}

write_required_database_manifest() {
  local database_dir="$1"
  required_database_manifest_contents > "$database_dir/required-databases.txt"
}

validate_required_database_manifest() {
  local database_dir="$1"
  local manifest="$database_dir/required-databases.txt"
  local expected actual name database
  if [ ! -f "$manifest" ] || [ -L "$manifest" ]; then
    echo "error: 필수 DB manifest가 없거나 일반 파일이 아닙니다: $manifest" >&2
    return 1
  fi
  expected="$(required_database_manifest_contents)"
  actual="$(cat "$manifest")"
  if [ "$actual" != "$expected" ]; then
    echo "error: 필수 DB manifest가 지원되는 런타임 집합과 일치하지 않습니다: $manifest" >&2
    return 1
  fi
  for name in "${REQUIRED_DATABASE_NAMES[@]}"; do
    database="$database_dir/$name.db"
    if [ ! -f "$database" ] || [ -L "$database" ]; then
      echo "error: 필수 DB가 없거나 일반 파일이 아닙니다: $database" >&2
      return 1
    fi
  done
}

# Shared fail-closed validation for Competition backup and restore artifacts.
validate_competition_database() {
  local database="$1"
  local validator="$ROOT/competition/scripts/validate-database.mjs"
  local image

  if [ ! -f "$database" ] || [ -L "$database" ]; then
    echo "error: Competition DB가 일반 파일이 아닙니다: $database" >&2
    return 1
  fi

  # Developer checkouts may have the native dependency locally. Deployment
  # checkouts intentionally need not: use the exact installed Competition
  # image there so backup/restore do not depend on host package-manager state.
  if command -v node >/dev/null 2>&1 \
    && [ -d "$ROOT/competition/node_modules/better-sqlite3" ]; then
    node "$validator" "$database"
    return
  fi

  if ! command -v podman >/dev/null 2>&1; then
    echo "error: Competition DB 전체 검증을 실행할 Node 의존성 또는 Podman 이미지가 없습니다." >&2
    return 1
  fi
  image="${COMPETITION_VALIDATOR_IMAGE:-$(podman container inspect --format '{{.ImageName}}' fsk-competition 2>/dev/null || true)}"
  image="${image:-ghcr.io/luftaquila/formula-student-korea/competition:latest}"
  podman run --rm --network none --read-only --security-opt label=disable \
    --entrypoint node \
    --volume "$database:/validation/competition.db:ro" \
    "$image" competition/scripts/validate-database.mjs /validation/competition.db
}
validate_competition_migration_report() {
  local report="$1"
  local report_sql report_identity report_schema report_id report_completed report_sha extra

  if [ ! -f "$report" ]; then
    return 0
  fi
  report_sql="${report//\'/\'\'}"
  report_identity="$(sqlite3 -tabs :memory: "
    SELECT json_extract(document, '$.schemaVersion'),
           json_extract(document, '$.migrationId'),
           json_extract(document, '$.completedAt'),
           json_extract(document, '$.target.sha256')
    FROM (SELECT CAST(readfile('$report_sql') AS TEXT) AS document)
    WHERE json_valid(document);")"
  IFS=$'\t' read -r report_schema report_id report_completed report_sha extra <<< "$report_identity"
  if { [ "$report_schema" != "1" ] && [ "$report_schema" != "2" ]; } \
    || [[ ! "$report_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] \
    || [[ ! "$report_completed" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] \
    || [[ ! "$report_sha" =~ ^[0-9a-f]{64}$ ]] \
    || [ -n "${extra:-}" ]; then
    echo "error: Competition migration report 형식이 올바르지 않습니다: $report" >&2
    return 1
  fi

}

# Support-service databases are restored beside Competition and must be proven
# readable before an archive is published or any live service is stopped.
validate_support_sqlite_database() {
  local service="$1"
  local database="$2"
  local validator="$ROOT/competition/scripts/validate-support-database.mjs"
  local image

  case "$service" in
    auth|calendar|course|email) ;;
    *)
      echo "error: 알 수 없는 지원 서비스 DB 검증 대상입니다: $service" >&2
      return 1
      ;;
  esac
  if [ ! -f "$database" ] || [ -L "$database" ]; then
    echo "error: $service DB가 일반 파일이 아닙니다: $database" >&2
    return 1
  fi
  if command -v node >/dev/null 2>&1 \
    && [ -d "$ROOT/competition/node_modules/better-sqlite3" ]; then
    if node "$validator" "$service" "$database"; then return 0; fi
    echo "error: $service DB 전체 런타임 스키마 검증에 실패했습니다: $database" >&2
    return 1
  fi
  if ! command -v podman >/dev/null 2>&1; then
    echo "error: $service DB 전체 검증을 실행할 Node 의존성 또는 Podman 이미지가 없습니다." >&2
    return 1
  fi
  image="${COMPETITION_VALIDATOR_IMAGE:-$(podman container inspect --format '{{.ImageName}}' fsk-competition 2>/dev/null || true)}"
  image="${image:-ghcr.io/luftaquila/formula-student-korea/competition:latest}"
  if podman run --rm --network none --read-only --security-opt label=disable \
    --entrypoint node \
    --volume "$database:/validation/database.db:ro" \
    "$image" competition/scripts/validate-support-database.mjs "$service" /validation/database.db; then
    return 0
  fi
  echo "error: $service DB 전체 런타임 스키마 검증에 실패했습니다: $database" >&2
  return 1
}

assert_existing_path_components_are_not_symlinks() {
  local target="$1"
  local description="$2"
  local path_cursor="/"
  local remaining component

  remaining="${target#/}"
  while [ -n "$remaining" ]; do
    component="${remaining%%/*}"
    if [ "$remaining" = "$component" ]; then
      remaining=""
    else
      remaining="${remaining#*/}"
    fi
    path_cursor="$path_cursor$component"
    if [ -L "$path_cursor" ]; then
      echo "error: $description 경로에 심볼릭 링크가 있습니다: $path_cursor" >&2
      return 1
    fi
    if [ ! -e "$path_cursor" ]; then
      return 0
    fi
    path_cursor="$path_cursor/"
  done
}

validate_competition_uploads() {
  local database="$1"
  local upload_root="$2"
  local required_tables invalid_metadata referenced_rows upload_root_real upload_root_lexical
  local submission_listing storage_target_lexical storage_relative
  local listing seen id storage_dir stored_name extra candidate candidate_lexical target_real relative

  required_tables="$(sqlite3 "$database" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('submission','submission_file');")"
  if [ "$required_tables" -ne 2 ]; then
    echo "error: Competition DB에 제출 파일 검증용 테이블이 없습니다." >&2
    return 1
  fi

  invalid_metadata="$(sqlite3 "$database" "
    SELECT COUNT(*)
    FROM (
      SELECT 'submission:' || id AS row_key
      FROM submission
      WHERE typeof(storage_dir) != 'text'
         -- Keep blank-path semantics identical to ECMAScript String.trim().
         OR length(trim(storage_dir,
              char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
              || char(160) || char(5760)
              || char(8192) || char(8193) || char(8194) || char(8195)
              || char(8196) || char(8197) || char(8198) || char(8199)
              || char(8200) || char(8201) || char(8202)
              || char(8232) || char(8233) || char(8239) || char(8287)
              || char(12288) || char(65279)
            )) = 0
         OR substr(storage_dir, 1, 1) = '/'
         OR instr(storage_dir, char(9)) > 0 OR instr(storage_dir, char(10)) > 0
         OR instr(storage_dir, char(13)) > 0 OR instr(storage_dir, char(0)) > 0
      UNION ALL
      SELECT 'submission_file:' || f.id AS row_key
      FROM submission_file f
      LEFT JOIN submission s ON s.id = f.submission_id
      WHERE s.id IS NULL
         OR typeof(f.stored_name) != 'text' OR length(f.stored_name) = 0
         OR instr(f.stored_name, '/') > 0
         OR instr(f.stored_name, char(9)) > 0 OR instr(f.stored_name, char(10)) > 0
         OR instr(f.stored_name, char(13)) > 0 OR instr(f.stored_name, char(0)) > 0
    );")"
  if [ "$invalid_metadata" -ne 0 ]; then
    echo "error: 경로를 검증할 수 없는 제출 파일 메타데이터가 ${invalid_metadata}건 있습니다." >&2
    return 1
  fi

  # Documents rejects symbolic links in the configured root and every existing
  # ancestor before cleanup. Preserve the lexical path here so realpath cannot
  # hide an ancestor link before backup/restore validation sees it.
  upload_root_lexical="$(realpath -ms -- "$upload_root")"
  if ! assert_existing_path_components_are_not_symlinks "$upload_root_lexical" "업로드 디렉터리"; then
    return 1
  fi
  if [ ! -d "$upload_root_lexical" ]; then
    echo "error: 안전한 업로드 디렉터리가 없습니다: $upload_root" >&2
    return 1
  fi
  upload_root_real="$(realpath -e -- "$upload_root_lexical")"
  if [ "$upload_root_real" = "/" ]; then
    echo "error: 업로드 루트로 파일시스템 루트를 사용할 수 없습니다." >&2
    return 1
  fi

  submission_listing="$(mktemp)"
  if ! sqlite3 -tabs "$database" "
    SELECT id, storage_dir
    FROM submission
    ORDER BY id;" > "$submission_listing"; then
    rm -f "$submission_listing"
    return 1
  fi
  while IFS=$'\t' read -r id storage_dir extra; do
    if [ -n "${extra:-}" ]; then
      echo "error: 제출 저장 경로 메타데이터를 안전하게 구분할 수 없습니다: submission $id" >&2
      rm -f "$submission_listing"
      return 1
    fi
    storage_target_lexical="$(realpath -ms -- "$upload_root_lexical/$storage_dir")"
    storage_relative="$(realpath -ms --relative-to="$upload_root_lexical" -- "$storage_target_lexical")"
    if [ "$storage_relative" = "." ]; then
      echo "error: 제출 저장 경로가 업로드 루트 자체입니다: submission $id" >&2
      rm -f "$submission_listing"
      return 1
    fi
    if [ "$storage_relative" = ".." ] || [[ "$storage_relative" == ../* ]]; then
      echo "error: 제출 저장 경로가 루트를 벗어납니다: submission $id" >&2
      rm -f "$submission_listing"
      return 1
    fi
    if ! assert_existing_path_components_are_not_symlinks "$storage_target_lexical" "제출 저장"; then
      echo "error: submission $id" >&2
      rm -f "$submission_listing"
      return 1
    fi
  done < "$submission_listing"
  rm -f "$submission_listing"

  referenced_rows="$(sqlite3 "$database" "SELECT COUNT(*) FROM submission_file;")"
  if [ "$referenced_rows" -eq 0 ]; then
    return 0
  fi

  listing="$(mktemp)"
  if ! sqlite3 -tabs "$database" "
    SELECT f.id, s.storage_dir, f.stored_name
    FROM submission_file f
    JOIN submission s ON s.id = f.submission_id
    ORDER BY f.id;" > "$listing"; then
    rm -f "$listing"
    return 1
  fi

  seen=0
  while IFS=$'\t' read -r id storage_dir stored_name extra; do
    if [ -n "${extra:-}" ]; then
      echo "error: 제출 파일 경로 메타데이터를 안전하게 구분할 수 없습니다: submission_file $id" >&2
      rm -f "$listing"
      return 1
    fi
    candidate="$upload_root_real/$storage_dir/$stored_name"
    candidate_lexical="$(realpath -ms -- "$candidate")"
    relative="$(realpath -ms --relative-to="$upload_root_real" -- "$candidate_lexical")"
    if [ "$relative" = "." ] || [ "$relative" = ".." ] || [[ "$relative" == ../* ]]; then
      echo "error: 참조된 업로드 경로가 루트를 벗어납니다: submission_file $id" >&2
      rm -f "$listing"
      return 1
    fi
    if ! assert_existing_path_components_are_not_symlinks "$candidate_lexical" "참조된 업로드"; then
      echo "error: submission_file $id ($relative)" >&2
      rm -f "$listing"
      return 1
    fi
    if ! target_real="$(realpath -e -- "$candidate_lexical" 2>/dev/null)"; then
      echo "error: 참조된 업로드가 없습니다: submission_file $id ($relative)" >&2
      rm -f "$listing"
      return 1
    fi
    case "$target_real" in
      "$upload_root_real"/*) ;;
      *)
        echo "error: 참조된 업로드의 실제 경로가 루트를 벗어납니다: submission_file $id" >&2
        rm -f "$listing"
        return 1
        ;;
    esac
    if [ ! -f "$target_real" ]; then
      echo "error: 참조된 업로드가 일반 파일이 아닙니다: submission_file $id ($relative)" >&2
      rm -f "$listing"
      return 1
    fi
    seen=$((seen + 1))
  done < "$listing"
  rm -f "$listing"

  if [ "$seen" -ne "$referenced_rows" ]; then
    echo "error: 제출 파일 검증 건수가 일치하지 않습니다: metadata=$referenced_rows verified=$seen" >&2
    return 1
  fi
}
