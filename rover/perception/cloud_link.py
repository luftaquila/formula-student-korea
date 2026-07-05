"""Course-server link for the FSK rover perception node.

Everything that talks HTTP to the course server lives here, kept separate from
the ROS node + camera capture (perception_node.py) and the depth math
(stereo.py):

  - Control SSE  GET {SERVER_URL}/api/rover/camera/control  (internal-secret).
    The server emits `camera-start` when an operator opens the live view and
    `camera-stop` when the last viewer leaves; we expose that as a thread-safe
    `stream_wanted` Event the capture loop reads to decide whether to push
    frames. Streaming is operator-driven; detection (mission-driven) is owned
    by the node and does NOT depend on this.
  - POST {SERVER_URL}/api/rover/camera   — JPEG frame upload (while watched).
  - POST {SERVER_URL}/api/rover/obstacle — one-shot operator alert when the
    detector trips (the actual mission pause is issued locally over ROS, never
    through here; this is best-effort notification only).

Tailscale-free: this process connects OUT to the public server, so nothing has
to reach INTO the rover.
"""

import json
import threading
import time

import requests

SSE_RECONNECT_MAX_S = 30.0
# Keep POSTs short: a slow frame POST blocks the capture loop's stream branch.
POST_TIMEOUT_S = 2.0


class CloudLink:
    def __init__(self, server_url, secret, allow_http=False, log=print):
        self.server_url = (server_url or "").rstrip("/")
        self._secret = secret or ""
        self._allow_http = allow_http
        self._log = log
        self._session = requests.Session()
        self._running = True
        # Set while an operator is watching (server camera-start..camera-stop).
        self.stream_wanted = threading.Event()
        # Set while an operator has toggled the depth composite on (server
        # depth-on..depth-off). A sub-mode of streaming: only meaningful while
        # stream_wanted is also set. The capture loop reads it to decide whether
        # to render the both-eyes depth composite instead of the plain eye.
        self.depth_wanted = threading.Event()
        # Called with the square size (m) when the server requests a calibration
        # (operator pressed 교정). Set by the node; runs on the SSE thread.
        self.on_calibrate = None
        self._last_warn_t = 0.0
        self._sse_thread = None

    # ── lifecycle ───────────────────────────────────────────────────────────
    def start(self):
        self._sse_thread = threading.Thread(target=self._sse_loop, daemon=True)
        self._sse_thread.start()

    def stop(self):
        self._running = False

    def _headers(self):
        return {"X-Internal-Service": self._secret} if self._secret else {}

    def _warn_throttled(self, msg):
        # A persistent misconfig logs a steady ~1/10s breadcrumb, not a flood.
        now = time.monotonic()
        if now - self._last_warn_t >= 10.0:
            self._last_warn_t = now
            self._log(msg)

    # ── outbound POSTs ────────────────────────────────────────────────────────
    def post_frame(self, jpeg_bytes):
        try:
            resp = self._session.post(
                f"{self.server_url}/api/rover/camera",
                data=jpeg_bytes,
                headers={**self._headers(), "Content-Type": "image/jpeg"},
                timeout=POST_TIMEOUT_S,
            )
            # 4xx/5xx is a *successful* HTTP exchange (won't raise) — surface it
            # (e.g. 403 = bad/rotated secret) instead of silently burning uplink.
            if resp.status_code >= 400:
                self._warn_throttled(f"frame POST rejected: HTTP {resp.status_code}")
        except requests.RequestException as e:
            self._warn_throttled(f"frame POST error: {e}")

    def post_obstacle(self, payload):
        """Best-effort operator alert. The mission pause is local (ROS); this
        only tells the server to surface a banner + auto-open the camera."""
        try:
            resp = self._session.post(
                f"{self.server_url}/api/rover/obstacle",
                json=payload,
                headers={**self._headers(), "Content-Type": "application/json"},
                timeout=POST_TIMEOUT_S,
            )
            if resp.status_code >= 400:
                self._warn_throttled(f"obstacle POST rejected: HTTP {resp.status_code}")
        except requests.RequestException as e:
            self._warn_throttled(f"obstacle POST error: {e}")

    def post_calibration_progress(self, payload):
        """Report calibration progress / result to the server (→ operator UI)."""
        try:
            self._session.post(
                f"{self.server_url}/api/rover/calibration-progress",
                json=payload,
                headers={**self._headers(), "Content-Type": "application/json"},
                timeout=POST_TIMEOUT_S,
            )
        except requests.RequestException as e:
            self._warn_throttled(f"calibration-progress POST error: {e}")

    # ── control SSE ───────────────────────────────────────────────────────────
    def _sse_loop(self):
        delay = 3.0
        while self._running:
            try:
                if self._connect_sse():
                    delay = 3.0
            except Exception as e:  # noqa: BLE001 - keep the loop alive
                self._log(f"control SSE error: {e}")
            # Server/stream gone → don't keep trying to push frames into a
            # dead relay; the capture loop drops the stream branch. The server
            # re-sends camera-start / depth-on on reconnect if still wanted.
            self.stream_wanted.clear()
            self.depth_wanted.clear()
            if self._running:
                time.sleep(delay)
                delay = min(delay * 2, SSE_RECONNECT_MAX_S)

    def _connect_sse(self):
        h = {**self._headers(), "Accept": "text/event-stream",
             "Cache-Control": "no-cache"}
        resp = self._session.get(
            f"{self.server_url}/api/rover/camera/control",
            headers=h, stream=True, timeout=(10.0, 90.0),
        )
        if resp.status_code in (401, 403):
            self._log(f"control SSE auth rejected: HTTP {resp.status_code} "
                      "(check INTERNAL_SECRET)")
        resp.raise_for_status()
        self._log("control SSE connected")
        event, data_lines = None, []
        for line in resp.iter_lines(decode_unicode=True):
            if not self._running:
                break
            if line is None:
                continue
            if line.startswith("event: "):
                event = line[7:].strip()
            elif line.startswith("data: "):
                data_lines.append(line[6:])
            elif line == "":                       # blank line ends an event
                if event:
                    self._dispatch(event, "\n".join(data_lines))
                event, data_lines = None, []
            # ":"-prefixed heartbeats and anything else are ignored.
        resp.close()
        return True

    def _dispatch(self, event, data):
        if event == "camera-start":
            self.stream_wanted.set()
        elif event == "camera-stop":
            self.stream_wanted.clear()
        elif event == "depth-on":
            self.depth_wanted.set()
        elif event == "depth-off":
            self.depth_wanted.clear()
        elif event == "calibrate":
            square_m = 0.025
            try:
                square_m = float((json.loads(data or "{}") or {}).get("square_m", 0.025))
            except (ValueError, TypeError):
                pass
            cb = self.on_calibrate
            if cb is not None:
                cb(square_m)
