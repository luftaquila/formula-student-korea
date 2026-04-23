# Snap Layout

Ubuntu Core deployment assets for the rover.

- `../snapcraft.yaml` — monolithic ROS 2 snap definition (name
  `fsk-rover-pilot`, `grade: stable`, `confinement: strict`, `base: core24`,
  `ros2-jazzy` extension)
- `bin/run-pilot` — daemon entrypoint. Reads `snap set` keys via `snapctl`,
  exports them into the environment, and `exec`s `ros2 launch pilot
  pilot.launch.py`
- `hooks/configure` — runs on install and on every `snap set`; writes
  `/etc/netplan/90-fsk-wifi.yaml` (default AP: `default` / `password`) and
  restarts the `pilot` daemon

## Supported `snap set` keys

All optional; unset keys fall back to the baked defaults. Secrets travel
via the environment only — `INTERNAL_SECRET` and the `NTRIP_*` values are
never placed on the ROS 2 parameter tree.

| Key | Consumer |
|-----|----------|
| `server-url` | `pilot.launch.py` → `bridge_node.server_url` |
| `internal-secret` | `bridge_node` (env `INTERNAL_SECRET`, `X-Internal-Service` header) |
| `ros-domain-id` | `run-pilot` (env `ROS_DOMAIN_ID`) |
| `ntrip-host`, `-port`, `-mountpoint`, `-username`, `-password` | `gps_node` / `NTRIPClient` |
| `wifi-ssid`, `wifi-password` | `hooks/configure` → netplan `90-fsk-wifi.yaml` |

## Image-level composition

This directory only defines the application snap. Base snap bundling
(`core24`, `pi`, `pi-kernel`, `console-conf`, `tailscale`) happens at the
Ubuntu Core image/model layer in `../image/`.

First-boot provisioning — SSH seeding via `system-user` assertion and
initial secret injection — is documented in
[`../docs/provisioning.md`](../docs/provisioning.md).
