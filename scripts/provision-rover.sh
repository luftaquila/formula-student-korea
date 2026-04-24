#!/bin/sh
# Provision a freshly-flashed rover end-to-end from the admin machine.
#
# Usage:
#   scripts/provision-rover.sh <rover-ip-or-host> [--ntrip-username=<id>]
#
# The script:
#   1. SSHes in as `fsk` (key auth set up by the image's system-user assertion),
#   2. connects the hardware plugs the pilot snap needs (network-setup-control,
#      raw-usb) — stock Ubuntu Core does not auto-connect these,
#   3. pushes `server-url`, `internal-secret`, and `ntrip-username` via
#      `snap set` (reading INTERNAL_SECRET and PUBLIC_URL from the repo's
#      .env so the values never have to be pasted),
#   4. restarts the pilot daemon.
#
# Re-running against the same rover is safe — `snap connect` and `snap set`
# no-op when the target state is already in place.

set -eu

usage() {
    cat >&2 <<EOF
usage: $(basename "$0") <rover-ip-or-host> [--ntrip-username=<id>]

Requires:
  - <repo>/.env with INTERNAL_SECRET and PUBLIC_URL
  - SSH key auth for fsk@<rover> (images built from this repo seed that).
EOF
    exit 2
}

HOST=""
NTRIP_USER=""
for arg in "$@"; do
    case "$arg" in
        --ntrip-username=*) NTRIP_USER="${arg#*=}" ;;
        -h|--help)          usage ;;
        -*)                 echo "unknown flag: $arg" >&2; usage ;;
        *)                  [ -z "$HOST" ] && HOST="$arg" || usage ;;
    esac
done
[ -n "$HOST" ] || usage

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
[ -f "$ENV_FILE" ] || { echo "cannot find $ENV_FILE" >&2; exit 1; }

# Pull the two keys we need without sourcing the whole file — we'd rather
# not leak unrelated secrets (JWT_SECRET etc.) into this process' environment.
grep_env() {
    awk -F= -v k="$1" '
        $0 ~ "^"k"=" {
            sub("^"k"=", "");
            gsub(/^"|"$/, "");
            print;
            exit;
        }' "$ENV_FILE"
}

INTERNAL_SECRET="$(grep_env INTERNAL_SECRET)"
PUBLIC_URL="$(grep_env PUBLIC_URL)"
[ -n "$INTERNAL_SECRET" ] || { echo "INTERNAL_SECRET missing in $ENV_FILE" >&2; exit 1; }
[ -n "$PUBLIC_URL" ]      || { echo "PUBLIC_URL missing in $ENV_FILE" >&2; exit 1; }

SERVER_URL="$PUBLIC_URL/course"
NTRIP_USER="${NTRIP_USER:-mail@luftaquila.io}"

SECRET_PREVIEW="$(printf '%s' "$INTERNAL_SECRET" | cut -c1-8)"

printf 'provisioning fsk@%s\n' "$HOST"
printf '  server-url:      %s\n' "$SERVER_URL"
printf '  internal-secret: %s…\n' "$SECRET_PREVIEW"
printf '  ntrip-username:  %s\n\n' "$NTRIP_USER"

ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
    "fsk@$HOST" \
    "INTERNAL_SECRET='$INTERNAL_SECRET' SERVER_URL='$SERVER_URL' NTRIP_USER='$NTRIP_USER' sh -s" \
    <<'REMOTE'
set -eu

echo "[rover] connecting plugs"
for plug in network-setup-control raw-usb; do
    if snap connections fsk-rover-pilot \
        | awk -v p="fsk-rover-pilot:$plug" '$2 == p && $3 != "-" { hit=1 } END { exit !hit }'; then
        echo "  already connected: $plug"
    else
        sudo snap connect "fsk-rover-pilot:$plug"
        echo "  connected: $plug"
    fi
done

echo "[rover] applying snap set"
sudo snap set fsk-rover-pilot \
    "server-url=$SERVER_URL" \
    "internal-secret=$INTERNAL_SECRET" \
    "ntrip-username=$NTRIP_USER"

echo "[rover] restarting pilot"
sudo snap restart fsk-rover-pilot.pilot >/dev/null

echo "[rover] services:"
snap services fsk-rover-pilot
REMOTE

printf '\nprovisioning complete. Tail logs with:\n'
printf '  ssh fsk@%s sudo snap logs fsk-rover-pilot.pilot -f\n' "$HOST"
