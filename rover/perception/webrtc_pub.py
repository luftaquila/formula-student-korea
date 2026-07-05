"""aiortc WHIP publisher for the perception node (Phase 2b — low-latency video).

Runs its own asyncio loop in a background thread. The capture loop pushes the
latest BGR frame via push_frame(); a VideoStreamTrack paces them to the target
fps and hands them to aiortc, which H.264-encodes and sends over WebRTC to a
mediamtx WHIP endpoint. Media is SRTP/UDP direct to mediamtx; only the one-shot
SDP offer/answer rides HTTP (WHIP), so it goes through the same 443 → caddy path
as the rest of the rover's outbound traffic.

Kept separate from perception_node so the (optional) aiortc dependency can be
missing without breaking capture/detection — the node guards the import.
"""
import asyncio
import fractions
import threading
import time

import av
import requests
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.rtcrtpsender import RTCRtpSender

_CLOCK_HZ = 90000  # RTP video clock


class _FrameTrack(VideoStreamTrack):
    """Serves the capture loop's latest frame, paced to `fps`."""

    def __init__(self, get_frame, fps):
        super().__init__()
        self._get_frame = get_frame
        self._interval = 1.0 / max(1, fps)
        self._last = None
        self._start = None

    async def recv(self):
        now = time.monotonic()
        if self._last is not None:
            wait = self._interval - (now - self._last)
            if wait > 0:
                await asyncio.sleep(wait)
        self._last = time.monotonic()
        if self._start is None:
            self._start = self._last

        bgr = self._get_frame()
        while bgr is None:                       # no frame pushed yet
            await asyncio.sleep(0.02)
            bgr = self._get_frame()

        frame = av.VideoFrame.from_ndarray(bgr, format="bgr24")
        frame.pts = int((self._last - self._start) * _CLOCK_HZ)
        frame.time_base = fractions.Fraction(1, _CLOCK_HZ)
        return frame


class WebRTCPublisher:
    """Publishes push_frame() frames to a WHIP endpoint. start()/stop() are
    cheap and idempotent-ish; create a fresh instance per publish session."""

    def __init__(self, whip_url, fps=15, log=print):
        self._whip_url = whip_url
        self._fps = fps
        self._log = log
        self._latest = None
        self._lock = threading.Lock()
        self._thread = None
        self._loop = None
        self._pc = None

    def push_frame(self, bgr):
        with self._lock:
            self._latest = bgr

    def _get_frame(self):
        with self._lock:
            return self._latest

    def alive(self):
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        if self.alive():
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        loop = self._loop
        if loop is not None:
            loop.call_soon_threadsafe(loop.stop)
        if self._thread is not None:
            self._thread.join(timeout=3)
        self._thread = None

    def _run(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._negotiate())
            self._loop.run_forever()          # keep sending until stop()
        except Exception as e:  # noqa: BLE001 - report + let the thread die; caller restarts
            self._log(f"WebRTC publish error: {e}")
        finally:
            try:
                self._loop.run_until_complete(self._close())
            except Exception:  # noqa: BLE001
                pass
            self._loop.close()
            self._loop = None

    async def _negotiate(self):
        self._pc = RTCPeerConnection()
        sender = self._pc.addTrack(_FrameTrack(self._get_frame, self._fps))
        # Force H.264 ONLY (Quest hardware-decodes it; cheaper on battery/latency).
        # If VP8 is ALSO offered, aiortc's sender falls back to VP8 at encode time
        # even when H.264 is negotiated first — dropping VP8 from the preferences
        # makes it actually send H.264 (verified: mediamtx reports "1 track (H264)").
        try:
            caps = RTCRtpSender.getCapabilities("video")
            h264 = [c for c in caps.codecs if c.mimeType == "video/H264"]
            if h264:
                for t in self._pc.getTransceivers():
                    if t.sender is sender:
                        t.setCodecPreferences(h264)
        except Exception:  # noqa: BLE001 - fall back to default codec order
            pass

        offer = await self._pc.createOffer()
        await self._pc.setLocalDescription(offer)

        def _post():
            return requests.post(self._whip_url, data=self._pc.localDescription.sdp,
                                 headers={"Content-Type": "application/sdp"}, timeout=10)
        resp = await self._loop.run_in_executor(None, _post)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"WHIP {resp.status_code}: {resp.text[:200]}")
        await self._pc.setRemoteDescription(
            RTCSessionDescription(sdp=resp.text, type="answer"))
        self._log(f"WebRTC publishing to {self._whip_url}")

    async def _close(self):
        if self._pc is not None:
            await self._pc.close()
            self._pc = None
