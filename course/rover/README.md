# FSK Rover

Raspberry Pi 5 + RTK GPS rover. Drives a waypoint mission and sprays a
marker at each cone. Runs as a podman container on AlmaLinux bootc;
remote access via Tailscale.

## Hardware

| Role | Part | Interface |
|------|------|-----------|
| Compute | Raspberry Pi 5 | — |
| Coprocessor | Waveshare RP2040-Zero | USB CDC (`/dev/ttyMCU`) |
| GPS | u-blox ZED-F9P | USB CDC (`/dev/ttyGPS`) |
| RTK corrections | NTRIP caster (NGII) | TCP |
| Motor driver | Cytron MDD10A | MCU GPIO PWM + DIR |
| Drive | 2× DC motor (Wheeltec R550 rear) | One MDD10A channel per wheel |
| Wheel encoders | 2× quadrature, 3.3 V push-pull, 500 PPR | MCU PIO + 3V3 supply |
| Steering servo | Wheeltec S20F (5–6.5 V, 20 kg·cm, 0.18 s/60°, 180°, stall 1.8 A, dead-zone 4 µs) | MCU GPIO PWM, signal only |
| Spray servo | Standard RC servo | Pi GPIO PWM (mission-specific) |
| E-Stop | NC momentary, fail-safe | MCU GP14 ↔ GND, internal pull-up; HIGH = tripped |
| Platform | Wheeltec R550 AKM Plus | Ackermann |
| Battery | 25.6 V (8S) LiFePO4, 6.6 Ah | XT60, BMS-protected |
| Pi supply | 5 V 5 A buck (battery → USB-C PD trigger) | Powers Pi 5 only |
| Servo supply | MP1584EN buck (5.5 V, ≥3 A) | S20F + spray VCC; signal lines stay on GPIO |

Pi GPIO (BCM, RP1 pinctrl) — overridable in `pilot/config/rover_params.yaml`:

| Pin | Signal |
|-----|--------|
| 13  | Spray servo (signal) |

The pilot container reaches RP1 via `/dev/gpiochip-rp1` (a stable udev
symlink that absorbs the chip-number changes RP1 has gone through across
firmware revisions) plus `/dev/gpiomem0`. MCU pin map and USB CDC
protocol: [§ MCU coprocessor](#mcu-coprocessor).

### Power chain

```
25.6 V LiFePO4 8S 6.6 Ah ─┬─► 5 V 5 A buck ──────► Pi 5 (USB-C PD)
                         ├─► MDD10A V_MOT ─────► rear DC motors
                         └─► MP1584EN @ 5.5 V ─► S20F + spray VCC
```

- S20F stall 1.8 A → servo VCC off Pi/MCU rail.
- Servo signal on 3.3 V GPIO (within S20F threshold).
- All GNDs commoned (battery, MDD10A, MP1584EN, Pi, MCU).
- Battery thresholds (firmware): warn 22 V, undervolt cutoff 20 V.
- MP1584EN: rec. 4.5–28 V, abs. max 30 V. 8S full charge 29.2 V is
  above rec., below abs. max. For margin: LM2596HV (abs. max 60 V).

### Drive control split

- **MCU (RP2040)** owns drive I/O — wheel encoders (PIO quadrature),
  MDD10A motor PWM, S20F steering, battery ADC, E-Stop, hardware +
  Pi-heartbeat watchdog. Pi link: USB CDC @ 50 Hz.
- **Pi** owns navigation, RTK, course-server bridge, and the
  mission-specific spray servo (BCM 13 via `spray_node`).

The bridge between them is `mcu_bridge_node`. Wire protocol and pin
map: [§ MCU coprocessor](#mcu-coprocessor). Firmware CI:
`.github/workflows/rover-mcu.yml`.

Battery divider supplements (BoM):

| Part | Notes |
|------|-------|
| Divider 100 kΩ + 10 kΩ 1 % | 8S → MCU ADC0 |
| 100 nF ceramic | ADC0 → GND |
| 3.3 V Zener / TVS | ADC0 → GND clamp |

## Architecture

Five ROS 2 Jazzy nodes, packaged together in a single rootful podman
container, bridge the course backend over SSE + REST:

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
                  (motor PWM, S20F, encoders,             │
                   battery, E-Stop, watchdog)             │
                                                /rover/nav/waypoint_reached
                                                          │
                                                   spray_node ── /rover/spray/done
                                                   (Pi GPIO 13, mission)
```

The container runs `--network=host` so DDS multicast and the course
server REST/SSE work against the host's NetworkManager-managed
interfaces, and pulls the GPS, MCU, and GPIO devices in via the
quadlet's `AddDevice=` directives.

### Mission state machine (`navigator_node`)

```
IDLE → CALIBRATING → NAVIGATING → SETTLING → SPRAYING ─(next wp)→ NAVIGATING
                                                           │
                                        (all waypoints done)│
                                                           ▼
                                                       RETURNING → IDLE

any state → EMERGENCY_STOP (on /rover/cmd/emergency_stop)
any driving state → ERROR   (GPS timeout or fix below required quality
                             for > fix_hysteresis_s; resumes when fix returns)
```

- **CALIBRATING** — drive straight to `calibration_distance` (2.5 m);
  derive heading from the position delta. Extend once on high variance;
  enter ERROR at `calibration_max_distance` (5 m) rather than accept a
  bad heading.
- **NAVIGATING** — Pure Pursuit, `max_curvature` clamp (3.0 1/m).
  `fix_hysteresis_s` (0.8 s) absorbs RTK fixed↔float flicker before
  tripping ERROR.
- **SETTLING → SPRAYING** — creep until within `settle_tolerance`
  (3 cm) for `settle_readings` (5) consecutive samples, then fire.

All thresholds, speeds, timeouts: `pilot/config/rover_params.yaml`
(inline comments).

## Image structure

Two OCI images, decoupled lifecycles:

| Image | Built by | Updates | Owns |
|-------|----------|---------|------|
| `ghcr.io/luftaquila/fsk-rover-host:{candidate,edge,vX.Y.Z}` | `course/rover/host/Containerfile` | `bootc upgrade` (24 h timer, reboot to apply) | AlmaLinux 10 + Pi 5 firmware/DTB, NetworkManager, sshd, tailscale, podman, udev rules, the pilot quadlet, fsk user with baked authorized_keys |
| `ghcr.io/luftaquila/fsk-rover-pilot:{candidate,edge,vX.Y.Z}` | `course/rover/pilot/Containerfile` | `podman auto-update` (24 h timer, in-place restart) | ROS 2 Jazzy + the five `pilot` nodes |

The host image is based on `quay.io/almalinuxorg/almalinux-bootc-rpi:10`,
which is the only public bootc base that ships the Pi 5 boot chain
(VPU → SPI bootloader → `bcm2712-rpi-5-b.dtb` + `kernel_2712.img`).
Stock `almalinux-bootc:10` is missing those firmware assets and the SPI
bootloader cannot read the SD media at all. AlmaLinux 10 is chosen
over 9 for ~35% smaller layers (rebuilt standard profile in 10);
podman, NetworkManager, openssh-server, and the bootc/podman timers
are version-equivalent on both releases.

## Provisioning

CI builds the OCI images; field bring-up flashes a SD image once and
then runs one SSH session per rover.

1. **Build SD image** — manual-dispatch `.github/workflows/rover-sd-image.yml`.
   No inputs required: the workflow auto-resolves the latest
   AlmaLinux bootc-rpi gpt-10-arm64 asset, applies Pi 5 fan dtparams
   to `config.txt`, and bakes a one-shot `fsk-firstboot.service` that
   runs `bootc switch fsk-rover-host:candidate && reboot` on first
   boot. Artifact: `rover-sd-image` → `fsk-rover-sd.img.xz`.

2. **Flash + boot** — write the artifact to a SD card, boot the Pi 5.
   The Pi reboots once mid-bring-up (firstboot service switches to
   the FSK host image). Within ~60 s after the second boot the rover
   has an IP on `eth0` (DHCP) or `wlan0` (default `fsk-default`
   profile: SSID `default`, PSK `password`). `pilot.service` enters a
   restart loop until step 3 — expected, secrets are not in the SD.

3. **Provision** — from the admin workstation (repo checkout, your SSH
   public key in <https://github.com/luftaquila.keys>):
   ```bash
   scripts/provision-rover.sh <rover-ip> [--ntrip-username=<id>]
   ```
   Reads `INTERNAL_SECRET` and `PUBLIC_URL` from `.env`, writes
   `/etc/pilot/pilot.conf`, creates the `internal-secret` and
   `ntrip-username` podman secrets, restarts `pilot.service`.
   Idempotent.

4. **Enable the SELinux container-device boolean** (once per rover):
   ```bash
   ssh fsk@<rover-ip> sudo setsebool -P container_use_devices on
   ```
   Required for the pilot container's `AddDevice=/dev/ttyGPS …`
   under enforcing mode. Persists across `bootc upgrade`.

5. **Wi-Fi (recommended)** — move the rover off the default AP:
   ```bash
   ssh fsk@<rover-ip> sudo nmcli connection modify fsk-default \
       802-11-wireless.ssid 'MyAP' \
       wifi-sec.psk 'mypassword'
   ssh fsk@<rover-ip> sudo nmcli connection up fsk-default
   ```
   Mutates `/etc/NetworkManager/system-connections/fsk-default.nmconnection`;
   survives reboots and `bootc upgrade`.

6. **Tailscale (off-LAN access only)**:
   ```bash
   ssh fsk@<rover-ip> sudo tailscale up --auth-key=tskey-…
   ```

7. **Verify**:
   ```bash
   ssh fsk@<rover-ip> systemctl status pilot.service
   ssh fsk@<rover-ip> sudo journalctl -u pilot.service -n 50
   ```
   `gps_node`, `navigator_node`, `bridge_node` come up unconditionally.
   `mcu_bridge_node` needs the RP2040 on `/dev/ttyMCU`; on a bench
   without the MCU it logs serial-open warnings and retries.
   `spray_node` needs Pi GPIO 13 wired to the spray servo.

8. **Pre-competition hold** — freeze the rover for the competition week:
   ```bash
   ssh fsk@<rover-ip> sudo systemctl disable --now \
       bootc-fetch-apply-updates.timer podman-auto-update.timer
   ```
   Re-enable with `systemctl enable --now …` after the event.

### Recovering an unreachable rover

If the rover is on a network where neither the default AP nor ethernet
DHCP can reach it, and it hasn't joined Tailscale yet, the recovery is
to re-flash the SD card. There is no equivalent of Ubuntu Core's
`auto-import.assert` USB recovery — bootc's first line of defense is
on-device `bootc rollback`, the second is reflash.

## Runtime configuration

bootc keeps the host image immutable; runtime knobs live outside the
image so that `bootc upgrade` doesn't churn them. Each piece uses the
target-native primitive directly — there is no `snap set` wrapper.

| Knob | Storage | Change with | Notes |
|------|---------|-------------|-------|
| `INTERNAL_SECRET` | rootful podman secret `internal-secret` | `printf '%s' $val \| sudo podman secret rm internal-secret 2>/dev/null; sudo podman secret create internal-secret -` | Wired to the container as `INTERNAL_SECRET` env. Not visible to `ros2 param get`. |
| `NTRIP_USERNAME` | rootful podman secret `ntrip-username` | same pattern as above | Wired as `NTRIP_USERNAME` env. NGII host (`www.gnssdata.or.kr`), port (`2101`), password (`gnss`) and mountpoint (auto, nearest base station) are not configurable. |
| `SERVER_URL`, `ROS_DOMAIN_ID` | `/etc/pilot/pilot.conf` (KEY=VALUE) | `sudo $EDITOR /etc/pilot/pilot.conf` | Loaded by quadlet `EnvironmentFile=`. |
| Wi-Fi SSID/PSK | `/etc/NetworkManager/system-connections/fsk-default.nmconnection` | `sudo nmcli connection modify fsk-default …` | Empty values invalid — NetworkManager rejects them at apply time. |
| Mission parameters (speeds, tolerances) | `pilot/config/rover_params.yaml` baked into pilot image | New pilot image build → push → auto-update | Intentionally not runtime-mutable; revert via `bootc rollback` is per-host, mission revert via `podman pull <prior-tag>`. |
| OTA channel | `bootc status` (host), `pilot.container` `Image=` line (pilot) | `sudo bootc switch ghcr.io/.../fsk-rover-host:edge`, edit + rebake host image for pilot | — |
| OTA freeze | `bootc-fetch-apply-updates.timer`, `podman-auto-update.timer` | `sudo systemctl disable --now <timer>` | Re-enable with `systemctl enable --now <timer>`. |

After changing any value the container reads (`pilot.conf` or a secret),
restart the unit:

```bash
sudo systemctl restart pilot.service
```

After taking up `fsk-default` with new credentials, the SSH session you
ran the command from will drop with the old AP — reconnect over the new
network or fall back to ethernet.

Battery calibration persists at `/var/lib/pilot/battery_cal.json` on
the host (bind-mounted into the container). Survives `systemctl
restart`, `podman auto-update`, and `bootc upgrade`. To inspect:

```bash
sudo cat /var/lib/pilot/battery_cal.json
```

Sanity bounds enforced by `mcu_bridge_node`: `measured_v ∈ [15, 32] V`,
`gain ∈ [0.5, 2.0]`. A corrupt or out-of-range cal file falls back to
`gain = 1.0` so a bad calibration can't brick the rover.

## OTA & rollback

Two independent update channels:

```bash
# Host (rare; reboot to apply)
sudo bootc status                          # show booted/staged digests
sudo systemctl start bootc-fetch-apply-updates.service   # fetch now
sudo bootc rollback && sudo systemctl reboot             # revert previous

# Pilot container (frequent; in-place)
sudo systemctl start podman-auto-update.service          # pull now
sudo podman pull ghcr.io/luftaquila/fsk-rover-pilot:edge \
  && sudo systemctl restart pilot.service                # manual promote
```

`bootc upgrade` is atomic — on reboot the bootloader switches to the
new deployment, and if boot fails the previous deployment is preserved
for a one-command rollback. `podman auto-update` checks the
`io.containers.autoupdate=registry` label and pulls when the digest
of the configured tag changes.

Mission changes ship through the pilot pipeline — do not reflash images
for them. Reflash is only needed for fresh provisioning, hardware
swaps, or when a new AlmaLinux bootc-rpi base ships changes that
cannot be reached via `bootc upgrade` alone.

Rover state inspection:

```bash
sudo bootc status
systemctl status pilot.service
sudo podman ps
sudo podman secret ls
sudo journalctl -u pilot.service -n 200
```

The course web UI surfaces a live status badge (connected · fix · NTRIP
· nav state) from `/api/rover/telemetry`.

## MCU coprocessor (`mcu/`)

RP2040-Zero firmware. Owns drive I/O: encoders (PIO quadrature),
MDD10A motor PWM, S20F steering PWM, speed PID, battery monitor,
E-Stop, HW + Pi-heartbeat watchdog, status LED. Pi link: USB CDC.

### Pinout

| Role | Pin | Notes |
|------|-----|-------|
| Left enc B/A    | GP2, GP3   | PIO needs the two phases on consecutive pins; lower = bit 0 |
| Right enc B/A   | GP4, GP5   | |
| E-Stop          | GP6        | NC + internal pull-up; HIGH = tripped (fail-safe) |
| Steering servo  | GP8        | S20F signal; VCC from BEC (slice4) |
| Left mot PWM/DIR | GP10, GP11 | → MDD10A PWM/DIR (PWM on slice5 chA) |
| Right mot PWM/DIR| GP12, GP13 | → MDD10A PWM/DIR (PWM on slice6 chA) |
| Status LED      | GP16       | onboard WS2812 |
| Battery V       | GP27 (ADC1)| 100 kΩ : 10 kΩ divider |

PIO usage: PIO0 SM0/SM1 = quadrature encoder (offset 0). PIO1 SM0 = WS2812.

Wheel encoders are 3.3 V push-pull — both the signal lines and power
(`VCC`/`GND`) come straight from the RP2040 (3V3 rail). No level
shifter; soft pull-ups on the input pins are harmless for a push-pull
driver. The PIO state machine reads the lower of each pair as bit 0,
so swapping which physical wire goes to the lower pin only flips
count direction.

E-Stop wiring is fail-safe: NC button between GP14 and GND with the
internal pull-up enabled. At rest the closed contact pulls LOW;
pressing the button or any open in the loop (broken wire, popped
connector) lets the pull-up take it HIGH. Firmware trips on HIGH so a
damaged cable also stops the rover.

### Battery divider

```
Vbat ─[100 kΩ 1%]─┬─ GP26
                  ├─ 100 nF ─ GND
                  ├─ 3.3 V Zener/TVS ─ GND
                  └─[10 kΩ 1%]─ GND
```

#### SOC mapping (8S LiFePO4)

`mcu_bridge_node` maps pack voltage → SOC % using a piecewise-linear
OCV-SOC table (rest voltage, no load). LiFePO4's discharge curve is
extremely flat between ~20 % and ~90 % SOC — most cells sit at
3.27–3.32 V — so a naïve linear `(V - V_empty) / (V_full - V_empty)`
map gives wildly wrong readings in the operating range. Above 27.20 V
clamps to 100 % (charger surface charge up to 29.2 V also clamps);
below 20.00 V clamps to 0 % (cell undervolt cutoff).

Voltages are read under load (motor IR drop) — % is most accurate at
rest. The reported `voltage` already has the field-calibrated gain
applied; `voltage_raw` carries the uncorrected ADC reading.

#### Field calibration (1-point gain)

The dominant ADC error sources on this board are *ratiometric*:
divider-resistor tolerance + RP2040 ADC Vref drift. Both shift with
temperature, which is why a one-time bench cal won't hold across a
hot summer day vs a cold morning. Operators re-calibrate in the field
via the course UI:

1. Battery chip popover → "전압 보정"
2. Read multimeter at the battery, type the value into the modal
3. Submit → `POST /api/rover/calibrate-battery {measured_v}` →
   SSE `calibrate-battery` → `bridge_node` publishes Float32 on
   `/rover/cmd/calibrate_battery` → `mcu_bridge_node` derives
   `gain = measured_v / V_raw` and persists to
   `$PILOT_STATE_DIR/battery_cal.json` (`/var/lib/pilot/battery_cal.json`
   on the host, bind-mounted into the container).

The saved JSON survives reboots, `podman auto-update`, and
`bootc upgrade`. Sanity bounds: `measured_v ∈ [15, 32] V`,
`gain ∈ [0.5, 2.0]`. A corrupt or out-of-range cal file falls back to
`gain = 1.0` so a bad calibration can't brick the rover.

### USB CDC protocol

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
| `B` | — | Reboot into USB BOOTSEL for `.uf2` reflash; emits `! BOOTSEL` first |

Two orthogonal state bits drive the control loop:

- **`g_pid_enabled`** — toggled by `L`. Gates whether the PID branch
  may run at all.
- **`g_use_raw_motor`** — set by command type. `M` sets RAW, `V` sets
  PID-lane.

The control loop uses the PID branch only when both agree — `L 1`
*and* the last setpoint command was `V`. Anything else (including a
fresh `M` after `V`) drops to the raw-duty bypass. The bridge sends
`P …` and `L (use_pid?1:0)` once at startup; each ROS velocity
callback then emits either `M` or `V` depending on the `use_pid`
parameter.

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

### Status LED

| Color | State |
|-------|-------|
| dim white | boot |
| green | idle |
| blue | driving |
| yellow | Pi heartbeat timeout, battery warn |
| magenta | battery undervolt |
| red blink | E-Stop active |

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

Output: `build/rover_mcu.uf2`.

Wheel/encoder overrides (defaults: r = 32.5 mm, PPR = 500):

```bash
cmake -S … -B … -DWHEEL_RADIUS_M=0.04 -DENCODER_PPR=200
```

### Flash

- First time (firmware doesn't yet know `B`): hold BOOT, plug USB-C,
  drag `.uf2` to the `RPI-RP2` drive.
- Subsequent (rover Pi): `sudo flash-mcu rover_mcu.uf2`.
  Sends `B` on `/dev/ttyMCU`, mounts the resulting RPI-RP2 disk,
  copies the file, waits for re-enumeration. The pilot container is
  paused for the duration and resumed automatically. Baked into the
  host image at `/usr/local/bin/flash-mcu`; updates flow through
  `bootc upgrade`.
- Off-rover host: `picotool load -f rover_mcu.uf2 && picotool reboot`.

After flash, the board enumerates as a USB CDC device. Always address
it via the udev symlink `/dev/ttyMCU` (installed by
`host/files/usr/lib/udev/rules.d/99-fsk-rover.rules`) — raw
`/dev/ttyACM*` ordering is non-deterministic when both the GPS and the
MCU are present.

### Omitted: motor current sensing

MDD10A self-protects; encoder velocity = 0 with a non-zero command
already covers stall detection. Re-add `current.c` + `FLAG_OVERCURRENT`
if a real shunt-amp / INA219 ever lands.

## CI

| Workflow | Trigger | Output |
|----------|---------|--------|
| `.github/workflows/rover-pilot-image.yml` | `main` push touching `course/rover/pilot/**` (→ `:candidate`), or manual dispatch with `release_channel` input | `ghcr.io/luftaquila/fsk-rover-pilot` OCI; `compileall` + pytest gate the build |
| `.github/workflows/rover-host-image.yml` | `main` push touching `course/rover/host/**` (→ `:candidate`), or manual dispatch | `ghcr.io/luftaquila/fsk-rover-host` OCI |
| `.github/workflows/rover-sd-image.yml` | Manual dispatch only (provisioning-only artifact) | Flashable `.img.xz` artifact: AlmaLinux bootc-rpi base + Pi 5 fan dtparams + first-boot `bootc switch` to `fsk-rover-host:candidate` |
| `.github/workflows/rover-mcu.yml` | `main` push touching `course/rover/mcu/**`, or manual dispatch | RP2040 coprocessor firmware (`rover_mcu.uf2`) |

PR / tag triggers are intentionally absent — every workflow auto-runs
on `main` push (path-gated) and is otherwise manual. Tag-based promotion
is done by manually dispatching with `release_channel=vX.Y.Z` (or `edge`).
The two OCI image workflows publish to GitHub Container Registry using
`GITHUB_TOKEN` — no external store credentials. The SD image workflow
takes the AlmaLinux-published prebuilt SD URL as a manual input; the
artifact is provisioning-only, deployed rovers track host/pilot
updates via the OTA timers without ever needing a fresh SD.

The pilot pipeline handles rolling updates; the host pipeline only
runs on host-config changes (sshd, NM defaults, sudoers, udev,
quadlet, dnf packages); the SD pipeline is only needed for first-time
provisioning, hardware swaps, or a base-OS jump that `bootc upgrade`
cannot reach (very rare).

## Release channels

| Trigger | Channel | Rollout |
|---------|---------|---------|
| Push to `main` | `:candidate` | Field rovers on candidate auto-pull within 24 h. |
| Manual dispatch (`release_channel=edge`) | `:edge` | Promote with `sudo bootc switch …:edge` (host) or via the pilot quadlet's `Image=` line (rebake the host image with the new tag). |
| Manual dispatch (`release_channel=vX.Y.Z`) | `:vX.Y.Z` | Immutable snapshot for rollback reference. |

Rovers default to `:candidate` (see `pilot.container` and the
`fsk-firstboot` service in the SD workflow); `:edge` is the
"promoted for competition" channel. Mission changes ship through the
pilot pipeline. Re-disable `bootc-fetch-apply-updates.timer` and
`podman-auto-update.timer` after every manual upgrade you want to
freeze in place.

## Local development (no rover)

Classic Ubuntu workstation with ROS 2 Jazzy:

```bash
mkdir -p ~/pilot_ws/src
ln -s "$(pwd)/pilot" ~/pilot_ws/src/pilot
cd ~/pilot_ws
source /opt/ros/jazzy/setup.bash
pip install -r src/pilot/requirements.txt
colcon build --packages-select pilot
source install/setup.bash

# Install the udev rules so /dev/ttyGPS and /dev/ttyMCU appear (the
# rover image bakes the same rules into /usr/lib/udev/rules.d/).
sudo install -m 644 \
    "$(pwd)/host/files/usr/lib/udev/rules.d/99-fsk-rover.rules" \
    /etc/udev/rules.d/99-fsk-rover.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=tty

# Env-only secrets (same contract the pilot.container quadlet uses)
INTERNAL_SECRET=… \
NTRIP_USERNAME=YOUR_NGII_LOGIN \
PILOT_STATE_DIR=/tmp \
  ros2 launch pilot pilot.launch.py \
    server_url:=https://your-server.example/course
```

Single-node iteration:

```bash
ros2 run pilot gps_node --ros-args --params-file src/pilot/config/rover_params.yaml
ros2 topic echo /rover/gps/position
ros2 topic echo /rover/nav/state
```

## Tests

```bash
# Pilot pytest — stubs rclpy/lgpio/pyserial so tests run without hardware
cd course/rover/pilot && python3 -m pytest test/ -q

# Backend + shared (repo root)
npm run test:course
npm run test:shared
```

## Operating assumptions

- All rovers share hardware layout and NTRIP endpoint.
- `pilot/config/rover_params.yaml` is identical across the fleet.
- Only `SERVER_URL`, `INTERNAL_SECRET`, `NTRIP_USERNAME` vary per
  rover, injected after first boot by `provision-rover.sh`.

## File map

| File | Owns |
|------|------|
| `pilot/config/rover_params.yaml` | All tunable parameters + inline docs |
| `pilot/pilot/navigator_node.py` | Mission state machine |
| `pilot/pilot/mcu_bridge_node.py` | USB CDC link to RP2040; Ackermann translation, odom integration, battery republish |
| `pilot/pilot/spray_node.py` | Spray servo on Pi GPIO 13 (mission-only) |
| `pilot/pilot/bridge_node.py` | Course server SSE/REST bridge + telemetry reporter |
| `pilot/pilot/lib/ackermann.py` | Ackermann kinematics (Wheeltec R550) |
| `pilot/pilot/lib/ntrip_client.py` | NTRIP v2 client with exponential backoff |
| `pilot/pilot/lib/ubx_parser.py` | ZED-F9P UBX parser (NAV-PVT, NAV-HPPOSLLH) |
| `pilot/Containerfile` | pilot OCI image build (`FROM ros:jazzy-ros-base`) |
| `host/Containerfile` | host bootc image build (`FROM almalinux-bootc-rpi:10`) |
| `host/files/etc/containers/systemd/pilot.container` | quadlet: pilot.service definition (devices, secrets, env, autoupdate) |
| `host/files/etc/pilot/pilot.conf.example` | non-secret env template (`SERVER_URL`, `ROS_DOMAIN_ID`) |
| `host/files/etc/NetworkManager/system-connections/fsk-default.nmconnection` | default Wi-Fi profile |
| `host/files/etc/tmpfiles.d/pilot-state.conf` | creates `/var/lib/pilot/` (battery cal bind-mount source) |
| `host/files/usr/lib/udev/rules.d/99-fsk-rover.rules` | `/dev/ttyGPS`, `/dev/ttyMCU`, `/dev/gpiochip-rp1` symlinks |
| `host/files/usr/local/bin/flash-mcu` | On-rover MCU reflash (sends `B`, copies UF2, restarts pilot.service) |
| `mcu/` | RP2040 coprocessor firmware (pico-sdk, C) — drive I/O |
| `../../scripts/provision-rover.sh` | One-shot post-flash provisioning (writes `/etc/pilot/pilot.conf`, creates podman secrets) |
