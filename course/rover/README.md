# FSK Rover

Raspberry Pi 5 + RTK GPS rover. Drives a waypoint mission and sprays a
marker at each cone. Packaged as the `fsk-rover-pilot` snap on Ubuntu
Core; remote access via Tailscale.

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

Pi GPIO (BCM, chip 4) — overridable in `pilot/config/rover_params.yaml`:

| Pin | Signal |
|-----|--------|
| 13  | Spray servo (signal) |

MCU pin map and USB CDC protocol: [§ MCU coprocessor](#mcu-coprocessor).

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

Five ROS 2 nodes bridge the course backend over SSE + REST:

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

## Provisioning

CI builds the image; field bring-up is one SSH session.

1. **Build** — `gh workflow run "Build Rover Image"`; download the
   `rover-ubuntu-core-image` artifact.
2. **Flash + boot** — SD → Pi 5. No console-conf, no Ubuntu One prompt.
   Snapd seeds the `fsk` user from the bundled `system-user` assertion;
   the configure hook writes `/etc/netplan/90-fsk-wifi.yaml` with the
   default profile. Within ~60 s the rover has an IP on `eth0` (DHCP)
   or `wlan0` (default AP). Pi firmware holds the cooling fan at 100 %
   from power-on.
3. **Provision** — from the admin workstation (repo checkout, SSH key
   in <https://github.com/luftaquila.keys>):
   ```bash
   scripts/provision-rover.sh <rover-ip> [--ntrip-username=<id>]
   ```
   Installs `course/rover/scripts/99-fsk-rover.rules` so the GPS and
   MCU appear at `/dev/ttyGPS` and `/dev/ttyMCU`, connects non-auto
   plugs (`network-setup-control`, `raw-usb`), reads `INTERNAL_SECRET`
   / `PUBLIC_URL` from `.env`, applies
   `snap set internal-secret server-url ntrip-username`, and restarts
   the pilot daemon. Idempotent — re-run after `.env` rotation.
4. **Wi-Fi (recommended)** — move the rover off the default AP:
   ```bash
   ssh fsk@<rover-ip> sudo snap set fsk-rover-pilot \
       wifi-ssid='MyAP' wifi-password='mypassword'
   ```
5. **Tailscale (off-LAN access only)**:
   ```bash
   ssh fsk@<rover-ip> sudo tailscale up --auth-key=TSKEY…
   ```
6. **Verify**:
   ```bash
   ssh fsk@<rover-ip> snap services fsk-rover-pilot
   ssh fsk@<rover-ip> sudo snap logs fsk-rover-pilot.pilot -n 50
   ```
   `gps_node`, `navigator_node`, `bridge_node` come up unconditionally.
   `mcu_bridge_node` needs the RP2040 on `/dev/ttyMCU`; on a bench
   without the MCU it logs serial-open warnings and retries.
   `spray_node` needs Pi GPIO 13 wired to the spray servo.
7. **Pre-competition hold** — pin the revision for the competition week:
   ```bash
   ssh fsk@<rover-ip> sudo snap refresh --hold=168h fsk-rover-pilot
   ```

### Recovering a rover with unreachable Wi-Fi

If the rover ends up on a network without the default AP and no
ethernet, write the `rover-auto-import-assert` artifact (from the
`Build Rover Image` run) to a FAT USB stick as `auto-import.assert` and
plug it in. Snapd re-creates the `fsk` user on next boot. SSH in,
confirm `network-setup-control` is connected, then reset
`wifi-ssid` / `wifi-password`.

## Snap configuration

`snap set fsk-rover-pilot <key>=<value>`. All keys optional; unset keys
fall back to `rover_params.yaml` defaults or the configure hook's
default Wi-Fi profile.

| Key | Consumer |
|-----|----------|
| `server-url` | `bridge_node.server_url`. Must be `https://` unless `server_url_allow_http: true`. |
| `internal-secret` | `bridge_node` (env `INTERNAL_SECRET`, `X-Internal-Service` header). |
| `ros-domain-id` | `run-pilot` (env `ROS_DOMAIN_ID`, default `0`). |
| `ntrip-username` | `gps_node` NGII RTK login. Host (`www.gnssdata.or.kr`), port (`2101`), password (`gnss`): compile-time constants in `gps_node.py`. Mountpoint: auto-selected by nearest-base-station lookup against the caster's source table. |
| `wifi-ssid`, `wifi-password` | `hooks/configure` → `/etc/netplan/90-fsk-wifi.yaml`. |

Secrets (`INTERNAL_SECRET`, `NTRIP_USERNAME`) flow
`snapctl → run-pilot → env → ROS node`, never via `declare_parameter` —
peers on the same `ROS_DOMAIN_ID` cannot read them with
`ros2 param get`.

### Wi-Fi

Requires `network-setup-control` connected (done by
`provision-rover.sh`). The configure hook rewrites
`/etc/netplan/90-fsk-wifi.yaml` and runs `netplan apply` on change only.

```bash
sudo snap set fsk-rover-pilot wifi-ssid='MyAP' wifi-password='mypassword'
```

Quote values with spaces or shell metacharacters. Clear both keys to
fall back to the baked default profile:

```bash
sudo snap unset fsk-rover-pilot wifi-ssid wifi-password
```

### Configure hook algorithm (`snap/hooks/configure`)

Runs on install and on every `snap set`:

1. If `network-setup-control` not connected → log, restart `pilot`,
   exit 0. A failing hook would abort the seed change and strand the
   rover in install mode.
2. Read `wifi-ssid` / `wifi-password`; empty or unset → `default` /
   `password`. Empty values must be treated as "use default" — writing
   an empty SSID produces invalid wpa_supplicant YAML and
   `netplan generate` then fails for the whole merged config, which
   also wipes the ethernet path from the generated networkd units.
3. Emit only the `wifis:` block. Ethernet is handled by snapd's
   `/etc/netplan/00-snapd-config.yaml` (matches `en*`/`eth*`, covers
   Pi 5's `end0`). Redeclaring ethernet here risks wiping it on any
   YAML error.
4. Rewrite `/etc/netplan/90-fsk-wifi.yaml` only when content changes;
   run `netplan apply`. No-op writes avoid yanking the link on
   unrelated `snap set` calls.
5. Restart the `pilot` daemon so other keys take effect immediately.

## Packaging & confinement

One monolithic snap. `grade: stable`, `confinement: strict`,
`base: core24`, ROS 2 Jazzy via the `ros2-jazzy` extension. Single
daemon `pilot` (`daemon: simple`, `restart-condition: on-failure`).

Required plugs (`snapcraft.yaml`):

| Plug | Purpose |
|------|---------|
| `network`, `network-bind` | Course server REST/SSE, NTRIP TCP |
| `raw-usb` | ZED-F9P + RP2040 USB CDC (also resolves `/dev/ttyGPS` and `/dev/ttyMCU`) |
| `serial-port` | udev-named serial lines if present |
| `gpio` | Spray servo (Pi GPIO 13) |
| `network-setup-control` | Configure hook writes `/etc/netplan/90-fsk-wifi.yaml` |

All plugs are on the Snapcraft Store's auto-approval list — new
revisions reach `candidate` without manual review.
`network-setup-control` and `raw-usb` are not auto-connected;
`provision-rover.sh` connects them. The configure hook no-ops when
`network-setup-control` is missing so first-boot seeding does not
abort.

Pi 5 fan is pinned at 100 % via `dtparam=fan_temp*` in
`ubuntu-seed/config.txt` — firmware-level, not a snap daemon, so the
snap stays inside the auto-approved plug set.

`grade: dangerous` on the model assertion is required because
`ubuntu-image` embeds the locally-built `fsk-rover-pilot` snap instead
of pulling a published revision. Once booted, the rover follows the
Store's signed channel like any Ubuntu Core device.

Rationale — one unit per rover keeps refresh / rollback a single
command (`snap refresh` / `snap revert`). Splitting the five nodes
into separate snaps would add inter-snap content-sharing plumbing for
no operational gain.

## Image assembly (`image/`)

Ubuntu Core image layer. All assembly happens in GitHub Actions;
developer machines only need the signing-key setup below.

### Inputs

| Name | Type | Contents |
|------|------|----------|
| `SNAP_BRAND_KEY_B64` | secret | `tar czf - -C ~/.snap/gnupg .` then `base64 -w0`. Brand signing key snapd uses for `snap sign`. |
| `SNAP_BRAND_KEY_NAME` | repo var | Key name as shown by `snap keys`, e.g. `fsk-rover-signing`. |
| `model.assertion.template` | checked-in | Unsigned model. CI refreshes `timestamp` per run and signs. |
| `system-user.template.json` | checked-in | Unsigned local-user assertion. CI fetches public keys from <https://github.com/luftaquila.keys>, fills `ssh-keys` + `since`/`until`/`timestamp`, then signs with `--chain` so `auto-import.assert` carries the required account/account-key assertions. |
| `fsk-rover-pilot` snap | built | Built inside the image workflow by `snapcore/action-build`. |
| `tailscale` | snap-store | Referenced from the model assertion, pulled at assembly time. |

Brand identity baked into `model.assertion.template`:

- `model` — `fsk-rover`
- `authority-id` / `brand-id` — `0omV9pEFvLnFgHtuPb1LUkfXbJyegTHc`

### Signing setup (one-time per brand key)

On a trusted workstation that already has the brand account logged in
to `snapcraft`:

```bash
# Create an assertion-signing key. Leave the passphrase blank — CI signs
# non-interactively and cannot type one.
snap create-key fsk-rover-signing
snapcraft register-key fsk-rover-signing

# Export the snapd gnupg homedir (path is ~/.snap/gnupg on classic Ubuntu).
tar czf /tmp/snap-brand-key.tar.gz -C ~/.snap/gnupg .
base64 -w0 /tmp/snap-brand-key.tar.gz | \
    gh secret set SNAP_BRAND_KEY_B64 --repo luftaquila/formula-student-korea

# Record the key name as a repo variable (not a secret).
gh variable set SNAP_BRAND_KEY_NAME --repo luftaquila/formula-student-korea \
    --body 'fsk-rover-signing'
```

### Image contents

Ships:

- `fsk-rover-pilot` snap (tracking `latest/candidate`)
- `tailscale` snap (not authenticated)
- `core24`, `snapd`, `pi`, `pi-kernel`
- signed `system-user` assertion → local `fsk` user with
  `authorized_keys` fetched from <https://github.com/luftaquila.keys> at
  build time
- default Wi-Fi profile `default` / `password` (applied by configure hook)
- `dtparam=fan_temp*` appended to `ubuntu-seed/config.txt` by the image
  workflow → 100 % fan from firmware init, independent of the kernel
  thermal governor

Does **not** ship: application secrets (`INTERNAL_SECRET`,
`NTRIP_USERNAME` — the NGII password and host are compile-time
constants, not secrets), Tailscale auth keys, per-rover overrides.

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
   `$SNAP_COMMON/battery_cal.json`.

The saved JSON survives reboots and snap refreshes. Sanity bounds:
`measured_v ∈ [15, 32] V`, `gain ∈ [0.5, 2.0]`. A corrupt or
out-of-range cal file falls back to `gain = 1.0` so a bad calibration
can't brick the rover.

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
- Subsequent (rover Pi): `sudo course/rover/scripts/flash-mcu.sh
  rover_mcu.uf2`. Sends `B` on `/dev/ttyMCU`, mounts the resulting
  RPI-RP2 disk, copies the file, waits for re-enumeration. The pilot
  snap is paused for the duration and resumed automatically.
- Off-rover host: `picotool load -f rover_mcu.uf2 && picotool reboot`.

After flash, the board enumerates as a USB CDC device. Always address
it via the udev symlink `/dev/ttyMCU` (installed by
`scripts/99-fsk-rover.rules`) — raw `/dev/ttyACM*` ordering is
non-deterministic when both the GPS and the MCU are present.

### Omitted: motor current sensing

MDD10A self-protects; encoder velocity = 0 with a non-zero command
already covers stall detection. Re-add `current.c` + `FLAG_OVERCURRENT`
if a real shunt-amp / INA219 ever lands.

## CI

| Workflow | Trigger | Output |
|----------|---------|--------|
| `.github/workflows/rover-snap.yml` | PR (artifact only), push to `main` (→ `candidate`), `v*` tag or `workflow_dispatch` with channel (→ `edge`) | `fsk-rover-pilot` snap; runs `compileall` + pytest before publish |
| `.github/workflows/rover-image.yml` | `workflow_dispatch` or weekly (Mon 14:00 KST) | Ubuntu Core image + chained `auto-import.assert` |
| `.github/workflows/rover-mcu.yml` | Push/PR touching `course/rover/mcu/**` | RP2040 coprocessor firmware (`rover_mcu.uf2`) |

The image workflow signs the model and `system-user` assertions
in-pipeline using the brand key from `SNAP_BRAND_KEY_B64` /
`SNAP_BRAND_KEY_NAME`, then builds via `ubuntu-image snap --assertion`
so the image boots straight to the seeded `fsk` SSH user. The "Force
Pi 5 fan to 100 %" step mounts the built `ubuntu-seed` partition and
appends `dtparam=fan_temp*` to `config.txt`.

The snap pipeline handles rolling updates; the image pipeline is only
needed for first-time provisioning, hardware swaps, or base-snap
refreshes.

## Release channels

| Trigger | Channel | Rollout |
|---------|---------|---------|
| PR (touches `course/rover/**`) | artifact only | — |
| Push to `main` | `latest/candidate` | Field rovers on candidate auto-refresh within 24 h. |
| Tag `vX.Y.Z` or `workflow_dispatch` with `release_channel=edge` | `latest/edge` | Promote with `sudo snap refresh --channel=latest/edge fsk-rover-pilot`. |

Rover default channel is `candidate` (see
`image/model.assertion.template`); `edge` is the "promoted for
competition" channel. Mission changes ship through the snap pipeline —
do not reflash images for them. Re-apply `--hold=168h` after every
manual refresh.

Rover state inspection:

```bash
snap info fsk-rover-pilot            # installed revision, tracking channel
snap services fsk-rover-pilot        # pilot daemon status
snap connections fsk-rover-pilot     # network-setup-control connected?
snap logs fsk-rover-pilot -n 200
```

Course web UI surfaces a live status badge (connected · fix · NTRIP ·
nav state) from `/api/rover/telemetry`.

## Local development (no snap)

Classic Ubuntu workstation with ROS 2 Jazzy:

```bash
mkdir -p ~/pilot_ws/src
ln -s "$(pwd)/pilot" ~/pilot_ws/src/pilot
cd ~/pilot_ws
source /opt/ros/jazzy/setup.bash
pip install -r src/pilot/requirements.txt
colcon build --packages-select pilot
source install/setup.bash

# Install the udev rules so /dev/ttyGPS and /dev/ttyMCU appear.
sudo bash src/pilot/scripts/setup_udev.sh

# Env-only secrets (same contract as run-pilot inside the snap)
INTERNAL_SECRET=… \
NTRIP_USERNAME=YOUR_NGII_LOGIN \
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
- Only `server-url`, `internal-secret`, `ntrip-username` vary per
  rover, injected after first boot.

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
| `snap/bin/run-pilot` | Pilot daemon entrypoint — env assembly |
| `snap/hooks/configure` | Wi-Fi netplan writer + daemon restart |
| `snapcraft.yaml` | Snap confinement and plugs |
| `image/model.assertion.template`, `image/system-user.template.json` | Ubuntu Core image assembly inputs |
| `mcu/` | RP2040 coprocessor firmware (pico-sdk, C) — drive I/O |
| `scripts/99-fsk-rover.rules` | udev rules for `/dev/ttyGPS` and `/dev/ttyMCU` |
| `../../scripts/provision-rover.sh` | One-shot post-flash provisioning |
| `pilot/scripts/setup_udev.sh` | Classic-Ubuntu udev installer for the same rules |
| `pilot/scripts/systemd/pilot.service` | (Legacy) systemd unit for non-snap runs |
