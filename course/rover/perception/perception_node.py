#!/usr/bin/env python3
"""FSK rover perception node (Phase 3).

Single owner of the USB stereo webcam. One capture loop serves two independent
concerns off the same device (a UVC node allows only one opener, so they must
share one loop):

  - Streaming (operator-driven): while the server reports an operator is
    watching (CloudLink.stream_wanted), crop one eye, JPEG-encode, POST to the
    MJPEG relay. Unchanged from Phase 2.
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
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from std_msgs.msg import Bool, String

from cloud_link import CloudLink
import stereo


def _env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def _env_int(name, default):
    try:
        return int(_env(name, default))
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
        allow_http = (_env("SERVER_URL_ALLOW_HTTP", "false") or "").lower() == "true"

        self._device = _env("CAMERA_DEVICE")  # left / SBS device; None → auto-probe
        self._width = _env_int("CAMERA_WIDTH", 1280)
        self._height = _env_int("CAMERA_HEIGHT", 480)
        self._fps = max(1, _env_int("CAMERA_FPS", 8))
        self._quality = min(100, max(1, _env_int("CAMERA_JPEG_QUALITY", 70)))
        self._view = (_env("CAMERA_VIEW", "left") or "left").lower()
        self._detect_fps = max(1, _env_int("DETECT_FPS", 4))
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

        # Cap OpenCV's thread pool so block matching / encode can't fan out
        # across every core and stall the navigator's control tick on the
        # shared Pi. (StereoDepth also sets this; doing it here covers the
        # encode path when no calibration is loaded.)
        cfg = stereo.config_from_env()
        try:
            cv2.setNumThreads(max(1, int(cfg.cv_threads)))
        except Exception:  # noqa: BLE001 - non-fatal tuning call
            pass

        self._detector = stereo.StereoDepth(cfg)
        self._debouncer = stereo.EdgeDebouncer(
            on_frames=_env_int("OBSTACLE_ON_FRAMES", 3),
            off_frames=_env_int("OBSTACLE_OFF_FRAMES", 5),
        )
        if self._detector.enabled:
            self.get_logger().info(
                f"obstacle detection ENABLED (layout={self._layout}, calib "
                f"{cfg.calib_path}, ROI {cfg.roi}, band {cfg.near_m}-{cfg.far_m} m)")
        else:
            self.get_logger().warn(
                "obstacle detection DISABLED — no usable stereo calibration at "
                f"{cfg.calib_path}. Run stereo_calibrate.py. Streaming still works.")

        self._cloud = CloudLink(self._server_url, secret, allow_http,
                                log=self.get_logger().info)
        self._cloud.start()

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

    def _run_detection(self, left, right):
        obstacle, info = self._detector.detect(left, right)
        state, _rising = self._debouncer.update(obstacle)
        if state != self._published_obstacle:
            self._publish_obstacle(state)
            self._published_obstacle = state
            if state:
                self.get_logger().warn(f"OBSTACLE in driving corridor: {info}")
                self._cloud.post_obstacle({"reason": "stereo", **info})
            else:
                self.get_logger().info("obstacle cleared")

    def _stereo_eyes(self, left_frame, right_frame):
        """Return (left, right) eye frames for the detector, or None if unavailable.

        dual: right_frame is the already-read second-device frame (None if its
        read failed / device not open); sbs: split the one frame in half.
        """
        if self._layout == "dual":
            return None if right_frame is None else (left_frame, right_frame)
        return stereo.split_sbs(left_frame)

    def _capture_loop(self):
        cap = None          # left eye (dual) or the single SBS device
        right_cap = None     # right eye, dual layout only; held only while detecting
        right_open_after = 0.0  # backoff gate for reopening a failed right eye
        idle_deadline = None
        last_detect = 0.0
        last_err_log = 0.0   # throttle the per-iteration exception log
        stream_interval = 1.0 / self._fps
        detect_interval = 1.0 / self._detect_fps
        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), self._quality]

        def release_right():
            nonlocal right_cap
            if right_cap is not None:
                right_cap.release()
                right_cap = None

        while self._running:
            stream = self._cloud.stream_wanted.is_set()
            detect = self._detection_wanted()
            self._set_detect_active(detect)

            if not (stream or detect):
                # Release devices after a short linger (avoid UVC thrash).
                now = time.monotonic()
                if cap is not None:
                    if idle_deadline is None:
                        idle_deadline = now + STOP_LINGER_S
                    elif now >= idle_deadline:
                        cap.release()
                        cap = None
                        release_right()
                        idle_deadline = None
                time.sleep(0.2)
                continue
            idle_deadline = None

            if cap is None:
                cap = open_capture(self._device, self._width, self._height,
                                   self.get_logger().warn)
                if cap is None:
                    time.sleep(1.0)  # camera may be unplugged; retry
                    continue

            t0 = time.monotonic()
            ok, frame = cap.read()
            if not ok or frame is None:
                self.get_logger().warn("frame grab failed; reopening device")
                cap.release()
                cap = None
                release_right()
                time.sleep(0.5)
                continue

            # Grab the right eye BACK-TO-BACK with the left (dual + due only), so
            # the two unsynchronised USB cams' frames are as close in time as
            # possible — before the stream encode/POST, which can take a while.
            # Only at the detect rate; the handle is opened lazily and kept open
            # until full idle (NOT released per NAVIGATING<->other transition),
            # so a flap while streaming can't thrash the UVC device.
            # Everything below works on a frame and may touch OpenCV (encode,
            # remap, block matching, reproject). Guard it: a single bad frame /
            # transient cv2 error must be logged-and-skipped, never propagate out
            # of the daemon thread — that would silently kill BOTH streaming and
            # detection while rclpy.spin keeps the process 'active' (so systemd
            # never restarts it).
            try:
                due = detect and (t0 - last_detect) >= detect_interval
                right_frame = None
                if due and self._layout == "dual":
                    if right_cap is None and t0 >= right_open_after:
                        right_cap = open_capture(self._right_device, self._width,
                                                 self._height, self.get_logger().warn)
                        if right_cap is None:
                            # Open failed (missing/flaky device) — back off so we
                            # don't spam open() + its log every detect cycle; the
                            # gate retries once the window elapses. Set ONLY on a
                            # real attempt, never on a gated-out cycle, or the
                            # window would keep sliding forward and never reopen.
                            right_open_after = t0 + RIGHT_OPEN_RETRY_S
                    if right_cap is not None:
                        okr, right_frame = right_cap.read()
                        if not okr or right_frame is None:
                            # A transient right-eye glitch must not silently kill
                            # detection — drop the handle and back off the reopen.
                            self.get_logger().warn("right eye grab failed; reopening")
                            release_right()
                            right_frame = None
                            right_open_after = t0 + RIGHT_OPEN_RETRY_S

                if stream:
                    # dual: stream the left eye whole. sbs: crop per CAMERA_VIEW.
                    out = frame if self._layout == "dual" else crop_view(frame, self._view)
                    ok2, buf = cv2.imencode(".jpg", out, encode_params)
                    # Re-check stream_wanted: a camera-stop may have arrived during
                    # read/encode, and we shouldn't push a frame nobody's watching.
                    if ok2 and self._cloud.stream_wanted.is_set():
                        self._cloud.post_frame(buf.tobytes())

                if due:
                    last_detect = t0
                    eyes = self._stereo_eyes(frame, right_frame)
                    if eyes is not None:
                        self._run_detection(eyes[0], eyes[1])
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

        if cap is not None:
            cap.release()
        release_right()

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
