# FSK Rover — Pilot

Raspberry Pi 5 + RTK GPS rover that drives a waypoint mission and sprays a
marker at each cone position. Ships as the `fsk-rover-pilot` snap on
Ubuntu Core with Tailscale-based remote access.

## Hardware

| Role | Part | Interface |
|------|------|-----------|
| Compute | Raspberry Pi 5 | — |
| GPS | u-blox ZED-F9P | USB CDC (`/dev/ttyACM0`) |
| RTK corrections | NTRIP caster | TCP |
| Motor driver | Cytron MDD10A | GPIO PWM + DIR |
| Drive | 2× DC motor (rear wheels, Wheeltec R550 kit) | Differential PWM |
| Steering servo | S20F | GPIO hardware PWM |
| Spray servo | Standard RC servo | GPIO hardware PWM |
| Platform | Wheeltec R550 AKM Plus | Ackermann |

GPIO assignments (BCM, RPi5 chip 4) — defaults in `pilot/config/rover_params.yaml`:

| Pin | Signal |
|-----|--------|
| 23  | MDD10A DIR1 (left motor) |
| 24  | MDD10A PWM1 |
| 27  | MDD10A DIR2 (right motor) |
| 22  | MDD10A PWM2 |
| 12  | Steering servo |
| 13  | Spray servo |

## Initial provisioning (new rover)

Short version: flash the CI-built image and SSH in. `docs/provisioning.md`
has the full sequence including secret injection.

1. Build the image — `gh workflow run "Build Rover Image"` and download the
   `rover-ubuntu-core-image` artifact.
2. Flash to SD, boot the Pi. The image ships a pre-seeded `fsk` user whose
   `authorized_keys` comes from <https://github.com/luftaquila.keys> and a
   default Wi-Fi profile (`default` / `password`).
3. `ssh fsk@<rover>` — no console-conf or Ubuntu One prompt.
4. `sudo tailscale up` and `sudo snap set fsk-rover-pilot internal-secret=… server-url=… ntrip-*=…`.

## Ongoing development

| Change | Result |
|--------|--------|
| PR → merge to `main` (touches `course/rover/**`) | Snap publishes to `latest/candidate`. Field rovers on the candidate channel auto-refresh within 24 h. |
| Push tag `vX.Y.Z` | Snap publishes to `latest/edge`. Operators promote rovers with `sudo snap refresh --channel=latest/edge fsk-rover-pilot`. |
| Rover-specific config | `sudo snap set fsk-rover-pilot <key>=<value>` → configure hook restarts the daemon (and rewrites Wi-Fi netplan when `wifi-*` changes). |

Check a rover's state:

```bash
snap info fsk-rover-pilot     # installed revision, tracking channel
snap services fsk-rover-pilot # daemon status
snap logs fsk-rover-pilot -n 200
```

The course web UI shows a live rover status badge (connected · fix · NTRIP
· nav state) sourced from `/api/rover/telemetry`.

## Snap configuration keys

All optional; when unset, the pilot uses the YAML defaults or the default
Wi-Fi profile baked into the configure hook.

| Key | Purpose |
|-----|---------|
| `server-url` | Course server base URL (must be `https://` unless `server_url_allow_http: true`) |
| `internal-secret` | Shared secret for the `X-Internal-Service` header |
| `ros-domain-id` | ROS 2 domain id (default `0`) |
| `ntrip-host`, `-port`, `-mountpoint`, `-username`, `-password` | RTK caster credentials |
| `wifi-ssid`, `wifi-password` | Override the default AP |

`INTERNAL_SECRET` and every `NTRIP_*` value flow
`snapctl → run-pilot → env → ROS node`, never via `declare_parameter`, so
peers on the same ROS 2 domain can't read them with `ros2 param get`.

## Local development (no snap)

Classic Ubuntu workstation with ROS 2 Jazzy installed:

```bash
# Workspace
mkdir -p ~/pilot_ws/src
ln -s "$(pwd)/pilot" ~/pilot_ws/src/pilot
cd ~/pilot_ws
source /opt/ros/jazzy/setup.bash
pip install -r src/pilot/requirements.txt
colcon build --packages-select pilot
source install/setup.bash

# (Optional) udev rule so the ZED-F9P shows up as /dev/ttyGPS on classic hosts
sudo bash src/pilot/scripts/setup_udev.sh

# Run with env-only secrets (same contract as run-pilot inside the snap)
INTERNAL_SECRET=… \
NTRIP_HOST=… NTRIP_PORT=2101 NTRIP_MOUNTPOINT=… \
NTRIP_USERNAME=… NTRIP_PASSWORD=… \
  ros2 launch pilot pilot.launch.py \
    server_url:=https://your-server.example/course
```

Iterate on a single node without restarting the launch graph:

```bash
ros2 run pilot gps_node       --ros-args --params-file src/pilot/config/rover_params.yaml
ros2 topic echo /rover/gps/position
ros2 topic echo /rover/nav/state
```

## Architecture

Five ROS 2 nodes talk to the course backend over SSE + REST:

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

## Mission state machine (navigator_node)

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

- **CALIBRATING**: drive straight up to `calibration_distance` (2.5 m), derive
  heading from the position delta. Extend once if variance is high; enter
  ERROR at `calibration_max_distance` (5 m) instead of accepting a bad heading.
- **NAVIGATING**: Pure Pursuit with a `max_curvature` (3.0 1/m) clamp.
  `fix_hysteresis_s` (0.8 s) prevents RTK fixed↔float flicker from tripping
  ERROR unnecessarily.
- **SETTLING → SPRAYING**: creep until within `settle_tolerance` (3 cm) for
  `settle_readings` (5) consecutive samples, then fire.

Every threshold, speed, and timeout is tunable in `pilot/config/rover_params.yaml`
with inline comments.

## Tests

```bash
# Pilot pytest — stubs rclpy/lgpio/pyserial so tests run without hardware
cd course/rover/pilot && python3 -m pytest test/ -q

# Backend + shared (repo root)
npm run test:course
npm run test:shared
```

CI (`.github/workflows/rover-snap.yml`) runs the pytest suite before every
snap publish.

## Where to look

| File | What it owns |
|------|--------------|
| `pilot/config/rover_params.yaml` | All tunable parameters + inline docs |
| `pilot/pilot/navigator_node.py` | Mission state machine |
| `pilot/pilot/bridge_node.py` | SSE/REST bridge + telemetry reporter |
| `pilot/pilot/lib/ackermann.py` | Ackermann kinematics for Wheeltec R550 |
| `pilot/pilot/lib/ntrip_client.py` | NTRIP v2 client with exponential backoff |
| `pilot/pilot/lib/ubx_parser.py` | ZED-F9P UBX parser (NAV-PVT, NAV-HPPOSLLH) |
| `snap/bin/run-pilot` | Snap daemon entrypoint — env assembly |
| `snap/hooks/configure` | Wi-Fi netplan writer + daemon restart |
| `snapcraft.yaml` | Snap confinement and plugs |
| `image/` | Ubuntu Core image assembly, model + system-user templates |
| `docs/provisioning.md` | New-rover bring-up procedure |
| `docs/ubuntu-core.md` | Packaging/confinement rationale |
