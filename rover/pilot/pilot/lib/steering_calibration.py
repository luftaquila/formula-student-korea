"""Steering centre auto-trim from a κ=0 commanded straight drive.

Why
---
The steering servo's mechanical zero rarely matches `servo_center_us`
exactly — manufacturing tolerance, linkage play, and tyre alignment all
shift the actual zero by a few µs. Even a 5 µs bias on a 500 µs full-lock
range produces a small but persistent curvature when the navigator
commands κ=0, which manifests as:

  • Manual straight drive veers steadily to one side.
  • Antenna-offset auto-cal blows up: the SCURVE phase integrates a
    chassis-pose ψ that's slightly off from reality every tick, so by
    the time it averages the body-frame antenna offset, the LSQ residual
    is meters instead of cm.

The fix is a one-shot trim measured from a long-enough κ=0 chord. If the
commanded-straight path is actually a slight arc (radius R), the
underlying steering bias is

    κ_bias  =  ±1/R          (sign from cross product of chord vs radius)
    trim_us =  κ_bias / κ_max  ·  servo_range_us

mcu_bridge then offsets every servo command by `trim_us`, restoring true
straight when the navigator commands κ=0.

Geometry
--------
Wheel-cal already drives 10 m at κ=0; we piggy-back on that drive,
collect ENU samples (one per GPS fix, deduped to ~2 cm motion), and fit
a circle (Kåsa algebraic LSQ — single 3×3 normal-matrix solve, no
iteration). For radii > `RADIUS_LARGE_M` the arc is indistinguishable
from a straight line under RTK noise (chord deviation ≪ 1 cm), so we
report `trim_us = 0` rather than a meaningless tiny correction.

Persistence
-----------
JSON at `$PILOT_STATE_DIR/steering_trim.json`:

    { "trim_us": 7.4, "radius_m": -103.2, "rms_residual_m": 0.018,
      "samples": 850, "drive_distance_m": 10.05,
      "calibrated_at": <ms epoch> }

Sign convention: trim_us has the same sign as the *correction* added to
the servo pulse — i.e. `servo_us += trim_us` cancels the bias. radius_m
is signed: positive means the rover arced left of its chord direction
(needs negative trim to straighten under `servo_us = center + (κ/κ_max)
· range`), negative means right.

Out-of-range trims (|trim_us| > `TRIM_BOUND_US`) signal something other
than steering bias (wheel slip, GPS chord noise, encoder drift) and are
rejected on load — the caller falls back to 0.0 µs and the rover drives
on the uncalibrated centre, which is *less* wrong than persisting a
huge trim.
"""

import json
import math
import os
import tempfile
import time


STEERING_TRIM_FILENAME = 'steering_trim.json'

# Sanity bound. Servo full-lock is ±servo_range_us (typically ±500 µs);
# 80 µs = 16 % of full-lock — a large steering bias but still leaves
# 84 % of the lock range on the worst side. Field measurements on this
# chassis hit −56 µs accumulated trim with the cal solver still
# requesting more correction (residual κ_bias from front-wheel
# alignment not yet cancelled), so 50 µs as the prior bound was below
# the actual mechanical bias. Above 80 µs we still refuse — that
# magnitude points at encoder slip, GPS chord error, or a wheel
# alignment problem the cal can't fix.
TRIM_BOUND_US = 80.0

# Solver acceptance gates. The chord noise floor over 10 m at RTK 1 cm
# 1σ is < 0.2 % of the chord, so we can resolve trim down to a few µs;
# below the min-distance gate we'd be fitting a line to noise.
SOLVE_MIN_DISTANCE_M = 5.0
SOLVE_MIN_SAMPLES = 50

# Below RADIUS_LARGE_M the arc is detectable in the chord; above it,
# the path is straight to within RTK noise. 100 m radius corresponds to
# κ = 0.01 1/m which on our servo geometry (κ_max ≈ 1.23 1/m,
# servo_range_us ≈ 500 µs) is < 5 µs of trim — within servo step
# resolution anyway, no point persisting it.
RADIUS_LARGE_M = 100.0


def steering_trim_path():
    base = os.environ.get('PILOT_STATE_DIR') or tempfile.gettempdir()
    return os.path.join(base, STEERING_TRIM_FILENAME)


def load_steering_trim(default=0.0):
    """Read the persisted trim_us.

    Returns `(trim_us, payload)`; payload is the parsed JSON dict (or
    None on missing/corrupt). Tolerates missing file and out-of-range
    values — a corrupt trim must never block boot, the caller silently
    uses 0.0 µs (uncalibrated centre).
    """
    path = steering_trim_path()
    try:
        with open(path, 'r') as f:
            data = json.load(f)
    except FileNotFoundError:
        return default, None
    except (OSError, json.JSONDecodeError):
        return default, None
    if not isinstance(data, dict):
        return default, None
    trim = data.get('trim_us')
    if not isinstance(trim, (int, float)):
        return default, None
    if not (-TRIM_BOUND_US <= trim <= TRIM_BOUND_US):
        return default, None
    return float(trim), data


def save_steering_trim(trim_us, *, radius_m, rms_residual_m, samples,
                       drive_distance_m):
    """Atomically persist the trim. Mirrors battery_cal / wheel_cal:
    tmp + fsync + rename, so a crash mid-write can never leave a
    half-written file at the canonical path."""
    if not (-TRIM_BOUND_US <= trim_us <= TRIM_BOUND_US):
        raise ValueError(f'trim_us out of range: {trim_us}')
    payload = {
        'trim_us': round(float(trim_us), 3),
        'radius_m': round(float(radius_m), 3) if math.isfinite(radius_m) else None,
        'rms_residual_m': round(float(rms_residual_m), 4),
        'samples': int(samples),
        'drive_distance_m': round(float(drive_distance_m), 3),
        'calibrated_at': int(time.time() * 1000),
    }
    path = steering_trim_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp'
    with open(tmp, 'w') as f:
        json.dump(payload, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    return payload


def _fit_circle_kasa(points):
    """Algebraic circle LSQ. Returns (cx, cy, r, rms_residual).

    Solves the linear system  A·z = b  where each row is
    (2 x_i, 2 y_i, 1) · (cx, cy, c) = (x_i² + y_i²),  c = cx² + cy² − r².
    Closed-form via the 3×3 normal matrix; no iteration. For collinear
    samples the matrix is rank-deficient and we return r = +∞
    (caller treats as straight line).
    """
    n = len(points)
    if n < 3:
        return 0.0, 0.0, float('inf'), float('inf')
    sx = sy = sxx = syy = sxy = sxxx = syyy = sxyy = sxxy = 0.0
    for x, y in points:
        sx += x
        sy += y
        sxx += x * x
        syy += y * y
        sxy += x * y
        sxxx += x * x * x
        syyy += y * y * y
        sxyy += x * y * y
        sxxy += x * x * y
    # Normal-equations matrix M and RHS v for [a, b, c]^T = [2cx, 2cy, c]^T.
    # Each sample contributes (x_i² + y_i²) on the RHS and (x_i, y_i, 1)
    # as the design row — the symmetric system below comes from M^T M.
    m = [
        [sxx, sxy, sx],
        [sxy, syy, sy],
        [sx,  sy,  float(n)],
    ]
    v = [
        sxxx + sxyy,
        sxxy + syyy,
        sxx + syy,
    ]
    det = (
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    )
    if abs(det) < 1e-12:
        # Collinear — circle radius is unbounded.
        return 0.0, 0.0, float('inf'), 0.0
    inv_det = 1.0 / det
    # Cramer's rule over 3×3 — cheaper than allocating an inverse.
    a = (
        v[0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (v[1] * m[2][2] - m[1][2] * v[2])
        + m[0][2] * (v[1] * m[2][1] - m[1][1] * v[2])
    ) * inv_det
    b = (
        m[0][0] * (v[1] * m[2][2] - m[1][2] * v[2])
        - v[0] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * v[2] - v[1] * m[2][0])
    ) * inv_det
    c = (
        m[0][0] * (m[1][1] * v[2] - v[1] * m[2][1])
        - m[0][1] * (m[1][0] * v[2] - v[1] * m[2][0])
        + v[0] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    ) * inv_det
    cx = a * 0.5
    cy = b * 0.5
    r2 = c + cx * cx + cy * cy
    if r2 < 0.0:
        return cx, cy, float('inf'), float('inf')
    r = math.sqrt(r2)
    rss = 0.0
    for x, y in points:
        rss += (math.hypot(x - cx, y - cy) - r) ** 2
    rms = math.sqrt(rss / n)
    return cx, cy, r, rms


def solve_steering_trim(*, samples, kappa_max, servo_range_us,
                        drive_distance_m):
    """Closed-form trim_us from a κ=0 commanded straight drive.

    Args:
        samples: iterable of (e, n) ENU positions captured during the drive.
        kappa_max: |κ| at full steering lock — `tan(max_steering_angle) /
                   wheelbase`. Determines the servo µs ↔ κ scaling.
        servo_range_us: |servo_us − servo_center_us| at full lock.
        drive_distance_m: GPS chord length; used by gates and persistence.

    Returns:
        dict {trim_us, radius_m, rms_residual_m, samples, reason}.
        On a clean straight drive (radius > RADIUS_LARGE_M) trim_us = 0.0
        and reason = None — the persistent file is still updated so the
        operator sees fresh `calibrated_at`.
    """
    pts = list(samples)
    n = len(pts)
    if n < SOLVE_MIN_SAMPLES:
        return {'reason': f'too few samples ({n} < {SOLVE_MIN_SAMPLES})',
                'samples': n}
    if drive_distance_m < SOLVE_MIN_DISTANCE_M:
        return {
            'reason': (f'GPS chord too short '
                       f'({drive_distance_m:.2f} m < '
                       f'{SOLVE_MIN_DISTANCE_M:.1f} m)'),
            'samples': n,
        }
    if kappa_max <= 0.0 or servo_range_us <= 0.0:
        return {'reason': 'invalid kappa_max or servo_range_us',
                'samples': n}

    cx, cy, r, rms = _fit_circle_kasa(pts)

    # Indistinguishable-from-straight: zero trim, healthy.
    if not math.isfinite(r) or r >= RADIUS_LARGE_M:
        return {
            'trim_us': 0.0,
            'radius_m': float('inf'),
            'rms_residual_m': rms if math.isfinite(rms) else 0.0,
            'samples': n,
            'reason': None,
        }

    # Sign of the curvature: cross product of chord direction (first→last
    # sample) with first-sample-to-centre vector. Positive cross means
    # centre is to the LEFT of the chord direction → rover arcs left
    # under κ = +1/R, so the bias is +1/R and the corrective trim_us is
    # *negative* (servo_us = center + (κ/κ_max)·range, so we want to
    # subtract the same κ).
    cdx = pts[-1][0] - pts[0][0]
    cdy = pts[-1][1] - pts[0][1]
    rdx = cx - pts[0][0]
    rdy = cy - pts[0][1]
    cross = cdx * rdy - cdy * rdx
    sign = 1.0 if cross >= 0 else -1.0
    kappa_bias = sign / r
    trim_us = -kappa_bias / kappa_max * servo_range_us

    # Out-of-range: do NOT persist. trim of 50 µs already covers a 10 %
    # full-lock bias; anything bigger is encoder slip or GPS chord error,
    # not steering geometry — applying it would push the servo out of one
    # side of its range.
    if not (-TRIM_BOUND_US <= trim_us <= TRIM_BOUND_US):
        return {
            'reason': (f'trim {trim_us:.1f} µs outside '
                       f'±{TRIM_BOUND_US:.0f} µs (radius={r:.1f} m)'),
            'trim_us': trim_us,
            'radius_m': sign * r,
            'rms_residual_m': rms,
            'samples': n,
        }

    return {
        'trim_us': trim_us,
        'radius_m': sign * r,
        'rms_residual_m': rms,
        'samples': n,
        'reason': None,
    }
