#!/usr/bin/env python3
"""FSK Rover camera streamer (Phase 2).

Bridges the rover's USB stereo webcam to the course server's MJPEG relay,
Tailscale-free: this process connects OUT to the server, so nothing has to
reach INTO the rover.

Flow:
  1. Open the control SSE  GET {SERVER_URL}/api/rover/camera/control
     (internal-secret auth). The server emits `camera-start` when an operator
     opens the live view and `camera-stop` when the last viewer leaves.
  2. While started, grab frames from the camera, JPEG-encode them, and POST
     each to  {SERVER_URL}/api/rover/camera  (Content-Type: image/jpeg).
  3. While stopped, release the device so the camera/CPU idle.

Capture only-while-watched keeps the rover's uplink and CPU free during normal
autonomous missions; the operator pulls the stream only when manually driving
or clearing an obstacle.

This container is deliberately decoupled from the ROS `pilot` container: it
talks plain HTTP to the server, not ROS, so the lean pilot image is untouched.
Phase 3 will extend THIS container with OpenCV stereo depth + obstacle
detection (hence the heavier opencv base lives here, not in pilot).

Config (environment):
  SERVER_URL          course server base, e.g. https://fsk.luftaquila.io/course
  INTERNAL_SECRET     X-Internal-Service auth (podman secret)
  CAMERA_DEVICE       v4l2 device index or path (default: auto-probe /dev/video*)
  CAMERA_WIDTH        capture width  (default 1280)
  CAMERA_HEIGHT       capture height (default 480)
  CAMERA_FPS          max frames/s pushed to the server (default 8)
  CAMERA_JPEG_QUALITY 1-100 (default 70)
  CAMERA_VIEW         left | right | full — a side-by-side stereo frame shows a
                      doubled image as 'full'; 'left'/'right' crop one sensor
                      for a single clean operator view (default: left)
  SERVER_URL_ALLOW_HTTP  "true" to permit http:// (trusted internal only)
"""

import os
import sys
import threading
import time

import cv2
import requests


def _env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def _env_int(name, default):
    try:
        return int(_env(name, default))
    except (TypeError, ValueError):
        return default


SERVER_URL = (_env("SERVER_URL") or "").rstrip("/")
INTERNAL_SECRET = _env("INTERNAL_SECRET", "")
CAMERA_DEVICE = _env("CAMERA_DEVICE")  # None → auto-probe
CAMERA_WIDTH = _env_int("CAMERA_WIDTH", 1280)
CAMERA_HEIGHT = _env_int("CAMERA_HEIGHT", 480)
CAMERA_FPS = max(1, _env_int("CAMERA_FPS", 8))
CAMERA_JPEG_QUALITY = min(100, max(1, _env_int("CAMERA_JPEG_QUALITY", 70)))
# Default 'left': a 60 mm-baseline USB stereo cam exposes a single side-by-side
# UVC frame, so 'full' would show the operator a doubled image. 'left' crops one
# sensor for a clean single view; set 'full' for a genuinely single-sensor cam.
CAMERA_VIEW = (_env("CAMERA_VIEW", "left") or "left").lower()
ALLOW_HTTP = (_env("SERVER_URL_ALLOW_HTTP", "false") or "").lower() == "true"

SSE_RECONNECT_MAX_S = 30.0
# Keep short: a slow POST blocks the capture thread, so this also bounds how
# long the device stays held after a camera-stop.
POST_TIMEOUT_S = 2.0


def log(msg):
    print(f"[camera] {msg}", flush=True)


def headers():
    h = {}
    if INTERNAL_SECRET:
        h["X-Internal-Service"] = INTERNAL_SECRET
    return h


def open_capture():
    """Open the first working camera. Returns a cv2.VideoCapture or None."""
    candidates = []
    if CAMERA_DEVICE is not None:
        # Numeric index or device path.
        candidates.append(int(CAMERA_DEVICE) if CAMERA_DEVICE.isdigit() else CAMERA_DEVICE)
    else:
        # Auto-probe: /dev/video0..9 (USB UVC cams enumerate low).
        candidates = list(range(10))
    for dev in candidates:
        cap = cv2.VideoCapture(dev)
        if cap.isOpened():
            # Prefer the camera's hardware MJPG so we don't pay for a raw
            # YUYV → re-encode round trip on the Pi.
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_WIDTH)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)
            # isOpened() is not enough: a metadata/ISP node (or a busy device)
            # can open but never deliver frames. Require a real grab so the
            # auto-probe falls through to the actual capture node instead of
            # live-locking on a dead /dev/video0.
            ok, frame = cap.read()
            if ok and frame is not None:
                log(f"opened camera {dev!r} ({CAMERA_WIDTH}x{CAMERA_HEIGHT})")
                return cap
            log(f"device {dev!r} opened but yields no frames; skipping")
        cap.release()
    log("no usable camera device found")
    return None


def crop_view(frame):
    """For a side-by-side stereo frame, optionally crop one sensor."""
    if CAMERA_VIEW not in ("left", "right"):
        return frame
    w = frame.shape[1]
    half = w // 2
    return frame[:, :half] if CAMERA_VIEW == "left" else frame[:, half:]


class CameraStreamer:
    def __init__(self):
        self._enabled = threading.Event()
        self._running = True
        self._session = requests.Session()
        self._worker = threading.Thread(target=self._capture_loop, daemon=True)
        self._last_warn_t = 0.0

    def _warn_throttled(self, msg):
        # Rate-limit noisy per-frame failures (rejected POSTs, network blips) so
        # a persistent misconfig logs a steady ~1/10s breadcrumb, not a flood.
        now = time.monotonic()
        if now - self._last_warn_t >= 10.0:
            self._last_warn_t = now
            log(msg)

    def start(self):
        if not self._enabled.is_set():
            log("capture START")
            self._enabled.set()

    def stop(self):
        if self._enabled.is_set():
            log("capture STOP")
            self._enabled.clear()

    def run(self):
        self._worker.start()
        self._sse_loop()

    # ── frame capture + push ───────────────────────────────────────────────
    def _capture_loop(self):
        cap = None
        interval = 1.0 / CAMERA_FPS
        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), CAMERA_JPEG_QUALITY]
        while self._running:
            if not self._enabled.is_set():
                if cap is not None:
                    cap.release()
                    cap = None
                # Wait until an operator opens the view.
                self._enabled.wait(timeout=0.5)
                continue
            if cap is None:
                cap = open_capture()
                if cap is None:
                    time.sleep(1.0)  # retry; camera may be unplugged
                    continue
            t0 = time.monotonic()
            ok, frame = cap.read()
            if not ok or frame is None:
                log("frame grab failed; reopening device")
                cap.release()
                cap = None
                time.sleep(0.5)
                continue
            ok, buf = cv2.imencode(".jpg", crop_view(frame), encode_params)
            # Honor a camera-stop that arrived during read/encode before paying
            # for a network POST (the loop top then releases the device).
            if ok and self._enabled.is_set():
                self._post_frame(buf.tobytes())
            # Cap the push rate.
            dt = time.monotonic() - t0
            if dt < interval:
                time.sleep(interval - dt)
        if cap is not None:
            cap.release()

    def _post_frame(self, jpeg_bytes):
        try:
            resp = self._session.post(
                f"{SERVER_URL}/api/rover/camera",
                data=jpeg_bytes,
                headers={**headers(), "Content-Type": "image/jpeg"},
                timeout=POST_TIMEOUT_S,
            )
            # A 2xx round-trip is normal (server returns 204). A 4xx/5xx is a
            # *successful* HTTP exchange, so it won't raise — surface it
            # (e.g. 403 = bad/rotated INTERNAL_SECRET) instead of silently
            # burning uplink pushing frames the server rejects.
            if resp.status_code >= 400:
                self._warn_throttled(f"frame POST rejected: HTTP {resp.status_code}")
        except requests.RequestException as e:
            # A viewer dropping or a transient network blip — keep going.
            self._warn_throttled(f"frame POST error: {e}")

    # ── control SSE ────────────────────────────────────────────────────────
    def _sse_loop(self):
        delay = 3.0
        while self._running:
            try:
                connected = self._connect_sse()
                if connected:
                    delay = 3.0
            except Exception as e:  # noqa: BLE001 - keep the loop alive
                log(f"control SSE error: {e}")
            # Server gone → ensure we're not holding the camera.
            self.stop()
            if self._running:
                time.sleep(delay)
                delay = min(delay * 2, SSE_RECONNECT_MAX_S)

    def _connect_sse(self):
        h = {**headers(), "Accept": "text/event-stream", "Cache-Control": "no-cache"}
        resp = self._session.get(
            f"{SERVER_URL}/api/rover/camera/control",
            headers=h, stream=True, timeout=(10.0, 90.0),
        )
        if resp.status_code in (401, 403):
            # Don't let an auth rejection (missing/rotated INTERNAL_SECRET) fail
            # silently behind the generic backoff — call it out by name.
            log(f"control SSE auth rejected: HTTP {resp.status_code} "
                "(check INTERNAL_SECRET)")
        resp.raise_for_status()
        log("control SSE connected")
        for line in resp.iter_lines(decode_unicode=True):
            if not self._running:
                break
            if not line or not line.startswith("event: "):
                continue
            event = line[7:].strip()
            if event == "camera-start":
                self.start()
            elif event == "camera-stop":
                self.stop()
        resp.close()
        return True


def main():
    if not SERVER_URL:
        log("FATAL: SERVER_URL not set")
        sys.exit(1)
    if not SERVER_URL.startswith("https://") and not ALLOW_HTTP:
        log(f"FATAL: SERVER_URL must be https:// (got {SERVER_URL!r}); "
            "set SERVER_URL_ALLOW_HTTP=true to override on a trusted network")
        sys.exit(1)
    if not INTERNAL_SECRET:
        # Exit non-zero rather than retry forever: the server denies every
        # request without the secret, so a silent retry loop would show the
        # unit 'active' while the camera never works. Exiting lets
        # perception.service's Restart=on-failure + StartLimit surface a
        # genuinely failed unit for the operator.
        log("FATAL: INTERNAL_SECRET not set — cannot authenticate to the server")
        sys.exit(1)
    CameraStreamer().run()


if __name__ == "__main__":
    main()
