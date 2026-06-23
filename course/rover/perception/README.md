# FSK Rover Perception

Owns the rover's USB stereo webcam and serves two concerns off the one device:

1. **Streaming (Phase 2)** — relays JPEG frames to the operator via the course
   server's MJPEG relay, capturing only while someone is watching.
2. **Obstacle detection (Phase 3)** — while the rover is driving a mission, runs
   stereo depth on the side-by-side frame and, on a corridor obstacle, pauses
   the mission **locally over ROS** so the operator can drive around it.

Runs as its own container alongside `pilot`, so the lean ROS image stays
untouched and the heavier OpenCV stack lives here. It shares pilot's
`ros:jazzy-ros-base` so the detector can join the same ROS graph as the
navigator (both run `--network=host` with one `ROS_DOMAIN_ID`); podman dedupes
the shared base layers, so the only marginal image cost is the OpenCV wheel.

## Architecture — local control, cloud alert

The detect→pause decision stays on the Pi (perception and navigator are
co-located), so it is instant and survives an uplink blip. The server is only in
the loop for the human-facing parts (alert, camera, resume), which need it
regardless.

```
 perception_node.py                                        course server
 ─────────────────                                         ─────────────
  capture loop (one device)
   ├─ stream branch  ──POST /api/rover/camera (jpeg)──────►  MJPEG relay → browser
   │   (only while an operator is watching)
   │
   └─ detect branch  (only while nav_state == NAVIGATING)
        stereo depth → corridor obstacle?
          │
          ├─ publish /rover/perception/obstacle (ROS) ──►  navigator: local PAUSE
          │                                                 (no server round trip)
          └─ POST /api/rover/obstacle (best-effort) ─────►  operator alert banner
                                                            + auto-open camera
                                                            + mirror status=paused
```

Operator flow: **detect → rover auto-pauses itself → alert + live camera pops up
→ operator drives manually around the obstacle → presses 재개 (resume)**. Resume
goes through the server (`/api/rover/resume`) exactly like an operator pause.

### Files

| File | Role |
|------|------|
| `perception_node.py` | entrypoint: rclpy node, owns the camera capture loop, wires streaming + detection |
| `cloud_link.py` | all HTTP to the server — control SSE (stream on/off), frame POST, obstacle alert POST |
| `stereo.py` | stereo depth + the pure (cv2-free) corridor-obstacle decision + edge debounce |
| `stereo_calibrate.py` | one-time checkerboard calibration tool (run on-demand, see below) |

## How streaming works (Phase 2)

Tailscale-free, outbound-only like `pilot`: the node holds a control SSE to the
server; the server emits `camera-start` when an operator opens the live view and
`camera-stop` when the last viewer leaves. While streaming is wanted the capture
loop JPEG-encodes one eye (`CAMERA_VIEW`) and POSTs each frame; the server fans
them to browsers as `multipart/x-mixed-replace`.

## How detection works (Phase 3)

- **Gated to driving.** The node subscribes to `/rover/nav/state` and only runs
  detection while it equals `NAVIGATING`. SETTLING/SPRAYING are stationary at a
  cone (no collision risk); everything else has no mission to interrupt.
- **Depth.** The SBS frame is split, rectified with the stored calibration, run
  through `StereoSGBM` to a disparity map, and reprojected to metric depth.
- **Decision.** If enough valid pixels in the driving-corridor ROI fall inside
  the `[OBSTACLE_NEAR_M, OBSTACLE_FAR_M]` band (fraction ≥ `OBSTACLE_MIN_FILL`,
  with a floor of `OBSTACLE_MIN_VALID_PX` valid pixels so a textureless corridor
  can't trip on speckle), it's an obstacle.
- **Debounce.** `OBSTACLE_ON_FRAMES` consecutive positives assert; the navigator
  pauses on the rising edge only. `OBSTACLE_OFF_FRAMES` consecutive clears
  release.
- **Safety default.** With no usable calibration the detector is **disabled**
  (reports no obstacle) — a missing calibration must never auto-pause on noise.
  Streaming still works.

> **Tuning the band at bring-up:** `OBSTACLE_NEAR_M` is a *near clip* — pixels
> closer than it are treated as lens-edge noise / the rover's own nose and do
> NOT count. Set it as small as the rectified depth is still trustworthy (an
> object filling the corridor closer than `OBSTACLE_NEAR_M` would otherwise be
> excluded). Validate the band/ROI/`MIN_FILL` against the real camera by driving
> at a known obstacle and watching the `fill`/`nearest_m` in the journal.

## Image

| Image | Built by | Updates |
|-------|----------|---------|
| `ghcr.io/luftaquila/fsk-rover-perception:{candidate,edge,vX.Y.Z}` | `Containerfile` | `podman auto-update` (24 h, in-place) |

`ros:jazzy-ros-base` (rclpy/std_msgs) + `opencv-python-headless` + `numpy` +
`requests`.

## Runtime

`perception.service` (host bootc image) → `/usr/local/bin/perception-run`, which
probes `/dev/video*` and `podman run`s this image with `--network=host`,
`--env-file /etc/pilot/pilot.conf`, the `internal-secret` podman secret, and a
`--volume /var/lib/perception` bind for the calibration. A udev `add|remove` on
a video device restarts the unit via `fsk-perception-replug.service`.

### Configuration (environment)

| Var | Default | Meaning |
|-----|---------|---------|
| `SERVER_URL` | — | course server base (from `/etc/pilot/pilot.conf`) |
| `INTERNAL_SECRET` | — | `X-Internal-Service` auth (podman secret) |
| `ROS_DOMAIN_ID` | 0 | must match `pilot` (from `/etc/pilot/pilot.conf`) |
| `CAMERA_DEVICE` | auto | v4l2 index/path; blank → probe `/dev/video0..9` |
| `CAMERA_WIDTH` / `CAMERA_HEIGHT` | 1280 / 480 | SBS capture resolution |
| `CAMERA_FPS` | 8 | max frames/s pushed while streaming |
| `CAMERA_JPEG_QUALITY` | 70 | 1–100 |
| `CAMERA_VIEW` | left | `left` \| `right` \| `full` — one sensor for a clean operator view |
| `OBSTACLE_DETECTION` | true | master switch; `false` disables detection entirely |
| `DETECT_FPS` | 4 | detection rate (sub-samples capture; a few fps is plenty) |
| `STEREO_CALIB_PATH` | `/var/lib/perception/stereo_calib.npz` | calibration file |
| `STEREO_NUM_DISPARITIES` | 96 | max disparity searched (multiple of 16); nearest detectable depth |
| `STEREO_BLOCK_SIZE` | 7 | SGBM block size (odd) |
| `STEREO_CV_THREADS` | 1 | cap on OpenCV threads so block matching can't starve the navigator tick |
| `OBSTACLE_ROI_{X0,Y0,X1,Y1}` | 0.30/0.55/0.70/0.98 | corridor rectangle (fractions of the frame) |
| `OBSTACLE_NEAR_M` / `OBSTACLE_FAR_M` | 0.4 / 2.5 | obstacle depth band (metres) |
| `OBSTACLE_MIN_FILL` | 0.12 | fraction of corridor in-band → obstacle |
| `OBSTACLE_MIN_VALID_PX` | 400 | floor on valid corridor pixels to trust a verdict |
| `OBSTACLE_ON_FRAMES` / `OBSTACLE_OFF_FRAMES` | 3 / 5 | debounce |

Override per-rover via `/etc/pilot/pilot.conf` then `sudo systemctl restart
perception.service`.

> **Uplink budget:** video shares the rover's uplink with the safety-critical
> pilot channel. Defaults suit a good LAN; on a cellular link lower `CAMERA_FPS`
> / `CAMERA_JPEG_QUALITY`. Detection itself sends nothing continuous — only one
> small POST per obstacle. The server rate-caps the relay (~25 fps) and only
> asks the rover to capture while watched.
>
> **Compute budget (Pi 5):** stereo block matching is the heavy part. It's kept
> affordable with a low `DETECT_FPS`, a corridor-only ROI, and `STEREO_CV_THREADS`
> capping OpenCV to ~1 core so it can't starve the navigator's control loop;
> detection is idle except while NAVIGATING. Tune `CAMERA_WIDTH/HEIGHT` down for
> more headroom (calibrate at the same resolution).

## Stereo calibration (one-time, per camera/mounting)

Until this runs, obstacle detection stays disabled. The rover is headless, so
the tool has no preview window — it auto-grabs board pairs as you sweep a
printed checkerboard across the frame.

```bash
# 1. Stop the running node so the camera is free.
ssh fsk@<rover-ip>
sudo systemctl stop perception.service

# 2. Run the calibration tool from the same image, with the camera + calib bind.
#    --entrypoint python3 is REQUIRED: the image's default entrypoint hardcodes
#    perception_node.py, so appended args would otherwise be ignored. The tool
#    needs only cv2/numpy (no ROS), so skipping the ROS-sourcing entrypoint is fine.
#    --square-m is the printed square edge IN METRES — it sets the depth units.
#    Calibrate at the SAME resolution the node runs at (CAMERA_WIDTH/HEIGHT).
sudo podman run --rm --network=host \
  --device /dev/video0:/dev/video0 \
  --volume /var/lib/perception:/var/lib/perception:z \
  --entrypoint python3 \
  ghcr.io/luftaquila/fsk-rover-perception:candidate \
  /opt/perception/stereo_calibrate.py \
    --cols 9 --rows 6 --square-m 0.025 --width 1280 --height 480

# 3. Restart the node — it picks up /var/lib/perception/stereo_calib.npz.
sudo systemctl start perception.service
```

The tool prints per-eye + stereo RMS and the recovered baseline (should be
~60 mm). Stereo RMS > 1.0 px means a poor calibration (recapture with a flatter
board / better lighting). `--cols`/`--rows` are **inner** corners (a 10×7-square
board → 9×6).

## Verify on the rover

```bash
ssh fsk@<rover-ip> systemctl status perception.service
ssh fsk@<rover-ip> sudo journalctl -u perception.service -n 50
# Journal: "opened camera ..."; "obstacle detection ENABLED" (or DISABLED if
# uncalibrated). Open the rover panel and toggle 📷 카메라 to confirm frames.
```

> **Hardware-validated:** the server relay + web `<img>` and the pure obstacle
> decision are covered by tests, but the capture path (`cv2.VideoCapture`) and
> the tuned depth thresholds must be confirmed against the actual camera. Drive
> a mission with something in the corridor and confirm the auto-pause + alert.

## CI

| Workflow | Trigger | Output |
|----------|---------|--------|
| `rover-perception-image.yml` | `main` push under `perception/**`; manual | `fsk-rover-perception` OCI; `compileall` + `pytest` gate (stereo decision + debounce) |
