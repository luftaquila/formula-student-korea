import { ref } from "vue";

// WHEP (WebRTC-HTTP Egress) player. Pulls a mediamtx stream into a <video>, with
// a gating hold (so the rover publishes) and retry-until-connected. Shared by the
// 2D panel and (pattern-wise) the VR view. STUN gives a server-reflexive
// candidate so ICE can traverse NAT.
export function useWhepStream() {
  const connected = ref(false); // track negotiated (ontrack) — gates retry
  const playing = ref(false);   // video actually rendering frames — gates display
  let pc = null;
  let holdSrc = null;
  let timer = null;
  let stopped = false;
  let busy = false;
  let videoEl = null;
  let whepUrl = "";
  let playTimer = null;

  async function attempt() {
    if (stopped || busy || connected.value) return;
    busy = true;
    try {
      if (pc) { try { pc.close(); } catch {} pc = null; }
      const p = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc = p;
      p.addTransceiver("video", { direction: "recvonly" });
      p.ontrack = (e) => {
        if (videoEl && e.streams[0]) {
          videoEl.srcObject = e.streams[0];
          videoEl.play().catch(() => {});
        }
        connected.value = true;
      };
      p.onconnectionstatechange = () => {
        if (p !== pc) return;
        // "disconnected" is usually a transient ICE blip that recovers — only a
        // terminal state tears down (so the view doesn't flap to MJPEG + "no signal").
        if (["failed", "closed"].includes(p.connectionState)) {
          connected.value = false;
          playing.value = false;
        }
      };
      await p.setLocalDescription(await p.createOffer());
      const res = await fetch(whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: p.localDescription.sdp,
      });
      if (!res.ok) throw new Error(`WHEP ${res.status}`);
      await p.setRemoteDescription({ type: "answer", sdp: await res.text() });
    } catch {
      if (pc) { try { pc.close(); } catch {} pc = null; }
      connected.value = false;
      // interval re-attempts until connected (e.g. publisher not online yet)
    } finally {
      busy = false;
    }
  }

  // start(videoEl, whepUrl, holdUrl): holdUrl (optional) is an SSE the server
  // counts as a viewer so the rover publishes; keep it open for the session.
  function start(video, url, holdUrl) {
    videoEl = video;
    whepUrl = url;
    stopped = false;
    connected.value = false;
    playing.value = false;
    if (holdUrl) holdSrc = new EventSource(holdUrl);
    attempt();
    timer = setInterval(attempt, 3000);
    // Detect "actually rendering" via videoWidth>0 — robust across browsers where
    // the 'playing' event may not fire (e.g. an off-screen <video>).
    playTimer = setInterval(() => {
      // Latch on the first decoded frame: a transient videoWidth=0 (e.g. a
      // mid-stream resolution change) must NOT flap us back to MJPEG. Only
      // start()/stop() or a terminal connectionState resets `playing` to false.
      if (videoEl && videoEl.videoWidth > 0) playing.value = true;
    }, 500);
  }

  function stop() {
    stopped = true;
    connected.value = false;
    playing.value = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (holdSrc) { holdSrc.close(); holdSrc = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (videoEl) { try { videoEl.srcObject = null; } catch {} }
  }

  return { connected, playing, start, stop };
}
