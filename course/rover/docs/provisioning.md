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

6. Confirm the daemon restarted with the new values:

```bash
snap services fsk-rover-pilot
snap logs fsk-rover-pilot -n 50
```

7. From this point onward, manage the rover through Tailscale-based SSH.

## Operating Assumptions

- all rovers share the same hardware layout
- all rovers use the same NTRIP endpoint and base parameters
- `pilot/config/rover_params.yaml` stays identical across the fleet
- only a small set of deployment secrets is injected after first boot
