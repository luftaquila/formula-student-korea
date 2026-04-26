# FSK Rover — Pilot

Raspberry Pi 5 + RTK GPS rover. Drives a waypoint mission and sprays a
marker at each cone. Packaged as the `fsk-rover-pilot` snap on Ubuntu
Core; remote access via Tailscale.

## Hardware

| Role | Part | Interface |
|------|------|-----------|
| Compute | Raspberry Pi 5 | — |
| GPS | u-blox ZED-F9P | USB CDC (`/dev/ttyACM0`) |
| RTK corrections | NTRIP caster (NGII) | TCP |
| Motor driver | Cytron MDD10A | GPIO PWM + DIR |
| Drive | 2× DC motor (Wheeltec R550 rear) | Differential PWM |
| Steering servo | S20F | GPIO hardware PWM |
| Spray servo | Standard RC servo | GPIO hardware PWM |
| Platform | Wheeltec R550 AKM Plus | Ackermann |

GPIO (BCM, RPi5 chip 4) — overridable in `pilot/config/rover_params.yaml`:

| Pin | Signal |
|-----|--------|
| 23  | MDD10A DIR1 (left motor) |
| 24  | MDD10A PWM1 |
| 27  | MDD10A DIR2 (right motor) |
| 22  | MDD10A PWM2 |
| 12  | Steering servo |
| 13  | Spray servo |

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
   Connects non-auto plugs (`network-setup-control`, `raw-usb`), reads
   `INTERNAL_SECRET` / `PUBLIC_URL` from `.env`, applies
   `snap set internal-secret server-url ntrip-username`, restarts the
   pilot daemon. Idempotent — re-run after `.env` rotation.
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
   `gps_node`, `battery_node`, `navigator_node`, `bridge_node` come up
   unconditionally. `motor_node` and `spray_node` need GPIO hardware
   (MDD10A + servos); their restart loop on a bench without the
   drivetrain is expected.
7. **Pre-competition hold** — pin the revision for the competition week:
   ```bash
   ssh fsk@<rover-ip> sudo snap refresh --hold=168h fsk-rover-pilot
   ```

Image ships:

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

Image does **not** ship: application secrets (`INTERNAL_SECRET`,
`NTRIP_USERNAME` — the NGII password and host are compile-time
constants, not secrets), Tailscale auth keys, per-rover overrides.

### Recovering a rover with unreachable Wi-Fi

If the rover ends up on a network without the default AP and no
ethernet, write the `rover-auto-import-assert` artifact (from the
`Build Rover Image` run) to a FAT USB stick as `auto-import.assert` and
plug it in. Snapd re-creates the `fsk` user on next boot. SSH in,
confirm `network-setup-control` is connected, then reset
`wifi-ssid` / `wifi-password`.

## Snap configuration (`snap set fsk-rover-pilot`)

All keys optional. Unset keys fall back to `rover_params.yaml` defaults
or the configure hook's default Wi-Fi profile.

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

# Optional — udev rule for /dev/ttyGPS on classic hosts
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
                          │                               │
                       motor_node                /rover/nav/waypoint_reached
                                                          │
                                                   spray_node ── /rover/spray/done
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

## Packaging & confinement

One monolithic snap. `grade: stable`, `confinement: strict`,
`base: core24`, ROS 2 Jazzy via the `ros2-jazzy` extension. Single
daemon `pilot` (`daemon: simple`, `restart-condition: on-failure`).

Required plugs (`snapcraft.yaml`):

| Plug | Purpose |
|------|---------|
| `network`, `network-bind` | Course server REST/SSE, NTRIP TCP |
| `raw-usb` | ZED-F9P USB CDC |
| `serial-port` | udev-named serial lines if present |
| `gpio` | MDD10A PWM/DIR, steering/spray servos |
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

## CI

| Workflow | Trigger | Output |
|----------|---------|--------|
| `.github/workflows/rover-snap.yml` | PR (artifact only), push to `main` (→ `candidate`), `v*` tag or `workflow_dispatch` with channel (→ `edge`) | `fsk-rover-pilot` snap; runs `compileall` + pytest before publish |
| `.github/workflows/rover-image.yml` | `workflow_dispatch` or weekly (Mon 14:00 KST) | Ubuntu Core image + chained `auto-import.assert` |

The image workflow signs the model and `system-user` assertions
in-pipeline using the brand key from `SNAP_BRAND_KEY_B64` /
`SNAP_BRAND_KEY_NAME`, then builds via `ubuntu-image snap --assertion`
so the image boots straight to the seeded `fsk` SSH user. The "Force
Pi 5 fan to 100 %" step mounts the built `ubuntu-seed` partition and
appends `dtparam=fan_temp*` to `config.txt`.

The snap pipeline handles rolling updates; the image pipeline is only
needed for first-time provisioning, hardware swaps, or base-snap
refreshes.

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
| `pilot/pilot/bridge_node.py` | SSE/REST bridge + telemetry reporter |
| `pilot/pilot/lib/ackermann.py` | Ackermann kinematics (Wheeltec R550) |
| `pilot/pilot/lib/ntrip_client.py` | NTRIP v2 client with exponential backoff |
| `pilot/pilot/lib/ubx_parser.py` | ZED-F9P UBX parser (NAV-PVT, NAV-HPPOSLLH) |
| `snap/bin/run-pilot` | Pilot daemon entrypoint — env assembly |
| `snap/hooks/configure` | Wi-Fi netplan writer + daemon restart |
| `snapcraft.yaml` | Snap confinement and plugs |
| `image/` | Ubuntu Core image assembly, model + system-user templates |
| `../../scripts/provision-rover.sh` | One-shot post-flash provisioning |
| `pilot/scripts/setup_udev.sh` | (Legacy) classic-Ubuntu udev rule for ZED-F9P |
| `pilot/scripts/systemd/pilot.service` | (Legacy) systemd unit for non-snap runs |
