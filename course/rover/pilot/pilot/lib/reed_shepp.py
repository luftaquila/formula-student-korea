"""Reed-Shepp shortest path between two oriented poses.

Implements the full 48-candidate Reed-Shepp planner from:

    Reeds, J.A. and Shepp, L.A. (1990).
    "Optimal paths for a car that goes both forwards and backwards."
    Pacific Journal of Mathematics, 145(2), 367-393.

The chassis is modelled as a car under a minimum-turning-radius
constraint that can drive forwards or backwards. The Reed-Shepp paper
proves the optimum is one of 48 specific path patterns (12 base words
× 4 transformations: identity, time-flip τ, reflect σ, and τ∘σ).

The 12 base-word solvers and the closed-form parameter formulas in
this module are derived from AtsushiSakai's PythonRobotics
(``PathPlanning/ReedsSheppPath/reeds_shepp_path_planning.py``;
MIT-licensed, https://github.com/AtsushiSakai/PythonRobotics), which
is the canonical reference Python implementation used in the
literature. The matplotlib / numpy dependencies in the upstream
have been removed; angle utilities are recoded with math.fmod so
the module has no external dependencies beyond the standard library
plus pilot.lib.* helpers. The interface and return types match
``pilot.lib.dubins`` so the path planner can swap them transparently.

License notice for the parts derived from PythonRobotics:
    MIT License
    Copyright (c) 2016- Atsushi Sakai
    See https://github.com/AtsushiSakai/PythonRobotics/blob/master/LICENSE

API
---
    plan(start, end, rho) -> ReedSheppPath
        start, end : (x, y, psi) in math frame (psi CCW positive).
        rho        : chassis minimum turning radius (m), > 0.
        Returns the shortest admissible path as a ReedSheppPath whose
        ``.segments`` list is ordered (kind, signed_length,
        start_pose, end_pose) tuples:
          - kind            ∈ {'L', 'S', 'R'}
          - signed_length   metres, positive forward, negative reverse
          - start_pose/end_pose  chassis pose at segment endpoints
        Returns None only if rho is non-positive (Reed-Shepp 1990
        Theorem 1: a path always exists for any reachable goal under
        rho > 0).

    sample(path, step_m) -> list of (x, y, psi, motion_sign)
        Discretises path at fixed arc-length steps. motion_sign is +1
        forward / -1 reverse for each sample. First sample is the
        path start, last is the path end.
"""

from math import cos, sin, atan2, sqrt, pi, fmod, acos, asin, hypot

TWO_PI = 2.0 * pi


def _wrap(theta):
    """Wrap to (-pi, pi]."""
    r = fmod(theta + pi, TWO_PI)
    if r <= 0:
        r += TWO_PI
    return r - pi


def _mod2pi(theta):
    """Reeds-Shepp's mod2pi: wraps to (-pi, pi].

    Note this is NOT [0, 2pi) — the closed-form solvers below expect
    the (-pi, pi] convention so they can use sign tests on (t, u, v)
    to filter inadmissible branches.
    """
    return _wrap(theta)


def _polar(x, y):
    return hypot(x, y), atan2(y, x)


# ── 12 base-word solvers ────────────────────────────────────────────
#
# Each takes the goal (x, y, phi) in the unit-radius start frame and
# returns either (False, [], []) or (True, [t, u, v, ...], [kinds])
# where the parameters are signed arc/line lengths (in the normalised
# frame) and kinds is a list of 'L'/'S'/'R' primitives. Sign of each
# parameter encodes motion direction (positive forward, negative reverse).

def _LSL(x, y, phi):
    u, t = _polar(x - sin(phi), y - 1.0 + cos(phi))
    if 0.0 <= t <= pi:
        v = _mod2pi(phi - t)
        if 0.0 <= v <= pi:
            return True, [t, u, v], ['L', 'S', 'L']
    return False, [], []


def _LSR(x, y, phi):
    u1sq, t1 = _polar(x + sin(phi), y - 1.0 - cos(phi))
    u1sq = u1sq * u1sq
    if u1sq >= 4.0:
        u = sqrt(u1sq - 4.0)
        theta = atan2(2.0, u)
        t = _mod2pi(t1 + theta)
        v = _mod2pi(t - phi)
        if t >= 0.0 and v >= 0.0:
            return True, [t, u, v], ['L', 'S', 'R']
    return False, [], []


def _LXRXL(x, y, phi):
    """L+ R- L+ : 'CCC' (Reed-Shepp word 8.3 / 8.4 branch a)."""
    zeta = x - sin(phi)
    eta = y - 1.0 + cos(phi)
    u1, theta = _polar(zeta, eta)
    if u1 <= 4.0:
        A = acos(0.25 * u1)
        t = _mod2pi(A + theta + pi / 2.0)
        u = _mod2pi(pi - 2.0 * A)
        v = _mod2pi(phi - t - u)
        return True, [t, -u, v], ['L', 'R', 'L']
    return False, [], []


def _LXRL(x, y, phi):
    """L+ R- L- : 'CCC' branch b."""
    zeta = x - sin(phi)
    eta = y - 1.0 + cos(phi)
    u1, theta = _polar(zeta, eta)
    if u1 <= 4.0:
        A = acos(0.25 * u1)
        t = _mod2pi(A + theta + pi / 2.0)
        u = _mod2pi(pi - 2.0 * A)
        v = _mod2pi(-phi + t + u)
        return True, [t, -u, -v], ['L', 'R', 'L']
    return False, [], []


def _LRXL(x, y, phi):
    """L+ R+ L- : 'CCC' branch c."""
    zeta = x - sin(phi)
    eta = y - 1.0 + cos(phi)
    u1, theta = _polar(zeta, eta)
    if u1 <= 4.0:
        u = acos(1.0 - u1 * u1 * 0.125)
        A = asin(2.0 * sin(u) / u1)
        t = _mod2pi(-A + theta + pi / 2.0)
        v = _mod2pi(t - u - phi)
        return True, [t, u, -v], ['L', 'R', 'L']
    return False, [], []


def _LRXLR(x, y, phi):
    """L+ R+ L- R- : 'CCCC' (word 8.7)."""
    zeta = x + sin(phi)
    eta = y - 1.0 - cos(phi)
    u1, theta = _polar(zeta, eta)
    if u1 <= 2.0:
        A = acos((u1 + 2.0) * 0.25)
        t = _mod2pi(theta + A + pi / 2.0)
        u = _mod2pi(A)
        v = _mod2pi(phi - t + 2.0 * u)
        if t >= 0.0 and u >= 0.0 and v >= 0.0:
            return True, [t, u, -u, -v], ['L', 'R', 'L', 'R']
    return False, [], []


def _LXRLXR(x, y, phi):
    """L+ R- L- R+ : 'CCCC' alternative branch."""
    zeta = x + sin(phi)
    eta = y - 1.0 - cos(phi)
    u1, _ = _polar(zeta, eta)
    u2 = (20.0 - u1 * u1) / 16.0
    if 0.0 <= u2 <= 1.0:
        u = acos(u2)
        A = asin(2.0 * sin(u) / u1)
        t = _mod2pi(atan2(eta, zeta) + A + pi / 2.0)
        v = _mod2pi(t - phi)
        if t >= 0.0 and v >= 0.0:
            return True, [t, -u, -u, v], ['L', 'R', 'L', 'R']
    return False, [], []


def _LXR90SL(x, y, phi):
    """L+ R-(π/2) S- L- : 'CCSC' (word 8.9 family)."""
    zeta = x - sin(phi)
    eta = y - 1.0 + cos(phi)
    u1, theta = _polar(zeta, eta)
    if u1 >= 2.0:
        u = sqrt(u1 * u1 - 4.0) - 2.0
        A = atan2(2.0, sqrt(u1 * u1 - 4.0))
        t = _mod2pi(theta + A + pi / 2.0)
        v = _mod2pi(t - phi + pi / 2.0)
        if t >= 0.0 and v >= 0.0:
            return True, [t, -pi / 2.0, -u, -v], ['L', 'R', 'S', 'L']
    return False, [], []


def _LSR90XL(x, y, phi):
    """L+ S+ R+(π/2) L- : 'CSCC' (word 8.10 family)."""
    zeta = x - sin(phi)
    eta = y - 1.0 + cos(phi)
    u1, theta = _polar(zeta, eta)
    if u1 >= 2.0:
        u = sqrt(u1 * u1 - 4.0) - 2.0
        A = atan2(sqrt(u1 * u1 - 4.0), 2.0)
        t = _mod2pi(theta - A + pi / 2.0)
        v = _mod2pi(t - phi - pi / 2.0)
        if t >= 0.0 and v >= 0.0:
            return True, [t, u, pi / 2.0, -v], ['L', 'S', 'R', 'L']
    return False, [], []


def _LXR90SR(x, y, phi):
    """L+ R-(π/2) S- R- : 'CCSC' second family."""
    zeta = x + sin(phi)
    eta = y - 1.0 - cos(phi)
    u1, theta = _polar(zeta, eta)
    if u1 >= 2.0:
        t = _mod2pi(theta + pi / 2.0)
        u = u1 - 2.0
        v = _mod2pi(phi - t - pi / 2.0)
        if t >= 0.0 and v >= 0.0:
            return True, [t, -pi / 2.0, -u, -v], ['L', 'R', 'S', 'R']
    return False, [], []


def _LSL90XR(x, y, phi):
    """L+ S+ L+(π/2) R- : 'CSCC' second family."""
    zeta = x + sin(phi)
    eta = y - 1.0 - cos(phi)
    u1, theta = _polar(zeta, eta)
    if u1 >= 2.0:
        t = _mod2pi(theta)
        u = u1 - 2.0
        v = _mod2pi(phi - t - pi / 2.0)
        if t >= 0.0 and v >= 0.0:
            return True, [t, u, pi / 2.0, -v], ['L', 'S', 'L', 'R']
    return False, [], []


def _LXR90SL90XR(x, y, phi):
    """L+ R-(π/2) S- L-(π/2) R+ : 'CCSCC' (word 8.11)."""
    zeta = x + sin(phi)
    eta = y - 1.0 - cos(phi)
    u1, theta = _polar(zeta, eta)
    if u1 >= 4.0:
        u = sqrt(u1 * u1 - 4.0) - 4.0
        A = atan2(2.0, sqrt(u1 * u1 - 4.0))
        t = _mod2pi(theta + A + pi / 2.0)
        v = _mod2pi(t - phi)
        if t >= 0.0 and v >= 0.0:
            return True, [t, -pi / 2.0, -u, -pi / 2.0, v], \
                   ['L', 'R', 'S', 'L', 'R']
    return False, [], []


_PATH_FUNCTIONS = (
    _LSL, _LSR,
    _LXRXL, _LXRL, _LRXL,
    _LRXLR, _LXRLXR,
    _LXR90SL, _LSR90XL,
    _LXR90SR, _LSL90XR,
    _LXR90SL90XR,
)


# ── transformation helpers ──────────────────────────────────────────


def _timeflip(lengths):
    """τ: negate every signed length (drive the word backwards)."""
    return [-x for x in lengths]


def _reflect(kinds):
    """σ: swap L ↔ R; S unchanged."""
    out = []
    for k in kinds:
        if k == 'L':
            out.append('R')
        elif k == 'R':
            out.append('L')
        else:
            out.append(k)
    return out


# ── candidate enumeration ───────────────────────────────────────────


def _set_path(paths, lengths, kinds):
    """Append a candidate, deduplicating against existing ones of the
    same kind sequence and similar total length.

    Reed-Shepp transformations can yield the same word twice; without
    dedupe we'd compare 96+ candidates instead of the 48 unique ones.
    """
    total = sum(abs(L) for L in lengths)
    for existing in paths:
        if existing[1] == kinds and abs(existing[2] - total) < 1e-9:
            return
    paths.append((lengths, list(kinds), total))


def _generate_candidates(x, y, phi):
    """Run every base solver under the 4 transformations and collect
    all admissible (lengths, kinds, total_length) candidates."""
    paths = []
    for fn in _PATH_FUNCTIONS:
        # Identity: (x, y, phi)
        ok, lens, ks = fn(x, y, phi)
        if ok:
            _set_path(paths, lens, ks)
        # τ time-flip: solve on (-x, y, -phi), negate lengths
        ok, lens, ks = fn(-x, y, -phi)
        if ok:
            _set_path(paths, _timeflip(lens), ks)
        # σ reflect: solve on (x, -y, -phi), swap L↔R in kinds
        ok, lens, ks = fn(x, -y, -phi)
        if ok:
            _set_path(paths, lens, _reflect(ks))
        # τ∘σ both
        ok, lens, ks = fn(-x, -y, phi)
        if ok:
            _set_path(paths, _timeflip(lens), _reflect(ks))
    return paths


# ── path representation ─────────────────────────────────────────────


class ReedSheppPath:
    __slots__ = ('length', 'segments', 'rho', 'start')

    def __init__(self, length, segments, rho, start):
        self.length = length
        self.segments = segments
        self.rho = rho
        self.start = start

    def __repr__(self):  # pragma: no cover - debug only
        word = ''.join(s[0] + ('+' if s[1] >= 0 else '-')
                       for s in self.segments)
        return f'ReedSheppPath({word}, length={self.length:.3f}m)'


def _advance(pose, kind, signed_length, rho):
    """Move chassis along one primitive of given kind, signed length.

    signed_length > 0 ⇒ forward; signed_length < 0 ⇒ reverse. For L/R
    arcs, signed_length is *metres* of arc travelled. For S, it's the
    metric length of the straight.
    """
    x, y, psi = pose
    direction = 1.0 if signed_length >= 0 else -1.0
    length = abs(signed_length)
    if kind == 'S':
        return (x + direction * length * cos(psi),
                y + direction * length * sin(psi),
                psi)
    # Arc: angular sweep dpsi = (signed direction × length) / rho.
    # For L the chassis rotates CCW around a centre offset on its
    # left-hand side; for R the centre is on the right.
    dpsi = direction * length / rho
    if kind == 'R':
        dpsi = -dpsi
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
    """Plan the shortest Reed-Shepp path from start to end."""
    if rho <= 0:
        raise ValueError('rho must be positive')

    # Transform end into the unit-radius start frame.
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    c = cos(start[2])
    s = sin(start[2])
    local_x = (c * dx + s * dy) / rho
    local_y = (-s * dx + c * dy) / rho
    local_phi = _wrap(end[2] - start[2])

    candidates = _generate_candidates(local_x, local_y, local_phi)
    if not candidates:
        return None

    best_lens, best_kinds, best_total = min(candidates, key=lambda c: c[2])

    # Reconstruct world-frame segments.
    segments = []
    cur = start
    for length, kind in zip(best_lens, best_kinds):
        metric_length = length * rho
        nxt = _advance(cur, kind, metric_length, rho)
        segments.append((kind, metric_length, cur, nxt))
        cur = nxt

    return ReedSheppPath(best_total * rho, segments, rho, start)


def sample(path, step_m):
    """Discretise a Reed-Shepp path at fixed arc-length steps."""
    if path is None:
        return []
    if step_m <= 0:
        raise ValueError('step_m must be positive')
    pts = [(path.start[0], path.start[1], path.start[2], 0)]
    leftover = 0.0
    for kind, signed_length, seg_start, seg_end in path.segments:
        seg_len = abs(signed_length)
        if seg_len <= 0:
            continue
        motion_sign = 1 if signed_length >= 0 else -1
        s = step_m - leftover
        while s < seg_len:
            partial_signed = motion_sign * s
            p = _advance(seg_start, kind, partial_signed, path.rho)
            pts.append((p[0], p[1], p[2], motion_sign))
            s += step_m
        leftover = (step_m - (s - seg_len)) % step_m
        pts.append((seg_end[0], seg_end[1], seg_end[2], motion_sign))
    return pts
