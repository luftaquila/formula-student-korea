# FSK Rover — MCU Coprocessor

RP2040-Zero firmware. Owns drive I/O: encoders (PIO quadrature), MDD10A
motor PWM, S20F steering PWM, speed PID, battery monitor, E-Stop, HW +
Pi-heartbeat watchdog, status LED. Pi link: USB CDC. The mission-
specific spray servo stays on Pi GPIO (out of scope here).

## Pinout

| Role | Pin | Notes |
|------|-----|-------|
| Left enc A/B    | GP2, GP3   | PIO needs A,B on consecutive pins |
| Right enc A/B   | GP4, GP5   | |
| Left mot PWM/DIR| GP6, GP7   | → MDD10A PWM1/DIR1 |
| Right mot PWM/DIR| GP8, GP9  | → MDD10A PWM2/DIR2 |
| Steering servo  | GP10       | S20F signal; VCC from BEC |
| E-Stop          | GP14       | active-low, internal pull-up |
| Status LED      | GP16       | onboard WS2812 |
| Battery V       | GP26 (ADC0)| 100 kΩ : 10 kΩ divider |

PIO usage: PIO0 SM0/SM1 = quadrature encoder (offset 0). PIO1 SM0 = WS2812.

## Battery divider

```
Vbat ─[100 kΩ 1%]─┬─ GP26
                  ├─ 100 nF ─ GND
                  ├─ 3.3 V Zener/TVS ─ GND
                  └─[10 kΩ 1%]─ GND
```

## USB CDC protocol

Line-based ASCII, `\n` terminated.

Pi → MCU:

| Cmd | Args | Meaning |
|-----|------|---------|
| `H` | — | Heartbeat (resets Pi-link WDT) |
| `M` | `<l_duty> <r_duty> <steer_us>` | Raw duty [-1,1] + steering. Implies `H`. |
| `V` | `<l_mps> <r_mps> <steer_us>` | Closed-loop velocity. Requires `L 1`. Implies `H`. |
| `E` | — | SW E-Stop |
| `C` | — | Clear E-Stop |
| `P` | `<kp> <ki> <kd>` | Live PID gains (both wheels) |
| `L` | `<0\|1>` | PID closed loop on/off |

MCU → Pi @ 50 Hz: `T <ms> <enc_l> <enc_r> <vel_l> <vel_r> <vbat> <flags>`

Flags (hex):

| Bit | Meaning |
|-----|---------|
| 0 | E-Stop active |
| 1 | Pi heartbeat timeout |
| 2 | Battery undervolt |
| 4 | PID active |
| 5 | Last boot from HW WDT |

Async events: `! <msg>` (e.g. `! WDT TIMEOUT`).

## Status LED

| Color | State |
|-------|-------|
| dim white | boot |
| green | idle |
| blue | driving |
| yellow | Pi heartbeat timeout |
| magenta | battery undervolt |
| red blink | E-Stop active |

## Build

```bash
sudo apt install cmake gcc-arm-none-eabi libnewlib-arm-none-eabi \
                 libstdc++-arm-none-eabi-newlib build-essential
git clone --depth 1 --recurse-submodules \
    https://github.com/raspberrypi/pico-sdk.git ~/pico-sdk
export PICO_SDK_PATH=~/pico-sdk
cmake -S course/rover/mcu -B course/rover/mcu/build -DPICO_BOARD=pico
cmake --build course/rover/mcu/build -j
```

Output: `build/rover_mcu.uf2`.

Wheel/encoder overrides (defaults: r = 32.5 mm, PPR = 1024):

```bash
cmake -S … -B … -DWHEEL_RADIUS_M=0.04 -DENCODER_PPR=200
```

## Flash

- First time: hold BOOT, plug USB-C, drag `.uf2` to the `RPI-RP2` drive.
- Subsequent: `picotool load -f rover_mcu.uf2 && picotool reboot`.

After flash board enumerates as `/dev/ttyACM0`.

## CI

`.github/workflows/rover-mcu.yml` builds on `course/rover/mcu/**`
changes. Artifact: `rover-mcu-firmware` (`.uf2`/`.elf`/`.bin`).

## Integration

Pi side: `pilot/pilot/mcu_bridge_node.py`. Launched unconditionally by
`pilot.launch.py`. Bridge does:

- TX `M` (raw duty) by default; `V` (m/s, PID) when `use_pid: true`
- TX `H` heartbeat at 10 Hz (MCU Pi-link WDT = 500 ms)
- TX `E` on `/rover/cmd/emergency_stop`
- RX `T …` → `/rover/motor/status`, `/rover/battery`, `/rover/odom`
- RX `! …` → logged at WARN level

Bridge params live in `rover_params.yaml` under `mcu_bridge_node`.

## Omitted: motor current sensing

MDD10A self-protects; encoder velocity = 0 with non-zero command
already covers stall. Re-add `current.c` + `FLAG_OVERCURRENT` if a real
shunt-amp / INA219 lands.
