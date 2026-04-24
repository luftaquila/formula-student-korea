# Ubuntu Core Deployment Notes

Design rationale and Ubuntu-Core-specific facts for the `fsk-rover-pilot`
snap. For day-to-day operation see [`README.md`](README.md) and
[`provisioning.md`](provisioning.md).

## Packaging model

One monolithic snap (`fsk-rover-pilot`), `grade: stable`,
`confinement: strict`, `base: core24`, ROS 2 Jazzy via the `ros2-jazzy` snap
extension. The snap ships two simple daemons:

- `pilot` (`daemon: simple`, `restart-condition: on-failure`) — the ROS 2
  pilot stack proper
- `fan-max` (`daemon: simple`, `restart-condition: always`) — holds the
  Pi 5 cooling fan at 100% via hwmon `pwm1` and thermal `cooling_device`
  writes. Runs alongside `pilot` but decoupled so a pilot crash can't take
  thermal management down

Rationale — one unit per rover keeps the refresh/rollback story a single
command (`snap refresh` / `snap revert`). Splitting the five ROS 2 nodes
into individual snaps would mean inter-snap content-sharing plumbing for
no operational gain.

## Snap confinement

Required plugs, all declared in `../snapcraft.yaml`:

- `network`, `network-bind` — course server REST/SSE and NTRIP TCP
- `raw-usb` — ZED-F9P USB CDC device
- `serial-port` — udev-named serial lines if present
- `gpio` — MDD10A PWM/DIR and the steering/spray servos
- `hardware-observe` — `fan-max` reads hwmon names to find the fan PWM
- `fan-control` (custom `system-files` plug, write-only on
  `/sys/class/thermal`, `/sys/class/hwmon`, and `/sys/devices/platform`)
  — `fan-max` writes PWM and thermal cooling_device state
- `network-setup-control` (configure hook) — writes
  `/etc/netplan/90-fsk-wifi.yaml`

`hardware-observe`, `fan-control`, and `network-setup-control` are not
auto-connected on a strict snap and must be connected once with
`sudo snap connect fsk-rover-pilot:<plug>` after first install — see
`provisioning.md`. The `configure` hook no-ops if `network-setup-control`
is missing, and `fan-max` keeps polling and just writes nothing if
`fan-control` is missing, so neither aborts seeding.

## Image composition

The Ubuntu Core image (see `../image/`) bundles:

- `core24`, `snapd`, `pi`, `pi-kernel` — Canonical base + gadget
- `tailscale` — for remote access, installed but not pre-authenticated
- `fsk-rover-pilot` — tracking `latest/candidate` by default
- a brand-signed `system-user` assertion that creates the `fsk` local user
  with `authorized_keys` fetched from <https://github.com/luftaquila.keys>

`grade: dangerous` on the model assertion is required because the image
build injects the local `fsk-rover-pilot` snap via `ubuntu-image --snap`
instead of pulling a published revision. Once booted, the rover follows
the Store's signed channel the same way any Ubuntu Core device does.

## Configure hook behaviour

`snap/hooks/configure` runs on install and on every `snap set`:

1. Reads `wifi-ssid` / `wifi-password` (defaults: `default` / `password`).
2. Rewrites `/etc/netplan/90-fsk-wifi.yaml` only when the content changes,
   then runs `netplan apply`. Skipping identical writes avoids yanking the
   link on unrelated `snap set` calls.
3. Restarts the `pilot` daemon so any other changed keys (NTRIP, server
   URL, internal secret) take effect immediately.

All supported `snap set` keys are listed in `README.md`.

## CI ownership

- `.github/workflows/rover-snap.yml` — verifies (`compileall` + `pytest`) and
  builds the snap; publishes `candidate` on main pushes, `edge` on `v*`
  tags or `workflow_dispatch` with a specified channel.
- `.github/workflows/rover-image.yml` — manual or weekly-scheduled; signs
  the model and a chained `auto-import.assert` in-pipeline from
  `image/model.assertion.template` and `image/system-user.template.json`
  using the brand key imported from `SNAP_BRAND_KEY_B64` and
  `SNAP_BRAND_KEY_NAME`.

## Legacy paths

Kept for non-Ubuntu-Core bring-up only:

- `pilot/scripts/setup_udev.sh` — classic Ubuntu udev rule for the ZED-F9P
  (gives `/dev/ttyGPS`, `MODE=0660`, `GROUP=dialout`)
- `pilot/scripts/systemd/pilot.service` — systemd unit if running the pilot
  without a snap
