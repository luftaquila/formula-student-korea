"""Antenna offset auto-calibration via constant-curvature circular drive.

The chassis kinematic model needs the body-frame position of the GPS antenna
relative to the rear-axle centre. Measuring with a tape works as a fallback
but is hard to keep accurate when the mast can move during deployment, so we
auto-calibrate by driving the rover in known-shape paths and fitting the
offset that explains the antenna trajectory.

Geometry
--------
While the rover orbits at constant curvature κ on flat ground, the rear-axle
centre traces a circle of radius R = 1/|κ| around some orbit centre O. The
chassis heading at orbit angle θ is ψ = θ + s·π/2, where s = sign(κ) (=+1
CCW, −1 CW). The antenna sits at body-frame offset r = (r_x, r_y) so its
world-frame position is

    a(t) = O + R·(cos θ, sin θ) + R(ψ)·r

Expanding R(ψ)·r and collecting cosines/sines of θ shows the antenna also
traces a CIRCLE about the same centre O, with radius

    ρ = sqrt((R − s·r_y)² + r_x²)

and a CONSTANT phase offset relative to the chassis orbit angle:

    φ = s·atan2(r_x, R − s·r_y)

Both ρ and φ are time-invariant, so they fall out of two ordinary algebraic
circle fits and one circular mean — no instantaneous heading required, no
iteration, no dependence on GPS heading-of-motion. Inverting:

    r_x = s·ρ·sin(s·φ)        (= ρ·sin φ for s=+1, −ρ·sin φ for s=−1)
    r_y = s·(R − ρ·cos(s·φ))  (= R − ρ·cos φ for s=+1, ρ·cos φ − R for s=−1)

Why this beats the SCURVE approach
----------------------------------
The previous SCURVE drive sampled chassis ψ from GPS heading-of-motion to
keep open-loop integration drift bounded, but the F9P's doppler-derived
heading lags actual rover heading by ~100 ms (a windowed average over recent
velocity vectors). On a high-lateral-acc SCURVE that lag rotates the recovered
r vector while preserving |r|, producing magnitude-correct but
direction-unstable offsets across runs (~25 cm direction variance against
0.3 m truth in field testing).

The circular method depends only on long-term orbit geometry — every per-
sample observation contributes ~1/N of its noise to the fitted (centre,
radius, phase), so a 100 ms heading lag on individual samples averages out
over multiple revolutions instead of biasing the result.

Drive pattern
-------------
Phase 1 (`STRAIGHT`):  drive κ = 0 for `straight_distance` metres at
    `calibration_speed`. Chord-regression of antenna ENU samples gives
    ψ_init with the same residual gates the mission-start calibration uses.
    The chord fit is the quality gate — if RTK is unstable or the chassis
    isn't tracking straight, we fail here rather than collecting a bad
    orbit.

Phase 2 (`CIRCLE`):    drive κ = ±1/R for N revolutions at
    `antenna_cal_speed`. Encoder-only chassis ψ integration (NO GPS
    heading snap) so the chassis trajectory stays in a consistent local
    frame; over the cal duration (~15-25 s) encoder ω drift on smooth
    ground is well under 1° and the orbit fit is robust to that. Sample
    every fresh GPS fix.

Persistence
-----------
JSON file at $PILOT_STATE_DIR/antenna_offset.json (host bind-mounted to
/var/lib/pilot in the rover image, same path family as battery_cal). Format:

    { "a_x": 0.301, "a_y": 0.045,
      "rms_residual_m": 0.012, "samples": 75,
      "drive_distance_m": 5.5, "calibrated_at": <ms epoch> }

Out-of-range values (|offset| > 1 m, |rms| > 0.5 m) are rejected on load and
the caller falls back to the YAML param defaults.
"""

import json
import math
import os
import tempfile
import time
from math import atan2, cos, sin, sqrt, pi, hypot

from pilot.lib.steering_calibration import _fit_circle_kasa


ANTENNA_OFFSET_FILENAME = 'antenna_offset.json'

# Sanity bounds for persisted values. The rover chassis is < 1 m on every
# axis, so anything outside this range is corrupt or wildly wrong.
OFFSET_BOUND_M = 1.0
RMS_BOUND_M = 0.5

# Solver acceptance gates.
SOLVE_MIN_SAMPLES = 30
# Was 0.05 (SCURVE-era). Circular drive's noise floor sits around 8-10 cm
# even when the recovered (a_x, a_y) is correct to a few cm — multipath +
# residual chassis-fit-vs-antenna-fit phase mismatch contribute systematic
# residuals that aren't actually offset error. Loosening to 10 cm keeps the
# bound-violation gate (|offset| > 1 m) catching real solver blowups while
# letting healthy circular cals persist automatically.
SOLVE_RMS_MAX_M = 0.10

# Circular-solver gates.
# Minimum total orbit-angle sweep on the chassis trace to trust the circle
# fit. Less than ~3/4 of a revolution is too short to nail down the centre.
SOLVE_CIRCLE_SWEEP_MIN_RAD = 1.5 * pi
# Per-circle-fit residual cap (applies to both chassis and antenna fits).
# Larger than this means the trajectory wasn't actually circular — encoder
# slip on chassis, GPS multipath on antenna, or someone bumped the rover.
SOLVE_CIRCLE_FIT_RMS_MAX_M = 0.10
# Mismatch between chassis and antenna orbit centres. They MUST be the same
# point in world frame; the chassis trace is integrated in a local frame
# rooted at the chord-fit ψ_init, and the antenna trace is in ENU rooted at
# the GPS start fix, so the two centres only coincide after we shift the
# chassis frame by (antenna_obs(0) − chassis_xy(0)). Larger residual flags
# a frame-alignment problem (ψ_init off, encoder drift) rather than just
# fit noise.
SOLVE_CIRCLE_CENTER_MISMATCH_M = 0.30
# Sane orbit-radius bounds. Chassis curvature limit (max ~1.2 1/m) puts
# physical R lower bound around 0.8 m; we drive at ~1.0 m by default. Cap
# at 5 m to catch a near-straight drive masquerading as a giant circle.
SOLVE_CIRCLE_RADIUS_MIN_M = 0.5
SOLVE_CIRCLE_RADIUS_MAX_M = 5.0


def antenna_offset_path():
    base = os.environ.get('PILOT_STATE_DIR') or tempfile.gettempdir()
    return os.path.join(base, ANTENNA_OFFSET_FILENAME)


def load_antenna_offset(default=(0.0, 0.0)):
    """Read the persisted (a_x, a_y).

    Returns a 2-tuple `(offset, payload)` where `offset` is the final value to
    use (defaults if the file is missing or unusable) and `payload` is the
    parsed JSON dict (or None). Tolerates missing file, missing fields, and
    out-of-range values — a corrupt calibration must never block the rover
    from booting; the caller silently uses YAML defaults instead.
    """
    path = antenna_offset_path()
    try:
        with open(path, 'r') as f:
            data = json.load(f)
    except FileNotFoundError:
        return default, None
    except (OSError, json.JSONDecodeError):
        return default, None
    if not isinstance(data, dict):
        return default, None
    a_x = data.get('a_x')
    a_y = data.get('a_y')
    if not (isinstance(a_x, (int, float)) and isinstance(a_y, (int, float))):
        return default, None
    if not (-OFFSET_BOUND_M <= a_x <= OFFSET_BOUND_M
            and -OFFSET_BOUND_M <= a_y <= OFFSET_BOUND_M):
        return default, None
    rms = data.get('rms_residual_m')
    if isinstance(rms, (int, float)) and rms > RMS_BOUND_M:
        return default, None
    return (float(a_x), float(a_y)), data


def save_antenna_offset(a_x, a_y, *, rms_residual_m, samples, drive_distance_m,
                        source='auto'):
    """Atomically persist the calibration JSON.

    Mirrors the battery_cal write: tmp file + fsync + rename, so a crash
    mid-write can never leave a half-written file at the canonical path.

    `source` is 'auto' (default — written by solve_antenna_offset's auto-cal
    drive) or 'manual' (operator typed a tape-measured value into the UI).
    The UI uses this to label the persisted offset and skip RMS / samples
    when irrelevant for manual entries.
    """
    if not (-OFFSET_BOUND_M <= a_x <= OFFSET_BOUND_M
            and -OFFSET_BOUND_M <= a_y <= OFFSET_BOUND_M):
        raise ValueError(f'offset out of range: ({a_x}, {a_y})')
    payload = {
        'a_x': round(float(a_x), 4),
        'a_y': round(float(a_y), 4),
        'rms_residual_m': round(float(rms_residual_m), 4),
        'samples': int(samples),
        'drive_distance_m': round(float(drive_distance_m), 3),
        'calibrated_at': int(time.time() * 1000),
        'source': source,
    }
    path = antenna_offset_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp'
    with open(tmp, 'w') as f:
        json.dump(payload, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    return payload


def _unwrap(angles):
    """Unwrap a sequence of angles into a continuous trace."""
    if not angles:
        return []
    out = [angles[0]]
    for a in angles[1:]:
        prev = out[-1]
        d = a - prev
        while d > pi:
            d -= 2.0 * pi
        while d < -pi:
            d += 2.0 * pi
        out.append(prev + d)
    return out


def _circular_mean(angles):
    """Mean of angles via unit-vector averaging. Returns a value in (-π, π]."""
    if not angles:
        return 0.0
    sx = sum(sin(a) for a in angles)
    sy = sum(cos(a) for a in angles)
    return atan2(sx, sy)


def solve_antenna_offset_circular(samples):
    """Closed-form (a_x, a_y) from a constant-curvature orbit drive.

    Args:
        samples: iterable of 5-tuples
                 (chassis_x, chassis_y, chassis_psi, antenna_obs_x,
                 antenna_obs_y), with chassis_xy and chassis_psi integrated
                 from encoders in a frame aligned to the antenna ENU origin
                 (i.e. the navigator anchors chassis_xy(0) at antenna_obs(0)
                 and ψ(0) at the chord-fit ψ_init). The chassis trajectory
                 must be a near-circular arc of at least ~3/4 revolution.

    Returns:
        dict with the calibration-result schema (a_x, a_y, rms_residual_m,
        samples, plus diagnostic circle_R_m, circle_rho_m, phase_phi_rad,
        rotation_sign) on success, or {'reason': '<why>'} on failure.
    """
    samples = list(samples)
    n = len(samples)
    if n < SOLVE_MIN_SAMPLES:
        return {'reason': f'too few samples ({n} < {SOLVE_MIN_SAMPLES})',
                'samples': n}

    chassis_pts = [(s[0], s[1]) for s in samples]
    antenna_pts = [(s[3], s[4]) for s in samples]

    Cxc, Cyc, R_c, rms_c = _fit_circle_kasa(chassis_pts)
    Cxa, Cya, rho, rms_a = _fit_circle_kasa(antenna_pts)

    if not (math.isfinite(R_c) and math.isfinite(rho)):
        return {'reason': 'chassis or antenna trace is collinear (no orbit)',
                'samples': n}

    if not (SOLVE_CIRCLE_RADIUS_MIN_M <= R_c <= SOLVE_CIRCLE_RADIUS_MAX_M):
        return {'reason': f'chassis orbit radius out of range ({R_c:.2f} m)',
                'samples': n, 'circle_R_m': R_c}
    if rho > SOLVE_CIRCLE_RADIUS_MAX_M:
        return {'reason': f'antenna orbit radius out of range ({rho:.2f} m)',
                'samples': n, 'circle_rho_m': rho}

    if rms_c > SOLVE_CIRCLE_FIT_RMS_MAX_M:
        return {'reason': (f'chassis trace not circular '
                           f'(fit rms {rms_c*100:.1f} cm)'),
                'samples': n}
    if rms_a > SOLVE_CIRCLE_FIT_RMS_MAX_M:
        return {'reason': (f'antenna trace not circular '
                           f'(fit rms {rms_a*100:.1f} cm)'),
                'samples': n}

    # Both circles must share the same world-frame centre (the orbit centre
    # is one geometric object). Their fitted positions should match within
    # GPS noise.
    centre_dist = hypot(Cxc - Cxa, Cyc - Cya)
    if centre_dist > SOLVE_CIRCLE_CENTER_MISMATCH_M:
        return {'reason': (f'chassis vs antenna orbit centres differ '
                           f'({centre_dist*100:.1f} cm)'),
                'samples': n,
                'centre_dist_m': centre_dist}

    # Per-sample orbit angles around each fitted centre, unwrapped.
    theta_c_raw = [atan2(cy - Cyc, cx - Cxc) for cx, cy in chassis_pts]
    theta_a_raw = [atan2(ay - Cya, ax - Cxa) for ax, ay in antenna_pts]
    theta_c = _unwrap(theta_c_raw)
    theta_a = _unwrap(theta_a_raw)

    sweep = theta_c[-1] - theta_c[0]
    if abs(sweep) < SOLVE_CIRCLE_SWEEP_MIN_RAD:
        return {'reason': (f'chassis orbit sweep too small '
                           f'({math.degrees(abs(sweep)):.0f}° < '
                           f'{math.degrees(SOLVE_CIRCLE_SWEEP_MIN_RAD):.0f}°)'),
                'samples': n}
    sign_rot = 1.0 if sweep > 0 else -1.0

    # Per-sample phase diff (already unwrapped continuously). Reduce to a
    # single angle via circular mean — no run-to-run sensitivity to which
    # branch the unwrapper picks.
    diffs = [theta_a[i] - theta_c[i] for i in range(n)]
    phi_signed = _circular_mean(diffs)

    # Inverse:
    #   CCW (s=+1):  φ_signed = +atan2(r_x, R − r_y)
    #     ⇒ r_x = ρ·sin φ_signed,   r_y = R − ρ·cos φ_signed
    #   CW (s=−1):  φ_signed = −atan2(r_x, R + r_y)
    #     ⇒ r_x = −ρ·sin φ_signed,  r_y = ρ·cos φ_signed − R
    if sign_rot > 0:
        a_x = rho * sin(phi_signed)
        a_y = R_c - rho * cos(phi_signed)
    else:
        a_x = -rho * sin(phi_signed)
        a_y = rho * cos(phi_signed) - R_c

    if not (-OFFSET_BOUND_M <= a_x <= OFFSET_BOUND_M
            and -OFFSET_BOUND_M <= a_y <= OFFSET_BOUND_M):
        return {'reason': f'offset out of bounds ({a_x:.2f}, {a_y:.2f})',
                'samples': n, 'a_x': a_x, 'a_y': a_y,
                'circle_R_m': R_c, 'circle_rho_m': rho,
                'phase_phi_rad': phi_signed, 'rotation_sign': sign_rot}

    # Residual: predict each antenna obs from chassis orbit angle + phase
    # offset, ρ, and centre. Captures rigid-body kinematic consistency
    # between the two traces.
    rss = 0.0
    for i in range(n):
        theta_pred = theta_c[i] + phi_signed
        ax_pred = Cxa + rho * cos(theta_pred)
        ay_pred = Cya + rho * sin(theta_pred)
        rss += ((antenna_pts[i][0] - ax_pred) ** 2
                + (antenna_pts[i][1] - ay_pred) ** 2)
    rms = sqrt(rss / n)

    if rms > SOLVE_RMS_MAX_M:
        return {
            'reason': f'residual RMS too high ({rms*100:.1f} cm > '
                      f'{SOLVE_RMS_MAX_M*100:.0f} cm)',
            'samples': n, 'a_x': a_x, 'a_y': a_y, 'rms_residual_m': rms,
            'circle_R_m': R_c, 'circle_rho_m': rho,
            'phase_phi_rad': phi_signed, 'rotation_sign': sign_rot,
        }

    return {
        'a_x': a_x, 'a_y': a_y,
        'rms_residual_m': rms,
        'samples': n,
        'circle_R_m': R_c,
        'circle_rho_m': rho,
        'phase_phi_rad': phi_signed,
        'rotation_sign': sign_rot,
        'centre_dist_m': centre_dist,
        'reason': None,
    }
