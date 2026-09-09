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

Bridge: `mcu_bridge_node`. Firmware CI: the `mcu` job in
`.github/workflows/rover.yml`.

## Architecture

Five ROS 2 Jazzy nodes run in the rootful `pilot` container with `--network=host`.
The separate [perception container](perception/README.md) shares the ROS graph,
streams camera video, and publishes `/rover/perception/obstacle` for local mission
pauses.

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

- **Antenna-precise docking**: `path_planner.py` emits one geometric segment per
  waypoint: `target_antenna` is the waypoint and chassis `end_pose` is
  `target − R(ψ_dock) · antenna_offset`. Dock bearing comes from the previous
  waypoint (live chassis pose for the first). The stateless planner compensates
  antenna offset and regenerates on skip, stuck, or replan.
- **State estimator**: at 20 Hz, fuses encoder (v, ω), GPS antenna position, and
  heading-of-motion with antenna-offset inversion into chassis (x, y, ψ).
  Encoder fusion avoids dependence on GPS heading's 200–500 ms latency.
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
- **CAL_ANTENNA**: after a straight chord fit, drive a circle at
  κ = ±1/`antenna_cal_radius_m` for `antenna_cal_revolutions`.
  `antenna_calibration.py` recovers (a_x, a_y) from chassis/antenna circle fits
  and mean phase, without instantaneous heading. Require sweep ≥270°
  (`SOLVE_CIRCLE_SWEEP_MIN_RAD`), per-circle RMS, and centre agreement before
  saving `$PILOT_STATE_DIR/antenna_offset.json`; stalled or interrupted orbits
  must not persist offsets.
- **CAL_WHEELS**: drive a straight 10 m chord at `wheel_cal_speed` and
  divide GPS chord distance by per-wheel encoder integration to recover
  per-wheel rolling-radius scale. Result written to
  `$PILOT_STATE_DIR/wheel_cal.json` and applied live via
  `/rover/cmd/apply_wheel_scales`. Bounded to ±15 % so encoder
  slip / GPS error never produces a runaway scale.

Thresholds are in `pilot/config/rover_params.yaml`. Measure
`antenna_offset_x` / `antenna_offset_y` on the chassis or run CAL_ANTENNA.

**Hub loss does not stop the rover.** Navigation runs onboard; `bridge_node`
reconnects with `sse_reconnect_delay` backoff capped at 30 s while the mission
continues. Use the physical E-Stop, or `/stop` after the link returns. The MCU
watchdog stops wheels when drive commands stop (for example, a navigator crash),
not when the hub disconnects.

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

1. **Build SD image** — manually dispatch `rover.yml` with component `sd`.
   It auto-resolves the latest AlmaLinux gpt-10-arm64, applies fan dtparams,
   bakes a one-shot `fsk-firstboot.service` (`bootc switch …:candidate &&
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
   ssh fsk@<rover-ip> sudo tailscale up --auth-key=tskey-… --accept-dns=true
   ```
   The baked NetworkManager profile keeps `1.1.1.1` and `8.8.8.8` as the
   system upstream resolvers. Tailscale preserves them as the public fallback
   while serving MagicDNS names (including short tailnet hostnames) through
   `100.100.100.100`. Chrony uses pinned NTP IPs before Tailscale starts, so a
   cold boot does not depend on either DNS path.

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
| Host DNS | public fallback in `fsk-default`; MagicDNS via Tailscale | `sudo tailscale set --accept-dns=true` |
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

Mission recovery:

- File: `/var/lib/pilot/mission_checkpoint.json` (host bind-mount).
- The navigator atomically persists the protocol-v2 mission, stable waypoint occurrence IDs, completed occurrences, immutable command result, command sequence, and original start before motion and after progress changes. Directory fsync failures fail closed. State reconciliation echoes the durable last-command ID, sequence, result, and reason so the server can order a held snapshot against a pending replay.
- Mission commands, state requests, and server reboot safety holds use reliable transient-local ROS QoS so bridge/navigator discovery order cannot lose a pending server intent. A safety hold remains retained and is retried by the server until the navigator has stopped, persisted the strongest local fence, and echoed its `hold_id` in a `held`/`interrupted` report. A `dispense_uncertain` hold ACK also carries the uncertainty reason, outcome, and occurrence ID, independent of cross-topic delivery order.
- A restored mission is always held until an explicit operator resume. An operator pause received during a GPS `ERROR` also revokes the saved auto-recovery state and remains durably paused after RTK returns. Terminal state is removed only after a mission-ID/plan-hash-correlated server reset.
- An invalid checkpoint creates a separate checksummed `mission_checkpoint.fault.json` latch. Start/resume stays fail-closed across reboots until a matching server reset or an explicit, command-correlated operator `end` recovery; best-effort identity read from a damaged file never authorizes motion.
- An empty protocol-v2 `resume` with `finish_behavior=stop` is a durable all-occurrences-skipped completion; empty `start` remains invalid, and `return_to_start` continues to support a return-only resume.
- Before firing the pump, the current occurrence is durably fenced as `dispense_uncertain`. A reboot, pause, E-stop, or timeout before the completion signal never auto-dispenses it again; the operator must skip the occurrence or replace it with a new occurrence for an explicit retry.

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

External NeoPixel sticks (16 LEDs, GP11) mirror the onboard status LED.
Pi heartbeat timeout makes both dark; E-Stop and undervoltage override this.
Independent nav lights (GP9) stay on while the MCU is powered.

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

All rover CI lives in `.github/workflows/rover.yml`. Pushes to `main` run only
the jobs selected by the changed paths; manual runs select one `component`.

| Component | Automatic trigger | Output |
|-----------|-------------------|--------|
| `pilot` | `pilot/**` | `fsk-rover-pilot` OCI; pytest gate |
| `perception` | `perception/**` | `fsk-rover-perception` OCI; compileall + pytest gate |
| `host` | `host/**` | `fsk-rover-host` OCI |
| `sd` | none (manual only) | `fsk-rover-sd.img.xz` |
| `mcu` | `mcu/**` | `rover_mcu.uf2` |
| `gps` | `gps/**` or shared Pilot library changes | compileall + pytest gate |

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
pnpm run test:course
pnpm run test:shared
```
