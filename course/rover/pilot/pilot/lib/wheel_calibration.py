"""Per-wheel encoder-scale calibration.

The MCU computes wheel velocity from encoder counts × `METERS_PER_COUNT`,
which is a single compile-time constant assuming both wheels share an
identical rolling radius. Real-world rubber tyres on the rover platform
vary by ±2-3 % from each other due to pressure, load, and wear. That
mismatch leaks into chassis ω = (v_r - v_l) / track and corrupts the
state estimator's dead-reckoned heading exactly in the regime where GPS
heading-of-motion is unavailable (creep_speed dock approach), eating
precious mm of waypoint tolerance.

Auto-cal procedure (runs from navigator's CAL_WHEELS state):
  • Drive κ = 0 at `wheel_cal_speed` for `wheel_cal_distance` metres.
  • Integrate per-wheel encoder distance ∫|v_wheel| dt during the drive.
  • Sample antenna ENU positions at the GPS rate.
  • Fit a circle to the ENU samples (Kåsa LSQ); compute the angular
    extent θ swept around its centre and the chassis path geometry.
  • Per-wheel reference distance:
      straight (R > RADIUS_LARGE_M):   ref = chord  (both wheels equal)
      curved   (finite R):             inner = (R − track/2)·|θ|
                                       outer = (R + track/2)·|θ|
                                       (sign of θ picks which wheel is
                                       inner vs outer)
  • scale_wheel = ref_wheel / encoder_wheel.
  • Persist (scale_l, scale_r) at $PILOT_STATE_DIR/wheel_cal.json,
    bind-mounted from the host. mcu_bridge re-loads on next boot or on
    receipt of /rover/cmd/calibrate_wheels.

The arc geometry matters: with a residual steering bias the κ=0
commanded drive arcs, and the outer wheel encoder reading inflates
purely because that side travels along a longer arc. The previous
chord-only formula attributed that to a wheel-radius mismatch and
flipped the per-wheel scales by ~1 % between consecutive cals depending
on which way the rover happened to drift. Using the GPS-fitted arc as
the per-wheel reference cancels that geometric component cleanly so
repeated cals on the same chassis converge to the same scales.

Persistence format mirrors battery_cal / antenna_offset:
    { "scale_l": 1.012, "scale_r": 0.987,
      "gps_distance_m": 10.21, "encoder_left_m": 10.09,
      "encoder_right_m": 10.35, "samples": 200,
      "arc_radius_m": 87.3, "arc_theta_rad": -0.117,
      "calibrated_at": <ms epoch> }

Out-of-range scales (|1 − scale| > 15 %) are rejected on load and the
caller falls back to (1.0, 1.0); a wildly off scale signals encoder
slip / wheel loss / GPS error rather than legitimate wheel mismatch and
must not silently brick subsequent missions.
"""

import json
import math
import os
import tempfile
import time

from pilot.lib.steering_calibration import _fit_circle_kasa


WHEEL_CAL_FILENAME = 'wheel_cal.json'

# Sanity bounds. Anything outside ±15 % is encoder slip / GPS error,
# not legitimate wheel-radius mismatch.
SCALE_BOUND_LO = 0.85
SCALE_BOUND_HI = 1.15

# Solver gates. The minimum drive distance is the dominant noise floor:
# RTK-fixed position is ~1 cm 1σ; over 10 m of drive that's < 0.2 % of
# the chord, well below the wheel-mismatch signal we're trying to
# resolve.
SOLVE_MIN_DISTANCE_M = 5.0
SOLVE_MIN_SAMPLES = 50  # 1 s @ 50 Hz telemetry

# Above this fitted radius the arc is indistinguishable from a straight
# line under RTK noise — chord deviation < 1 cm over a 10 m drive at
# r = 100 m. Use chord-based per-wheel reference (both wheels equal) in
# that regime; below it, use the arc model.
RADIUS_LARGE_M = 100.0


def wheel_cal_path():
    base = os.environ.get('PILOT_STATE_DIR') or tempfile.gettempdir()
    return os.path.join(base, WHEEL_CAL_FILENAME)


def load_wheel_cal(default=(1.0, 1.0)):
    """Read the persisted (scale_l, scale_r).

    Returns `((scale_l, scale_r), payload)` where `payload` is the parsed
    JSON dict (or None on missing/corrupt). Tolerates missing file,
    missing fields, and out-of-range values — a corrupt calibration must
    never block boot, the caller silently uses the (1.0, 1.0) default.
    """
    path = wheel_cal_path()
    try:
        with open(path, 'r') as f:
            data = json.load(f)
    except FileNotFoundError:
        return default, None
    except (OSError, json.JSONDecodeError):
        return default, None
    if not isinstance(data, dict):
        return default, None
    sl = data.get('scale_l')
    sr = data.get('scale_r')
    if not (isinstance(sl, (int, float)) and isinstance(sr, (int, float))):
        return default, None
    if not (SCALE_BOUND_LO <= sl <= SCALE_BOUND_HI
            and SCALE_BOUND_LO <= sr <= SCALE_BOUND_HI):
        return default, None
    return (float(sl), float(sr)), data


def save_wheel_cal(scale_l, scale_r, *, gps_distance_m,
                   encoder_left_m, encoder_right_m, samples,
                   arc_radius_m=None, arc_theta_rad=None):
    """Atomically persist (scale_l, scale_r) and provenance.

    Mirrors the battery_cal / antenna_offset write: tmp file + fsync +
    rename, so a crash mid-write can never leave a half-written file at
    the canonical path.
    """
    if not (SCALE_BOUND_LO <= scale_l <= SCALE_BOUND_HI
            and SCALE_BOUND_LO <= scale_r <= SCALE_BOUND_HI):
        raise ValueError(f'scale out of range: ({scale_l}, {scale_r})')
    payload = {
        'scale_l': round(float(scale_l), 5),
        'scale_r': round(float(scale_r), 5),
        'gps_distance_m': round(float(gps_distance_m), 3),
        'encoder_left_m': round(float(encoder_left_m), 3),
        'encoder_right_m': round(float(encoder_right_m), 3),
        'samples': int(samples),
        'calibrated_at': int(time.time() * 1000),
    }
    if arc_radius_m is not None and math.isfinite(arc_radius_m):
        payload['arc_radius_m'] = round(float(arc_radius_m), 3)
    if arc_theta_rad is not None and math.isfinite(arc_theta_rad):
        payload['arc_theta_rad'] = round(float(arc_theta_rad), 5)
    path = wheel_cal_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp'
    with open(tmp, 'w') as f:
        json.dump(payload, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    return payload


def solve_wheel_scales(*, samples_enu, encoder_left_m, encoder_right_m,
                       samples, track_width_m, gps_distance_m=None):
    """Closed-form per-wheel scale from a κ=0 commanded drive.

    Args:
        samples_enu: iterable of (e, n) GPS antenna positions captured
            during the drive. The first/last samples define the chord;
            the full set drives the circle fit when the path is curved.
        encoder_left_m: integrated raw encoder distance, left wheel.
        encoder_right_m: integrated raw encoder distance, right wheel.
        samples: count of telemetry samples (used by the min-sample gate).
        track_width_m: chassis track width; sets the inner/outer wheel
            arc-length differential when the drive is curved.
        gps_distance_m: optional pre-computed straight-line chord between
            start and end (haversine on lat/lon). If omitted, derived from
            samples_enu. Accepting it from the caller keeps parity with
            `_handle_cal_wheels`'s gating logic, which uses haversine.

    Returns:
        dict with {scale_l, scale_r, samples, gps_distance_m, arc_radius_m,
        arc_theta_rad, reason} on success (reason=None), or
        {reason: '<why>', ...partial fields} on failure. Failure causes:
        too few samples, chord too short, encoder near zero, derived scale
        outside the ±15 % bound, or fewer than 3 ENU samples.
    """
    if samples < SOLVE_MIN_SAMPLES:
        return {'reason': f'too few samples ({samples} < {SOLVE_MIN_SAMPLES})',
                'samples': samples}

    pts = list(samples_enu)
    if len(pts) < 3:
        return {'reason': f'too few ENU samples for arc fit ({len(pts)} < 3)',
                'samples': samples}

    e0, n0 = pts[0]
    e1, n1 = pts[-1]
    chord = math.hypot(e1 - e0, n1 - n0)
    if gps_distance_m is None:
        gps_distance_m = chord

    if gps_distance_m < SOLVE_MIN_DISTANCE_M:
        return {
            'reason': (f'GPS chord too short '
                       f'({gps_distance_m:.2f} m < '
                       f'{SOLVE_MIN_DISTANCE_M:.1f} m)'),
            'samples': samples,
        }
    if encoder_left_m <= 0.1 or encoder_right_m <= 0.1:
        return {
            'reason': (f'encoder displacement near zero '
                       f'(L={encoder_left_m:.2f} m, '
                       f'R={encoder_right_m:.2f} m) — wheel slip or '
                       f'stalled drive'),
            'samples': samples,
        }

    cx, cy, r, _rms = _fit_circle_kasa(pts)

    if not math.isfinite(r) or r >= RADIUS_LARGE_M:
        # Straight drive: both wheels travel the chord distance.
        ref_l = chord
        ref_r = chord
        arc_radius_out = None
        arc_theta_out = None
    else:
        # Curved drive: per-wheel reference is the corresponding rear-axle
        # arc length. θ is the signed angle swept at the circle centre
        # between the first and last samples — sign tells us which side
        # is inner. Antenna offset (~30 cm) shifts the antenna's effective
        # circle radius from the chassis radius by O(a_x² / R), which is
        # < 1 mm at r ≥ 30 m and absorbed into RTK chord noise.
        v0 = (e0 - cx, n0 - cy)
        v1 = (e1 - cx, n1 - cy)
        crs = v0[0] * v1[1] - v0[1] * v1[0]
        dot = v0[0] * v1[0] + v0[1] * v1[1]
        theta = math.atan2(crs, dot)
        if abs(theta) < 1e-6:
            # Degenerate — start/end coincide on the circle, treat as straight.
            ref_l = chord
            ref_r = chord
            arc_radius_out = r
            arc_theta_out = theta
        else:
            inner_dist = (r - track_width_m / 2.0) * abs(theta)
            outer_dist = (r + track_width_m / 2.0) * abs(theta)
            # `theta > 0` from atan2(cross, dot) means the centre is
            # counter-clockwise from the chord direction — the rover
            # arced LEFT, so the right wheel is on the outer side.
            if theta > 0:
                ref_l = inner_dist
                ref_r = outer_dist
            else:
                ref_l = outer_dist
                ref_r = inner_dist
            arc_radius_out = r
            arc_theta_out = theta

    scale_l = ref_l / encoder_left_m
    scale_r = ref_r / encoder_right_m

    if not (SCALE_BOUND_LO <= scale_l <= SCALE_BOUND_HI):
        return {
            'reason': (f'left scale {scale_l:.3f} outside '
                       f'[{SCALE_BOUND_LO}, {SCALE_BOUND_HI}]'),
            'scale_l': scale_l, 'scale_r': scale_r, 'samples': samples,
        }
    if not (SCALE_BOUND_LO <= scale_r <= SCALE_BOUND_HI):
        return {
            'reason': (f'right scale {scale_r:.3f} outside '
                       f'[{SCALE_BOUND_LO}, {SCALE_BOUND_HI}]'),
            'scale_l': scale_l, 'scale_r': scale_r, 'samples': samples,
        }
    return {
        'scale_l': scale_l,
        'scale_r': scale_r,
        'samples': samples,
        'gps_distance_m': gps_distance_m,
        'arc_radius_m': arc_radius_out,
        'arc_theta_rad': arc_theta_out,
        'reason': None,
    }
