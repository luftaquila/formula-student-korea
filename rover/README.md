# FSK Rover

Raspberry Pi 5 + RTK GPS rover. Drives a waypoint mission, sprays a
marker at each cone. Podman container on AlmaLinux bootc; Tailscale
for remote access.

## Hardware

| Role | Part | Interface |
|------|------|-----------|
| Compute | Raspberry Pi 5 | — |
| Coprocessor | Waveshare RP2040-Zero | USB CDC (`/dev/ttyMCU`) |
| GPS | u-blox ZED-F9P | USB CDC (`/dev/ttyGPS`) |
| RTK corrections | NTRIP caster (NGII) | TCP |
| Motor driver | Cytron MDD10A | MCU PWM + DIR |
| Drive | 2× MD36L P27 DC gearmotor (27:1) on Wheeltec R550 rear | one MDD10A channel per wheel |
| Wheel encoders | 2× quadrature on motor shaft, 3.3 V push-pull, 500 PPR (×4 × 27 = 54000 counts/wheel rev); XH2.54-4P connector | MCU PIO + 3V3 |
| Wheels | 125 mm dia (Wheeltec R550) | rear drive, front passive |
| Steering servo | Wheeltec S20F (5–6.5 V, 20 kg·cm, stall 1.8 A) | MCU PWM |
| Peristaltic pump (dispenser) | switched via IRLZ44N logic-level MOSFET + 1N4007 flyback | MCU GP6 on/off; servo 5.5 V rail |
| E-Stop | NC momentary, fail-safe | MCU GP7, internal pull-up |
| Status sticks | 2× NeoPixel Stick (8× WS2812 each) | MCU PIO via 2N7002 level shifter (GP11); mirrors onboard LED 1:1 |
| Nav lights | red/green, 3-pin module (+5V/GND/control) | MCU GP9 direct on/off; steady on |
| Platform | Wheeltec R550 AKM Plus | Ackermann |
| Battery | 25.6 V (8S) LiFePO4, 6.6 Ah | XT60, BMS |
| Pi supply | 5 V 5 A buck → USB-C PD | Pi only |
| Servo supply | MP1584EN @ 5.5 V, ≥3 A | S20F + pump + NeoPixel sticks + nav lights |

The Pi drives no GPIO: the peristaltic pump is switched by the MCU
(GP6 → IRLZ44N MOSFET gate — see Pinout below). `spray_node` only
decides pump on/off and forwards it via `mcu_bridge_node` as `D <0|1>`.

### Power chain

```
25.6 V LiFePO4 8S 6.6 Ah ─┬─► 5 V 5 A buck ──────► Pi 5 (USB-C PD)
                         ├─► MDD10A V_MOT ─────► rear DC motors
                         └─► MP1584EN @ 5.5 V ─► S20F + pump VCC
```

- All GNDs commoned.
- Battery thresholds: warn 22 V, undervolt cutoff 20 V.
- MP1584EN abs. max 30 V; 8S full charge 29.2 V is in range. LM2596HV (60 V) for margin.

### Drive control split

- **MCU**: encoders, motor PWM, steering, peristaltic pump (GP6 MOSFET),
  battery ADC, E-Stop, status LEDs (onboard + external sticks), nav
  lights, WDTs. Pi link USB CDC @ 50 Hz.
- **Pi**: navigation, RTK, course bridge, dispense sequencing (pump
  on/off on the MCU).

Bridge: `mcu_bridge_node`. Firmware CI: `.github/workflows/rover-mcu.yml`.

## Architecture

Five ROS 2 Jazzy nodes in the rootful `pilot` container, `--network=host` (a
separate `perception` container handles camera streaming — WebRTC (H.264, WHIP →
mediamtx) primary with an MJPEG fallback, plus a WebXR VR stereo stream — and
stereo obstacle detection — it joins this same ROS graph and publishes `/rover/perception/obstacle`,
which `navigator_node` turns into a local mission pause; see `perception/`):

```
course server (port 10000)
        │
        │  SSE /api/rover/stream    ← execute-path, request-position,
        │                              emergency-stop, manual-control
        │  POST /api/rover/position      ┐
        │       /api/rover/telemetry     │  (from the rover)
        │       /api/rover/status        ┘
        │
    bridge_node
        │
 ┌──────┴──────────────── topics ───────────────────────┐
 │                                                      │
 gps_node ── /rover/gps/{position,heading,fix_status} ─┐
 gps_node ── /rover/ntrip/status ──────────────────────┤
                                                       ▼
                                               navigator_node
                                                 │        │
                      /rover/cmd/velocity ◄──────┘        │
                          ▼                               │
                  mcu_bridge_node ── USB CDC ── RP2040    │
                                                /rover/nav/waypoint_reached
                                                          │
                                                   spray_node ── /rover/spray/done
```

Hot-plug behaviour:

- `pilot-run` probes `/dev` at start and passes only present devices to `podman run --device`.
- udev `add|remove` on GPS/MCU fires `fsk-pilot-replug.service`, which debounces and restarts `pilot.service`.
- Container restart latency: ~5 s.
- A missing device doesn't block the others.

### Mission state machine (`navigator_node`)

```
IDLE → CALIBRATING → NAVIGATING → SETTLING → SPRAYING ─(next wp)→ NAVIGATING
                                                           │
                              (all wp done, return_to_start)│
                                                           ▼
                                              NAVIGATING (return) → IDLE

IDLE → CAL_ANTENNA → IDLE   (operator-triggered antenna-offset auto-cal)
IDLE → CAL_WHEELS  → IDLE   (operator-triggered per-wheel scale auto-cal)

any state → EMERGENCY_STOP (on /rover/cmd/emergency_stop)
any driving state → ERROR  (GPS timeout / fix below quality > fix_hysteresis_s,
                            or battery below battery_abort_pct mid-mission)
```

- **Antenna-precise docking**: the planner emits ONE segment per waypoint
  (`path_planner.py`), whose `end_pose` is the chassis dock pose
  `target − R(ψ_dock) · antenna_offset` — the pose that lands the GPS
  antenna (the only cm-precise quantity we observe) exactly on the user's
  clicked target — and whose `target_antenna` is the waypoint itself.
  ψ_dock is the bearing from the previous waypoint (or the live chassis
  pose, for the first WP) to the current one, so consecutive cones are
  joined by a smooth corridor, and non-zero antenna offset is compensated
  at planning time. The planner is purely geometric (no controller state),
  so it regenerates cheaply on skip / stuck / mid-mission replan.
- **State estimator** fuses MCU encoder odometry (chassis v, ω) with GPS
  antenna position and GPS heading-of-motion (with antenna-offset
  inversion) into a chassis (x, y, ψ) at 20 Hz. ψ never depends on raw
  GPS heading-of-motion alone — that decouples control from the 200–500
  ms heading-of-motion latency that previously caused figure-8 swings.
- **CALIBRATING**: drive κ = 0 at `calibration_speed`, regress chassis
  heading from antenna ENU samples. Trustworthy when chord ≥
  `calibration_chord_min_m` AND residual RMS ≤ `calibration_residual_max`
  (production: 1.5 m / 5 cm → ~2° heading 1σ), otherwise extend once
  and ERROR if still bad. Hard cap at `calibration_max_distance`.
- **NAVIGATING**: a single `L1Tracker` (antenna-as-unicycle transform,
  Aicardi-Casalino-Bicchi-Balestrino 1995; `path_tracker.py`) drives the
  antenna onto `target_antenna` for the whole approach — there is no
  separate cruise/dock split. With `eta = bearing(antenna→target) −
  chassis_ψ` it commands `v = v_des · cos(eta)` and
  `κ = tan(eta) / antenna_offset_x`, κ clamped to `max_curvature`
  (1.7 1/m ≈ tan(30.5°)/0.33); cos(eta) drops v to zero as eta → 90°
  instead of fighting a saturated κ. Inside `l1_brake_zone_m` of the
  target, v ramps linearly from `cruise_speed` down to `l1_min_speed_m_s`
  and holds that floor through the last `l1_creep_dist_m` so the chassis
  settles to min-speed before capture. For large attitude error
  (|eta| > `l1_kturn_enter_rad`, 60°) the forward arc physically cannot
  close (min radius ≈ 0.59 m), so a K-turn reverses with saturated κ
  (rotation direction and alignment both latched against close-range
  bearing noise), then straightens (κ=0) to build a `l1_kturn_exit_dist_m`
  standoff for the next forward leg. 'reached' fires when antenna→target
  drops below `l1_cm_capture_m` (3 cm).
- **SETTLING → SPRAYING**: antenna within `settle_tolerance` for
  `settle_readings` consecutive samples → fire. Drift back outside
  `waypoint_tolerance` mid-settle hands control back to the dock tracker.
- **CAL_ANTENNA**: drive a straight chord (chord-fit ψ_init), then a
  constant-curvature CIRCLE orbit (κ = ±1/`antenna_cal_radius_m` for
  `antenna_cal_revolutions`), and run a closed-form circular solver
  (`antenna_calibration.py`): while orbiting, both the chassis trace and
  the antenna trace are circles about the same centre, so two circle fits
  plus a phase mean recover (a_x, a_y) with no instantaneous heading
  needed. Gates on a minimum orbit sweep (`SOLVE_CIRCLE_SWEEP_MIN_RAD`,
  270°), per-circle fit RMS, and chassis-vs-antenna centre agreement, so
  an orbit that didn't really happen (encoder stall, mid-drive E-Stop)
  can't silently persist a garbage offset. Result written to
  `$PILOT_STATE_DIR/antenna_offset.json`.
- **CAL_WHEELS**: drive a straight 10 m chord at `wheel_cal_speed` and
  divide GPS chord distance by per-wheel encoder integration to recover
  per-wheel rolling-radius scale. Result written to
  `$PILOT_STATE_DIR/wheel_cal.json` and applied live via
  `/rover/cmd/apply_wheel_scales`. Bounded to ±15 % so encoder
  slip / GPS error never produces a runaway scale.

Thresholds in `pilot/config/rover_params.yaml`. The most physically
load-bearing knob is `antenna_offset_x` / `antenna_offset_y` — measure
it once on the actual chassis with a tape (or run CAL_ANTENNA once);
everything else self-corrects via GPS feedback.

**Hub connectivity is not a safety interlock.** The mission state machine runs
entirely onboard (`navigator_node`); the server SSE link only carries operator
commands and telemetry. If the hub connection drops mid-mission, `bridge_node`
reconnects with backoff (`sse_reconnect_delay`, capped at 30 s) but the rover
keeps executing the current mission — a dropped link does **not** pause or stop
it. To halt a running rover you must trigger EMERGENCY_STOP: the `/stop` command
once the link is back, or the physical E-Stop (independent of the hub). The
onboard drive watchdog is a separate mechanism — it stops the wheels if the MCU
stops receiving drive commands (e.g. a `navigator_node` crash), not on hub loss.

Fleet-wide identical: hardware, NTRIP endpoint, `rover_params.yaml`. Per-rover differs only in `SERVER_URL` / `INTERNAL_SECRET` (or the optional `ROVER_SECRET`) / `NTRIP_USERNAME`.

## Image structure

| Image | Built by | Updates | Owns |
|-------|----------|---------|------|
| `ghcr.io/luftaquila/fsk-rover-host:{candidate,edge,vX.Y.Z}` | `host/Containerfile` | `bootc upgrade` (24 h, reboot) | AlmaLinux 10 + Pi 5 firmware/DTB, NM, sshd, tailscale, podman, udev, `pilot.service` + `pilot-run`, `perception.service` + `perception-run`, fsk user |
| `ghcr.io/luftaquila/fsk-rover-pilot:{candidate,edge,vX.Y.Z}` | `pilot/Containerfile` | `podman auto-update` (24 h, in-place) | ROS 2 Jazzy + the five `pilot` nodes |
| `ghcr.io/luftaquila/fsk-rover-perception:{candidate,edge,vX.Y.Z}` | `perception/Containerfile` | `podman auto-update` (24 h, in-place) | OpenCV camera streamer (WebRTC/aiortc + MJPEG fallback + VR stereo) + stereo obstacle detection (see `perception/`) |

- Host base: `quay.io/almalinuxorg/almalinux-bootc-rpi:10`.
- Stock `almalinux-bootc:10` lacks Pi 5 firmware and won't boot.

## Provisioning

1. **Build SD image** — manual dispatch `rover-sd-image.yml`. Auto-resolves
   the latest AlmaLinux gpt-10-arm64, applies fan dtparams, bakes a
   one-shot `fsk-firstboot.service` (`bootc switch …:candidate &&
   reboot`). Artifact: `fsk-rover-sd.img.xz`.

2. **Flash + boot**. Pi reboots once mid-bring-up. After ~60 s: IP on
   `eth0` (DHCP) or `wlan0` (default `fsk-default`: SSID `default`,
   PSK `password`). `pilot.service` restart-loops until step 3.

3. **Provision** (admin workstation, SSH key in <https://github.com/luftaquila.keys>):
   ```bash
   scripts/provision-rover.sh <rover-ip> [--ntrip-username=<id>]
   ```
   Reads `INTERNAL_SECRET`, `PUBLIC_URL` from `.env`. Idempotent.

4. **Wi-Fi**:
   ```bash
   ssh fsk@<rover-ip> sudo nmcli connection modify fsk-default \
       802-11-wireless.ssid 'MyAP' wifi-sec.psk 'mypassword'
   ssh fsk@<rover-ip> sudo nmcli connection up fsk-default
   ```

5. **Tailscale** (off-LAN):
   ```bash
   ssh fsk@<rover-ip> sudo tailscale up --auth-key=tskey-…
   ```

6. **Verify**:
   ```bash
   ssh fsk@<rover-ip> systemctl status pilot.service
   ssh fsk@<rover-ip> sudo journalctl -u pilot.service -n 50
   ```

7. **Pre-competition freeze**:
   ```bash
   ssh fsk@<rover-ip> sudo systemctl disable --now \
       bootc-fetch-apply-updates.timer podman-auto-update.timer
   ```

### Recovery

Unreachable (no LAN, no Tailscale) → reflash SD. On-rover: `bootc rollback`.

## Runtime configuration

| Knob | Storage | Change with |
|------|---------|-------------|
| `INTERNAL_SECRET` | podman secret `internal-secret` | `printf '%s' $val \| sudo podman secret create internal-secret -` |
| `NTRIP_USERNAME` | podman secret `ntrip-username` | same pattern |
| `SERVER_URL`, `ROS_DOMAIN_ID` | `/etc/pilot/pilot.conf` | `sudo $EDITOR /etc/pilot/pilot.conf` |
| Wi-Fi | `/etc/NetworkManager/system-connections/fsk-default.nmconnection` | `sudo nmcli connection modify fsk-default …` |
| Mission params | `pilot/config/rover_params.yaml` (baked) | new pilot build → push → auto-update |
| OTA channel | `bootc status` (host); `pilot-run` `IMAGE=` (pilot) | `sudo bootc switch …:edge`; rebake host |
| OTA freeze | both timers | `sudo systemctl disable --now <timer>` |

After changing `pilot.conf` or any secret: `sudo systemctl restart pilot.service`.

Fixed NTRIP settings (NGII):

| Field | Value |
|-------|-------|
| host:port | `www.gnssdata.or.kr:2101` |
| password | `gnss` |
| mountpoint | auto-selected (nearest base, RTCM 3.2) |

Battery calibration:

- File: `/var/lib/pilot/battery_cal.json` (host bind-mount).
- Persists across `systemctl restart`, `podman auto-update`, `bootc upgrade`.
- Bounds: `measured_v ∈ [15, 32] V`, `gain ∈ [0.5, 2.0]`. OOB → reset to `gain = 1.0`.

Antenna offset calibration (CAL_ANTENNA):

- File: `/var/lib/pilot/antenna_offset.json` (host bind-mount).
- Persisted `(a_x, a_y)` overrides the YAML default; absent / corrupt → fall back to YAML.
- Bounds: `a_x ∈ [0.05, 1] m`, `|a_y| ≤ 1 m`, RMS residual ≤ 10 cm, orbit sweep ≥ 270° (rejects orbits that didn't actually rotate the rover).

Wheel scale calibration (CAL_WHEELS):

- File: `/var/lib/pilot/wheel_cal.json` (host bind-mount).
- Persisted `(scale_l, scale_r)` is applied live by `mcu_bridge_node` as `v_wheel_corrected = v_wheel_raw × scale`.
- Bounds: `scale ∈ [0.85, 1.15]`, GPS chord ≥ 5 m, ≥ 50 samples (1 s @ 50 Hz). OOB → reject and refuse to persist (caller falls back to current live scale).

## OTA & rollback

```bash
# Host (rare; reboot to apply)
sudo bootc status
sudo systemctl start bootc-fetch-apply-updates.service
sudo bootc rollback && sudo systemctl reboot

# Pilot (frequent; in-place)
sudo systemctl start podman-auto-update.service
sudo podman pull ghcr.io/luftaquila.../fsk-rover-pilot:edge \
  && sudo systemctl restart pilot.service
```

State:

```bash
sudo bootc status
systemctl status pilot.service
sudo podman ps
sudo podman secret ls
sudo journalctl -u pilot.service -n 200
```

## MCU coprocessor (`mcu/`)

### Pinout

| Role | Pin | Notes |
|------|-----|-------|
| Left enc B/A | GP2, GP3 | PIO consecutive pins; lower = bit 0 |
| Right enc B/A | GP4, GP5 | |
| E-Stop | GP7 | NC + pull-up; HIGH = tripped |
| Steering servo | GP8 | S20F signal |
| Peristaltic pump | GP6 | IRLZ44N MOSFET gate; on/off (plain SIO) |
| Left mot PWM/DIR | GP15, GP27 | → MDD10A (PWM slice7B; DIR digital) |
| Right mot PWM/DIR | GP28, GP29 | → MDD10A (PWM slice6A; DIR digital) |
| Onboard status LED | GP16 | onboard WS2812 |
| Ext NeoPixel data | GP11 | 16-LED stick chain via 2N7002 shifter (firmware-inverted) |
| Nav lights | GP9 | red/green 3-pin module (+5V/GND/control), direct on/off |
| Battery V | GP26 (ADC0) | 100 kΩ : 10 kΩ |

### Firmware internals

- PIO0 SM0/SM1: quadrature decoders.
- PIO1 SM0: onboard WS2812. PIO1 SM1: external 16-LED stick chain (mirrors onboard 1:1).
- GP11 (ext LEDs) inverted via `gpio_set_outover` to cancel the 2N7002 level shifter; idle line stays low so the WS2812 reset gap is preserved.
- Nav lights (GP9): held on at boot, steady; on/off only (no PWM).
- Encoder VCC/signal off RP2040 3V3 rail.
- E-Stop fail-safe: open contact → tripped.

### Battery divider

```
Vbat ─[100 kΩ 1%]─┬─ GP26 (ADC0)
                  ├─ 100 nF ─ GND
                  └─[10 kΩ 1%]─ GND
```

### SOC mapping (8S LiFePO4)

- `mcu_bridge_node` does piecewise-linear OCV-SOC interpolation (LiFePO4 is flat 20–90 % SOC, so linear maps fail).
- Above 27.20 V → 100 %; below 20.00 V → 0 %.
- `voltage` = calibrated; `voltage_raw` = uncorrected ADC.

### Field calibration (1-point gain)

Operator path: battery popover → "전압 보정" → enter multimeter reading.

Pipeline:

```
POST /api/rover/calibrate-battery
  → SSE → bridge_node → /rover/cmd/calibrate_battery
  → gain = measured_v / V_raw
  → $PILOT_STATE_DIR/battery_cal.json
```

### USB CDC protocol

Line-based ASCII, `\n` terminated.

Pi → MCU:

| Cmd | Args | Meaning |
|-----|------|---------|
| `H` | — | Heartbeat |
| `M` | `<l_duty> <r_duty> <steer_us>` | Raw duty [-1,1]; sets RAW lane |
| `V` | `<l_mps> <r_mps> <steer_us>` | Closed-loop; sets PID lane |
| `E` | — | SW E-Stop |
| `C` | — | Clear SW E-Stop latch (a still-open HW line stays tripped) |
| `P` | `<kp> <ki> <kd>` | PID gains |
| `L` | `<0\|1>` | PID gate (`1` allow, `0` force RAW) |
| `K` | `<pulse_duty> <pulse_ms> <fire_above_mps>` | Brake-pulse params |
| `A` | — | Arm one brake pulse on the next setpoint-deadband entry |
| `D` | `<0\|1>` | Peristaltic pump off/on (independent of M/V) |
| `N` | `<0\|1>` | Nav fault from Pi (GPS lost): `1` set, `0` clear |
| `B` | — | Reboot to BOOTSEL; emits `! BOOTSEL` first |

PID runs only when `L 1` AND last setpoint was `V`.

MCU → Pi @ 50 Hz: `T <ms> <enc_l> <enc_r> <vel_l> <vel_r> <vbat> <flags>`

Flags (hex):

| Bit | Meaning |
|-----|---------|
| 0 | E-Stop |
| 1 | Pi heartbeat timeout |
| 2 | Battery undervolt (≤ 20 V — motors gated) |
| 3 | Battery warn (≤ 22 V) |
| 4 | PID active |
| 5 | Last boot from HW WDT |
| 6 | Nav GPS lost (Pi-reported; chassis stopped Pi-side) |
| 7 | Raw E-Stop line (physical button/wire HIGH; bit 0 also ORs the SW latch) |

Async: `! <msg>` (e.g. `! WDT TIMEOUT`).

### Status LED

| Color | State |
|-------|-------|
| dim white | boot |
| green | idle |
| blue | driving |
| yellow | battery warn |
| magenta | undervolt |
| orange blink | nav GPS lost |
| red blink | E-Stop |
| off (dark) | Pi link down (Pi powered off / unplugged) |

The two external NeoPixel Sticks (16 LEDs, GP11) mirror this onboard LED 1:1
— same colour and blink. When the Pi heartbeat times out (Pi powered off or
unplugged) the status LEDs + sticks go dark — the MCU stays powered from the
battery rail, so without this they would sit lit; E-Stop and undervolt still
override. The nav lights (GP9) are independent: steady on whenever the MCU is
powered, not tied to status.

### Build

```bash
sudo apt install cmake gcc-arm-none-eabi libnewlib-arm-none-eabi \
                 libstdc++-arm-none-eabi-newlib build-essential
git clone --depth 1 --recurse-submodules \
    https://github.com/raspberrypi/pico-sdk.git ~/pico-sdk
export PICO_SDK_PATH=~/pico-sdk
cmake -S rover/mcu -B rover/mcu/build -DPICO_BOARD=pico
cmake --build rover/mcu/build -j
```

Output: `build/rover_mcu.uf2`. Overrides (defaults r=62.5 mm, PPR=500, gear=27):
`-DWHEEL_RADIUS_M=… -DENCODER_PPR=… -DGEAR_RATIO=…`.

### Flash

| Context | Command |
|---------|---------|
| First time | hold BOOT, plug USB-C, drag `.uf2` to `RPI-RP2` |
| Rover Pi | `sudo flash-mcu rover_mcu.uf2` (pauses pilot for the duration) |
| Off-rover | `picotool load -f rover_mcu.uf2 && picotool reboot` |

Address as `/dev/ttyMCU` — `/dev/ttyACM*` ordering is non-deterministic.

> Current sensing intentionally omitted: MDD10A self-protects, encoder-vel = 0 with non-zero command covers stall. Re-add `current.c` + `FLAG_OVERCURRENT` if a shunt-amp lands.

## CI

| Workflow | Trigger | Output |
|----------|---------|--------|
| `rover-pilot-image.yml` | `main` push under `pilot/**`; manual | `fsk-rover-pilot` OCI; pytest gate |
| `rover-perception-image.yml` | `main` push under `perception/**`; manual | `fsk-rover-perception` OCI; compileall + pytest gate |
| `rover-host-image.yml` | `main` push under `host/**`; manual | `fsk-rover-host` OCI |
| `rover-sd-image.yml` | manual only | `fsk-rover-sd.img.xz` |
| `rover-mcu.yml` | `main` push under `mcu/**`; manual | `rover_mcu.uf2` |

## Release channels

| Trigger | Channel | Rollout |
|---------|---------|---------|
| `main` push | `:candidate` | auto-pull within 24 h |
| dispatch `edge` | `:edge` | `sudo bootc switch …:edge`; rebake host for pilot |
| dispatch `vX.Y.Z` | `:vX.Y.Z` | rollback reference |

- Default channel: `:candidate`.
- Re-disable both timers after manual upgrades.

## Local development (no rover)

```bash
mkdir -p ~/pilot_ws/src
ln -s "$(pwd)/pilot" ~/pilot_ws/src/pilot
cd ~/pilot_ws
source /opt/ros/jazzy/setup.bash
pip install -r src/pilot/requirements.txt
colcon build --packages-select pilot
source install/setup.bash

INTERNAL_SECRET=… NTRIP_USERNAME=YOUR_NGII_LOGIN PILOT_STATE_DIR=/tmp \
  ros2 launch pilot pilot.launch.py \
    server_url:=https://your-server.example/course
```

<details>
<summary>Mirror the rover's <code>/dev/tty{GPS,MCU}</code> symlinks (only if your dev box has these devices)</summary>

```bash
sudo install -m 644 \
    "$(pwd)/host/files/usr/lib/udev/rules.d/99-fsk-rover.rules" \
    /etc/udev/rules.d/99-fsk-rover.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=tty
```
</details>

Single-node:

```bash
ros2 run pilot gps_node --ros-args --params-file src/pilot/config/rover_params.yaml
ros2 topic echo /rover/gps/position
```

## Tests

```bash
cd rover/pilot && python3 -m pytest test/ -q
npm run test:course
npm run test:shared
```

