#!/bin/sh
# Provision the FSK GPS-registration unit (Raspberry Pi Zero 2 W) from the
# admin machine. Counterpart to provision-rover.sh, but the GPS unit runs
# Raspberry Pi OS Lite (cloud-init headless), not the AlmaLinux bootc host —
# so this script also DEPLOYS the agent code, not just secrets.
#
# Usage:
#   scripts/provision-gps.sh <host> [--ntrip-username=<id>] \
#       [--tailscale-authkey=<tskey-...>]
#
# What it does (idempotent):
#   1. tars the gps agent + the reused pilot.lib.* modules and copies them in,
#   2. apt-installs python3-serial / python3-requests and Tailscale,
#   3. installs /opt/gps-register, the systemd unit, and the udev rule,
#   4. writes /etc/gps-register/gps.conf (SERVER_URL + INTERNAL_SECRET +
#      NTRIP_USERNAME) 0600 root, sourced from the repo's .env,
#   5. brings Tailscale up if an auth key was given,
#   6. enables + restarts gps-register.service and verifies it stays active.
#
# Re-running against the same unit is safe — files are overwritten, config is
# rewritten, apt/tailscale installs are no-ops when already present.

set -eu

usage() {
    cat >&2 <<EOF
usage: $(basename "$0") <host> [--ntrip-username=<id>] [--tailscale-authkey=<key>]

Requires:
  - <repo>/.env with INTERNAL_SECRET and PUBLIC_URL
  - SSH key auth for fsk@<host> (cloud-init seeded https://github.com/luftaquila.keys)
EOF
    exit 2
}

HOST=""
NTRIP_USER=""
TS_AUTHKEY=""
ENV_FILE_OVERRIDE=""
for arg in "$@"; do
    case "$arg" in
        --ntrip-username=*)   NTRIP_USER="${arg#*=}" ;;
        --tailscale-authkey=*) TS_AUTHKEY="${arg#*=}" ;;
        --env-file=*)         ENV_FILE_OVERRIDE="${arg#*=}" ;;
        -h|--help)            usage ;;
        -*)                   echo "unknown flag: $arg" >&2; usage ;;
        *)                    [ -z "$HOST" ] && HOST="$arg" || usage ;;
    esac
done
[ -n "$HOST" ] || usage

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
# --env-file lets you point at a production .env (e.g. the deploy host's)
# without committing real secrets into the repo's dev .env.
ENV_FILE="${ENV_FILE_OVERRIDE:-$REPO_ROOT/.env}"
GPS_DIR="$REPO_ROOT/course/rover/gps"
PILOT_LIB="$REPO_ROOT/course/rover/pilot/pilot/lib"
[ -f "$ENV_FILE" ] || { echo "cannot find $ENV_FILE" >&2; exit 1; }
[ -d "$GPS_DIR" ]  || { echo "cannot find $GPS_DIR" >&2; exit 1; }

# Pull only the keys we need; avoid leaking unrelated secrets into the env.
grep_env() {
    awk -F= -v k="$1" '
        $0 ~ "^"k"=" { sub("^"k"=", ""); gsub(/^"|"$/, ""); print; exit; }' "$ENV_FILE"
}

INTERNAL_SECRET="$(grep_env INTERNAL_SECRET)"
PUBLIC_URL="$(grep_env PUBLIC_URL)"
[ -n "$INTERNAL_SECRET" ] || { echo "INTERNAL_SECRET missing in $ENV_FILE" >&2; exit 1; }
[ -n "$PUBLIC_URL" ]      || { echo "PUBLIC_URL missing in $ENV_FILE" >&2; exit 1; }

SERVER_URL="$PUBLIC_URL/course"
NTRIP_USER="${NTRIP_USER:-mail@luftaquila.io}"
SECRET_PREVIEW="$(printf '%s' "$INTERNAL_SECRET" | cut -c1-8)"

printf 'provisioning fsk@%s (GPS unit)\n' "$HOST"
printf '  SERVER_URL:      %s\n' "$SERVER_URL"
printf '  INTERNAL_SECRET: %s…\n' "$SECRET_PREVIEW"
printf '  NTRIP_USERNAME:  %s\n' "$NTRIP_USER"
printf '  Tailscale:       %s\n\n' "$([ -n "$TS_AUTHKEY" ] && echo 'up via auth key' || echo 'install only (run tailscale up manually)')"

SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

# 1. Assemble a staging tree: the agent + the reused pilot.lib.* modules
#    (single source of truth — copied from pilot, not vendored in git).
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/systemd" "$STAGING/udev" "$STAGING/pilot/lib"
cp "$GPS_DIR/gps_register.py" "$GPS_DIR/requirements.txt" "$GPS_DIR/README.md" "$STAGING/"
cp "$GPS_DIR/systemd/gps-register.service" "$STAGING/systemd/"
cp "$GPS_DIR/udev/99-fsk-gps.rules" "$STAGING/udev/"
: > "$STAGING/pilot/__init__.py"
: > "$STAGING/pilot/lib/__init__.py"
for m in ubx_parser ntrip_client geo_utils protocol_utils; do
    cp "$PILOT_LIB/$m.py" "$STAGING/pilot/lib/"
done

# 2. Ship the tarball over SSH (no rsync dependency on the Pi).
echo "[local] copying agent bundle to fsk@$HOST"
tar -cz -C "$STAGING" . | ssh $SSH_OPTS "fsk@$HOST" 'cat > /tmp/gps-deploy.tgz'

# 3. Remote provisioning. Secrets arrive on stdin (kept off argv); the
#    heredoc body is quoted so nothing expands locally.
{
    printf '%s\n' "$INTERNAL_SECRET"
    printf '%s\n' "$SERVER_URL"
    printf '%s\n' "$NTRIP_USER"
    printf '%s\n' "$TS_AUTHKEY"
    cat <<'REMOTE'
set -eu

echo "[gps] installing python deps + tailscale"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-serial python3-requests >/dev/null
if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "[gps] deploying agent to /opt/gps-register"
TMP="$(mktemp -d)"
tar -xzf /tmp/gps-deploy.tgz -C "$TMP"
sudo install -d -m 755 /opt/gps-register
sudo install -m 755 "$TMP/gps_register.py" /opt/gps-register/gps_register.py
sudo install -m 644 "$TMP/requirements.txt" "$TMP/README.md" /opt/gps-register/
sudo rm -rf /opt/gps-register/pilot
sudo cp -r "$TMP/pilot" /opt/gps-register/pilot
sudo install -m 644 "$TMP/systemd/gps-register.service" /etc/systemd/system/gps-register.service
sudo install -m 644 "$TMP/udev/99-fsk-gps.rules" /etc/udev/rules.d/99-fsk-gps.rules
rm -rf "$TMP" /tmp/gps-deploy.tgz

echo "[gps] writing /etc/gps-register/gps.conf"
sudo install -d -m 755 /etc/gps-register
# 0600 root-owned: holds INTERNAL_SECRET. systemd reads it as EnvironmentFile.
umask 077
sudo tee /etc/gps-register/gps.conf >/dev/null <<EOF
SERVER_URL=$SERVER_URL
INTERNAL_SECRET=$INTERNAL_SECRET
NTRIP_USERNAME=$NTRIP_USER
EOF
sudo chmod 600 /etc/gps-register/gps.conf

echo "[gps] reloading udev"
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=tty --subsystem-match=usb

echo "[gps] enabling + restarting gps-register.service"
sudo systemctl daemon-reload
sudo systemctl enable gps-register.service >/dev/null 2>&1 || true
sudo systemctl restart gps-register.service

if [ -n "$TS_AUTHKEY" ]; then
    echo "[gps] bringing Tailscale up"
    sudo tailscale up --auth-key="$TS_AUTHKEY"
fi

# Settle, then assert health — bad secrets/serial crash within ~8 s.
sleep 8
if sudo systemctl is-active --quiet gps-register.service; then
    echo "[gps] gps-register.service: active"
else
    echo "[gps] gps-register.service: NOT active — recent log:" >&2
    sudo journalctl -u gps-register.service -n 30 --no-pager >&2
    exit 1
fi
REMOTE
} | ssh $SSH_OPTS "fsk@$HOST" \
    'IFS= read -r INTERNAL_SECRET
     IFS= read -r SERVER_URL
     IFS= read -r NTRIP_USER
     IFS= read -r TS_AUTHKEY
     export INTERNAL_SECRET SERVER_URL NTRIP_USER TS_AUTHKEY
     sh -s'

printf '\nprovisioning complete. Tail logs with:\n'
printf '  ssh fsk@%s sudo journalctl -u gps-register.service -f\n' "$HOST"
if [ -z "$TS_AUTHKEY" ]; then
    printf '\nTailscale installed but not connected. Bring it up with:\n'
    printf '  ssh fsk@%s sudo tailscale up\n' "$HOST"
fi
