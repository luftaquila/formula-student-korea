# Ubuntu Core Notes

Recommended deployment layout:

- `pilot/`: ROS 2 package source and local service assets
- `snap/`: Ubuntu Core packaging files
- `image/`: Ubuntu Core image assembly templates and notes
- `docs/`: operations and deployment documentation

Selected deployment model:

- single monolithic snap
- ROS 2 app runs as a snap daemon at boot
- Ubuntu Core image includes `fsk-rover-pilot` and `tailscale` snaps
- default rover settings are embedded in `pilot/config/rover_params.yaml`
- only a few operational values are overrideable through `snap set`
- the `fsk-rover-pilot` snap stages its Python runtime dependencies directly
- the `fsk-rover-pilot` snap uses a `configure` hook to restart after `snap set`

Access and bootstrap model:

- first login uses Ubuntu One SSH key injection during Ubuntu Core setup
- `tailscale` is preinstalled in the image but not pre-authenticated
- after the first SSH login, the operator runs `sudo tailscale up`
- the operator then applies `snap set fsk-rover-pilot ...`
- the `configure` hook restarts the daemon so the new values take effect immediately

Supported snap configuration keys:

- `server-url`
- `internal-secret`
- `ros-domain-id`

Configuration strategy:

- common hardware parameters stay in the packaged YAML
- identical devices all run the same snap revision
- no per-device YAML layer is introduced unless field exceptions appear later
- the image does not contain `fsk-rover-pilot` application secrets
- the image does not contain Tailscale auth keys

Recommended first-boot sequence:

1. flash the Ubuntu Core image that already includes `fsk-rover-pilot` and `tailscale`
2. complete Ubuntu Core setup with Ubuntu One so SSH keys are injected
3. SSH into the rover over the local network
4. run `sudo tailscale up --auth-key=...`
5. run `sudo snap set fsk-rover-pilot internal-secret=...`
6. optionally set `server-url=...` and `ros-domain-id=...`
7. verify with `snap services fsk-rover-pilot` and `snap logs fsk-rover-pilot -n 50`
8. continue all later access over Tailscale SSH

CI ownership:

- `.github/workflows/rover-snap.yml` builds the snap on every push to `main` and publishes it to the `latest/edge` channel on the Snap Store
- `.github/workflows/rover-image.yml` is a manual (`workflow_dispatch`) pipeline that rebuilds the snap and assembles the Ubuntu Core image
- the signed model assertion is expected as the `ROVER_MODEL_ASSERTION_B64` GitHub secret
- Snap Store credentials are expected as the `SNAPCRAFT_STORE_CREDENTIALS` GitHub secret

Legacy notes:

- `pilot/scripts/systemd/` remains only as a reference for non-Core environments
- `pilot/scripts/setup_udev.sh` remains available for classic Ubuntu bring-up
