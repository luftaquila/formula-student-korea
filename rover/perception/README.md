# FSK Rover Perception

Owns the rover's USB stereo webcam and serves two concerns off it:

1. **Streaming (Phase 2)** — relays JPEG frames (the left eye) to the operator
   via the course server's MJPEG relay, capturing only while someone is watching.
2. **Obstacle detection (Phase 3)** — while the rover is driving a mission, runs
   stereo depth on the two eyes and, on a corridor obstacle, pauses the mission
   **locally over ROS** so the operator can drive around it.

> **Camera layout.** The rover's "Stereo Vision" unit is **dual-node**: the two
> eyes are separate `/dev/video` nodes (left=`video0`, right=`video2`, each
> 1280×720) — NOT a side-by-side frame. `STEREO_LAYOUT=dual` (default) opens both;
> `STEREO_LAYOUT=sbs` handles a camera that emits one combined frame instead.

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
loop JPEG-encodes one eye — the left node whole in dual layout, or `CAMERA_VIEW`
cropped from the SBS frame — and POSTs each frame; the server fans them to
browsers as `multipart/x-mixed-replace`.

### Depth composite (operator toggle)

When the operator toggles the depth view on, the server emits `depth-on`
(`depth-off` to clear) on the same control SSE. While it's on AND a calibration
is loaded, each streamed frame becomes a **both-eyes composite** instead of the
plain left eye (`stereo.compute_composite`): the **sharp rectified left eye at
full resolution** with a **translucent depth heatmap** overlaid where the stereo
match is valid, plus a marker + distance at the **whole-frame nearest point**.
The heavy SGBM runs on a downscaled copy (`VIZ_DEPTH_SCALE`) so the real image
stays crisp while depth stays cheap; the marker maps back to the base with a
simple scale (base and depth share the rectified frame). Rendered on the rover,
so the server/browser just relay the JPEG. Falls back to the plain stream with
no calibration. Benchmarked on the Pi 5 (720p base, 512×288 depth, 3WAY): ~5 fps
on one core (NAVIGATING) / ~10 fps on three (paused/idle). The plain stream and
the obstacle detector are unaffected.

## How detection works (Phase 3)

- **Gated to driving.** The node subscribes to `/rover/nav/state` and only runs
  detection while it equals `NAVIGATING`. SETTLING/SPRAYING are stationary at a
  cone (no collision risk); everything else has no mission to interrupt.
- **Depth.** The two eyes (dual: `video0`+`video2`; sbs: one frame split) are
  rectified with the stored calibration, run through `StereoSGBM` to a disparity
  map, and reprojected to metric depth.
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
| `STEREO_LAYOUT` | dual | `dual` (two `/dev/video` nodes) \| `sbs` (one side-by-side frame) |
| `CAMERA_DEVICE` | auto | left eye / SBS device; blank → probe `/dev/video0..9` (dual pins `video0`) |
| `STEREO_RIGHT_DEVICE` | `/dev/video2` | right eye (dual layout) |
| `CAMERA_WIDTH` / `CAMERA_HEIGHT` | 1280 / 480 | capture resolution per device (rover cam delivers 1280×720; set 720) |
| `CAMERA_FPS` | 15 | max frames/s pushed while streaming (the 720p cam delivers ~13, so this is above the hardware ceiling; lower on a constrained uplink) |
| `CAMERA_JPEG_QUALITY` | 70 | 1–100 |
| `CAMERA_VIEW` | left | sbs layout only: `left`\|`right`\|`full` crop. Dual streams the left eye whole. |
| `OBSTACLE_DETECTION` | true | master switch; `false` disables detection entirely |
| `DETECT_FPS` | 4 | detection rate (sub-samples capture; a few fps is plenty) |
| `STEREO_SGBM_MODE` | 3way | block matcher: `3way` (fast, multi-core), `sgbm` (accurate, single-core), `hh`/`hh4`. Applies to detection AND the live depth composite. |
| `VIZ_NEAR_M` / `VIZ_FAR_M` | 0.3 / 5.0 | live composite: depth range mapped to the heatmap colours + near clip for the nearest-point marker |
| `VIZ_DEPTH_SCALE` | 0.4 | live composite: depth-compute size as a fraction of the calib (base) size — base renders sharp at full res, SGBM runs on this downscaled copy (0.4 of 720p → 512×288) |
| `VIZ_THREADS_IDLE` | 3 | OpenCV threads for the composite while NOT navigating (paused/idle); forced to 1 while NAVIGATING so it can't starve the control tick |
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
  --device /dev/video0:/dev/video0 --device /dev/video2:/dev/video2 \
  --volume /var/lib/perception:/var/lib/perception:z \
  --entrypoint python3 \
  ghcr.io/luftaquila/fsk-rover-perception:candidate \
  /opt/perception/stereo_calibrate.py \
    --device /dev/video0 --right-device /dev/video2 \
    --cols 9 --rows 6 --square-m 0.025 --width 1280 --height 720

# 3. Restart the node — it picks up /var/lib/perception/stereo_calib.npz.
sudo systemctl start perception.service
```

> **Calibrating at a lower depth resolution (for the live depth composite / a faster
> detect):** stereo block matching cost scales with resolution, so the depth pipeline
> can run much faster at a smaller size (benchmarked on the Pi 5: 512×288 3WAY ≈ 22 fps
> on one core vs ~2 fps at 720p). The cam **ignores `--width/--height` and always
> delivers 720p**, so pass `--proc-width/--proc-height` to downsample each captured eye
> before solving — that is what fixes the maps' `image_size` at the target size (at
> runtime `StereoDepth._prep_eye` resizes the 720p eye to match). Keep the aspect 16:9
> (the sensor is 16:9); 512×288 and 640×360 are good picks. Also set
> `STEREO_NUM_DISPARITIES` proportionally (720p→96, 512×288→32, 640×360→48):
> ```bash
> ... /opt/perception/stereo_calibrate.py \
>     --device /dev/video0 --right-device /dev/video2 \
>     --cols 9 --rows 6 --square-m 0.025 --proc-width 512 --proc-height 288
> ```

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
