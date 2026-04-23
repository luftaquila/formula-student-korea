# Image Assembly

This directory documents the Ubuntu Core image layer for the rover.

## CI Strategy

Image assembly is handled in GitHub Actions instead of on a developer machine.

- `.github/workflows/rover-snap.yml` builds and publishes the `fsk-rover-pilot` snap on every push to `main` (edge channel)
- `.github/workflows/rover-image.yml` is a manual (`workflow_dispatch`) workflow that rebuilds the snap and assembles the Ubuntu Core image
- image assembly is intentionally separate from the snap pipeline because it is only needed for first-time provisioning; ongoing updates flow through the snap channel

## Inputs

The image build expects:

- `SNAP_BRAND_KEY_B64` GitHub **secret** — tar+base64 of the `snap create-key`
  gnupg homedir containing the brand signing key (see "Signing setup" below)
- `SNAP_BRAND_KEY_NAME` GitHub **repo variable** — name of the key (output of
  `snap keys`, e.g. `fsk-rover-signing`)
- `model.assertion.template` (checked-in) — unsigned model, CI fills in the
  timestamp and signs it per-run
- `system-user.template.json` (checked-in) — unsigned local-user assertion.
  CI fetches SSH public keys at build time from
  <https://github.com/luftaquila.keys>, injects them into the template
  alongside fresh `since` / `until` / `timestamp` fields, signs, and stages the
  result as `auto-import.assert` inside the image so the `fsk` user exists on
  first boot with no console-conf prompt
- the `fsk-rover-pilot` snap, built inside the image workflow
- the `tailscale` snap, referenced from the model assertion

Current account values already wired into `model.assertion.template`:

- `model`: `fsk-rover`
- `authority-id`: `0omV9pEFvLnFgHtuPb1LUkfXbJyegTHc`
- `brand-id`: `0omV9pEFvLnFgHtuPb1LUkfXbJyegTHc`

CI signs the assertion on every run with a freshly-refreshed `timestamp`, so the
template lives in git unsigned and nobody has to remember to re-sign.

The model uses `grade: dangerous` because the image build injects the local
`fsk-rover-pilot` snap with `ubuntu-image --snap`.

## Signing Setup (one-time per brand key)

Run these commands on a trusted machine that already has the brand account
logged in to `snapcraft`:

```bash
# Create a signing key and register it with the brand. Leave the passphrase
# blank — CI signs non-interactively and cannot type one.
snap create-key fsk-rover-signing
snapcraft register-key fsk-rover-signing

# Export the gnupg homedir snapd uses for assertion signing.
# On classic Ubuntu hosts the path is ~/.snap/gnupg (verify with `ls`).
tar czf /tmp/snap-brand-key.tar.gz -C ~/.snap/gnupg .
base64 -w0 /tmp/snap-brand-key.tar.gz | \
    gh secret set SNAP_BRAND_KEY_B64 --repo luftaquila/formula-student-korea

# Record the key name as a repo variable (not a secret).
gh variable set SNAP_BRAND_KEY_NAME --repo luftaquila/formula-student-korea \
    --body 'fsk-rover-signing'
```

The old `ROVER_MODEL_ASSERTION_B64` secret is no longer read and can be removed
from repo secrets.

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
