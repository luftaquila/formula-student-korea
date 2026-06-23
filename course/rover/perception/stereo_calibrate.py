#!/usr/bin/env python3
"""One-time stereo calibration for the FSK rover's USB stereo webcam (Phase 3).

Run this ONCE per camera/mounting, on the rover, to produce the rectification
maps + reprojection matrix that stereo.py needs for metric depth. Until it has
run, obstacle detection stays disabled (stereo.StereoDepth.enabled == False) and
the rover never auto-pauses on an obstacle.

Headless by design: the rover has no display, so there is no preview window.
Hold a printed checkerboard in front of the camera and slowly sweep it across
the frame at varied distances/angles; the tool auto-grabs a pair whenever the
board is found in BOTH eyes and has moved enough since the last grab, printing
progress, until it has enough pairs.

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
import os
import sys
import time

import cv2
import numpy as np


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


def _find_corners(gray, pattern):
    flags = cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE
    found, corners = cv2.findChessboardCorners(gray, pattern, flags)
    if not found:
        return None
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
    return cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)


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
    ap.add_argument("--cols", type=int, default=9, help="inner corners per row")
    ap.add_argument("--rows", type=int, default=6, help="inner corners per col")
    ap.add_argument("--square-m", type=float, default=0.025,
                    help="checkerboard square edge in metres")
    ap.add_argument("--count", type=int, default=20, help="target board pairs")
    ap.add_argument("--min-shift-px", type=float, default=25.0,
                    help="min mean-corner move between accepted grabs")
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

    # Object points: the board's corners in its own frame, scaled to metres so
    # T (and therefore depth) comes out in metres.
    objp = np.zeros((args.rows * args.cols, 3), np.float32)
    objp[:, :2] = np.mgrid[0:args.cols, 0:args.rows].T.reshape(-1, 2)
    objp *= float(args.square_m)

    objpoints, imgL, imgR = [], [], []
    last_mean = None
    eye_size = None  # (w, h) of one eye
    start = time.monotonic()
    print(f"Collecting {args.count} board pairs — sweep the checkerboard "
          f"across the frame at varied distances/angles...")

    while len(objpoints) < args.count:
        if time.monotonic() - start > args.timeout_s:
            print(f"timeout after {args.timeout_s:.0f}s with "
                  f"{len(objpoints)} pairs", file=sys.stderr)
            break
        ok, frame = cap.read()
        if not ok or frame is None:
            time.sleep(0.05)
            continue
        if args.layout == "dual":
            ok2, rframe = right_cap.read()
            if not ok2 or rframe is None:
                time.sleep(0.05)
                continue
            left, right = frame, rframe
        else:
            w = frame.shape[1] // 2
            left, right = frame[:, :w], frame[:, w:w * 2]
        if eye_size is None:
            eye_size = (left.shape[1], left.shape[0])
        gl = cv2.cvtColor(left, cv2.COLOR_BGR2GRAY)
        gr = cv2.cvtColor(right, cv2.COLOR_BGR2GRAY)
        cl = _find_corners(gl, pattern)
        if cl is None:
            continue
        cr = _find_corners(gr, pattern)
        if cr is None:
            continue
        mean = cl.reshape(-1, 2).mean(axis=0)
        if last_mean is not None:
            if np.linalg.norm(mean - last_mean) < args.min_shift_px:
                continue  # too similar to the last grab — keep sweeping
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

    # Per-eye intrinsics first, then stereo extrinsics with intrinsics fixed.
    rms_l, K1, D1, _, _ = cv2.calibrateCamera(objpoints, imgL, eye_size, None, None)
    rms_r, K2, D2, _, _ = cv2.calibrateCamera(objpoints, imgR, eye_size, None, None)
    stereo_rms, K1, D1, K2, D2, R, T, _, _ = cv2.stereoCalibrate(
        objpoints, imgL, imgR, K1, D1, K2, D2, eye_size,
        criteria=(cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 1e-5),
        flags=cv2.CALIB_FIX_INTRINSIC,
    )
    R1, R2, P1, P2, Q, _, _ = cv2.stereoRectify(
        K1, D1, K2, D2, eye_size, R, T,
        flags=cv2.CALIB_ZERO_DISPARITY, alpha=0,
    )
    map1x, map1y = cv2.initUndistortRectifyMap(K1, D1, R1, P1, eye_size, cv2.CV_32FC1)
    map2x, map2y = cv2.initUndistortRectifyMap(K2, D2, R2, P2, eye_size, cv2.CV_32FC1)

    baseline_m = float(np.linalg.norm(T))
    print(f"per-eye RMS: L={rms_l:.3f} R={rms_r:.3f}  stereo RMS={stereo_rms:.3f} px")
    print(f"recovered baseline: {baseline_m * 1000:.1f} mm "
          f"(expected ~60 mm — large deviation means a bad calibration)")
    if stereo_rms > 1.0:
        print("WARNING: stereo RMS > 1.0 px — calibration is poor; depth will "
              "be noisy. Recapture with a flatter board and better lighting.",
              file=sys.stderr)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    np.savez(
        args.out,
        map1x=map1x, map1y=map1y, map2x=map2x, map2y=map2y,
        Q=Q, image_size=np.array(eye_size, dtype=np.int32),
        baseline_m=np.float32(baseline_m), stereo_rms=np.float32(stereo_rms),
        square_m=np.float32(args.square_m),
    )
    print(f"saved calibration → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
