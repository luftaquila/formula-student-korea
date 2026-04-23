#!/bin/bash
# Setup udev rules for consistent serial port naming on the RPi5.
#
# After running this script:
#   /dev/ttyGPS  → ZED-F9P GPS receiver
#
# Usage:
#   sudo bash setup_udev.sh
#   sudo udevadm control --reload-rules && sudo udevadm trigger

set -euo pipefail

RULES_FILE="/etc/udev/rules.d/99-pilot.rules"

cat > "$RULES_FILE" << 'EOF'
# ZED-F9P GPS receiver (u-blox). Restrict to dialout group to avoid world-writable /dev/ttyGPS.
# On Ubuntu Core the pilot snap uses the serial-port interface instead and this file is unused.
SUBSYSTEM=="tty", ATTRS{idVendor}=="1546", ATTRS{idProduct}=="01a9", SYMLINK+="ttyGPS", MODE="0660", GROUP="dialout"
EOF

echo "udev rules written to $RULES_FILE"
echo "Run: sudo udevadm control --reload-rules && sudo udevadm trigger"
echo ""
echo "After reconnecting the GPS, it will be available at /dev/ttyGPS"
echo "Update rover_params.yaml: serial_port: /dev/ttyGPS"
