# Image Assembly

Ubuntu Core image layer for the rover. All assembly happens in GitHub
Actions; developer machines only need the signing-key setup below.

## Pipelines

- `.github/workflows/rover-snap.yml` — builds `fsk-rover-pilot` on every
  PR (artifact only), publishes `candidate` on pushes to `main`, and
  publishes `edge` on `v*` tags or `workflow_dispatch` with a specified
  channel. Field rovers refresh from these channels, so new missions
  roll out through this pipeline rather than through fresh images.
- `.github/workflows/rover-image.yml` — manual (`workflow_dispatch`) or
  weekly (Mon 14:00 KST). Signs the model and a chained
  `auto-import.assert` in-pipeline and bakes that assertion bundle into
  the image seed at build time via `ubuntu-image snap --assertion`, so
  the image boots straight to the seeded `fsk` SSH user without
  console-conf.

Ongoing updates flow through the snap pipeline; the image pipeline is
only needed for first-time provisioning, hardware swaps, or base-snap
refreshes.

## Inputs

| Name | Type | Contents |
|------|------|----------|
| `SNAP_BRAND_KEY_B64` | secret | `tar czf - -C ~/.snap/gnupg .` then `base64 -w0`. Contains the brand signing key snapd uses for `snap sign`. |
| `SNAP_BRAND_KEY_NAME` | repo var | Key name as shown by `snap keys`, e.g. `fsk-rover-signing`. |
| `model.assertion.template` | checked-in | Unsigned model. CI refreshes `timestamp` per run and signs. |
| `system-user.template.json` | checked-in | Unsigned local-user assertion. CI fetches public keys from <https://github.com/luftaquila.keys>, fills `ssh-keys` + `since`/`until`/`timestamp`, then signs it with `--chain` so `auto-import.assert` contains the required account/account-key assertions too. |
| `fsk-rover-pilot` snap | built | Built inside the image workflow by `snapcore/action-build`. |
| `tailscale` | snap-store | Referenced from the model assertion, pulled at assembly time. |

Brand identity baked into `model.assertion.template`:

- `model` — `fsk-rover`
- `authority-id` / `brand-id` — `0omV9pEFvLnFgHtuPb1LUkfXbJyegTHc`

`grade: dangerous` is required because the image embeds the locally-built
`fsk-rover-pilot` snap via `ubuntu-image --snap` rather than a published
revision.

## Signing Setup (one-time per brand key)

On a trusted workstation that already has the brand account logged in
to `snapcraft`:

```bash
# Create an assertion-signing key. Leave the passphrase blank — CI signs
# non-interactively and cannot type one.
snap create-key fsk-rover-signing
snapcraft register-key fsk-rover-signing

# Export the snapd gnupg homedir (path is ~/.snap/gnupg on classic Ubuntu).
tar czf /tmp/snap-brand-key.tar.gz -C ~/.snap/gnupg .
base64 -w0 /tmp/snap-brand-key.tar.gz | \
    gh secret set SNAP_BRAND_KEY_B64 --repo luftaquila/formula-student-korea

# Record the key name as a repo variable (not a secret).
gh variable set SNAP_BRAND_KEY_NAME --repo luftaquila/formula-student-korea \
    --body 'fsk-rover-signing'
```

The older `ROVER_MODEL_ASSERTION_B64` secret is no longer read by CI; it
can be removed from the repo secrets.

## Security model

The image contains:

- Ubuntu Core base snaps
- `fsk-rover-pilot`, `tailscale`
- a signed `system-user` assertion creating local user `fsk` with SSH keys
- a default Wi-Fi profile (`default` / `password`) applied by the pilot
  snap's `configure` hook at first boot
- `dtparam=fan_temp*` lines appended to `ubuntu-seed/config.txt` by the
  image workflow's "Force Pi 5 fan to 100%" step, so the Pi firmware
  runs the cooling fan at full PWM from power-on without any kernel or
  snap involvement

The image does **not** contain:

- `fsk-rover-pilot` application secrets (`INTERNAL_SECRET`,
  `NTRIP_USERNAME` — the NGII password and host are hard-coded constants,
  not secrets)
- Tailscale auth keys
- per-device override files

Per-rover secrets are injected after first login via `snap set`. See
[`../docs/README.md`](../docs/README.md) for the full first-boot
sequence.
