cmake_minimum_required(VERSION 3.13)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(PICO_BOARD pico CACHE STRING "Board type")

include(pico_sdk_import.cmake)

project(rover_mcu C CXX ASM)

pico_sdk_init()

add_executable(rover_mcu
    src/main.c
    src/encoder.c
    src/battery.c
    src/motor.c
    src/servo.c
    src/pump.c
    src/pid.c
    src/estop.c
    src/status_led.c
    src/nav_lights.c
    src/protocol.c
)
# (No motor current sensing — MDD10A self-protects, encoder velocity = 0
# already covers stall detection. Re-add a current.c module if a real
# shunt-amp / INA219 ever lands.)

pico_generate_pio_header(rover_mcu ${CMAKE_CURRENT_LIST_DIR}/src/quadrature_encoder.pio)
pico_generate_pio_header(rover_mcu ${CMAKE_CURRENT_LIST_DIR}/src/ws2812.pio)

target_include_directories(rover_mcu PRIVATE src)

target_link_libraries(rover_mcu
    pico_stdlib
    pico_multicore
    hardware_pio
    hardware_pwm
    hardware_adc
    hardware_irq
    hardware_watchdog
    hardware_clocks
    hardware_sync
)

# USB CDC stdout (printf -> /dev/ttyACM0 on the Pi).
pico_enable_stdio_usb(rover_mcu 1)
pico_enable_stdio_uart(rover_mcu 0)
# Cap the per-printf CDC-flush wait far below HW_WATCHDOG_MS=1000 so a
# host-side stall (pilot reconnect loop, broken serial fd, kernel TTY
# buffer full) can NEVER let printf hold the main loop past the watchdog
# deadline. The SDK default 500_000 us combined with multiple per-tick
# printfs cascades into a self-inducing crash loop: host stops draining
# CDC → printf blocks → watchdog_update() not reached → MCU resets →
# USB re-enumerates → host racing to reconnect doesn't drain in time →
# repeat. With 20 ms here, telemetry that can't be delivered is dropped
# rather than killing the chip.
target_compile_definitions(rover_mcu PRIVATE
    PICO_STDIO_USB_STDOUT_TIMEOUT_US=20000
)

pico_add_extra_outputs(rover_mcu)
