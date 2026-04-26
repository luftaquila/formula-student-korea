#!/bin/bash
# Install FSK rover udev rules on a classic Ubuntu host.
#
# After running this script, the kernel creates:
#   /dev/ttyGPS  -> ZED-F9P GNSS receiver
#   /dev/ttyMCU  -> RP2040-Zero coprocessor
#
# Production rovers (Ubuntu Core) get the same rules installed by
# scripts/provision-rover.sh, which copies the same .rules file.
#
# Usage:
#   sudo bash setup_udev.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../../scripts/99-fsk-rover.rules"
DEST="/etc/udev/rules.d/99-fsk-rover.rules"

[ -f "$SRC" ] || { echo "rules file missing: $SRC" >&2; exit 1; }

install -m 644 "$SRC" "$DEST"
echo "installed: $DEST"

udevadm control --reload-rules
udevadm trigger --subsystem-match=tty
echo "udev reloaded; reconnect the ZED-F9P / RP2040 to confirm symlinks"
