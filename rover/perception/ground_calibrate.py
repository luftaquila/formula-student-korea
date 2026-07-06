#!/usr/bin/env python3
"""Calibrate the ground-depth curve for above-ground obstacle detection.

The camera's height + pitch are fixed, so on FLAT ground the expected depth of
the clear ground is a fixed function of image row. This tool measures that curve
— point the rover down a stretch of flat EMPTY ground (no obstacle) in its normal
driving pose, and it records, per row-fraction, the median valid (high-confidence)
depth inside the detection corridor's x-band, then saves the curve next to the
stereo calibration (…_ground.npz). `stereo.decide()` in "aboveground" mode then
flags anything closer than this curve as an obstacle.

Run in the perception image with both eyes mapped and the camera free:

    podman run --rm --network=host --device /dev/video0 --device /dev/video2 \\
      -v /var/lib/perception:/var/lib/perception:z \\
      --env-file /etc/pilot/pilot.conf --entrypoint python3 \\
      ghcr.io/luftaquila/fsk-rover-perception:candidate \\
      /opt/perception/ground_calibrate.py

Env: BENCH_LEFT/BENCH_RIGHT (device indices, default 0/2), GROUND_FRAMES (30),
GROUND_BINS (40), CAMERA_WIDTH/HEIGHT, STEREO_LAYOUT. Output path: GROUND_PROFILE_PATH
or …_ground.npz beside STEREO_CALIB_PATH.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2
import numpy as np
import stereo

W = int(os.environ.get("CAMERA_WIDTH", "1280") or "1280")
H = int(os.environ.get("CAMERA_HEIGHT", "720") or "720")
LEFT = int(os.environ.get("BENCH_LEFT", "0"))
RIGHT = int(os.environ.get("BENCH_RIGHT", "2"))
FRAMES = int(os.environ.get("GROUND_FRAMES", "30"))
NBINS = int(os.environ.get("GROUND_BINS", "40"))
LAYOUT = (os.environ.get("STEREO_LAYOUT", "dual") or "dual").lower()

cfg = stereo.config_from_env()
det = stereo.StereoDepth(cfg)
if not det.enabled:
    print(f"FATAL: stereo not enabled (no calibration at {cfg.calib_path})")
    sys.exit(1)
out_path = cfg.ground_profile_path or stereo.default_ground_path(cfg.calib_path)
x0, _y0, x1, _y1 = cfg.roi
print(f"ground calibration: scale={cfg.viz_depth_scale} conf_min={cfg.conf_min} "
      f"x-band=[{x0},{x1}] frames={FRAMES} bins={NBINS} -> {out_path}")


def open_eye(dev):
    c = cv2.VideoCapture(dev)
    if not c.isOpened():
        c.release(); return None
    c.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    c.set(cv2.CAP_PROP_FRAME_WIDTH, W); c.set(cv2.CAP_PROP_FRAME_HEIGHT, H)
    c.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return c


if LAYOUT == "dual":
    left, right = open_eye(LEFT), open_eye(RIGHT)
    if left is None or right is None:
        print(f"FATAL: cannot open eyes L={LEFT} R={RIGHT}"); sys.exit(1)

    def pair():
        left.grab(); right.grab()
        o1, l = left.retrieve(); o2, r = right.retrieve()
        return (l, r) if (o1 and o2 and l is not None and r is not None) else (None, None)
else:
    cap = open_eye(LEFT)
    if cap is None:
        print("FATAL: cannot open SBS camera"); sys.exit(1)

    def pair():
        ok, f = cap.read()
        if not ok or f is None:
            return None, None
        return stereo.split_sbs(f)


cv2.setNumThreads(1)
for _ in range(8):                                   # warm up
    l, r = pair()
    if l is not None:
        det.compute_depth(l, r, scale=cfg.viz_depth_scale)

bin_depths = [[] for _ in range(NBINS)]
got = 0
for _ in range(FRAMES):
    l, r = pair()
    if l is None:
        continue
    d = det.compute_depth(l, r, scale=cfg.viz_depth_scale)
    if d is None:
        continue
    dz, valid, conf = d
    if conf is not None:
        valid = valid & (conf >= cfg.conf_min)
    _rf, dm = stereo.ground_row_medians(dz, valid, x0, x1, NBINS)   # shared binning
    for b in range(NBINS):
        if np.isfinite(dm[b]):
            bin_depths[b].append(float(dm[b]))
    got += 1

if got == 0:
    print("FATAL: captured no usable frames"); sys.exit(1)

row_fracs, depths = [], []
for b in range(NBINS):
    row_fracs.append((b + 0.5) / NBINS)
    depths.append(float(np.median(bin_depths[b])) if bin_depths[b] else np.nan)

rf, dm = stereo.fit_ground_profile(row_fracs, depths)
if rf.size < 2:
    print("FATAL: too few valid rows to fit a ground curve — is the corridor flat "
          "ground with texture? try better lighting / a longer clear run.")
    sys.exit(1)

stereo.save_ground_profile(out_path, rf, dm)
print(f"\nfitted ground curve ({rf.size} rows, {got} frames):")
for i in range(0, rf.size, max(1, rf.size // 20)):
    print(f"  y={rf[i]:.2f}  ground≈{dm[i]:.2f} m")
print(f"\nnear (bottom) ≈ {dm[-1]:.2f} m, far (top) ≈ {dm[0]:.2f} m")
print(f"SAVED {out_path}")
print("restart perception.service to load it (detection switches to aboveground).")
