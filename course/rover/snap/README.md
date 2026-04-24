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
  restarts the `pilot` daemon. Requires the `network-setup-control` plug
  to be connected (`sudo snap connect fsk-rover-pilot:network-setup-control`)
  — the hook no-ops otherwise so first-boot seeding does not abort

## Supported `snap set` keys

All optional; unset keys fall back to the baked defaults. The two secret
values (`INTERNAL_SECRET`, `NTRIP_USERNAME`) travel via the environment
only — never placed on the ROS 2 parameter tree where peers on the same
`ROS_DOMAIN_ID` could read them.

| Key | Consumer |
|-----|----------|
| `server-url` | `pilot.launch.py` → `bridge_node.server_url` |
| `internal-secret` | `bridge_node` (env `INTERNAL_SECRET`, `X-Internal-Service` header) |
| `ros-domain-id` | `run-pilot` (env `ROS_DOMAIN_ID`) |
| `ntrip-username` | `gps_node` / `NTRIPClient`. Host (`www.gnssdata.or.kr`), port (`2101`), and password (`gnss`) are compile-time constants because the rover only targets NGII. Mountpoint is chosen automatically from the caster's source table — nearest base station to the first 3D fix. |
| `wifi-ssid`, `wifi-password` | `hooks/configure` → netplan `90-fsk-wifi.yaml` |

## Image-level composition

This directory only defines the application snap. Base snap bundling
(`core24`, `pi`, `pi-kernel`, `tailscale`) happens at the
Ubuntu Core image/model layer in `../image/`, which also appends
`dtparam=fan_temp*` to `ubuntu-seed/config.txt` so the Pi 5 cooling fan
runs at 100% from firmware init — no snap daemon or super-privileged
plug is involved in fan control.

First-boot provisioning — SSH seeding via `system-user` assertion and
initial secret injection — is documented in
[`../docs/provisioning.md`](../docs/provisioning.md).
