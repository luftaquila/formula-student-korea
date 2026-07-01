# Bootstrap fragment that locates pico-sdk and pulls in its CMake helpers.
# Mirrors $PICO_SDK_PATH/external/pico_sdk_import.cmake from upstream.

if (DEFINED ENV{PICO_SDK_PATH} AND (NOT PICO_SDK_PATH))
    set(PICO_SDK_PATH $ENV{PICO_SDK_PATH})
    message("Using PICO_SDK_PATH from environment ('${PICO_SDK_PATH}')")
endif ()

if (NOT PICO_SDK_PATH)
    message(FATAL_ERROR
        "PICO_SDK_PATH is not set. Clone https://github.com/raspberrypi/pico-sdk "
        "and either export PICO_SDK_PATH=<dir> or pass -DPICO_SDK_PATH=<dir>.")
endif ()

get_filename_component(PICO_SDK_PATH "${PICO_SDK_PATH}" REALPATH BASE_DIR "${CMAKE_BINARY_DIR}")

set(PICO_SDK_INIT_CMAKE_FILE "${PICO_SDK_PATH}/pico_sdk_init.cmake")
if (NOT EXISTS ${PICO_SDK_INIT_CMAKE_FILE})
    message(FATAL_ERROR
        "PICO_SDK_PATH='${PICO_SDK_PATH}' does not contain pico_sdk_init.cmake. "
        "Verify the SDK clone is complete.")
endif ()

set(PICO_SDK_PATH "${PICO_SDK_PATH}" CACHE PATH "Path to the Pico SDK" FORCE)

include(${PICO_SDK_INIT_CMAKE_FILE})
