# FSK Rover Perception

Captures the rover's USB stereo webcam and streams it to the operator via the
course server's MJPEG relay. Runs as its own container alongside `pilot`, so the
lean ROS image stays untouched and the heavier OpenCV stack lives here (Phase 3
will add stereo depth + obstacle detection in the same container).

## How it works (Phase 2 — streaming)

Tailscale-free, same outbound-only pattern as `pilot`:

```
camera_streamer.py ──GET  /api/rover/camera/control (SSE, internal)──►  course server
   (perception)    ◄── camera-start / camera-stop ──────────────────
                   ──POST /api/rover/camera (image/jpeg, internal)──►  relay → browser <img>
```

- The server emits `camera-start` when an operator opens the live view and
  `camera-stop` when the last viewer leaves, so the camera/CPU/uplink idle
  during normal autonomous missions.
- While started, the streamer grabs frames, JPEG-encodes them, and POSTs each
  to the server, which fans them to admin browsers as `multipart/x-mixed-replace`.

## Image

| Image | Built by | Updates |
|-------|----------|---------|
| `ghcr.io/luftaquila/fsk-rover-perception:{candidate,edge,vX.Y.Z}` | `Containerfile` | `podman auto-update` (24 h, in-place) |

`python:3.13-slim` + `opencv-python-headless` + `requests`.

## Runtime

`perception.service` (host bootc image) → `/usr/local/bin/perception-run`, which
probes `/dev/video*` and `podman run`s this image with `--network=host`,
`--env-file /etc/pilot/pilot.conf` (for `SERVER_URL`) and the `internal-secret`
podman secret. A udev `add|remove` on a video device restarts the unit via
`fsk-perception-replug.service` so it re-probes.

### Configuration (environment)

| Var | Default | Meaning |
|-----|---------|---------|
| `SERVER_URL` | — | course server base (from `/etc/pilot/pilot.conf`) |
| `INTERNAL_SECRET` | — | `X-Internal-Service` auth (podman secret) |
| `CAMERA_DEVICE` | auto | v4l2 index/path; blank → probe `/dev/video0..9` |
| `CAMERA_WIDTH` / `CAMERA_HEIGHT` | 1280 / 480 | capture resolution |
| `CAMERA_FPS` | 8 | max frames/s pushed |
| `CAMERA_JPEG_QUALITY` | 70 | 1–100 |
| `CAMERA_VIEW` | left | `left` \| `right` \| `full` — a side-by-side stereo frame shows doubled as `full`; `left`/`right` crop one sensor for a single clean operator view |

Override per-rover with `podman` env or by editing `/etc/pilot/pilot.conf`
(then `sudo systemctl restart perception.service`).

## Verify on the rover

```bash
ssh fsk@<rover-ip> systemctl status perception.service
ssh fsk@<rover-ip> sudo journalctl -u perception.service -n 50
# Then open the rover panel in the web UI and toggle 📷 카메라.
```

> **Hardware-validated:** the streaming pipeline (server relay + web `<img>`) is
> covered by the course test-suite, but the capture path (`cv2.VideoCapture` →
> JPEG → POST) must be confirmed against the actual camera — check the journal
> for `opened camera` and `capture START`, then confirm frames in the web view.

## CI

| Workflow | Trigger | Output |
|----------|---------|--------|
| `rover-perception-image.yml` | `main` push under `perception/**`; manual | `fsk-rover-perception` OCI; `compileall` gate |
