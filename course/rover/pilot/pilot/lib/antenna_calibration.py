"""Antenna offset auto-calibration.

The chassis kinematic model needs the body-frame position of the GPS antenna
relative to the rear axle. Measuring it with a tape works (and is the safest
fallback), but on a chassis where the antenna mast can move during deployment
or transport, an automatic procedure is more reliable.

Math
----
For each sample collected during a calibration drive — chassis pose
(x_c, y_c, ψ) integrated from MCU encoders, and observed antenna ENU position
(a_obs_x, a_obs_y) from GPS — the rigid-body link is:

    [a_obs_x]   [x_c]                        [a_x]
    [a_obs_y] = [y_c] + R(ψ) ·               [a_y]

Stacking N samples and writing u_i = a_obs_i − chassis_xy_i gives an
overdetermined system M · [a_x; a_y] = u (2N rows, 2 columns) where each
2×2 block of M is R(ψ_i). The Gauss–Newton normal matrix is

    M^T M = Σ_i R(ψ_i)^T R(ψ_i) = N · I_2

so the closed-form solution is

    [a_x]   1
    [a_y] = N · Σ_i R(ψ_i)^T · u_i

i.e. the body-frame antenna-offset estimate from each sample is just R(-ψ_i)
applied to its world-frame residual, and we average. No iteration, no
linearisation; the only assumption is that ψ_i is reasonably accurate during
the drive (which is why we bootstrap from a straight chord first and trust
encoders for the brief excitation phase).

Observability: the system is rank-deficient when ψ is constant (pure
straight drive can't separate a_x and a_y because both contribute the same
constant world-frame offset). The drive pattern below sweeps κ through both
signs to break the degeneracy.

Drive pattern
-------------
Phase 1 (`STRAIGHT`):  drive κ = 0 for `straight_distance` metres at
    `calibration_speed`. Chord-regression of antenna ENU samples gives ψ_init
    with the same residual gates the mission-start calibration uses.

Phase 2 (`SCURVE`):    drive κ(t) sinusoidal with sign alternating across
    periods — period k uses (-1)^k · κ_max · sin(2π · t / period). ψ nets
    back to ψ_init at the end of every full period (sin integrates to 0),
    AND because consecutive periods swing opposite ways, the lateral drift
    accumulated in period k is cancelled by period k+1. With an even number
    of periods the rover ends on the same straight line it started on.

    The naïve all-positive sin (no sign flip) keeps ψ entirely on one side
    of ψ_init for the whole drive — ∫sin dt = (1−cos)/(2π/T) ≥ 0 always —
    so the rover steadily drifts ~v²·κ_max·T/(2π) m laterally per period
    and accumulates a non-rigid chassis-vs-antenna trace that blows up the
    LSQ residual (54 cm RMS on a v=1.2, T=4, periods=2 run).

    Encoder integration over the brief drive (~10 s) accumulates < 1° drift
    on smooth ground. Use an EVEN periods count for full lateral cancellation;
    odd counts leave one uncancelled lobe.

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
from math import cos, sin, sqrt, pi


ANTENNA_OFFSET_FILENAME = 'antenna_offset.json'

# Sanity bounds for persisted values. The rover chassis is < 1 m on every
# axis, so anything outside this range is corrupt or wildly wrong.
OFFSET_BOUND_M = 1.0
RMS_BOUND_M = 0.5

# Solver acceptance gates.
SOLVE_MIN_SAMPLES = 30
SOLVE_RMS_MAX_M = 0.05
# Minimum ψ excitation across the sample set. The closed-form solver
# itself is well-defined for any ψ (R^T R = I), but it silently absorbs
# chassis-pose origin error into the offset estimate when the drive
# fails to rotate the rover. The S-curve drive (κ_max=0.5, v=0.5 m/s,
# T=4 s) produces ~18° peak ψ excursion in normal operation; this gate
# (~8.6°) flags a SCURVE that didn't execute (encoder stall, motor
# failure, mid-drive E-Stop) without rejecting healthy runs.
SOLVE_PSI_SPREAD_MIN_RAD = 0.15


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


def solve_antenna_offset(samples):
    """Closed-form LSQ for (a_x, a_y) given calibration-drive samples.

    Args:
        samples: iterable of (chassis_x, chassis_y, chassis_psi,
                              antenna_obs_x, antenna_obs_y) tuples.

    Returns:
        dict with keys {'a_x', 'a_y', 'rms_residual_m', 'samples',
        'reason'} on success, or {'reason': '<why>'} on failure. Failure
        causes: not enough samples, residual above acceptance gate.
    """
    samples = list(samples)
    n = len(samples)
    if n < SOLVE_MIN_SAMPLES:
        return {'reason': f'too few samples ({n} < {SOLVE_MIN_SAMPLES})',
                'samples': n}

    # ψ-excitation gate. Unwrap each sample's ψ relative to the first so
    # crossing the ±π boundary doesn't artificially inflate the spread.
    psi0 = samples[0][2]
    unwrapped = []
    for s in samples:
        d = s[2] - psi0
        # Wrap to [-π, π] then offset by psi0 to get a continuous trace.
        while d > pi:
            d -= 2.0 * pi
        while d < -pi:
            d += 2.0 * pi
        unwrapped.append(psi0 + d)
    psi_spread = max(unwrapped) - min(unwrapped)
    if psi_spread < SOLVE_PSI_SPREAD_MIN_RAD:
        return {
            'reason': (f'insufficient ψ excitation '
                       f'({math.degrees(psi_spread):.1f}° < '
                       f'{math.degrees(SOLVE_PSI_SPREAD_MIN_RAD):.1f}°)'),
            'samples': n,
        }

    sum_bx = 0.0
    sum_by = 0.0
    rotated = []  # cache per-sample R(-ψ)·u for the residual pass
    for cx, cy, psi, ax, ay in samples:
        u_x = ax - cx
        u_y = ay - cy
        # Body-frame offset implied by THIS sample. Averaging these is the
        # closed-form LSQ — see module docstring.
        bx = cos(psi) * u_x + sin(psi) * u_y
        by = -sin(psi) * u_x + cos(psi) * u_y
        sum_bx += bx
        sum_by += by
        rotated.append((bx, by, psi, u_x, u_y))

    a_x = sum_bx / n
    a_y = sum_by / n

    # Bound check before residual calc — a wildly wrong offset usually
    # signals chassis-pose drift (encoder slip / yaw bias) rather than a
    # bad antenna position, and we'd rather refuse than persist a 2 m
    # offset that would brick subsequent missions.
    if not (-OFFSET_BOUND_M <= a_x <= OFFSET_BOUND_M
            and -OFFSET_BOUND_M <= a_y <= OFFSET_BOUND_M):
        return {'reason': f'offset out of bounds ({a_x:.2f}, {a_y:.2f})',
                'samples': n, 'a_x': a_x, 'a_y': a_y}

    rss = 0.0
    for _bx, _by, psi, u_x, u_y in rotated:
        pred_u_x = cos(psi) * a_x - sin(psi) * a_y
        pred_u_y = sin(psi) * a_x + cos(psi) * a_y
        rss += (u_x - pred_u_x) ** 2 + (u_y - pred_u_y) ** 2
    rms = sqrt(rss / n)

    if rms > SOLVE_RMS_MAX_M:
        return {
            'reason': f'residual RMS too high ({rms*100:.1f} cm > '
                      f'{SOLVE_RMS_MAX_M*100:.0f} cm)',
            'samples': n, 'a_x': a_x, 'a_y': a_y, 'rms_residual_m': rms,
        }

    return {
        'a_x': a_x, 'a_y': a_y,
        'rms_residual_m': rms,
        'samples': n,
        'reason': None,
    }


def scurve_curvature(elapsed_s, kappa_max, period_s):
    """Sign-alternating S-curve κ(t).

    κ(t) = (-1)^k · κ_max · sin(2π · t / period_s) for the kth period.
    Each period nets zero yaw (sin integral over a period is zero); the
    sign flip across periods cancels lateral drift over even period counts.
    See module docstring for the geometry.

    The flip introduces a corner in dκ/dt at period boundaries (κ itself
    stays continuous, hitting 0 at the boundary). The servo slew limit is
    well above the kink rate so this is benign in practice.
    """
    if period_s <= 0:
        return 0.0
    period_idx = int(elapsed_s // period_s)
    sign = -1.0 if (period_idx % 2) else 1.0
    return sign * kappa_max * math.sin(2.0 * math.pi * elapsed_s / period_s)
