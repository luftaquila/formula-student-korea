# Ubuntu Core Deployment Notes

Design rationale and Ubuntu-Core-specific facts for the `fsk-rover-pilot`
snap. For day-to-day operation see [`README.md`](README.md) and
[`provisioning.md`](provisioning.md).

## Packaging model

One monolithic snap (`fsk-rover-pilot`), `grade: stable`,
`confinement: strict`, `base: core24`, ROS 2 Jazzy via the `ros2-jazzy` snap
extension. The snap ships a single daemon:

- `pilot` (`daemon: simple`, `restart-condition: on-failure`) — the ROS 2
  pilot stack proper

Pi 5 cooling-fan control is deliberately **not** a snap daemon. Instead
the image build workflow appends `dtparam=fan_temp*` lines to
`ubuntu-seed/config.txt` so the Pi firmware pins the fan to 100% from
power-on, independent of the kernel thermal governor. This keeps the
snap's interface set within the Snapcraft Store's auto-approved list
(no `system-files`/`hardware-observe` needed).

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
- `network-setup-control` (configure hook) — writes
  `/etc/netplan/90-fsk-wifi.yaml`

`network-setup-control` is not auto-connected on a strict snap and must
be connected once with `sudo snap connect fsk-rover-pilot:network-setup-control`
after first install — see `provisioning.md`. The `configure` hook no-ops
if it is missing, so seeding does not abort.

Every plug above is on the Snapcraft Store's auto-approval list, so new
revisions flow to the `candidate` channel without manual review.

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

1. If `network-setup-control` is not connected, the hook logs that it is
   skipping Wi-Fi setup, restarts the `pilot` daemon, and exits 0. This
   graceful no-op matters for first boot: a failing configure hook would
   abort the seed change and leave the rover stuck in install mode.
2. Otherwise, reads `wifi-ssid` / `wifi-password`, falling back to
   `default` / `password` when either key is unset or empty. The hook
   only emits a `wifis:` block; the ethernet path is handled by the
   snapd-provided `/etc/netplan/00-snapd-config.yaml`, which matches
   `en*`/`eth*` globs (Pi 5's `end0` is covered there). Re-declaring
   ethernet in the 90 file was both redundant and dangerous — any
   invalid YAML here wipes ethernet along with Wi-Fi from the merged
   netplan output.
3. Rewrites `/etc/netplan/90-fsk-wifi.yaml` only when the content changes,
   then runs `netplan apply`. Skipping identical writes avoids yanking the
   link on unrelated `snap set` calls.
4. Restarts the `pilot` daemon so any other changed keys (NTRIP username,
   server URL, internal secret) take effect immediately.

All supported `snap set` keys are listed in `README.md`.

## CI ownership

- `.github/workflows/rover-snap.yml` — verifies (`compileall` + `pytest`) and
  builds the snap; publishes `candidate` on main pushes, `edge` on `v*`
  tags or `workflow_dispatch` with a specified channel.
- `.github/workflows/rover-image.yml` — manual or weekly-scheduled; signs
  the model and a chained `auto-import.assert` in-pipeline from
  `image/model.assertion.template` and `image/system-user.template.json`
  using the brand key imported from `SNAP_BRAND_KEY_B64` and
  `SNAP_BRAND_KEY_NAME`. After `ubuntu-image snap`, this workflow also
  mounts the built image's `ubuntu-seed` partition and appends
  `dtparam=fan_temp*` lines to `config.txt` so the Pi firmware holds the
  cooling fan at 100% from power-on (see the "Force Pi 5 fan to 100%"
  step).

## Legacy paths

Kept for non-Ubuntu-Core bring-up only:

- `pilot/scripts/setup_udev.sh` — classic Ubuntu udev rule for the ZED-F9P
  (gives `/dev/ttyGPS`, `MODE=0660`, `GROUP=dialout`)
- `pilot/scripts/systemd/pilot.service` — systemd unit if running the pilot
  without a snap
