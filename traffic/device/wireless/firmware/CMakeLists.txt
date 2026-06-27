cmake_minimum_required(VERSION 3.13)

# Cross toolchain must be selected before project() so the compiler probe runs
# against arm-none-eabi. Allow an external -DCMAKE_TOOLCHAIN_FILE to win.
if(NOT CMAKE_TOOLCHAIN_FILE)
    set(CMAKE_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/cmake/arm-none-eabi.cmake")
endif()

project(traffic_device C CXX ASM)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Bare-metal C++ for RadioLib: drop the parts that need a hosted runtime.
string(APPEND CMAKE_CXX_FLAGS
    " -fno-exceptions -fno-rtti -fno-threadsafe-statics -fno-use-cxa-atexit")

# Vendored bare-metal deps (cloned by tools/build.sh / CI at pinned refs).
set(NRFX_PATH       "${CMAKE_CURRENT_LIST_DIR}/vendor/nrfx"       CACHE PATH "nrfx checkout")
set(CMSIS_PATH      "${CMAKE_CURRENT_LIST_DIR}/vendor/CMSIS_5"    CACHE PATH "CMSIS_5 checkout")
set(RADIOLIB_PATH   "${CMAKE_CURRENT_LIST_DIR}/vendor/RadioLib"   CACHE PATH "RadioLib checkout")
set(MONOCYPHER_PATH "${CMAKE_CURRENT_LIST_DIR}/vendor/monocypher" CACHE PATH "Monocypher checkout")
set(MDK_DIR         "${NRFX_PATH}/bsp/stable/mdk")

foreach(req
        "${MDK_DIR}/gcc_startup_nrf52840.S"
        "${MDK_DIR}/system_nrf52840.c"
        "${MDK_DIR}/nrf_common.ld"
        "${CMSIS_PATH}/CMSIS/Core/Include/core_cm4.h"
        "${RADIOLIB_PATH}/src/RadioLib.h"
        "${CMAKE_CURRENT_LIST_DIR}/vendor/tinyusb/src/tusb.h"
        "${MONOCYPHER_PATH}/src/monocypher.c"
        "${NRFX_PATH}/drivers/src/nrfx_power.c")
    if(NOT EXISTS "${req}")
        message(FATAL_ERROR "missing vendored dependency: ${req}\nRun tools/build.sh (it clones nrfx + CMSIS_5 + RadioLib + tinyusb + monocypher).")
    endif()
endforeach()

# The fleet key is NOT compiled in. It is provisioned per board at runtime into
# a reserved flash page (keystore.c) over the serial 'K' command, so this build
# is key-less and safe to publish from CI on a public repo (DESIGN §2.11).

# RadioLib as a static library. Non-Arduino mode (ARDUINO is undefined → the
# library uses our custom HAL). Built without our -Wall to avoid upstream noise;
# unused modules are dropped by --gc-sections at link.
file(GLOB_RECURSE RADIOLIB_SRC "${RADIOLIB_PATH}/src/*.cpp")
add_library(radiolib STATIC ${RADIOLIB_SRC})
target_include_directories(radiolib PUBLIC "${RADIOLIB_PATH}/src")
target_compile_options(radiolib PRIVATE -ffunction-sections -fdata-sections)

# Monocypher — single-file XChaCha20-Poly1305 AEAD for the secured air link
# (DESIGN §2.11). Built with -w to keep it off our -Wall surface.
add_library(monocypher STATIC "${MONOCYPHER_PATH}/src/monocypher.c")
target_include_directories(monocypher PUBLIC "${MONOCYPHER_PATH}/src")
target_compile_options(monocypher PRIVATE -ffunction-sections -fdata-sections -w)

# nRF USB stack: TinyUSB CDC-ACM device + nrfx_power (USB power events) + our
# usb.c/usb_descriptors.c. -w silences upstream warnings; config/ holds
# tusb_config.h's siblings nrfx_config.h + nrfx_glue.h.
set(TUSB "${CMAKE_CURRENT_LIST_DIR}/vendor/tinyusb/src")
add_library(nrfusb STATIC
    "${TUSB}/tusb.c"
    "${TUSB}/common/tusb_fifo.c"
    "${TUSB}/device/usbd.c"
    "${TUSB}/device/usbd_control.c"
    "${TUSB}/class/cdc/cdc_device.c"
    "${TUSB}/portable/nordic/nrf5x/dcd_nrf5x.c"
    "${NRFX_PATH}/drivers/src/nrfx_power.c"
    src/usb.c
    src/usb_descriptors.c
)
target_include_directories(nrfusb PUBLIC
    src
    config
    "${TUSB}"
    "${NRFX_PATH}"
    "${NRFX_PATH}/drivers/include"
    "${NRFX_PATH}/hal"
    "${NRFX_PATH}/haly"
    "${NRFX_PATH}/bsp/stable"
    "${MDK_DIR}"
    "${CMSIS_PATH}/CMSIS/Core/Include"
)
target_compile_definitions(nrfusb PUBLIC NRF52840_XXAA)
target_compile_options(nrfusb PRIVATE -ffunction-sections -fdata-sections -w)

set(ELF traffic_device)

add_executable(${ELF}
    "${MDK_DIR}/gcc_startup_nrf52840.S"
    "${MDK_DIR}/system_nrf52840.c"
    src/main.c
    src/board.c
    src/lights.c
    src/sensor.c
    src/meas.c
    src/capture.c
    src/secure.c
    src/keystore.c
    src/proto_usb.c
    src/node_id.c
    src/radio_hal.cpp
    src/radio.cpp
    src/runtime.cpp
)

target_include_directories(${ELF} PRIVATE
    src
    "${MONOCYPHER_PATH}/src"
    "${MDK_DIR}"
    "${CMSIS_PATH}/CMSIS/Core/Include"
)

target_compile_definitions(${ELF} PRIVATE NRF52840_XXAA)

# Single binary for all boards — role is chosen at runtime from USB (master = a
# PC host enumerates us, else sensor; src/main.c). A sensor's on-air identity is
# the low 32 bits of its chip's FICR.DEVICEID (src/node_id.c); the master
# auto-registers it on first contact. Nothing is hardcoded per board.

# Test-only: sensor synthesizes a periodic event (physical SENSOR line unwired).
option(SENSOR_SIM "Sensor fires a synthetic event every 3 s (testing only)" OFF)
if(SENSOR_SIM)
    target_compile_definitions(${ELF} PRIVATE SENSOR_SIM)
endif()

# Debug: print the chip id + resolved role over USB once per second.
option(NODE_DEBUG "Print chip id / role over USB (testing only)" OFF)
if(NODE_DEBUG)
    target_compile_definitions(${ELF} PRIVATE NODE_DEBUG)
endif()

target_compile_options(${ELF} PRIVATE
    -Wall -Wextra
    -ffunction-sections -fdata-sections
    $<$<COMPILE_LANGUAGE:C>:-std=gnu11>
)

target_link_libraries(${ELF} radiolib nrfusb monocypher)

# Link with newlib (nano) + nosys stubs; our startup calls _start. The custom
# linker script places the app at 0x26000; -L<mdk> lets it INCLUDE nrf_common.ld.
# C++ objects pull the CXX linker driver → libstdc++ (nano) is linked.
set(LINKER_SCRIPT "${CMAKE_CURRENT_LIST_DIR}/linker/nrf52840_app.ld")
target_link_options(${ELF} PRIVATE
    -T "${LINKER_SCRIPT}"
    -L "${MDK_DIR}"
    --specs=nano.specs
    --specs=nosys.specs
    -Wl,--gc-sections
    -Wl,-Map=${ELF}.map
    -Wl,--print-memory-usage
)
set_target_properties(${ELF} PROPERTIES
    SUFFIX ".elf"
    LINK_DEPENDS "${LINKER_SCRIPT}")

# Post-build: raw images + UF2 (family 0xADA52840), report section sizes.
add_custom_command(TARGET ${ELF} POST_BUILD
    COMMAND ${CMAKE_OBJCOPY} -O binary "${ELF}.elf" "${ELF}.bin"
    COMMAND ${CMAKE_OBJCOPY} -O ihex   "${ELF}.elf" "${ELF}.hex"
    COMMAND python3 "${CMAKE_CURRENT_LIST_DIR}/tools/bin2uf2.py"
            --base 0x26000 --family 0xADA52840
            "${ELF}.bin" "${ELF}.uf2"
    COMMAND ${CMAKE_SIZE} "${ELF}.elf"
    VERBATIM)
