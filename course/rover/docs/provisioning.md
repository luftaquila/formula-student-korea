# Provisioning Flow

The rover uses a two-stage bootstrap:

1. Ubuntu Core grants the first SSH login through Ubuntu One key injection.
2. The operator finishes remote operations setup from that first shell.

## Image Contents

The common Ubuntu Core image should include:

- the `fsk-rover-pilot` snap
- the `tailscale` snap
- the default Pilot ROS 2 configuration

The image should not include:

- `fsk-rover-pilot` application secrets
- Tailscale auth keys
- per-device override files

## First-Boot Procedure

1. Flash the prepared Ubuntu Core image to the Raspberry Pi 5.
2. Boot the rover and complete Ubuntu Core setup with the target Ubuntu One account.
3. SSH into the rover using the injected Ubuntu One key.
4. Bring up Tailscale:

```bash
sudo tailscale up --auth-key=TSKEY...
```

5. Apply Pilot settings:

```bash
sudo snap set fsk-rover-pilot internal-secret=YOUR_SECRET
sudo snap set fsk-rover-pilot server-url=https://test.luftaquila.io/course
sudo snap set fsk-rover-pilot ros-domain-id=0
```

6. Apply NTRIP credentials (never commit these to `rover_params.yaml`):

```bash
sudo snap set fsk-rover-pilot ntrip-host=gnss.ngii.go.kr
sudo snap set fsk-rover-pilot ntrip-port=2101
sudo snap set fsk-rover-pilot ntrip-mountpoint=VRS-RTCM31
sudo snap set fsk-rover-pilot ntrip-username=YOUR_USERNAME
sudo snap set fsk-rover-pilot ntrip-password=YOUR_PASSWORD
```

7. Confirm the daemon restarted with the new values:

```bash
snap services fsk-rover-pilot
snap logs fsk-rover-pilot -n 50
```

8. Pin the rover to the current `fsk-rover-pilot` revision for the week
   leading up to a competition so an automatic refresh can't ship a
   candidate build into the field:

```bash
sudo snap refresh --hold=168h fsk-rover-pilot
```

9. From this point onward, manage the rover through Tailscale-based SSH.

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
