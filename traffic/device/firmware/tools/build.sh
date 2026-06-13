#!/bin/sh
# Configure + build the firmware. Clones the pinned bare-metal deps on first run
# (skipped once vendor/ exists). Runs the same on the host, in the build
# container, and in CI.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VENDOR="$HERE/vendor"

NRFX_REF=v4.3.0
CMSIS_REF=5.9.0
RADIOLIB_REF=7.7.1
TINYUSB_REF=0.20.0

if [ ! -d "$VENDOR/nrfx" ]; then
    git clone --depth 1 --branch "$NRFX_REF" \
        https://github.com/NordicSemiconductor/nrfx.git "$VENDOR/nrfx"
fi

if [ ! -d "$VENDOR/CMSIS_5" ]; then
    git clone --depth 1 --branch "$CMSIS_REF" --filter=blob:none --sparse \
        https://github.com/ARM-software/CMSIS_5.git "$VENDOR/CMSIS_5"
    git -C "$VENDOR/CMSIS_5" sparse-checkout set CMSIS/Core/Include
fi

if [ ! -d "$VENDOR/RadioLib" ]; then
    git clone --depth 1 --branch "$RADIOLIB_REF" \
        https://github.com/jgromes/RadioLib.git "$VENDOR/RadioLib"
fi

if [ ! -d "$VENDOR/tinyusb" ]; then
    git clone --depth 1 --branch "$TINYUSB_REF" \
        https://github.com/hathach/tinyusb.git "$VENDOR/tinyusb"
fi

cmake -G Ninja -S "$HERE" -B "$HERE/build" -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build "$HERE/build" --parallel
