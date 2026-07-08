#!/usr/bin/env python3
"""FSK rover perception node (Phase 3).

Single owner of the USB stereo webcam. One capture loop serves two independent
concerns off the same device (a UVC node allows only one opener, so they must
share one loop):

  - Streaming (operator-driven): while the server reports an operator is
    watching (CloudLink.stream_wanted), JPEG-encode a frame and POST it to the
    MJPEG relay. Normally the plain left eye; when the operator also toggles the
    depth view on (CloudLink.depth_wanted) and a calibration is loaded, the frame
    is a both-eyes composite instead — the sharp rectified left eye with a depth
    heatmap + nearest-point distance overlaid. Detection and the composite share a
    single stereo depth pass per frame (stereo.compute_depth → decide +
    render_composite), so the composite adds no second SGBM.
  - Obstacle detection (mission-driven): while the navigator is NAVIGATING and
    a stereo calibration is loaded, run stereo depth on the two eyes (dual-node
    by default) at a low rate; on a debounced obstacle in the driving corridor,
    publish /rover/perception/obstacle (Bool). The navigator pauses the mission
    LOCALLY on the rising edge, so the control decision never leaves the Pi and
    survives an uplink blip. A best-effort POST to /api/rover/obstacle asks the
    server to alert the operator + auto-open the camera (the human-facing parts
    that need the server regardless).

Published topics:
    /rover/perception/obstacle (std_msgs/Bool) - debounced corridor obstacle

Subscribed topics:
    /rover/nav/state (std_msgs/String) - gates detection to mission driving
"""

import os
import sys
import threading
import time

import cv2
import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from std_msgs.msg import Bool, String

from cloud_link import CloudLink
import stereo

# Optional low-latency WebRTC publish (aiortc). Guarded so a missing/broken
# aiortc never takes down capture + detection — streaming falls back to MJPEG.
try:
    from webrtc_pub import WebRTCPublisher
    _WEBRTC_AVAILABLE = True
except Exception:  # noqa: BLE001
    WebRTCPublisher = None
    _WEBRTC_AVAILABLE = False


def _env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def _env_int(name, default):
    try:
        return int(_env(name, default))
    except (TypeError, ValueError):
        return default


def _env_float(name, default):
    try:
        return float(_env(name, default))
    except (TypeError, ValueError):
        return default


# Linger before releasing the camera when neither streaming nor detecting, so a
# flapping viewer / a brief IDLE between waypoints doesn't thrash the UVC device
# (many cams wedge on rapid reopen).
STOP_LINGER_S = 3.0
# Back off right-eye (re)open attempts on failure so a missing / flaky
# STEREO_RIGHT_DEVICE can't spam open() + its "no usable camera" log every
# detect cycle. Detection stays inactive (with a throttled warning) until the
# device recovers; the rover keeps driving meanwhile.
RIGHT_OPEN_RETRY_S = 2.0
# Detection runs only while the navigator reports this state — the rover is
# driving under autonomy and could drive INTO something. SETTLING/SPRAYING are
# stationary at a cone, so an obstacle there isn't a collision risk.
DRIVING_STATE = "NAVIGATING"


def open_capture(device, width, height, log):
    """Open the first working camera. Returns a cv2.VideoCapture or None."""
    if device is not None:
        candidates = [int(device) if str(device).isdigit() else device]
    else:
        candidates = list(range(10))  # auto-probe /dev/video0..9
    for dev in candidates:
        cap = cv2.VideoCapture(dev)
        if cap.isOpened():
            # Prefer hardware MJPG so we don't pay a YUYV → re-encode round trip.
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            # Minimise the driver FIFO so read() returns the most recent frame.
            # The left eye is read every loop but the right only at the detect
            # rate; without a shallow buffer the right cam's queue fills and
            # read() returns a stale frame, desyncing the stereo pair. Best-effort
            # (some V4L2 drivers ignore it).
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            # isOpened() is not enough: a metadata node (or a busy device) can
            # open but never deliver frames. Require a real grab so auto-probe
            # falls through to the actual capture node.
            ok, frame = cap.read()
            if ok and frame is not None:
                log(f"opened camera {dev!r} ({width}x{height})")
                return cap
            log(f"device {dev!r} opened but yields no frames; skipping")
        cap.release()
    log("no usable camera device found")
    return None


class StereoReader:
    """Background thread that continuously reads a GRAB-SYNCED stereo pair, so both
    the VR stream AND obstacle-detection depth get a sub-millisecond-aligned pair
    without the capture loop blocking on sequential reads. read_stereo_pair()'s
    grab→grab (before either retrieve) pins the two capture instants together —
    critical for depth on a moving rover. When the pair isn't needed (want_pair
    False, e.g. plain 2D MJPEG) it reads the LEFT eye alone and releases the right,
    so the left keeps its full USB frame rate."""

    def __init__(self, left_device, right_device, width, height, log, dual):
        self._left_device = left_device
        self._right_device = right_device
        self._width = width
        self._height = height
        self._log = log
        self._dual = dual
        self._want_pair = dual
        self._left = None
        self._right = None
        self._ts = 0.0
        self._lock = threading.Lock()
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def set_want_pair(self, want):
        self._want_pair = bool(want) and self._dual

    def _store(self, left, right):
        with self._lock:
            self._left = left
            self._right = right
            self._ts = time.monotonic()

    def _loop(self):
        left_cap = None
        right_cap = None
        right_open_after = 0.0

        def drop_right():
            nonlocal right_cap
            if right_cap is not None:
                right_cap.release()
                right_cap = None

        while self._running:
            if left_cap is None:
                left_cap = open_capture(self._left_device, self._width, self._height, self._log)
                if left_cap is None:
                    time.sleep(1.0)
                    continue
            need_right = self._want_pair
            if not need_right:
                drop_right()  # free the right eye's USB bandwidth for the left's fps
            elif right_cap is None and time.monotonic() >= right_open_after:
                right_cap = open_capture(self._right_device, self._width, self._height, self._log)
                if right_cap is None:
                    right_open_after = time.monotonic() + RIGHT_OPEN_RETRY_S
            try:
                if need_right and right_cap is not None:
                    pair = stereo.read_stereo_pair(left_cap, right_cap)  # grab-grab synced
                    if pair is None:
                        self._log("right eye grab failed; reopening")
                        drop_right()
                        right_open_after = time.monotonic() + RIGHT_OPEN_RETRY_S
                        ok, left = left_cap.read()
                        if ok and left is not None:
                            self._store(left, None)
                    else:
                        self._store(pair[0], pair[1])
                else:
                    ok, left = left_cap.read()
                    if ok and left is not None:
                        self._store(left, None)
                    else:
                        left_cap.release()
                        left_cap = None
                        drop_right()
                        time.sleep(0.3)
            except Exception:  # noqa: BLE001 - a bad frame must not kill the reader
                time.sleep(0.1)
        if left_cap is not None:
            left_cap.release()
        drop_right()

    def pair(self, max_age=1.0):
        """Latest synced (left, right); right is None in mono / until it opens.
        (None, None) if the frame is stale (camera stalled) so the loop reopens."""
        with self._lock:
            if self._left is None or (time.monotonic() - self._ts) >= max_age:
                return None, None
            return self._left, self._right

    def release(self):
        self._running = False
        try:
            self._thread.join(timeout=1.5)
        except Exception:  # noqa: BLE001
            pass


def crop_view(frame, view):
    """For a side-by-side stereo frame, crop one sensor for a clean stream."""
    if view not in ("left", "right"):
        return frame
    w = frame.shape[1]
    half = w // 2
    return frame[:, :half] if view == "left" else frame[:, half:half * 2]


class PerceptionNode(Node):
    def __init__(self):
        super().__init__("perception_node")
        self._running = True

        self._server_url = (_env("SERVER_URL") or "").rstrip("/")
        secret = _env("INTERNAL_SECRET", "")
        self._internal_secret = secret  # also sent as X-Internal-Service on WHIP publish
        allow_http = (_env("SERVER_URL_ALLOW_HTTP", "false") or "").lower() == "true"

        self._device = _env("CAMERA_DEVICE")  # left / SBS device; None → auto-probe
        self._width = _env_int("CAMERA_WIDTH", 1280)
        self._height = _env_int("CAMERA_HEIGHT", 480)
        # Default above the ~13 fps the 720p cam actually delivers, so the camera
        # (not this cap) is the limiter; lower via env on a constrained uplink.
        self._fps = max(1, _env_int("CAMERA_FPS", 15))
        self._quality = min(100, max(1, _env_int("CAMERA_JPEG_QUALITY", 70)))
        self._view = (_env("CAMERA_VIEW", "left") or "left").lower()
        # Obstacle-detection rate. Since detection + the live depth composite share
        # ONE stereo pass at the 512x288 compute scale, the SGBM cost is paid once
        # per frame, leaving headroom above the old default of 4. Still bounded by
        # the ~13 fps camera ceiling and single-thread SGBM while NAVIGATING.
        self._detect_fps = max(1, _env_int("DETECT_FPS", 8))
        # OpenCV threads for stereo while the mission is NOT NAVIGATING (paused/idle
        # — when the operator usually watches the composite). While NAVIGATING it
        # drops to STEREO_CV_THREADS so block matching can't starve the navigator's
        # control tick.
        self._viz_threads_idle = max(1, _env_int("VIZ_THREADS_IDLE", 3))
        # Depth-compute resolution as a fraction of calib — the SINGLE stereo pass
        # (detection + composite share it) runs here. Mirrors stereo's default.
        self._viz_depth_scale = _env_float("VIZ_DEPTH_SCALE", 0.4)
        self._detect_master = (_env("OBSTACLE_DETECTION", "true") or "").lower() != "false"
        # Stereo layout. "dual": the two eyes are SEPARATE /dev/video nodes
        # (the rover's "Stereo Vision" cam — left=video0, right=video2); the
        # stream uses the left eye whole (no crop). "sbs": one side-by-side
        # frame split in half, and CAMERA_VIEW crops one eye for the stream.
        self._layout = (_env("STEREO_LAYOUT", "dual") or "dual").lower()
        self._right_device = _env("STEREO_RIGHT_DEVICE", "/dev/video2")
        # In dual layout pin the left eye to video0 so auto-probe can't pick the
        # right eye as "left" (which would feed the detector two right frames).
        if self._device is None and self._layout == "dual":
            self._device = "/dev/video0"

        # UI-triggered calibration. cols/rows = INNER corners (must match the
        # printed board: 9×6). square_m comes from the operator (the calibrate
        # command). A request from the SSE thread just sets a flag the capture
        # loop picks up — the collection runs there, never on the SSE thread.
        self._calib_cols = _env_int("STEREO_CALIB_COLS", 9)
        self._calib_rows = _env_int("STEREO_CALIB_ROWS", 6)
        self._calib_count = max(6, _env_int("STEREO_CALIB_COUNT", 20))
        self._calib_min_shift = _env_int("STEREO_CALIB_MIN_SHIFT_PX", 25)
        # Max mean-corner move (px) between CONSECUTIVE detected frames for a
        # pair to count as "board held still". The two eyes capture a few ms
        # apart, so a pair grabbed mid-motion desyncs; only grabbing while settled
        # makes that gap irrelevant. Distinct from min_shift (spacing between
        # accepted grabs). Dual layout only. Default is deliberately loose so a
        # handheld board still collects a full set within the timeout; tighten
        # via env for a tripod-mounted board.
        self._calib_max_motion = _env_float("STEREO_CALIB_MAX_MOTION_PX", 3.0)
        self._calib_timeout_s = _env_int("STEREO_CALIB_TIMEOUT_S", 180)
        self._calib_lock = threading.Lock()
        self._calib_request = None  # square_m (m) when a stereo calibration is pending
        self._ground_calib_request = None  # frame count when a ground calibration is pending

        # Cap OpenCV's thread pool so block matching / encode can't fan out
        # across every core and stall the navigator's control tick on the
        # shared Pi. (StereoDepth also sets this; doing it here covers the
        # encode path when no calibration is loaded.)
        cfg = stereo.config_from_env()
        self._calib_path = cfg.calib_path
        # The detection thread cap (STEREO_CV_THREADS). Honoured whenever the
        # composite is NOT rendering; the composite may raise it to
        # VIZ_THREADS_IDLE, but only while paused/idle (never during NAVIGATING).
        self._cv_threads = max(1, int(cfg.cv_threads))
        try:
            cv2.setNumThreads(self._cv_threads)
        except Exception:  # noqa: BLE001 - non-fatal tuning call
            pass

        self._detector = stereo.StereoDepth(cfg)
        self._debouncer = stereo.EdgeDebouncer(
            on_frames=_env_int("OBSTACLE_ON_FRAMES", 3),
            off_frames=_env_int("OBSTACLE_OFF_FRAMES", 5),
        )
        if self._detector.enabled:
            mode = self._detector.detect_mode
            if mode == "aboveground":
                detail = (f"aboveground (ground profile {self._detector._ground_path}, "
                          f"min obstacle {cfg.min_obstacle_w_m}x{cfg.min_obstacle_h_m} m, "
                          f"range <= {cfg.max_detect_range_m} m)")
            else:
                detail = f"band {cfg.near_m}-{cfg.far_m} m, min_fill {cfg.min_fill}"
            self.get_logger().info(
                f"obstacle detection ENABLED (layout={self._layout}, calib "
                f"{cfg.calib_path}, ROI {cfg.roi}, mode={mode}: {detail})")
        else:
            self.get_logger().warn(
                "obstacle detection DISABLED — no usable stereo calibration at "
                f"{cfg.calib_path}. Run stereo_calibrate.py. Streaming still works.")

        self._cloud = CloudLink(self._server_url, secret, allow_http,
                                log=self.get_logger().info)
        self._cloud.on_calibrate = self._request_calibration
        self._cloud.on_calibrate_ground = self._request_ground_calibration
        self._cloud.start()

        # Low-latency WebRTC publish (Phase 2b). While an operator is watching
        # (same stream_wanted gate as MJPEG) the streamed frame is ALSO H.264
        # WHIP-published to mediamtx at {SERVER_URL}/api/rtc/rover-2d/whip. MJPEG
        # stays as the fallback. Disabled if aiortc is unavailable.
        self._webrtc_enabled = _WEBRTC_AVAILABLE and bool(self._server_url) and \
            (_env("WEBRTC_PUBLISH", "true") or "").lower() != "false"
        # Two independent WebRTC streams, each encoded only while its viewer is
        # present: rover-2d = mono / depth-composite (2D panel); rover-vr = rectified
        # left|right side-by-side stereo (the VR view splits it per eye).
        self._whip_url_2d = f"{self._server_url}/api/rtc/rover-2d/whip"
        self._whip_url_vr = f"{self._server_url}/api/rtc/rover-vr/whip"
        self._webrtc_pub_2d = None
        self._webrtc_pub_vr = None
        self._webrtc_next_2d = 0.0   # cooldowns so a failing WHIP can't retry every frame
        self._webrtc_next_vr = 0.0
        if self._webrtc_enabled:
            self.get_logger().info(
                f"WebRTC publish ENABLED → 2d {self._whip_url_2d} / vr {self._whip_url_vr}")
        elif not _WEBRTC_AVAILABLE:
            self.get_logger().warn("WebRTC publish disabled (aiortc unavailable) — MJPEG only")

        reliable = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self._pub_obstacle = self.create_publisher(
            Bool, "/rover/perception/obstacle", reliable)
        # Latched, matching navigator's TRANSIENT_LOCAL nav/state publisher: if
        # this node (re)starts mid-mission (camera udev replug, auto-update), it
        # must get the CURRENT nav state at once — otherwise detection would stay
        # off until the next state transition.
        state_qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                               durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.create_subscription(String, "/rover/nav/state", self._on_nav_state, state_qos)

        self._nav_state = ""
        self._detect_active = False
        self._published_obstacle = False

        self._worker = threading.Thread(target=self._capture_loop, daemon=True)
        self._worker.start()
        self.get_logger().info("Perception node started")

    def _on_nav_state(self, msg):
        self._nav_state = msg.data

    def _detection_wanted(self):
        return (self._detect_master and self._detector.enabled
                and self._nav_state == DRIVING_STATE)

    def _publish_obstacle(self, present):
        msg = Bool()
        msg.data = bool(present)
        self._pub_obstacle.publish(msg)

    def _set_detect_active(self, active):
        """Track the detect-active edge; clear the signal when detection stops.

        When detection deactivates (mission left NAVIGATING — e.g. we just
        auto-paused), drop the debounce run and assert 'no obstacle' so a stale
        True can't linger on the topic into the next driving stretch.
        """
        if active == self._detect_active:
            return
        self._detect_active = active
        if not active:
            self._debouncer.reset()
            if self._published_obstacle:
                self._publish_obstacle(False)
                self._published_obstacle = False

    def _run_detection(self, depth_z, valid, conf):
        # Decide from a PRECOMPUTED depth map (the pass shared with the composite),
        # so stereo is never run twice for a frame. conf is the WLS confidence map
        # (or None) — decide() gates on it so guessed depth can't auto-pause.
        obstacle, info = self._detector.decide(depth_z, valid, conf)
        state, _rising = self._debouncer.update(obstacle)
        if state != self._published_obstacle:
            self._publish_obstacle(state)
            self._published_obstacle = state
            if state:
                self.get_logger().warn(f"OBSTACLE in driving corridor: {info}")
                self._cloud.post_obstacle({"reason": "stereo", **info})
            else:
                self.get_logger().info("obstacle cleared")
        # TEMP driving diagnostic: throttled per-frame detector state to the journal,
        # so a real mission's misses / false positives can be triaged frame-by-frame
        # (`journalctl -u perception.service | grep 'detect diag'`). Remove once tuned.
        now = time.monotonic()
        if now - getattr(self, "_last_diag_log", 0.0) >= 0.5:
            self._last_diag_log = now
            self.get_logger().info(f"detect diag: obstacle={obstacle} {info}")

    def _stereo_eyes(self, left_frame, right_frame):
        """Return (left, right) eye frames for the detector, or None if unavailable.

        dual: right_frame is the already-read second-device frame (None if its
        read failed / device not open); sbs: split the one frame in half.
        """
        if self._layout == "dual":
            return None if right_frame is None else (left_frame, right_frame)
        return stereo.split_sbs(left_frame)

    # ── UI-triggered calibration ────────────────────────────────────────────
    def _request_calibration(self, square_m):
        """Flag a calibration (called from the SSE thread). The capture loop
        runs it — never block the SSE thread on the ~minute-long collection."""
        with self._calib_lock:
            self._calib_request = float(square_m)
        self.get_logger().info(f"stereo calibration requested (square={square_m} m)")

    def _take_calib_request(self):
        with self._calib_lock:
            sq, self._calib_request = self._calib_request, None
            return sq

    def _request_ground_calibration(self, frames):
        """Flag a ground calibration (called from the SSE thread). The capture loop
        runs it — never block the SSE thread on the multi-second capture."""
        with self._calib_lock:
            self._ground_calib_request = int(frames)
        self.get_logger().info(f"ground calibration requested (frames={frames})")

    def _take_ground_calib_request(self):
        with self._calib_lock:
            n, self._ground_calib_request = self._ground_calib_request, None
            return n

    def _progress(self, payload):
        self._cloud.post_calibration_progress(payload)

    def _run_calibration(self, square_m):
        """Collect checkerboard pairs from both eyes, compute + save the
        calibration, and reload the detector. Runs in the capture thread (the
        loop has already released its own camera handles). Streams the left eye
        throughout so the operator can aim the board, and reports progress."""
        cols, rows = self._calib_cols, self._calib_rows
        pattern = (cols, rows)
        target = self._calib_count
        self.get_logger().info(
            f"calibration START ({cols}×{rows} inner corners, {square_m} m, "
            f"target {target} pairs)")
        self._progress({"phase": "start", "captured": 0, "target": target})

        left_cap = open_capture(self._device, self._width, self._height,
                                self.get_logger().warn)
        right_cap = None
        if self._layout == "dual":
            right_cap = open_capture(self._right_device, self._width,
                                     self._height, self.get_logger().warn)
        if left_cap is None or (self._layout == "dual" and right_cap is None):
            if left_cap is not None:
                left_cap.release()
            if right_cap is not None:
                right_cap.release()
            self._progress({"phase": "done", "ok": False, "error": "camera open failed"})
            return

        objp = stereo.board_object_points(cols, rows, square_m)
        objpoints, imgL, imgR = [], [], []
        last_mean = None    # last ACCEPTED grab (drives the coverage gate)
        prev_mean = None    # last detected frame (drives the stationarity gate)
        eye_size = None
        start = time.monotonic()
        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), self._quality]
        try:
            while len(objpoints) < target and self._running:
                if time.monotonic() - start > self._calib_timeout_s:
                    break
                if self._layout == "dual":
                    pair = stereo.read_stereo_pair(left_cap, right_cap)
                    if pair is None:
                        time.sleep(0.05)
                        continue
                    left, right = pair
                    frame = left  # the left eye is what we preview/stream
                else:
                    ok, frame = left_cap.read()
                    if not ok or frame is None:
                        time.sleep(0.05)
                        continue
                    left, right = stereo.split_sbs(frame)
                if eye_size is None:
                    eye_size = (left.shape[1], left.shape[0])
                # Stream the left eye so the operator can see what they're aiming.
                if self._cloud.stream_wanted.is_set():
                    shown = frame if self._layout == "dual" else crop_view(frame, self._view)
                    ok2, buf = cv2.imencode(".jpg", shown, encode_params)
                    if ok2:
                        self._cloud.post_frame(buf.tobytes())
                cl = stereo.find_chessboard(cv2.cvtColor(left, cv2.COLOR_BGR2GRAY), pattern)
                if cl is None:
                    continue
                cr = stereo.find_chessboard(cv2.cvtColor(right, cv2.COLOR_BGR2GRAY), pattern)
                if cr is None:
                    continue
                mean = cl.reshape(-1, 2).mean(axis=0)
                # Stationarity gate (dual layout only): only grab while the board
                # is momentarily still. The two eyes capture a few ms apart, so a
                # pair grabbed mid-motion lands the board at different places in L
                # vs R and poisons the stereo solve; letting it settle makes that
                # inter-eye gap irrelevant. SBS eyes share one hardware-synced
                # frame, so there is nothing to gate. Motion is measured against
                # the PREVIOUS detected frame (prev_mean, updated every detected
                # frame), separate from last_mean (the last ACCEPTED grab).
                if self._layout == "dual":
                    motion = (float(np.linalg.norm(mean - prev_mean))
                              if prev_mean is not None else float("inf"))
                    prev_mean = mean
                    if motion > self._calib_max_motion:
                        continue  # board still moving — let it settle before grabbing
                if last_mean is not None and float(np.linalg.norm(mean - last_mean)) < self._calib_min_shift:
                    continue  # too similar to the last accepted grab — keep sweeping
                last_mean = mean
                objpoints.append(objp.copy())
                imgL.append(cl)
                imgR.append(cr)
                self._progress({"phase": "collecting", "captured": len(objpoints),
                                "target": target})
        finally:
            left_cap.release()
            if right_cap is not None:
                right_cap.release()

        if len(objpoints) < 6:
            self._progress({"phase": "done", "ok": False,
                            "error": f"only {len(objpoints)} board pairs (need ≥ 6)"})
            self.get_logger().warn(f"calibration FAILED: {len(objpoints)} pairs")
            return
        try:
            result = stereo.compute_stereo_calibration(objpoints, imgL, imgR, eye_size)
            stereo.save_calibration(self._calib_path, result, square_m)
        except Exception as e:  # noqa: BLE001 - report failure to the operator
            self._progress({"phase": "done", "ok": False, "error": f"compute/save failed: {e}"})
            self.get_logger().error(f"calibration compute/save failed: {e}")
            return
        # Reload the detector so detection activates without a restart.
        self._detector = stereo.StereoDepth(stereo.config_from_env())
        rms = round(result["stereo_rms"], 3)
        rms_l = round(result["rms_l"], 3)
        rms_r = round(result["rms_r"], 3)
        baseline_mm = round(result["baseline_m"] * 1000, 1)
        pairs_used = result.get("pairs_used", len(objpoints))
        # per-eye RMS is reported alongside the stereo RMS so a poor calibration
        # can be diagnosed from the record: high per-eye → intrinsic/distortion;
        # low per-eye but high stereo → eye-sync / extrinsic. pairs_used < pairs
        # means desync outliers were culled before the final solve.
        self._progress({"phase": "done", "ok": True, "rms": rms,
                        "rms_l": rms_l, "rms_r": rms_r,
                        "baseline_mm": baseline_mm, "pairs": len(objpoints),
                        "pairs_used": pairs_used})
        self.get_logger().info(
            f"calibration DONE: {pairs_used}/{len(objpoints)} pairs used, "
            f"RMS {rms} px (L {rms_l} / R {rms_r}), baseline {baseline_mm} mm")

    def _run_ground_calibration(self, frames):
        """Capture flat EMPTY ground and fit the per-row ground-depth curve for
        above-ground detection, then reload the detector so it switches to
        aboveground WITHOUT a restart. Runs in the capture thread (handles
        released). Streams the left eye so the operator can confirm clean flat
        ground, and reports progress/result to the UI. Requires a stereo
        calibration (metric depth) — reports a clear error otherwise."""
        if not self._detector.enabled:
            self._progress({"kind": "ground", "phase": "done", "ok": False,
                            "error": "stereo calibration required first"})
            self.get_logger().warn("ground calibration skipped: no stereo calibration")
            return
        cfg = self._detector.cfg
        frames = max(10, min(120, int(frames)))
        nbins = max(8, _env_int("GROUND_BINS", 40))
        x0, _y0, x1, _y1 = cfg.roi
        scale = cfg.viz_depth_scale
        self.get_logger().info(f"ground calibration START ({frames} frames, {nbins} bins)")
        self._progress({"kind": "ground", "phase": "start", "captured": 0, "target": frames})

        left_cap = open_capture(self._device, self._width, self._height, self.get_logger().warn)
        right_cap = None
        if self._layout == "dual":
            right_cap = open_capture(self._right_device, self._width, self._height, self.get_logger().warn)
        if left_cap is None or (self._layout == "dual" and right_cap is None):
            if left_cap is not None:
                left_cap.release()
            if right_cap is not None:
                right_cap.release()
            self._progress({"kind": "ground", "phase": "done", "ok": False, "error": "camera open failed"})
            return

        bin_acc = [[] for _ in range(nbins)]
        got = 0
        start = time.monotonic()
        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), self._quality]
        try:
            for _ in range(6):   # warm up auto-exposure
                if self._layout == "dual":
                    stereo.read_stereo_pair(left_cap, right_cap)
                else:
                    left_cap.read()
            while got < frames and self._running:
                if time.monotonic() - start > 60.0:
                    break
                if self._layout == "dual":
                    pair = stereo.read_stereo_pair(left_cap, right_cap)
                    if pair is None:
                        time.sleep(0.03); continue
                    left, right = pair
                    frame = left
                else:
                    ok, frame = left_cap.read()
                    if not ok or frame is None:
                        time.sleep(0.03); continue
                    left, right = stereo.split_sbs(frame)
                # Stream the left eye so the operator sees they're aiming at clean
                # flat ground (an obstacle in view would corrupt the ground curve).
                if self._cloud.stream_wanted.is_set():
                    shown = frame if self._layout == "dual" else crop_view(frame, self._view)
                    ok2, buf = cv2.imencode(".jpg", shown, encode_params)
                    if ok2:
                        self._cloud.post_frame(buf.tobytes())
                depth = self._detector.compute_depth(left, right, scale=scale)
                if depth is None:
                    continue
                dz, valid, conf = depth
                if conf is not None:
                    valid = valid & (conf >= cfg.conf_min)
                _rf, dm = stereo.ground_row_medians(dz, valid, x0, x1, nbins)
                for b in range(nbins):
                    if np.isfinite(dm[b]):
                        bin_acc[b].append(float(dm[b]))
                got += 1
                self._progress({"kind": "ground", "phase": "collecting",
                                "captured": got, "target": frames})
        finally:
            left_cap.release()
            if right_cap is not None:
                right_cap.release()

        if got == 0:
            self._progress({"kind": "ground", "phase": "done", "ok": False, "error": "no usable frames"})
            return
        row_fracs = [(b + 0.5) / nbins for b in range(nbins)]
        depths = [float(np.median(bin_acc[b])) if bin_acc[b] else float("nan") for b in range(nbins)]
        rf, dm = stereo.fit_ground_profile(row_fracs, depths)
        if rf.size < 2:
            self._progress({"kind": "ground", "phase": "done", "ok": False,
                            "error": "too few valid rows — aim at textured flat ground with light"})
            self.get_logger().warn("ground calibration FAILED: too few valid rows")
            return
        gpath = cfg.ground_profile_path or stereo.default_ground_path(cfg.calib_path)
        try:
            stereo.save_ground_profile(gpath, rf, dm)
        except Exception as e:  # noqa: BLE001 - report failure to the operator
            self._progress({"kind": "ground", "phase": "done", "ok": False, "error": f"save failed: {e}"})
            self.get_logger().error(f"ground calibration save failed: {e}")
            return
        # Reload the detector so it loads the new curve and switches to aboveground.
        self._detector = stereo.StereoDepth(stereo.config_from_env())
        near = round(float(np.nanmin(dm)), 2)
        far = round(float(np.nanmax(dm)), 2)
        self._progress({"kind": "ground", "phase": "done", "ok": True,
                        "near_m": near, "far_m": far, "rows": int(rf.size),
                        "mode": self._detector.detect_mode})
        self.get_logger().info(
            f"ground calibration DONE: {rf.size} rows from {got} frames, "
            f"near {near} m far {far} m, mode={self._detector.detect_mode}")

    def _capture_loop(self):
        reader = None        # StereoReader: grab-synced left+right (mono if no right)
        idle_deadline = None
        last_detect = 0.0
        last_err_log = 0.0   # throttle the per-iteration exception log
        stream_interval = 1.0 / self._fps
        detect_interval = 1.0 / self._detect_fps
        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), self._quality]

        while self._running:
            # A pending calibration takes over: free this loop's camera handles
            # so the calibration can open both eyes exclusively, run it (it
            # streams + reports progress itself), then resume the normal loop.
            calib_square_m = self._take_calib_request()
            if calib_square_m is not None:
                if reader is not None:
                    reader.release()
                    reader = None
                idle_deadline = None
                self._set_detect_active(False)
                # The collection loop touches OpenCV per frame; an unexpected
                # error there must not propagate out of this daemon thread (that
                # kills BOTH streaming and detection while rclpy keeps the process
                # 'active'). Catch, report to the operator, and resume.
                try:
                    self._run_calibration(calib_square_m)
                except Exception as e:  # noqa: BLE001 - keep the capture thread alive
                    self.get_logger().error(f"calibration crashed: {e}")
                    self._progress({"phase": "done", "ok": False,
                                    "error": f"calibration crashed: {e}"})
                continue

            # A pending GROUND calibration likewise takes over the loop.
            ground_frames = self._take_ground_calib_request()
            if ground_frames is not None:
                if reader is not None:
                    reader.release()
                    reader = None
                idle_deadline = None
                self._set_detect_active(False)
                try:
                    self._run_ground_calibration(ground_frames)
                except Exception as e:  # noqa: BLE001 - keep the capture thread alive
                    self.get_logger().error(f"ground calibration crashed: {e}")
                    self._progress({"kind": "ground", "phase": "done", "ok": False,
                                    "error": f"crashed: {e}"})
                continue

            stream = self._cloud.stream_wanted.is_set()
            detect = self._detection_wanted()
            self._set_detect_active(detect)

            # Each WebRTC publisher runs only while streaming AND its viewer wants
            # it; torn down otherwise so an unwatched stream costs no H.264.
            if (not (stream and self._cloud.webrtc_2d_wanted.is_set())
                    and self._webrtc_pub_2d is not None):
                self._webrtc_pub_2d.stop()
                self._webrtc_pub_2d = None
            if (not (stream and self._cloud.webrtc_vr_wanted.is_set())
                    and self._webrtc_pub_vr is not None):
                self._webrtc_pub_vr.stop()
                self._webrtc_pub_vr = None

            if not (stream or detect):
                # Release devices after a short linger (avoid UVC thrash).
                now = time.monotonic()
                if reader is not None:
                    if idle_deadline is None:
                        idle_deadline = now + STOP_LINGER_S
                    elif now >= idle_deadline:
                        reader.release()
                        reader = None
                        idle_deadline = None
                time.sleep(0.2)
                continue
            idle_deadline = None

            if reader is None:
                reader = StereoReader(self._device, self._right_device,
                                      self._width, self._height,
                                      self.get_logger().warn, dual=(self._layout == "dual"))

            # Keep the right eye (grab-synced pair) only when depth/stereo needs it;
            # a plain 2D MJPEG viewer reads the left alone at full frame rate.
            want_pair = detect or (stream and self._detector.enabled
                                   and self._layout == "dual"
                                   and (self._cloud.webrtc_vr_wanted.is_set()
                                        or self._cloud.depth_wanted.is_set()))
            reader.set_want_pair(want_pair)

            t0 = time.monotonic()
            frame, right_frame = reader.pair()
            if frame is None:
                time.sleep(0.05)  # reader warming up, or camera stalled → reopen
                continue

            # Everything below works on a frame and may touch OpenCV (encode,
            # remap, block matching, reproject). Guard it: a single bad frame /
            # transient cv2 error must be logged-and-skipped, never propagate out
            # of the daemon thread — that would silently kill BOTH streaming and
            # detection while rclpy.spin keeps the process 'active' (so systemd
            # never restarts it).
            try:
                due = detect and (t0 - last_detect) >= detect_interval
                # Live depth composite is wanted when an operator toggled it on, a
                # calibration is loaded, and we have two eyes (dual). It stays on
                # during NAVIGATING too: detection and the composite SHARE one depth
                # pass (below), so the composite adds only a cheap overlay, not a
                # second SGBM — it can't starve the detector. It needs the right eye
                # during plain streaming too, every streamed frame.
                depth_stream = (stream and self._cloud.depth_wanted.is_set()
                                and self._detector.enabled and self._layout == "dual")
                # WebRTC gating: 2D (mono/composite → rover-2d) and VR (stereo SBS →
                # rover-vr) are independent; VR needs both eyes + a calibration.
                webrtc_2d = (stream and self._webrtc_enabled
                             and self._cloud.webrtc_2d_wanted.is_set())
                webrtc_vr = (stream and self._webrtc_enabled
                             and self._cloud.webrtc_vr_wanted.is_set()
                             and self._detector.enabled and self._layout == "dual")
                # Thread budget: drop to the detection cap (STEREO_CV_THREADS) while
                # NAVIGATING so stereo can't starve the navigator's control tick;
                # allow more cores when paused/idle (when the operator usually
                # watches). Set every iteration so it can't stay stuck high.
                cv2.setNumThreads(self._cv_threads if self._nav_state == DRIVING_STATE
                                  else self._viz_threads_idle)
                # right_frame is the grab-synced right eye from reader.pair() above
                # (None in mono / until the right eye opens).

                # ONE stereo depth pass at the configured scale, reused by BOTH the
                # composite and detection so SGBM never runs twice for a frame. Only
                # when something needs it and we have the eye pair.
                depth = None
                eyes = self._stereo_eyes(frame, right_frame)
                if eyes is not None and (due or depth_stream):
                    depth = self._detector.compute_depth(
                        eyes[0], eyes[1], scale=self._viz_depth_scale)

                if stream:
                    # MJPEG only while an MJPEG viewer is attached (a WebRTC-only VR
                    # session sends mjpeg-off → skip the JPEG encode+POST entirely).
                    mjpeg = self._cloud.mjpeg_wanted.is_set()
                    # 'out' = mono left / depth composite — needed by MJPEG AND the
                    # 2D WebRTC stream (rover-2d). Computed once, shared by both.
                    out = None
                    if mjpeg or webrtc_2d:
                        # Depth composite (sharp rectified left + heatmap + nearest
                        # marker/distance) when toggled on + calibrated + we have depth;
                        # otherwise the plain eye (left whole in dual, cropped in sbs).
                        if depth_stream and depth is not None:
                            out, _cinfo = self._detector.render_composite(frame, depth[0], depth[1], depth[2])
                            if out is None:                 # calibration vanished mid-stream
                                out = frame
                        else:
                            out = frame if self._layout == "dual" else crop_view(frame, self._view)
                            # Operator asked for depth but we can't render it here — no
                            # stereo calibration or not a dual-eye cam. Label the frame so
                            # "depth on but a plain image" reads as "needs calibration".
                            # Copy first: 'out' aliases the capture buffer. ASCII only.
                            if (self._cloud.depth_wanted.is_set()
                                    and not (self._detector.enabled and self._layout == "dual")):
                                out = out.copy()
                                for color, thick in (((0, 0, 0), 4), ((60, 220, 255), 1)):
                                    cv2.putText(out, "DEPTH unavailable - no stereo calibration",
                                                (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                                                color, thick, cv2.LINE_AA)
                    if mjpeg and out is not None:
                        ok2, buf = cv2.imencode(".jpg", out, encode_params)
                        # Re-check stream_wanted: a camera-stop may have arrived during
                        # read/encode, and we shouldn't push a frame nobody's watching.
                        if ok2 and self._cloud.stream_wanted.is_set():
                            self._cloud.post_frame(buf.tobytes())

                    # 2D WebRTC (mono / depth composite) → rover-2d. Lazy (re)start
                    # with a cooldown so a failing WHIP can't retry every frame.
                    if webrtc_2d and out is not None:
                        now = time.monotonic()
                        if ((self._webrtc_pub_2d is None or not self._webrtc_pub_2d.alive())
                                and now >= self._webrtc_next_2d):
                            if self._webrtc_pub_2d is not None:
                                self._webrtc_pub_2d.stop()
                            self._webrtc_next_2d = now + 5.0
                            self._webrtc_pub_2d = WebRTCPublisher(
                                self._whip_url_2d, self._fps, self.get_logger().info,
                                self._internal_secret)
                            self._webrtc_pub_2d.start()
                        if self._webrtc_pub_2d is not None:
                            self._webrtc_pub_2d.push_frame(out)

                    # VR WebRTC (rectified left|right SBS, split per eye) → rover-vr.
                    if webrtc_vr:
                        now = time.monotonic()
                        if ((self._webrtc_pub_vr is None or not self._webrtc_pub_vr.alive())
                                and now >= self._webrtc_next_vr):
                            if self._webrtc_pub_vr is not None:
                                self._webrtc_pub_vr.stop()
                            self._webrtc_next_vr = now + 5.0
                            self._webrtc_pub_vr = WebRTCPublisher(
                                self._whip_url_vr, self._fps, self.get_logger().info,
                                self._internal_secret)
                            self._webrtc_pub_vr.start()
                        if self._webrtc_pub_vr is not None and right_frame is not None:
                            sbs = self._detector.rectify_sbs(frame, right_frame)
                            if sbs is not None:
                                self._webrtc_pub_vr.push_frame(sbs)
                            # else: no calib/frame → skip (keeps last), no size flip

                if due and depth is not None:
                    last_detect = t0
                    self._run_detection(depth[0], depth[1], depth[2])
            except Exception as e:  # noqa: BLE001 - keep the capture thread alive
                if (t0 - last_err_log) >= 5.0:
                    last_err_log = t0
                    self.get_logger().warn(f"capture iteration error (skipped frame): {e}")

            # Capture at the stream rate when watched, else the (slower) detect
            # rate — no point grabbing faster than the only active consumer.
            target = stream_interval if stream else detect_interval
            dt = time.monotonic() - t0
            if dt < target:
                time.sleep(target - dt)

        if reader is not None:
            reader.release()
        for pub_attr in ("_webrtc_pub_2d", "_webrtc_pub_vr"):
            pub = getattr(self, pub_attr)
            if pub is not None:
                pub.stop()
                setattr(self, pub_attr, None)

    def destroy_node(self):
        self._running = False
        self._cloud.stop()
        worker = getattr(self, "_worker", None)
        if worker is not None:
            worker.join(timeout=3.0)
        super().destroy_node()


def main(args=None):
    server_url = (_env("SERVER_URL") or "").rstrip("/")
    allow_http = (_env("SERVER_URL_ALLOW_HTTP", "false") or "").lower() == "true"
    if not server_url:
        print("[perception] FATAL: SERVER_URL not set", flush=True)
        sys.exit(1)
    if not server_url.startswith("https://") and not allow_http:
        print(f"[perception] FATAL: SERVER_URL must be https:// (got {server_url!r}); "
              "set SERVER_URL_ALLOW_HTTP=true to override on a trusted network",
              flush=True)
        sys.exit(1)
    if not _env("INTERNAL_SECRET", ""):
        # Exit non-zero rather than retry forever: the server denies every
        # request without the secret, so a silent loop would show the unit
        # 'active' while nothing works. Restart=on-failure surfaces it.
        print("[perception] FATAL: INTERNAL_SECRET not set", flush=True)
        sys.exit(1)

    rclpy.init(args=args)
    node = PerceptionNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
