# Provisioning Flow

The CI-built image ships with a pre-seeded `fsk` local user and Wi-Fi defaults,
so first boot requires no console interaction.

## Image Contents

The common Ubuntu Core image includes:

- the `fsk-rover-pilot` snap
- the `tailscale` snap
- a signed `system-user` assertion creating local user `fsk` whose
  `authorized_keys` is fetched at image build time from
  <https://github.com/luftaquila.keys>
- a default Wi-Fi profile (`default` / `password`) applied by the pilot snap's
  configure hook

The image does **not** include:

- `fsk-rover-pilot` application secrets (`INTERNAL_SECRET`,
  `NTRIP_USERNAME` — the NGII password and host are hard-coded constants,
  not secrets)
- Tailscale auth keys
- per-device override files

## First-Boot Procedure

1. Flash the image to the Raspberry Pi 5.

2. Boot the rover. **No console-conf, no Ubuntu One prompt.** Snapd seeds the
   `fsk` user from the bundled system-user assertion and the pilot snap's
   configure hook writes `/etc/netplan/90-fsk-wifi.yaml` with the default
   Wi-Fi profile. Within ~60s the rover has an IP on either `eth0` (DHCP) or
   `wlan0` (joining the `default` / `password` AP).

3. SSH in from any machine whose public key is published at
   <https://github.com/luftaquila.keys>:

   ```bash
   ssh fsk@<rover-ip>
   ```

4. Connect `network-setup-control` (it is not auto-connected on a
   strict-confinement snap). Do this **before** any `snap set wifi-*` —
   the `configure` hook silently no-ops without it and the new Wi-Fi
   settings silently never reach netplan:

   ```bash
   sudo snap connect fsk-rover-pilot:network-setup-control
   ```

   Verify with `snap connections fsk-rover-pilot`. Pi 5 cooling fan
   needs no plug — it is pinned to 100% at the firmware level via
   `dtparam=fan_temp*` in `ubuntu-seed/config.txt`, written by the
   image build workflow.

5. (Recommended) Switch the rover to a non-default Wi-Fi once it is on a
   stable network (requires step 4):

   ```bash
   sudo snap set fsk-rover-pilot wifi-ssid=<ssid> wifi-password=<pw>
   ```

6. Bring up Tailscale:

   ```bash
   sudo tailscale up --auth-key=TSKEY...
   ```

7. Apply Pilot secrets (these are deliberately not baked into the image):

   ```bash
   sudo snap set fsk-rover-pilot internal-secret=YOUR_SECRET
   sudo snap set fsk-rover-pilot server-url=https://test.luftaquila.io/course
   sudo snap set fsk-rover-pilot ros-domain-id=0
   ```

8. Apply the NTRIP operator login. Caster host (`www.gnssdata.or.kr`),
   port (`2101`), and password (`gnss`) are hard-coded in `gps_node.py`
   because the rover only ever targets NGII and the shared RTK password is
   a protocol constant. Mountpoint is auto-selected at runtime — `gps_node`
   fetches the caster's source table after the first 3D fix and picks the
   nearest RTCM 3.2 base station:

   ```bash
   sudo snap set fsk-rover-pilot ntrip-username=YOUR_NGII_LOGIN
   ```

9. Confirm the daemon restarted with the new values:

   ```bash
   snap services fsk-rover-pilot
   snap logs fsk-rover-pilot.pilot -n 50
   ```

10. Pin the rover to the current `fsk-rover-pilot` revision for the week
    leading up to a competition so an automatic refresh can't ship a
    candidate build into the field:

    ```bash
    sudo snap refresh --hold=168h fsk-rover-pilot
    ```

11. From this point onward, manage the rover through Tailscale-based SSH.

## Recovering a Rover With Unreachable Wi-Fi

If the rover ends up on a network without the default AP and without ethernet,
the `rover-auto-import-assert` artifact from the `Build Rover Image` workflow
run can be copied to a FAT-formatted USB stick as `auto-import.assert` and
inserted; snapd will re-create the `fsk` user from it on next boot. Then SSH in
and (after confirming `network-setup-control` is connected — step 4 above)
run `sudo snap set fsk-rover-pilot wifi-ssid=... wifi-password=...` to steer
the rover back to a reachable AP.

## Release Channels

The snap publish pipeline (`.github/workflows/rover-snap.yml`) follows
a promotion flow so field units never see untested code:

- **PR builds** — artifact only. No publish.
- **Pushes to `main`** — publish to `candidate`. This is the staging
  channel for the field team to smoke-test before a competition.
- **Tagged release (`vX.Y.Z`)** or **manual `workflow_dispatch` with
  `release_channel=edge`** — publish to `edge`. Field images default to
  `candidate` (see `image/model.assertion.template`), so edge is the
  "promoted for competition" channel.

Before each competition, switch field rovers to the tagged edge build:

```bash
sudo snap refresh --channel=latest/edge fsk-rover-pilot
snap info fsk-rover-pilot
# Ensure tracking=latest/edge and the installed revision matches the
# tagged release. Re-apply the 168h refresh hold afterwards.
```

## Operating Assumptions

- all rovers share the same hardware layout
- all rovers use the same NTRIP endpoint and base parameters
- `pilot/config/rover_params.yaml` stays identical across the fleet
- only a small set of deployment secrets is injected after first boot
