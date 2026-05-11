"""Dubins curves: shortest forward-only path between two oriented poses.

Given a start pose (x_s, y_s, psi_s), an end pose (x_e, y_e, psi_e), and a
minimum turning radius rho, computes the shortest path the chassis can drive
(forward only) under a constant-curvature constraint. Three primitives:

    L = left turn arc  (CCW, kappa = +1/rho)
    R = right turn arc (CW,  kappa = -1/rho)
    S = straight line  (kappa = 0)

Dubins (1957) proved the optimum is one of six 3-primitive types:
    {LSL, RSR, LSR, RSL, RLR, LRL}

This module implements the closed-form solver from
    Shkel & Lumelsky, "Classification of the Dubins set" (2001)
and returns the shortest valid candidate.

API:
    plan(start, end, rho) -> DubinsPath
        start, end: (x, y, psi) triples (psi in math frame, CCW positive)
        rho: minimum turning radius (m, positive)
        DubinsPath: object with .length, .type, .segments where segments is a
        list of (kind, length, start_pose, end_pose) tuples and kind is one of
        'L', 'R', 'S'.

    sample(path, step_m) -> list of (x, y, psi)
        Discretises the path at fixed arc-length steps.
"""

from math import cos, sin, atan2, sqrt, pi, fmod, acos, hypot

TWO_PI = 2.0 * pi


def _mod2pi(theta):
    """Wrap to [0, 2pi)."""
    r = fmod(theta, TWO_PI)
    if r < 0:
        r += TWO_PI
    return r


def _wrap(theta):
    """Wrap to (-pi, pi]."""
    r = fmod(theta + pi, TWO_PI)
    if r <= 0:
        r += TWO_PI
    return r - pi


# Each candidate returns (t, p, q) in normalised units (multiplied by rho to
# get arc length), or None if the geometry doesn't admit that combination.

def _lsl(alpha, beta, d):
    sa, sb = sin(alpha), sin(beta)
    ca, cb = cos(alpha), cos(beta)
    tmp0 = d + sa - sb
    p_sq = 2 + d * d - 2 * cos(alpha - beta) + 2 * d * (sa - sb)
    if p_sq < -1e-9:
        return None
    tmp1 = atan2(cb - ca, tmp0)
    t = _mod2pi(-alpha + tmp1)
    p = sqrt(max(0.0, p_sq))
    q = _mod2pi(beta - tmp1)
    return t, p, q


def _rsr(alpha, beta, d):
    sa, sb = sin(alpha), sin(beta)
    ca, cb = cos(alpha), cos(beta)
    tmp0 = d - sa + sb
    p_sq = 2 + d * d - 2 * cos(alpha - beta) + 2 * d * (sb - sa)
    if p_sq < -1e-9:
        return None
    tmp1 = atan2(ca - cb, tmp0)
    t = _mod2pi(alpha - tmp1)
    p = sqrt(max(0.0, p_sq))
    q = _mod2pi(-beta + tmp1)
    return t, p, q


def _lsr(alpha, beta, d):
    sa, sb = sin(alpha), sin(beta)
    ca, cb = cos(alpha), cos(beta)
    p_sq = -2 + d * d + 2 * cos(alpha - beta) + 2 * d * (sa + sb)
    if p_sq < -1e-9:
        return None
    p = sqrt(max(0.0, p_sq))
    tmp1 = atan2(-ca - cb, d + sa + sb) - atan2(-2.0, p)
    t = _mod2pi(-alpha + tmp1)
    q = _mod2pi(-_mod2pi(beta) + tmp1)
    return t, p, q


def _rsl(alpha, beta, d):
    sa, sb = sin(alpha), sin(beta)
    ca, cb = cos(alpha), cos(beta)
    p_sq = d * d - 2 + 2 * cos(alpha - beta) - 2 * d * (sa + sb)
    if p_sq < -1e-9:
        return None
    p = sqrt(max(0.0, p_sq))
    tmp1 = atan2(ca + cb, d - sa - sb) - atan2(2.0, p)
    t = _mod2pi(alpha - tmp1)
    q = _mod2pi(beta - tmp1)
    return t, p, q


def _rlr(alpha, beta, d):
    sa, sb = sin(alpha), sin(beta)
    ca, cb = cos(alpha), cos(beta)
    tmp = (6.0 - d * d + 2.0 * cos(alpha - beta) + 2.0 * d * (sa - sb)) / 8.0
    if abs(tmp) > 1:
        return None
    p = _mod2pi(TWO_PI - acos(tmp))
    t = _mod2pi(alpha - atan2(ca - cb, d - sa + sb) + p / 2.0)
    q = _mod2pi(alpha - beta - t + p)
    return t, p, q


def _lrl(alpha, beta, d):
    sa, sb = sin(alpha), sin(beta)
    ca, cb = cos(alpha), cos(beta)
    tmp = (6.0 - d * d + 2.0 * cos(alpha - beta) + 2.0 * d * (-sa + sb)) / 8.0
    if abs(tmp) > 1:
        return None
    p = _mod2pi(TWO_PI - acos(tmp))
    t = _mod2pi(-alpha - atan2(ca - cb, d + sa - sb) + p / 2.0)
    q = _mod2pi(_mod2pi(beta) - alpha - t + p)
    return t, p, q


_PLANNERS = (
    ('LSL', _lsl, ('L', 'S', 'L')),
    ('RSR', _rsr, ('R', 'S', 'R')),
    ('LSR', _lsr, ('L', 'S', 'R')),
    ('RSL', _rsl, ('R', 'S', 'L')),
    ('RLR', _rlr, ('R', 'L', 'R')),
    ('LRL', _lrl, ('L', 'R', 'L')),
)


class DubinsPath:
    """A planned Dubins path. Lengths in meters, all poses in (x, y, psi)."""

    __slots__ = ('type', 'length', 'segments', 'rho', 'start')

    def __init__(self, type_, length, segments, rho, start):
        self.type = type_
        self.length = length
        # Each segment: (kind, length, start_pose, end_pose). length is in
        # meters (arc length for L/R, line length for S).
        self.segments = segments
        self.rho = rho
        self.start = start

    def __repr__(self):  # pragma: no cover - debug only
        return f'DubinsPath({self.type}, length={self.length:.3f}m)'


def _advance(pose, kind, length, rho):
    """Apply a primitive of given kind+length starting from `pose`."""
    x, y, psi = pose
    if kind == 'S':
        return (x + length * cos(psi),
                y + length * sin(psi),
                psi)
    # Arc length = rho * |dpsi|, with sign by kind.
    dpsi = length / rho
    if kind == 'R':
        dpsi = -dpsi
    # Centre of the turning circle is perpendicular to the heading on the
    # turn-side.
    if kind == 'L':
        cx = x - rho * sin(psi)
        cy = y + rho * cos(psi)
    else:  # 'R'
        cx = x + rho * sin(psi)
        cy = y - rho * cos(psi)
    psi_end = _wrap(psi + dpsi)
    if kind == 'L':
        x_end = cx + rho * sin(psi_end)
        y_end = cy - rho * cos(psi_end)
    else:
        x_end = cx - rho * sin(psi_end)
        y_end = cy + rho * cos(psi_end)
    return (x_end, y_end, psi_end)


def plan(start, end, rho):
    """Compute the shortest Dubins path from start to end with turning radius rho.

    Returns a DubinsPath, or None if no path is admissible (shouldn't happen
    for valid rho > 0 since LSR/RSL always have a solution geometrically).
    """
    if rho <= 0:
        raise ValueError('rho must be positive')

    x_s, y_s, psi_s = start
    x_e, y_e, psi_e = end
    dx = x_e - x_s
    dy = y_e - y_s
    D = hypot(dx, dy)
    d = D / rho
    theta = atan2(dy, dx) if D > 1e-9 else 0.0
    alpha = _mod2pi(psi_s - theta)
    beta = _mod2pi(psi_e - theta)

    best = None
    for name, fn, kinds in _PLANNERS:
        result = fn(alpha, beta, d)
        if result is None:
            continue
        t, p, q = result
        # In Shkel & Lumelsky each of (t, p, q) is the parameter of its
        # primitive — angle (rad) for L/R, normalised length for S — and
        # the metric length of every primitive is rho * parameter.
        l1 = t * rho
        l2 = p * rho
        l3 = q * rho
        total = l1 + l2 + l3
        if best is None or total < best[0]:
            best = (total, name, (l1, l2, l3), kinds)

    if best is None:
        return None
    total, name, lens, kinds = best
    # Build segment list with poses
    segments = []
    cur = (x_s, y_s, psi_s)
    for kind, ell in zip(kinds, lens):
        nxt = _advance(cur, kind, ell, rho)
        segments.append((kind, ell, cur, nxt))
        cur = nxt
    return DubinsPath(name, total, segments, rho, (x_s, y_s, psi_s))


def sample(path, step_m):
    """Discretise a Dubins path at fixed arc-length steps."""
    if path is None:
        return []
    if step_m <= 0:
        raise ValueError('step_m must be positive')
    pts = [path.start]
    accumulated = 0.0
    for kind, ell, seg_start, _ in path.segments:
        if ell <= 0:
            continue
        # Cover this segment in steps of `step_m`, accounting for any
        # leftover distance from the previous segment.
        s = step_m - accumulated
        while s < ell:
            pts.append(_advance(seg_start, kind, s, path.rho))
            s += step_m
        accumulated = ell - (s - step_m)
    pts.append(path.segments[-1][3])
    return pts
