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

E-Stop wiring is fail-safe: a NC momentary button between GP14 and GND
with the MCU's internal pull-up enabled. At rest the closed contact
pulls the line LOW; pressing the button (or any open in the loop —
broken wire, popped connector) lets the pull-up take it HIGH. The
firmware treats HIGH as the tripped state, so a damaged cable also
stops the rover.

Wheel encoders are 3.3 V push-pull (signal *and* power supplied from
the RP2040's 3V3 rail — `3V3 → encoder VCC`, `GND → encoder GND`,
`A/B → GP2/3, GP4/5`). No level shifter required. The PIO program
keeps soft pull-ups on the input pins, which is harmless for a
push-pull driver.

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
| `M` | `<l_duty> <r_duty> <steer_us>` | Raw duty [-1,1] + steering. Implies `H`, switches lane to RAW. |
| `V` | `<l_mps> <r_mps> <steer_us>` | Closed-loop setpoint (m/s). Implies `H`, switches lane to PID. |
| `E` | — | SW E-Stop |
| `C` | — | Clear E-Stop (only takes effect after the GPIO line returns to rest) |
| `P` | `<kp> <ki> <kd>` | Live PID gains (both wheels) |
| `L` | `<0\|1>` | PID gate — `1` allows the PID lane, `0` forces RAW |

There are two orthogonal state bits:

- **`g_pid_enabled`** — toggled by `L`. Gates whether the PID branch
  may run at all.
- **`g_use_raw_motor`** — set by command type. `M` sets RAW, `V` sets
  PID-lane.

The control loop uses the PID branch only when both agree — i.e.
`L 1` *and* the last setpoint command was `V`. Anything else
(including a fresh `M` after `V`) drops to the raw-duty bypass. The
bridge sends `P …` and `L (use_pid?1:0)` once at startup; then each
ROS velocity callback emits either `M` or `V` depending on the
`use_pid` parameter.

MCU → Pi @ 50 Hz: `T <ms> <enc_l> <enc_r> <vel_l> <vel_r> <vbat> <flags>`

Flags (hex):

| Bit | Meaning |
|-----|---------|
| 0 | E-Stop active |
| 1 | Pi heartbeat timeout |
| 2 | Battery undervolt (≤ 20 V — motors gated by core1) |
| 3 | Battery warn (≤ 22 V, advisory only) |
| 4 | PID active (`L 1` AND last command was `V`) |
| 5 | Last boot caused by hardware watchdog reset |

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

Wheel/encoder overrides (defaults: r = 32.5 mm, PPR = 500):

```bash
cmake -S … -B … -DWHEEL_RADIUS_M=0.04 -DENCODER_PPR=200
```

## Flash

- First time: hold BOOT, plug USB-C, drag `.uf2` to the `RPI-RP2` drive.
- Subsequent: `picotool load -f rover_mcu.uf2 && picotool reboot`.

After flash, the board enumerates as a USB CDC device. Use the udev
symlink `/dev/ttyMCU` (installed by `scripts/99-fsk-rover.rules` via
`pilot/scripts/setup_udev.sh` on classic Ubuntu, or by
`scripts/provision-rover.sh` on the Ubuntu Core rover) instead of the
raw `/dev/ttyACM*` name — enumeration order is non-deterministic when
both the GPS and the MCU are present.

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
