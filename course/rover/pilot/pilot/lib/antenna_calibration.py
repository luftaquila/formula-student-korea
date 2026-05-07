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
from math import atan2, cos, sin, sqrt, pi


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

# Iterative refinement of GPS-heading-of-motion bias. The cal SCURVE
# samples chassis ψ via GPS heading-of-motion (snapped at every fix),
# but that heading equals the *antenna's* velocity direction, not the
# chassis: ψ_GPS = ψ_chassis + atan2(ω·a_x, v − ω·a_y) when the rover
# rotates. Using ψ_GPS as ψ_chassis without correction would
# underestimate a_x; the recorded chassis_xy was ALSO integrated using
# ψ_GPS rather than ψ_chassis, so a single-pass LSQ on the captured
# samples cancels the a_x signal at first order. Solve iteratively
# under the difference model:
#   v_obs(t) = (R(ψ_chassis(t)) − R(ψ_chassis(0))) · r
#   ψ_chassis(t) = ψ_GPS(t) − atan2(ω·a_x, v − ω·a_y)
#   chassis_xy(t) = antenna_obs(0) + ∫v·(cos ψ_chassis, sin ψ_chassis) dt
# Convergence depends on the initial r — the (0, 0) start is a fixed
# point at (0, r_y) for symmetric SCURVEs. Multi-start over a small
# grid of guesses and pick the basin with the lowest residual RMS.
SOLVE_REFINE_MAX_ITERS = 20
SOLVE_REFINE_TOL_M = 1e-3
# Seeds for the multi-start. (0, 0) catches the legacy/no-bias case
# (small offsets at chord centerline); the ±OFFSET_BOUND_M corners
# explore the remaining quadrants. We don't sweep finer because the
# cost is N samples × MAX_ITERS per seed and the basins are wide.
SOLVE_REFINE_SEEDS = (
    (0.0, 0.0),
    (0.3, 0.0),
    (-0.3, 0.0),
    (0.0, 0.3),
    (0.0, -0.3),
)


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
        samples: iterable of either 5- or 8-tuples per sample:
                 (chassis_x, chassis_y, chassis_psi,
                  antenna_obs_x, antenna_obs_y[, omega, v, t]).
                 The 8-tuple form (with ω, v, elapsed time) enables the
                 iterative GPS-heading-of-motion bias correction; the
                 5-tuple form runs only the single-pass fit and matches
                 the legacy on-disk dump format.

    Returns:
        dict with keys {'a_x', 'a_y', 'rms_residual_m', 'samples',
        'iterations', 'reason'} on success, or {'reason': '<why>'} on
        failure. Failure causes: not enough samples, ψ excitation below
        gate, residual above acceptance gate, offset bound violation.
    """
    samples = list(samples)
    n = len(samples)
    if n < SOLVE_MIN_SAMPLES:
        return {'reason': f'too few samples ({n} < {SOLVE_MIN_SAMPLES})',
                'samples': n}

    has_dynamics = n > 0 and len(samples[0]) >= 8

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

    def _legacy_fit(psi_per_sample):
        """Single-pass LSQ for legacy 5-tuple samples (no dynamics)."""
        sx = 0.0
        sy = 0.0
        for (s, psi_use) in zip(samples, psi_per_sample):
            u_x = s[3] - s[0]
            u_y = s[4] - s[1]
            sx += cos(psi_use) * u_x + sin(psi_use) * u_y
            sy += -sin(psi_use) * u_x + cos(psi_use) * u_y
        return sx / n, sy / n

    # Legacy path: no per-sample ω/v available, fall back to the simple
    # average-of-rotated-residuals LSQ. This matches the on-disk dump
    # format from older builds and the unit-test fixtures.
    if not has_dynamics:
        psi_used = [s[2] for s in samples]
        a_x, a_y = _legacy_fit(psi_used)
        iterations = 0
        cx_used = [s[0] for s in samples]
        cy_used = [s[1] for s in samples]
    else:
        # Difference-model LSQ with iterative chassis-trajectory
        # re-integration. The GPS-heading snap leaves two coupled
        # biases in the captured samples:
        #   1) The recorded chassis ψ equals the antenna's heading-
        #      of-motion, ψ_GPS = ψ_chassis + atan2(ω·a_x, v − ω·a_y).
        #   2) The recorded chassis position was integrated using
        #      ψ_GPS, not ψ_chassis, so it drifts away from the true
        #      rear-axle trajectory by an integral proportional to a_x.
        # Single-pass LSQ rotates the residuals by ψ_GPS and ends up
        # with a_x ≈ 0 because the position bias exactly cancels the
        # rotation signal at first order.
        #
        # The model that survives both biases:
        #   antenna_obs(t) − antenna_obs(0) − Δchassis(t) =
        #       (R(ψ_chassis(t)) − R(ψ_chassis(0))) · r
        # where Δchassis(t) is the chassis displacement re-integrated
        # using ψ_chassis(t) = ψ_GPS(t) − atan2(ω·a_x, v − ω·a_y).
        # The LSQ normal-matrix on this is a scalar 2(1 − cos(ψ − ψ_0))
        # times the identity, so the per-iteration step is:
        #     r_new = (Σ M_i^T v_obs_i) / Σ 2(1 − cos(ψ_i − ψ_0))
        # Iterate r → ψ_chassis(r) → Δchassis(r) → r' → … until
        # |Δr| < SOLVE_REFINE_TOL_M. The (0, 0) start is a fixed point
        # at (0, r_y) for sign-alternating SCURVEs, so the iteration
        # multi-starts over SOLVE_REFINE_SEEDS and picks the basin with
        # the lowest residual RMS.
        ae0 = samples[0][3]
        an0 = samples[0][4]

        def _refine_from(seed_x, seed_y):
            """Run iterative refinement from one initial guess.
            Returns (a_x, a_y, psi_corr, cx, cy, iterations, rms)."""
            ax = float(seed_x)
            ay = float(seed_y)
            psi_corr = [s[2] for s in samples]
            cx = [ae0] * n
            cy = [an0] * n
            its = 0
            sum_w = 0.0
            for it in range(SOLVE_REFINE_MAX_ITERS):
                # 1. Per-sample corrected ψ from current r.
                psi_corr = []
                for s in samples:
                    omega = s[5]
                    v = s[6]
                    denom = v - omega * ay
                    if abs(denom) < 0.05:
                        psi_corr.append(s[2])
                    else:
                        psi_corr.append(s[2] - atan2(omega * ax, denom))

                # 2. Re-integrate chassis displacement (anchored at the
                # antenna observation at t=0) using the corrected ψ.
                # `t` from the stored elapsed time gives dt rather than
                # guessing from sample order; a stalled GPS interval
                # would otherwise silently scale the integration.
                cx = [ae0]
                cy = [an0]
                for i in range(1, n):
                    dt = samples[i][7] - samples[i - 1][7]
                    if not (0.0 < dt < 0.5):
                        cx.append(cx[-1])
                        cy.append(cy[-1])
                        continue
                    v_i = samples[i][6]
                    # Trapezoidal: integrate at the midpoint heading
                    # between consecutive snaps.
                    mid = 0.5 * (psi_corr[i - 1] + psi_corr[i])
                    cx.append(cx[-1] + v_i * cos(mid) * dt)
                    cy.append(cy[-1] + v_i * sin(mid) * dt)

                # 3. LSQ on the difference model. M_i^T M_i is scalar,
                # so the normal equation reduces to a weighted sum.
                sx = 0.0
                sy = 0.0
                sum_w = 0.0
                psi_anchor = psi_corr[0]
                for i in range(n):
                    psi_i = psi_corr[i]
                    u_x = (samples[i][3] - ae0) - (cx[i] - ae0)
                    u_y = (samples[i][4] - an0) - (cy[i] - an0)
                    bxi = cos(psi_i) * u_x + sin(psi_i) * u_y
                    byi = -sin(psi_i) * u_x + cos(psi_i) * u_y
                    bx0 = cos(psi_anchor) * u_x + sin(psi_anchor) * u_y
                    by0 = -sin(psi_anchor) * u_x + cos(psi_anchor) * u_y
                    sx += bxi - bx0
                    sy += byi - by0
                    sum_w += 2.0 * (1.0 - cos(psi_i - psi_anchor))
                its = it + 1
                if sum_w < 1e-9:
                    return None
                nx = sx / sum_w
                ny = sy / sum_w
                if (abs(nx - ax) < SOLVE_REFINE_TOL_M
                        and abs(ny - ay) < SOLVE_REFINE_TOL_M):
                    ax, ay = nx, ny
                    break
                ax, ay = nx, ny

            # Compute final residual RMS under the difference model.
            rss = 0.0
            psi_anchor = psi_corr[0]
            for i in range(n):
                u_x = (samples[i][3] - ae0) - (cx[i] - ae0)
                u_y = (samples[i][4] - an0) - (cy[i] - an0)
                psi_i = psi_corr[i]
                pux = ((cos(psi_i) - cos(psi_anchor)) * ax
                       - (sin(psi_i) - sin(psi_anchor)) * ay)
                puy = ((sin(psi_i) - sin(psi_anchor)) * ax
                       + (cos(psi_i) - cos(psi_anchor)) * ay)
                rss += (u_x - pux) ** 2 + (u_y - puy) ** 2
            return ax, ay, psi_corr, cx, cy, its, sqrt(rss / n)

        # Multi-start: try every seed, keep the candidate that fits the
        # data best. Out-of-bounds candidates (offset > 1 m) are skipped
        # so a runaway iteration on a noisy seed can't win the
        # min-RMS contest.
        best = None
        total_iters = 0
        for sx, sy in SOLVE_REFINE_SEEDS:
            run = _refine_from(sx, sy)
            if run is None:
                continue
            ax_r, ay_r, psi_r, cx_r, cy_r, its_r, rms_r = run
            total_iters += its_r
            if not (-OFFSET_BOUND_M <= ax_r <= OFFSET_BOUND_M
                    and -OFFSET_BOUND_M <= ay_r <= OFFSET_BOUND_M):
                continue
            if best is None or rms_r < best[6]:
                best = (ax_r, ay_r, psi_r, cx_r, cy_r, its_r, rms_r)
        if best is None:
            return {
                'reason': 'no in-bounds seed converged',
                'samples': n, 'iterations': total_iters,
            }
        a_x, a_y, psi_used, cx_used, cy_used, iterations, _ = best

    # Bound check before residual calc — a wildly wrong offset usually
    # signals chassis-pose drift (encoder slip / yaw bias) rather than a
    # bad antenna position, and we'd rather refuse than persist a 2 m
    # offset that would brick subsequent missions.
    if not (-OFFSET_BOUND_M <= a_x <= OFFSET_BOUND_M
            and -OFFSET_BOUND_M <= a_y <= OFFSET_BOUND_M):
        return {'reason': f'offset out of bounds ({a_x:.2f}, {a_y:.2f})',
                'samples': n, 'a_x': a_x, 'a_y': a_y,
                'iterations': iterations}

    # Residual under the model that produced r. For has_dynamics this is
    # the difference model: u_i = (R(ψ_i) − R(ψ_anchor)) · r. For legacy
    # samples it's the original u_i = R(ψ_i) · r form.
    rss = 0.0
    if has_dynamics:
        psi_anchor = psi_used[0]
        for i in range(n):
            u_x = (samples[i][3] - samples[0][3]) - (cx_used[i] - samples[0][3])
            u_y = (samples[i][4] - samples[0][4]) - (cy_used[i] - samples[0][4])
            psi_i = psi_used[i]
            pred_u_x = (cos(psi_i) - cos(psi_anchor)) * a_x \
                - (sin(psi_i) - sin(psi_anchor)) * a_y
            pred_u_y = (sin(psi_i) - sin(psi_anchor)) * a_x \
                + (cos(psi_i) - cos(psi_anchor)) * a_y
            rss += (u_x - pred_u_x) ** 2 + (u_y - pred_u_y) ** 2
    else:
        for s, psi_use in zip(samples, psi_used):
            u_x = s[3] - s[0]
            u_y = s[4] - s[1]
            pred_u_x = cos(psi_use) * a_x - sin(psi_use) * a_y
            pred_u_y = sin(psi_use) * a_x + cos(psi_use) * a_y
            rss += (u_x - pred_u_x) ** 2 + (u_y - pred_u_y) ** 2
    rms = sqrt(rss / n)

    if rms > SOLVE_RMS_MAX_M:
        return {
            'reason': f'residual RMS too high ({rms*100:.1f} cm > '
                      f'{SOLVE_RMS_MAX_M*100:.0f} cm)',
            'samples': n, 'a_x': a_x, 'a_y': a_y, 'rms_residual_m': rms,
            'iterations': iterations,
        }

    return {
        'a_x': a_x, 'a_y': a_y,
        'rms_residual_m': rms,
        'samples': n,
        'iterations': iterations,
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
