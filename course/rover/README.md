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
| Drive | 2× DC (Wheeltec R550 rear) | one MDD10A channel per wheel |
| Wheel encoders | 2× quadrature, 3.3 V push-pull, 500 PPR | MCU PIO + 3V3 |
| Steering servo | Wheeltec S20F (5–6.5 V, 20 kg·cm, stall 1.8 A) | MCU PWM |
| Spray servo | Standard RC | Pi GPIO PWM |
| E-Stop | NC momentary, fail-safe | MCU GP14, internal pull-up |
| Platform | Wheeltec R550 AKM Plus | Ackermann |
| Battery | 25.6 V (8S) LiFePO4, 6.6 Ah | XT60, BMS |
| Pi supply | 5 V 5 A buck → USB-C PD | Pi only |
| Servo supply | MP1584EN @ 5.5 V, ≥3 A | S20F + spray VCC |

Pi GPIO (BCM, RP1 — overridable in `pilot/config/rover_params.yaml`):

| Pin | Signal |
|-----|--------|
| 13  | Spray servo |

Pilot reaches RP1 via `/dev/gpiochip-rp1` + `/dev/gpiomem0`.

### Power chain

```
25.6 V LiFePO4 8S 6.6 Ah ─┬─► 5 V 5 A buck ──────► Pi 5 (USB-C PD)
                         ├─► MDD10A V_MOT ─────► rear DC motors
                         └─► MP1584EN @ 5.5 V ─► S20F + spray VCC
```

- All GNDs commoned.
- Battery thresholds: warn 22 V, undervolt cutoff 20 V.
- MP1584EN abs. max 30 V; 8S full charge 29.2 V is in range.
  LM2596HV (60 V) for margin.

### Drive control split

- **MCU**: encoders, motor PWM, steering, battery ADC, E-Stop, WDTs.
  Pi link USB CDC @ 50 Hz.
- **Pi**: navigation, RTK, course bridge, spray servo.

Bridge: `mcu_bridge_node`. Firmware CI: `.github/workflows/rover-mcu.yml`.

### Battery divider BoM

| Part | Notes |
|------|-------|
| 100 kΩ + 10 kΩ 1 % | 8S → MCU ADC0 |
| 100 nF ceramic | ADC0 → GND |
| 3.3 V Zener / TVS | ADC0 → GND clamp |

## Architecture

Five ROS 2 Jazzy nodes, one rootful podman container, `--network=host`:

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

Devices via quadlet `AddDevice=`.

### Mission state machine (`navigator_node`)

```
IDLE → CALIBRATING → NAVIGATING → SETTLING → SPRAYING ─(next wp)→ NAVIGATING
                                                           │
                                        (all waypoints done)│
                                                           ▼
                                                       RETURNING → IDLE

any state → EMERGENCY_STOP (on /rover/cmd/emergency_stop)
any driving state → ERROR   (GPS timeout / fix below quality > fix_hysteresis_s)
```

- **CALIBRATING**: drive 2.5 m, derive heading from delta. ERROR at 5 m.
- **NAVIGATING**: Pure Pursuit, `max_curvature` 3.0 1/m, `fix_hysteresis_s` 0.8 s.
- **SETTLING → SPRAYING**: within 3 cm for 5 consecutive samples → fire.

Thresholds in `pilot/config/rover_params.yaml`.

## Image structure

| Image | Built by | Updates | Owns |
|-------|----------|---------|------|
| `ghcr.io/luftaquila/fsk-rover-host:{candidate,edge,vX.Y.Z}` | `host/Containerfile` | `bootc upgrade` (24 h, reboot) | AlmaLinux 10 + Pi 5 firmware/DTB, NM, sshd, tailscale, podman, udev, pilot quadlet, fsk user |
| `ghcr.io/luftaquila/fsk-rover-pilot:{candidate,edge,vX.Y.Z}` | `pilot/Containerfile` | `podman auto-update` (24 h, in-place) | ROS 2 Jazzy + the five `pilot` nodes |

Host base: `quay.io/almalinuxorg/almalinux-bootc-rpi:10`. Stock
`almalinux-bootc:10` lacks Pi 5 firmware and won't boot.

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

4. **SELinux** (once per rover):
   ```bash
   ssh fsk@<rover-ip> sudo setsebool -P container_use_devices on
   ```

5. **Wi-Fi**:
   ```bash
   ssh fsk@<rover-ip> sudo nmcli connection modify fsk-default \
       802-11-wireless.ssid 'MyAP' wifi-sec.psk 'mypassword'
   ssh fsk@<rover-ip> sudo nmcli connection up fsk-default
   ```

6. **Tailscale** (off-LAN):
   ```bash
   ssh fsk@<rover-ip> sudo tailscale up --auth-key=tskey-…
   ```

7. **Verify**:
   ```bash
   ssh fsk@<rover-ip> systemctl status pilot.service
   ssh fsk@<rover-ip> sudo journalctl -u pilot.service -n 50
   ```

8. **Pre-competition freeze**:
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
| OTA channel | `bootc status` (host); quadlet `Image=` (pilot) | `sudo bootc switch …:edge`; rebake host |
| OTA freeze | both timers | `sudo systemctl disable --now <timer>` |

After changing `pilot.conf` or any secret: `sudo systemctl restart pilot.service`.

NTRIP host/port/password/mountpoint are fixed (NGII `www.gnssdata.or.kr:2101`,
password `gnss`, auto mountpoint).

Battery calibration: `/var/lib/pilot/battery_cal.json` (host bind-mount).
Survives `systemctl restart`, `podman auto-update`, `bootc upgrade`.
Bounds: `measured_v ∈ [15, 32] V`, `gain ∈ [0.5, 2.0]`; OOB → `gain = 1.0`.

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

RP2040-Zero firmware. Pi link: USB CDC.

### Pinout

| Role | Pin | Notes |
|------|-----|-------|
| Left enc B/A | GP2, GP3 | PIO consecutive pins; lower = bit 0 |
| Right enc B/A | GP4, GP5 | |
| E-Stop | GP6 | NC + pull-up; HIGH = tripped |
| Steering servo | GP8 | S20F signal |
| Left mot PWM/DIR | GP10, GP11 | → MDD10A |
| Right mot PWM/DIR | GP12, GP13 | → MDD10A |
| Status LED | GP16 | onboard WS2812 |
| Battery V | GP27 (ADC1) | 100 kΩ : 10 kΩ |

PIO0 SM0/SM1 = quadrature. PIO1 SM0 = WS2812.
Encoder VCC/signal off RP2040 3V3 rail. E-Stop fail-safe (open → trip).

### Battery divider

```
Vbat ─[100 kΩ 1%]─┬─ GP26
                  ├─ 100 nF ─ GND
                  ├─ 3.3 V Zener/TVS ─ GND
                  └─[10 kΩ 1%]─ GND
```

### SOC mapping (8S LiFePO4)

`mcu_bridge_node` does piecewise-linear OCV-SOC interpolation (LiFePO4
is flat 20–90 % SOC; linear maps fail). Above 27.20 V → 100 %; below
20.00 V → 0 %. `voltage` = calibrated; `voltage_raw` = uncorrected ADC.

### Field calibration (1-point gain)

Course UI: battery popover → "전압 보정" → enter multimeter reading.
`POST /api/rover/calibrate-battery` → SSE → `bridge_node` →
`/rover/cmd/calibrate_battery` → `gain = measured_v / V_raw` →
`$PILOT_STATE_DIR/battery_cal.json`.

### USB CDC protocol

Line-based ASCII, `\n` terminated.

Pi → MCU:

| Cmd | Args | Meaning |
|-----|------|---------|
| `H` | — | Heartbeat |
| `M` | `<l_duty> <r_duty> <steer_us>` | Raw duty [-1,1]; sets RAW lane |
| `V` | `<l_mps> <r_mps> <steer_us>` | Closed-loop; sets PID lane |
| `E` | — | SW E-Stop |
| `C` | — | Clear E-Stop (after GPIO returns to rest) |
| `P` | `<kp> <ki> <kd>` | PID gains |
| `L` | `<0\|1>` | PID gate (`1` allow, `0` force RAW) |
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

Async: `! <msg>` (e.g. `! WDT TIMEOUT`).

### Status LED

| Color | State |
|-------|-------|
| dim white | boot |
| green | idle |
| blue | driving |
| yellow | heartbeat timeout / battery warn |
| magenta | undervolt |
| red blink | E-Stop |

### Build

```bash
sudo apt install cmake gcc-arm-none-eabi libnewlib-arm-none-eabi \
                 libstdc++-arm-none-eabi-newlib build-essential
git clone --depth 1 --recurse-submodules \
    https://github.com/raspberrypi/pico-sdk.git ~/pico-sdk
export PICO_SDK_PATH=~/pico-sdk
cmake -S course/rover/mcu -B course/rover/mcu/build -DPICO_BOARD=pico
cmake --build course/rover/mcu/build -j
```

Output: `build/rover_mcu.uf2`. Overrides (defaults r=32.5 mm, PPR=500):
`-DWHEEL_RADIUS_M=… -DENCODER_PPR=…`.

### Flash

- First time: hold BOOT, plug USB-C, drag `.uf2` to `RPI-RP2`.
- Rover Pi: `sudo flash-mcu rover_mcu.uf2`. Pilot is paused for the duration.
- Off-rover: `picotool load -f rover_mcu.uf2 && picotool reboot`.

Address as `/dev/ttyMCU` — `/dev/ttyACM*` ordering is non-deterministic.

### Omitted: motor current sensing

MDD10A self-protects; encoder vel = 0 with non-zero command covers
stall. Re-add `current.c` + `FLAG_OVERCURRENT` if a shunt-amp lands.

## CI

| Workflow | Trigger | Output |
|----------|---------|--------|
| `rover-pilot-image.yml` | `main` push under `pilot/**`; manual | `fsk-rover-pilot` OCI; pytest gate |
| `rover-host-image.yml` | `main` push under `host/**`; manual | `fsk-rover-host` OCI |
| `rover-sd-image.yml` | manual only | `fsk-rover-sd.img.xz` |
| `rover-mcu.yml` | `main` push under `mcu/**`; manual | `rover_mcu.uf2` |

Manual dispatch with `release_channel=vX.Y.Z` or `edge` for promotion.
GHCR auth via `GITHUB_TOKEN`.

## Release channels

| Trigger | Channel | Rollout |
|---------|---------|---------|
| `main` push | `:candidate` | auto-pull within 24 h |
| dispatch `edge` | `:edge` | `sudo bootc switch …:edge`; rebake host for pilot |
| dispatch `vX.Y.Z` | `:vX.Y.Z` | rollback reference |

Default channel: `:candidate`. Re-disable both timers after manual upgrades.

## Local development (no rover)

```bash
mkdir -p ~/pilot_ws/src
ln -s "$(pwd)/pilot" ~/pilot_ws/src/pilot
cd ~/pilot_ws
source /opt/ros/jazzy/setup.bash
pip install -r src/pilot/requirements.txt
colcon build --packages-select pilot
source install/setup.bash

sudo install -m 644 \
    "$(pwd)/host/files/usr/lib/udev/rules.d/99-fsk-rover.rules" \
    /etc/udev/rules.d/99-fsk-rover.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=tty

INTERNAL_SECRET=… NTRIP_USERNAME=YOUR_NGII_LOGIN PILOT_STATE_DIR=/tmp \
  ros2 launch pilot pilot.launch.py \
    server_url:=https://your-server.example/course
```

Single-node:

```bash
ros2 run pilot gps_node --ros-args --params-file src/pilot/config/rover_params.yaml
ros2 topic echo /rover/gps/position
```

## Tests

```bash
cd course/rover/pilot && python3 -m pytest test/ -q
npm run test:course
npm run test:shared
```

## Operating assumptions

- Hardware and NTRIP endpoint identical fleet-wide.
- `pilot/config/rover_params.yaml` identical fleet-wide.
- Per-rover: `SERVER_URL`, `INTERNAL_SECRET`, `NTRIP_USERNAME` only.

## File map

| File | Owns |
|------|------|
| `pilot/config/rover_params.yaml` | tunables + inline docs |
| `pilot/pilot/navigator_node.py` | mission state machine |
| `pilot/pilot/mcu_bridge_node.py` | USB CDC; Ackermann; odom; battery |
| `pilot/pilot/spray_node.py` | spray servo (Pi GPIO 13) |
| `pilot/pilot/bridge_node.py` | course server SSE/REST + telemetry |
| `pilot/pilot/lib/ackermann.py` | Ackermann kinematics |
| `pilot/pilot/lib/ntrip_client.py` | NTRIP v2 client |
| `pilot/pilot/lib/ubx_parser.py` | ZED-F9P UBX parser |
| `pilot/Containerfile` | pilot OCI build |
| `host/Containerfile` | host bootc build |
| `host/files/etc/containers/systemd/pilot.container` | quadlet |
| `host/files/etc/pilot/pilot.conf.example` | env template |
| `host/files/etc/NetworkManager/system-connections/fsk-default.nmconnection` | default Wi-Fi |
| `host/files/etc/tmpfiles.d/pilot-state.conf` | `/var/lib/pilot/` |
| `host/files/usr/lib/udev/rules.d/99-fsk-rover.rules` | device symlinks |
| `host/files/usr/local/bin/flash-mcu` | on-rover MCU reflash |
| `mcu/` | RP2040 firmware (pico-sdk, C) |
| `../../scripts/provision-rover.sh` | post-flash provisioning |
