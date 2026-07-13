#!/bin/sh
# Provision a freshly-flashed rover end-to-end from the admin machine.
#
# Usage:
#   scripts/provision-rover.sh <rover-ip-or-host> [--ntrip-username=<id>]
#
# What it does (idempotent):
#   1. SSHes in as `fsk` (key auth seeded by the host bootc image),
#   2. writes /etc/pilot/pilot.conf with SERVER_URL + ROS_DOMAIN_ID
#      (sourced from the repo's .env),
#   3. recreates the `internal-secret` and `ntrip-username` podman
#      secrets from .env (the pilot.container quadlet wires them into
#      the container's env),
#   4. restarts pilot.service and verifies it stays active.
#
# Re-running against the same rover is safe — secrets are removed and
# recreated, /etc/pilot/pilot.conf is overwritten, systemctl restart
# is a no-op when nothing has changed.

set -eu

usage() {
    cat >&2 <<EOF
usage: $(basename "$0") <rover-ip-or-host> [--ntrip-username=<id>]

Requires:
  - <repo>/.env with INTERNAL_SECRET and PUBLIC_URL
  - SSH key auth for fsk@<rover> (host bootc image bakes
    https://github.com/luftaquila.keys at build time)
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

# Pull only the two keys we need; avoid leaking unrelated secrets
# (JWT_SECRET, etc.) into the local environment.
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
# --ntrip-username 미지정 시 .env의 NTRIP_USERNAME으로 폴백. 개인 NTRIP 계정을 스크립트에
# 하드코딩하지 않는다(리포에 자격증명 상수를 남기지 않음).
[ -n "$NTRIP_USER" ] || NTRIP_USER="$(grep_env NTRIP_USERNAME)"
[ -n "$NTRIP_USER" ] || { echo "NTRIP username이 없습니다: --ntrip-username=<id> 또는 $ENV_FILE의 NTRIP_USERNAME을 설정하세요." >&2; exit 1; }
# 선택적 로버 전용 시크릿. 설정 시 장비가 X-Rover-Secret으로 course 로버 라우트에 인증해
# 허브 전역 INTERNAL_SECRET을 소지하지 않아도 된다. 비어 있으면 INTERNAL_SECRET으로 폴백.
ROVER_SECRET="$(grep_env ROVER_SECRET)"

SECRET_PREVIEW="$(printf '%s' "$INTERNAL_SECRET" | cut -c1-8)"

printf 'provisioning fsk@%s\n' "$HOST"
printf '  SERVER_URL:      %s\n' "$SERVER_URL"
printf '  INTERNAL_SECRET: %s…\n' "$SECRET_PREVIEW"
printf '  NTRIP_USERNAME:  %s\n\n' "$NTRIP_USER"

SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

# Send secret values on stdin instead of embedding them in the remote command
# line. That avoids argv exposure on both machines and preserves values that
# contain shell metacharacters such as single quotes.
{
    printf '%s\n' "$INTERNAL_SECRET"
    printf '%s\n' "$SERVER_URL"
    printf '%s\n' "$NTRIP_USER"
    printf '%s\n' "$ROVER_SECRET"
    cat <<'REMOTE'
set -eu

echo "[rover] writing /etc/pilot/pilot.conf"
sudo install -d -m 755 /etc/pilot
# tee creates the file with the default umask (022 -> 0644), which is
# what we want for a non-secret KEY=VALUE file. No explicit chmod —
# sudoers.d/fsk only whitelists install/tee/podman/systemctl/nmcli/
# tailscale/bootc.
# Camera config for the dual-node "Stereo Vision" cam (each eye a separate
# /dev/video node at 1280x720, NOT side-by-side):
#  - CAMERA_HEIGHT=720 matches the eye resolution the cam actually delivers.
#  - CAMERA_VIEW=full prevents the SBS-crop default (CAMERA_VIEW=left) from
#    slicing a single eye in half (which looked portrait). NOTE: the perception
#    node's dual layout streams the left eye whole regardless of CAMERA_VIEW —
#    this only matters for the crop-based (SBS) image / STEREO_LAYOUT=sbs, where
#    it must stay 'full'. Detection defaults to dual (left=video0, right=video2).
# DETECT_FPS=8 pins the obstacle-detection rate on this rover. It matches the code
# default (perception_node.py), so it's belt-and-suspenders — kept explicit here
# alongside the other camera tuning. Bounded by the ~13 fps camera ceiling and the
# single-thread SGBM cap while NAVIGATING (STEREO_CV_THREADS).
printf 'SERVER_URL=%s\nROS_DOMAIN_ID=0\nCAMERA_VIEW=full\nCAMERA_HEIGHT=720\nDETECT_FPS=8\n' "$SERVER_URL" \
    | sudo tee /etc/pilot/pilot.conf >/dev/null

echo "[rover] (re)creating podman secrets"
for s in internal-secret ntrip-username rover-secret; do
    sudo podman secret rm "$s" >/dev/null 2>&1 || true
done
printf '%s' "$INTERNAL_SECRET" | sudo podman secret create internal-secret - >/dev/null
printf '%s' "$NTRIP_USER"      | sudo podman secret create ntrip-username -  >/dev/null
# rover-secret은 설정된 경우에만 생성한다. 존재하면 pilot-run/perception-run이 마운트해
# 장비가 X-Rover-Secret으로 인증한다(없으면 INTERNAL_SECRET 폴백).
if [ -n "${ROVER_SECRET:-}" ]; then
    printf '%s' "$ROVER_SECRET" | sudo podman secret create rover-secret - >/dev/null
    echo "[rover] rover-secret created (device will use X-Rover-Secret)"
fi

echo "[rover] restarting pilot.service + perception.service"
sudo systemctl restart pilot.service
# perception.service shares /etc/pilot/pilot.conf + the internal-secret we just
# (re)wrote, but it was started at boot before they existed — restart it too so
# it picks up SERVER_URL/secret instead of sitting in its StartLimit lockout.
sudo systemctl restart perception.service || true

# Give the container a moment to settle before asserting health —
# secret-driven crashes show up within ~10 s.
sleep 10
if sudo systemctl is-active --quiet pilot.service; then
    echo "[rover] pilot.service: active"
else
    echo "[rover] pilot.service: NOT active — recent log:" >&2
    sudo journalctl -u pilot.service -n 30 --no-pager >&2
    exit 1
fi
# perception is non-critical (camera streaming) — report but don't fail
# provisioning if it isn't up (e.g. no camera attached yet).
if sudo systemctl is-active --quiet perception.service; then
    echo "[rover] perception.service: active"
else
    echo "[rover] perception.service: not active (camera optional) — recent log:"
    sudo journalctl -u perception.service -n 10 --no-pager || true
fi
REMOTE
} | ssh $SSH_OPTS "fsk@$HOST" \
    'IFS= read -r INTERNAL_SECRET
     IFS= read -r SERVER_URL
     IFS= read -r NTRIP_USER
     IFS= read -r ROVER_SECRET
     export INTERNAL_SECRET SERVER_URL NTRIP_USER ROVER_SECRET
     sh -s'

printf '\nprovisioning complete. Tail logs with:\n'
printf '  ssh fsk@%s sudo journalctl -u pilot.service -f\n' "$HOST"
