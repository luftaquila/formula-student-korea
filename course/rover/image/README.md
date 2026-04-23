# Image Assembly

This directory documents the Ubuntu Core image layer for the rover.

## CI Strategy

Image assembly is handled in GitHub Actions instead of on a developer machine.

- `.github/workflows/rover-snap.yml` builds and publishes the `fsk-rover-pilot` snap on every push to `main` (edge channel)
- `.github/workflows/rover-image.yml` is a manual (`workflow_dispatch`) workflow that rebuilds the snap and assembles the Ubuntu Core image
- image assembly is intentionally separate from the snap pipeline because it is only needed for first-time provisioning; ongoing updates flow through the snap channel

## Inputs

The image build expects:

- a signed Ubuntu Core model assertion stored as the `ROVER_MODEL_ASSERTION_B64` GitHub secret
- the `fsk-rover-pilot` snap built inside the image workflow
- the `tailscale` snap to be referenced from the model assertion

Current account values already wired into `model.assertion.template`:

- `model`: `fsk-rover`
- `authority-id`: `0omV9pEFvLnFgHtuPb1LUkfXbJyegTHc`
- `brand-id`: `0omV9pEFvLnFgHtuPb1LUkfXbJyegTHc`

Before signing, refresh `timestamp`.

The model uses `grade: dangerous` because the image build injects the local `fsk-rover-pilot` snap with `ubuntu-image --snap`.

## Security Model

The common image should include:

- Ubuntu Core base snaps
- the `fsk-rover-pilot` snap
- the `tailscale` snap

The common image should not include:

- Pilot runtime secrets
- Tailscale auth keys
- per-device override files

## First-Boot Flow

1. Flash the CI-built Ubuntu Core image.
2. Complete Ubuntu Core setup with Ubuntu One to inject SSH keys.
3. SSH into the rover.
4. Join Tailscale:

```bash
sudo tailscale up --auth-key=TSKEY...
```

5. Apply Pilot settings:

```bash
sudo snap set fsk-rover-pilot internal-secret=YOUR_SECRET
sudo snap set fsk-rover-pilot server-url=https://test.luftaquila.io/course
sudo snap set fsk-rover-pilot ros-domain-id=0
```

The `fsk-rover-pilot` snap `configure` hook restarts the daemon automatically after each `snap set`.
