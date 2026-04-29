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
  • Measure ground-truth distance from the GPS chord (haversine of
    start → end RTK-fixed positions). On a straight drive both wheels
    travel the same physical distance, so scale_wheel = gps_dist /
    encoder_dist.
  • Persist (scale_l, scale_r) at $PILOT_STATE_DIR/wheel_cal.json,
    bind-mounted from the host. mcu_bridge re-loads on next boot or on
    receipt of /rover/cmd/calibrate_wheels.

Persistence format mirrors battery_cal / antenna_offset:
    { "scale_l": 1.012, "scale_r": 0.987,
      "gps_distance_m": 10.21, "encoder_left_m": 10.09,
      "encoder_right_m": 10.35, "samples": 200,
      "calibrated_at": <ms epoch> }

Out-of-range scales (|1 − scale| > 15 %) are rejected on load and the
caller falls back to (1.0, 1.0); a wildly off scale signals encoder
slip / wheel loss / GPS error rather than legitimate wheel mismatch and
must not silently brick subsequent missions.
"""

import json
import os
import tempfile
import time


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
                   encoder_left_m, encoder_right_m, samples):
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
    path = wheel_cal_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp'
    with open(tmp, 'w') as f:
        json.dump(payload, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    return payload


def solve_wheel_scales(*, gps_distance_m, encoder_left_m, encoder_right_m,
                       samples):
    """Closed-form per-wheel scale from a straight-drive measurement.

    Returns dict with `scale_l`, `scale_r`, `reason=None` on success, or
    `{'reason': '<why>'}` on failure. Failure causes: too little drive
    distance, missing encoder displacement, or a derived scale outside
    the ±15 % bound (which signals encoder slip / GPS error, not
    legitimate mismatch).
    """
    if samples < SOLVE_MIN_SAMPLES:
        return {'reason': f'too few samples ({samples} < {SOLVE_MIN_SAMPLES})',
                'samples': samples}
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
    scale_l = gps_distance_m / encoder_left_m
    scale_r = gps_distance_m / encoder_right_m
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
        'reason': None,
    }
