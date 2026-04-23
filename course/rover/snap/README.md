# Snap Layout

`snap/` contains the Ubuntu Core deployment assets for the rover.

- `../snapcraft.yaml`: monolithic ROS 2 snap definition
- `bin/run-pilot`: daemon entrypoint that reads optional snap configuration

Runtime model:

- the snap contains the default ROS 2 config from `pilot/config/rover_params.yaml`
- the `fsk-rover-pilot` app runs as a daemon at boot
- the Ubuntu Core image is expected to include a separate `tailscale` snap
- `snapctl get` is used only for a small set of optional overrides:
  - `server-url`
  - `internal-secret`
  - `ros-domain-id`

Bootstrap model:

- first SSH access comes from Ubuntu One key injection during Ubuntu Core setup
- `tailscale` is installed in the image but authenticated after the first SSH login
- `fsk-rover-pilot` secrets are injected with `snap set` after Tailscale join

This directory defines the `fsk-rover-pilot` application snap only. Image composition that bundles
`fsk-rover-pilot` together with `tailscale` happens at the Ubuntu Core image/model layer.
