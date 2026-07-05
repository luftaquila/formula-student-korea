#!/usr/bin/env python3
"""One-time stereo calibration for the FSK rover's USB stereo webcam (Phase 3).

Run this ONCE per camera/mounting, on the rover, to produce the rectification
maps + reprojection matrix that stereo.py needs for metric depth. Until it has
run, obstacle detection stays disabled (stereo.StereoDepth.enabled == False) and
the rover never auto-pauses on an obstacle.

Headless by design: the rover has no display, so there is no preview window.
Hold a printed checkerboard in front of the camera and sweep it across the
frame at varied distances/angles, PAUSING briefly at each pose; the tool
auto-grabs a pair whenever the board is found in BOTH eyes, has moved enough
since the last grab, and is momentarily still — the two eyes capture a few ms
apart, so grabbing mid-motion lands the board at different places in L vs R and
inflates the stereo RMS. It prints progress until it has enough pairs.

The rover's "Stereo Vision" cam is dual-node (default): the two eyes are
separate /dev/video nodes (left=video0, right=video2). Pass --layout sbs for a
camera that emits one side-by-side frame instead.

Usage (inside the perception container, both eyes passed through):
  python3 stereo_calibrate.py \
      --cols 9 --rows 6 --square-m 0.025 \
      --device /dev/video0 --right-device /dev/video2 \
      --width 1280 --height 720 \
      --out /var/lib/perception/stereo_calib.npz

  --layout       = dual (two nodes, default) | sbs (one side-by-side frame)
  --cols/--rows  = number of INNER corners (a 10x7-square board → 9x6 corners)
  --square-m     = printed square edge in METRES (this sets depth units!)
  --width/--height = capture size PER device; calibrate at the SAME resolution
                     the node runs at (CAMERA_WIDTH/CAMERA_HEIGHT) so maps match.

Saves an .npz with: map1x, map1y, map2x, map2y (per-eye rectify maps), Q
(reprojection), image_size (per-eye w,h). stereo.load_calibration() reads it.
"""

import argparse
import sys
import time

import cv2
import numpy as np

import stereo  # shared corner-finding + calibration compute/IO


def _open_camera(device, width, height):
    cap = cv2.VideoCapture(int(device) if str(device).isdigit() else device)
    if not cap.isOpened():
        return None
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    ok, frame = cap.read()
    if not ok or frame is None:
        cap.release()
        return None
    return cap


def main(argv=None):
    ap = argparse.ArgumentParser(description="FSK rover stereo calibration")
    ap.add_argument("--layout", choices=["dual", "sbs"], default="dual",
                    help="dual: two /dev/video nodes; sbs: one side-by-side frame")
    ap.add_argument("--device", default="/dev/video0",
                    help="left eye (dual) or the SBS device")
    ap.add_argument("--right-device", default="/dev/video2",
                    help="right eye (dual layout only)")
    ap.add_argument("--width", type=int, default=1280, help="capture width per device")
    ap.add_argument("--height", type=int, default=720, help="capture height per device")
    ap.add_argument("--proc-width", type=int, default=0,
                    help="downsample each captured eye to this width BEFORE solving "
                         "(0 = use the captured size). The rover cam ignores capture "
                         "resolution requests and always delivers 720p, so to calibrate "
                         "at a lower resolution (e.g. 512x288 for a faster depth compute) "
                         "set --proc-width/--proc-height here, not --width/--height.")
    ap.add_argument("--proc-height", type=int, default=0,
                    help="downsample height before solving (see --proc-width)")
    ap.add_argument("--cols", type=int, default=9, help="inner corners per row")
    ap.add_argument("--rows", type=int, default=6, help="inner corners per col")
    ap.add_argument("--square-m", type=float, default=0.025,
                    help="checkerboard square edge in metres")
    ap.add_argument("--count", type=int, default=20, help="target board pairs")
    ap.add_argument("--min-shift-px", type=float, default=25.0,
                    help="min mean-corner move between accepted grabs")
    ap.add_argument("--max-motion-px", type=float, default=3.0,
                    help="max mean-corner move vs the previous frame to count as "
                         "'board held still' (dual layout only); only grab while "
                         "settled so the few-ms gap between the two eyes can't "
                         "desync a pair. Loose by default for a handheld board")
    ap.add_argument("--timeout-s", type=float, default=180.0,
                    help="give up if not enough pairs in this long")
    ap.add_argument("--out", default="/var/lib/perception/stereo_calib.npz")
    args = ap.parse_args(argv)

    pattern = (args.cols, args.rows)
    cap = _open_camera(args.device, args.width, args.height)
    if cap is None:
        print(f"FATAL: cannot open camera {args.device!r} at "
              f"{args.width}x{args.height}", file=sys.stderr)
        return 1
    right_cap = None
    if args.layout == "dual":
        right_cap = _open_camera(args.right_device, args.width, args.height)
        if right_cap is None:
            print(f"FATAL: cannot open right eye {args.right_device!r}", file=sys.stderr)
            cap.release()
            return 1

    objp = stereo.board_object_points(args.cols, args.rows, args.square_m)
    objpoints, imgL, imgR = [], [], []
    last_mean = None    # last ACCEPTED grab (coverage gate)
    prev_mean = None    # last detected frame (stationarity gate)
    eye_size = None  # (w, h) of one eye
    start = time.monotonic()
    print(f"Collecting {args.count} board pairs — sweep the checkerboard "
          f"across the frame at varied distances/angles...")

    while len(objpoints) < args.count:
        if time.monotonic() - start > args.timeout_s:
            print(f"timeout after {args.timeout_s:.0f}s with "
                  f"{len(objpoints)} pairs", file=sys.stderr)
            break
        if args.layout == "dual":
            pair = stereo.read_stereo_pair(cap, right_cap)
            if pair is None:
                time.sleep(0.05)
                continue
            left, right = pair
        else:
            ok, frame = cap.read()
            if not ok or frame is None:
                time.sleep(0.05)
                continue
            left, right = stereo.split_sbs(frame)
        # Downsample to the processing resolution BEFORE corner-finding, so the
        # maps + image_size come out at that size (the cam ignores capture-size
        # requests and always delivers 720p; this is how we calibrate at 512x288).
        if args.proc_width and args.proc_height:
            proc = (args.proc_width, args.proc_height)
            left = cv2.resize(left, proc, interpolation=cv2.INTER_AREA)
            right = cv2.resize(right, proc, interpolation=cv2.INTER_AREA)
        if eye_size is None:
            eye_size = (left.shape[1], left.shape[0])
        gl = cv2.cvtColor(left, cv2.COLOR_BGR2GRAY)
        gr = cv2.cvtColor(right, cv2.COLOR_BGR2GRAY)
        cl = stereo.find_chessboard(gl, pattern)
        if cl is None:
            continue
        cr = stereo.find_chessboard(gr, pattern)
        if cr is None:
            continue
        mean = cl.reshape(-1, 2).mean(axis=0)
        # Stationarity gate (dual layout only): only grab while the board is held
        # still. The two eyes capture a few ms apart, so a pair grabbed mid-motion
        # lands the board at different places in L vs R and inflates the stereo
        # RMS. SBS eyes share one hardware-synced frame, so nothing to gate.
        # Motion is vs the previous detected frame; min_shift below spaces
        # ACCEPTED grabs for coverage.
        if args.layout == "dual":
            motion = (np.linalg.norm(mean - prev_mean)
                      if prev_mean is not None else float("inf"))
            prev_mean = mean
            if motion > args.max_motion_px:
                continue  # board still moving — let it settle
        if last_mean is not None:
            if np.linalg.norm(mean - last_mean) < args.min_shift_px:
                continue  # too similar to the last accepted grab — keep sweeping
        last_mean = mean
        objpoints.append(objp.copy())
        imgL.append(cl)
        imgR.append(cr)
        print(f"  captured {len(objpoints)}/{args.count}")

    cap.release()
    if right_cap is not None:
        right_cap.release()
    if len(objpoints) < 6:
        print(f"FATAL: only {len(objpoints)} pairs — need >= 6 for a stable "
              "calibration. Improve lighting / board visibility and retry.",
              file=sys.stderr)
        return 1

    result = stereo.compute_stereo_calibration(objpoints, imgL, imgR, eye_size)
    print(f"per-eye RMS: L={result['rms_l']:.3f} R={result['rms_r']:.3f}  "
          f"stereo RMS={result['stereo_rms']:.3f} px")
    print(f"recovered baseline: {result['baseline_m'] * 1000:.1f} mm "
          f"(expected ~60 mm — large deviation means a bad calibration)")
    if result["stereo_rms"] > 1.0:
        print("WARNING: stereo RMS > 1.0 px — calibration is poor; depth will "
              "be noisy. Recapture with a flatter board and better lighting.",
              file=sys.stderr)

    stereo.save_calibration(args.out, result, args.square_m)
    print(f"saved calibration → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
