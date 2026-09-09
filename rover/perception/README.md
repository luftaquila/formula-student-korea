# FSK Rover Perception

Owns the USB stereo camera for viewer-triggered video and mission obstacle detection.
WebRTC/H.264 is primary: WHIP publishes `rover-2d` (mono/depth composite) and
`rover-vr` (rectified left|right stereo) to mediamtx. MJPEG is the fallback.
During navigation, stereo obstacles trigger a local ROS pause.

The rover camera exposes separate left `/dev/video0` and right `/dev/video2` nodes,
each 1280×720. Default `STEREO_LAYOUT=dual` opens both; `sbs` supports a combined frame.
Perception runs separately from `pilot`, sharing `ros:jazzy-ros-base`, host networking,
and `ROS_DOMAIN_ID` to join the same ROS graph.

## Architecture — local control, cloud alert

Perception pauses the co-located navigator over ROS without an uplink. The server
handles operator alerts, video, and resume.

```
 perception_node.py                                        course server
 ─────────────────                                         ─────────────
  capture loop (one device)
   ├─ stream branch  (only while an operator is watching)
   │    ├─ WebRTC (H.264) ─WHIP→ mediamtx ─WHEP→ browser   [primary: rover-2d / rover-vr]
   │    └─ MJPEG ─POST /api/rover/camera (jpeg)→ relay → browser   [fallback]
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

Resume is an explicit server command; obstacle clearance does not auto-resume
the mission. See [Missions](../../docs/api.md#missions-roveroperate).

## Streaming

The outbound control SSE gates capture and encoding by viewer:

| Event | Work enabled |
|---|---|
| `camera-start` / `camera-stop` | Camera capture |
| `webrtc-2d-on` / `webrtc-vr-on` | WHIP publisher for the corresponding stream |
| `mjpeg-on` | JPEG POST relay for fallback viewers |

WebRTC publishes to `{SERVER_URL}/api/rtc/{rover-2d,rover-vr}/whip` at
`CAMERA_FPS`. 2D uses the left eye or depth composite; VR uses rectified stereo.
MJPEG uses the whole left eye in dual layout or `CAMERA_VIEW` in SBS layout, and
activates when WebRTC negotiation fails or the stream drops.

### Depth composite

`depth-on` / `depth-off` on the control SSE toggles the shared MJPEG/`rover-2d`
composite while any 2D viewer is present. With calibration, it overlays depth on
the full-resolution rectified left eye and marks the nearest point and distance.
Without calibration, it shows a labelled plain stream.

Detection and visualization share one downscaled depth pass (`VIZ_DEPTH_SCALE`);
the overlay maps back to the full-resolution frame. OpenCV uses
`STEREO_CV_THREADS` while navigating to preserve control-loop capacity.

With `ximgproc`, left/right SGBM matchers feed the WLS filter. The display uses its
filled depth map, but detection and the nearest marker require confidence ≥
`STEREO_WLS_CONF_MIN` to exclude interpolated depth. Without `ximgproc`, use plain
SGBM plus `filterSpeckles`. Keep `numDisparities` unscaled with compute resolution:
96 reaches about 0.35 m at 512×288.
The marker uses the nearest equidepth region's centroid and excludes `VIZ_EDGE_MARGIN`.

## Detection

Detection runs only while `/rover/nav/state` is `NAVIGATING`. Calibrated stereo
images produce metric depth through rectification and StereoSGBM. An obstacle
requires corridor fill ≥ `OBSTACLE_MIN_FILL` within
`[OBSTACLE_NEAR_M, OBSTACLE_FAR_M]` and ≥ `OBSTACLE_MIN_VALID_PX` valid pixels.
`OBSTACLE_ON_FRAMES` positives assert a rising-edge pause;
`OBSTACLE_OFF_FRAMES` clear it. Without usable calibration, detection is disabled
and streaming remains available.

Pixels closer than `OBSTACLE_NEAR_M` are excluded. Set this near clip only as high
as needed to reject unreliable depth; validate the band, ROI, and fill threshold
on the actual camera using journal `fill` / `nearest_m`.

## Image

| Image | Built by | Updates |
|-------|----------|---------|
| `ghcr.io/luftaquila/fsk-rover-perception:{candidate,edge,vX.Y.Z}` | `Containerfile` | `podman auto-update` (24 h, in-place) |

Dependencies: `ros:jazzy-ros-base` (rclpy/std_msgs), `opencv-python-headless`,
`numpy`, `requests`, `aiortc`, and `av`. PyAV bundles ffmpeg/x264 for H.264;
without `aiortc`/`av`, the node falls back to MJPEG-only.

## Runtime

`perception.service` (host bootc image) → `/usr/local/bin/perception-run`, which
probes `/dev/video*` and `podman run`s this image with `--network=host`,
`--env-file /etc/pilot/pilot.conf`, the `internal-secret` podman secret, and a
`--volume /var/lib/perception` bind for the calibration. A udev `add|remove` on
a video device restarts the unit via `fsk-perception-replug.service`.

### Configuration (environment)

| Var | Default | Meaning |
|-----|---------|---------|
| `SERVER_URL` | — | course server base (from `/etc/pilot/pilot.conf`); also builds the WHIP publish URLs `{SERVER_URL}/api/rtc/rover-2d/whip` + `/rover-vr/whip` |
| `SERVER_URL_ALLOW_HTTP` | false | allow a plain `http://` SERVER_URL (WHIP/SSE over http); otherwise `https` is required |
| `INTERNAL_SECRET` | — | `X-Internal-Service` auth (podman secret) |
| `ROS_DOMAIN_ID` | 0 | must match `pilot` (from `/etc/pilot/pilot.conf`) |
| `STEREO_LAYOUT` | dual | `dual` (two `/dev/video` nodes) \| `sbs` (one side-by-side frame) |
| `CAMERA_DEVICE` | auto | left eye / SBS device; blank → probe `/dev/video0..9` (dual pins `video0`) |
| `STEREO_RIGHT_DEVICE` | `/dev/video2` | right eye (dual layout) |
| `CAMERA_WIDTH` / `CAMERA_HEIGHT` | 1280 / 480 | per-device capture size (rover camera: 1280×720; set height 720) |
| `CAMERA_FPS` | 15 | MJPEG/WebRTC fps cap; 720p camera delivers ~13 fps. Lower for constrained uplinks |
| `CAMERA_JPEG_QUALITY` | 70 | 1–100 |
| `CAMERA_VIEW` | left | sbs layout only: `left`\|`right`\|`full` crop. Dual streams the left eye whole. |
| `OBSTACLE_DETECTION` | true | master switch; `false` disables detection entirely |
| `DETECT_FPS` | 4 | detection fps (sub-samples capture) |
| `STEREO_WLS_LAMBDA` / `STEREO_WLS_SIGMA` | 8000 / 1.5 | WLS filter regularisation / edge sensitivity (OpenCV defaults) |
| `STEREO_WLS_CONF_MIN` | 128 | min WLS confidence (0–255) for a pixel to count in DETECTION + the nearest marker (rejects interpolated depth) |
| `STEREO_SGBM_MODE` | sgbm | FALLBACK matcher mode when `ximgproc` is absent (`sgbm`/`3way`/`hh`/`hh4`); ignored when WLS is active (its left matcher is 3WAY) |
| `STEREO_SPECKLE_FILTER_SIZE` | 200 | FALLBACK-only `cv2.filterSpeckles` size (px); WLS does its own cleanup |
| `VIZ_NEAR_M` / `VIZ_FAR_M` | 0.3 / 5.0 | live composite: depth range mapped to the heatmap colours + near clip for the nearest-point marker |
| `VIZ_DEPTH_SCALE` | 0.4 | shared detection/composite depth scale; 720p × 0.4 → 512×288. Auto-scales `OBSTACLE_MIN_VALID_PX`; display stays full-resolution |
| `VIZ_EDGE_MARGIN` | 0.05 | live composite: ignore this fraction of each frame edge when picking the nearest-point marker (keeps it off the top border / the rover's own structure) |
| `VIZ_THREADS_IDLE` | 3 | OpenCV threads for stereo while NOT navigating (paused/idle); drops to `STEREO_CV_THREADS` while NAVIGATING so it can't starve the control tick |
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

Video shares the pilot uplink. On cellular links, lower `CAMERA_FPS` and
`CAMERA_JPEG_QUALITY`; the relay caps video at ~25 fps and captures only while
watched. Detection sends only an obstacle alert POST.

On Pi 5, limit `DETECT_FPS` and `STEREO_CV_THREADS` to preserve the navigation
control loop. Detection runs only while NAVIGATING and uses a corridor ROI.
Lower capture resolution for more headroom and recalibrate at that resolution.

## Stereo calibration (one-time, per camera/mounting)

Calibration requires physical checkerboard captures; the headless tool has no
preview window. Detection remains disabled without usable calibration.

```bash
# 1. Stop the running node so the camera is free.
ssh fsk@<rover-ip>
sudo systemctl stop perception.service

# 2. Run the calibration tool from the same image, with the camera + calib bind.
#    Override the default perception_node.py entrypoint with python3 (no ROS needed).
#    --square-m is the printed square edge in metres; use the runtime resolution.
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

For a camera that ignores capture `--width`/`--height`, use
`--proc-width`/`--proc-height` to set the calibration image size (16:9).
Runtime resizes captures to that size. Do not scale `STEREO_NUM_DISPARITIES`
with resolution; it controls the nearest measurable depth.

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

Tests cover relay and obstacle decision logic. Capture and depth thresholds
require actual-camera verification, including mission pause and alert delivery.

## CI

| Workflow | Trigger | Output |
|----------|---------|--------|
| `rover.yml` (`perception`) | `main` push under `perception/**`; manual component selection | `fsk-rover-perception` OCI; `compileall` + `pytest` gate (stereo decision + debounce) |
