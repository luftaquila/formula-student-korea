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

Operator flow: **detect → rover auto-pauses itself → alert + live camera pops up
→ operator drives manually around the obstacle → presses 재개 (resume)**. Resume
goes through the server (`/api/rover/resume`) exactly like an operator pause.

### Files

| File | Role |
|------|------|
| `perception_node.py` | entrypoint: rclpy node, owns the camera capture loop, wires streaming (MJPEG + WebRTC) + detection |
| `cloud_link.py` | all HTTP to the server — control SSE (camera-start/stop, mjpeg-on/off, webrtc-2d/vr-on/off, depth-on/off), JPEG frame POST, obstacle alert POST |
| `webrtc_pub.py` | aiortc WHIP publisher — H.264-encodes pushed frames (via PyAV) and streams them to a mediamtx WHIP endpoint; one publisher per stream (rover-2d, rover-vr) |
| `stereo.py` | stereo depth + rectified SBS (`rectify_sbs`, for the VR stream) + the pure (cv2-free) corridor-obstacle decision + edge debounce |
| `stereo_calibrate.py` | one-time checkerboard calibration tool (run on-demand, see below) |

## How streaming works

Tailscale-free, outbound-only like `pilot`: the node holds a control SSE to the
server. The server tracks viewers and emits fine-grained gating on that channel
so the rover only does the work someone is watching: `camera-start`/`camera-stop`
(any viewer at all), `webrtc-2d-on`/`webrtc-vr-on` (a WebRTC viewer of that stream
is holding), and `mjpeg-on` (an MJPEG fallback `<img>` viewer is attached).

- **WebRTC (primary).** On `webrtc-2d-on`/`webrtc-vr-on` the node lazily starts a
  `webrtc_pub.py` WHIP publisher for that stream and pushes frames to mediamtx,
  which relays them to the browser over WHEP. `rover-2d` carries the mono left eye
  (or the depth composite); `rover-vr` carries the rectified left|right
  side-by-side stereo (`stereo.rectify_sbs`) that the VR view splits per eye. Each
  stream is encoded only while its viewer is present, so a 2D-only session pays no
  VR cost and vice-versa. Frames are paced to `CAMERA_FPS`; the WHIP URLs are built
  from `SERVER_URL` (`/api/rtc/rover-2d/whip`, `/api/rtc/rover-vr/whip`).
- **MJPEG (fallback).** On `mjpeg-on` the capture loop also JPEG-encodes one eye —
  the left node whole in dual layout, or `CAMERA_VIEW` cropped from the SBS frame —
  and POSTs each frame; the server fans them to browsers as
  `multipart/x-mixed-replace`. The browser only opens this if WebRTC can't
  negotiate (e.g. a network with no viable ICE path) or drops mid-session.

### Depth composite (operator toggle)

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
96 reaches about 0.35 m at 512×288; scaling it previously limited range to ~1.08 m.
The marker uses the nearest equidepth region's centroid and excludes `VIZ_EDGE_MARGIN`.

Pi 5 measurements (720p base, 512×288 depth): ~23 fps SGBM compute;
paused/idle composite ~8 fps on three cores or ~5 fps on one, limited by rectification.

## How detection works

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

Until this runs, obstacle detection stays disabled. The rover is headless, so
the tool has no preview window — it auto-grabs board pairs as you sweep a
printed checkerboard across the frame.

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
| `rover.yml` (`perception`) | `main` push under `perception/**`; manual component selection | `fsk-rover-perception` OCI; `compileall` + `pytest` gate (stereo decision + debounce) |
