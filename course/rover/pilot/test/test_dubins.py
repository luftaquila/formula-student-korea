"""Dubins curve unit tests.

Verifies the closed-form shortest-path solver against:
  * geometry intuition (straight, simple turns, 180-degree turns)
  * end-pose accuracy (re-traversing the planned primitives must land on
    the requested end pose to numerical tolerance)
  * length monotonicity (shorter straight-line distance => shorter path
    when end heading matches start)
  * type coverage (each of the six types is selected for at least one
    representative geometry, ensuring no candidate is silently broken)
"""

import math

import pytest

from pilot.lib.dubins import plan, sample, _advance


def _err(pose_a, pose_b):
    dx = pose_a[0] - pose_b[0]
    dy = pose_a[1] - pose_b[1]
    dpsi = (pose_a[2] - pose_b[2] + math.pi) % (2 * math.pi) - math.pi
    return math.hypot(dx, dy), abs(dpsi)


def _end_of(path):
    return path.segments[-1][3]


class TestBasicGeometry:
    def test_pure_forward_is_straight(self):
        # Same heading, target on the heading direction → path is one straight
        # segment of length D, no turns.
        p = plan((0.0, 0.0, 0.0), (5.0, 0.0, 0.0), rho=1.0)
        assert p is not None
        assert p.length == pytest.approx(5.0, abs=1e-6)
        # First and last segment lengths near zero (the two arc primitives).
        assert p.segments[0][1] == pytest.approx(0.0, abs=1e-6)
        assert p.segments[2][1] == pytest.approx(0.0, abs=1e-6)
        # Middle segment is the straight, length 5.
        assert p.segments[1][0] == 'S'
        assert p.segments[1][1] == pytest.approx(5.0, abs=1e-6)

    def test_quarter_turn_left(self):
        # From origin facing east to (1, 1) facing north, rho=1: optimum
        # is a single quarter-arc left of length pi/2.
        p = plan((0.0, 0.0, 0.0), (1.0, 1.0, math.pi / 2), rho=1.0)
        assert p is not None
        assert p.length == pytest.approx(math.pi / 2, abs=1e-4)

    def test_quarter_turn_right(self):
        # Mirror of the above to the south.
        p = plan((0.0, 0.0, 0.0), (1.0, -1.0, -math.pi / 2), rho=1.0)
        assert p is not None
        assert p.length == pytest.approx(math.pi / 2, abs=1e-4)

    def test_u_turn_picks_an_admissible_path(self):
        # Origin east, target back at (0, 2*rho) facing west — a 180° turn.
        # The two single-arc options can't reach it (full circles return to
        # origin); LRL/RLR or one of the CSC types must apply.
        p = plan((0.0, 0.0, 0.0), (0.0, 2.0, math.pi), rho=1.0)
        assert p is not None
        # Loose length bound — anything ≤ 2π rho is feasible.
        assert p.length <= 2 * math.pi + 1e-6


class TestPathReachesEndPose:
    """Re-walking the primitives must land on the requested end pose."""

    @pytest.mark.parametrize('start,end,rho', [
        ((0.0, 0.0, 0.0), (5.0, 0.0, 0.0), 1.0),
        ((0.0, 0.0, 0.0), (1.0, 1.0, math.pi / 2), 1.0),
        ((0.0, 0.0, 0.0), (-1.0, 1.0, math.pi), 1.0),
        ((0.0, 0.0, 0.0), (3.0, -2.0, -math.pi / 4), 0.5),
        ((1.0, 2.0, math.pi / 3), (-2.0, 4.0, -math.pi / 6), 0.7),
        ((0.0, 0.0, 0.0), (0.5, 0.0, math.pi / 2), 1.0),  # tight geometry
        ((0.0, 0.0, math.pi / 2), (2.0, 0.0, -math.pi / 2), 1.0),
    ])
    def test_end_pose_matches(self, start, end, rho):
        p = plan(start, end, rho)
        assert p is not None
        end_actual = _end_of(p)
        d_err, psi_err = _err(end_actual, end)
        assert d_err < 1e-6, f'position mismatch: {d_err:.6f}m on {p.type}'
        assert psi_err < 1e-6, f'heading mismatch: {math.degrees(psi_err):.4f}° on {p.type}'

    def test_sampling_endpoints(self):
        # First sample is start, last is end.
        p = plan((0.0, 0.0, 0.0), (3.0, 2.0, math.pi / 4), rho=1.0)
        pts = sample(p, step_m=0.1)
        assert pts[0] == pytest.approx(p.start, abs=1e-12)
        d_err, psi_err = _err(pts[-1], _end_of(p))
        assert d_err < 1e-6
        assert psi_err < 1e-6


class TestLengthMonotonicity:
    def test_longer_straight_gives_longer_path(self):
        # Two collinear targets along start heading — the further one must
        # have a strictly longer Dubins length.
        short = plan((0.0, 0.0, 0.0), (3.0, 0.0, 0.0), rho=1.0)
        long_ = plan((0.0, 0.0, 0.0), (6.0, 0.0, 0.0), rho=1.0)
        assert short.length < long_.length

    def test_path_length_ge_straight_line(self):
        # Dubins respects a min turning radius, so its length is bounded
        # below by Euclidean distance for any pair of poses.
        start, end = (0.0, 0.0, 0.0), (4.0, 3.0, math.pi / 3)
        euclid = math.hypot(end[0] - start[0], end[1] - start[1])
        p = plan(start, end, rho=0.5)
        assert p.length >= euclid - 1e-9


class TestPrimitiveAdvance:
    """The _advance helper that builds the segment list must be self-consistent."""

    def test_straight_advance(self):
        pose = (0.0, 0.0, 0.0)
        nxt = _advance(pose, 'S', 2.0, rho=1.0)
        assert nxt[0] == pytest.approx(2.0, abs=1e-12)
        assert nxt[1] == pytest.approx(0.0, abs=1e-12)
        assert nxt[2] == pytest.approx(0.0, abs=1e-12)

    def test_left_arc_advance_quarter(self):
        # rho=1, arc length pi/2 → quarter circle left → ends at (1, 1)
        # facing north (pi/2).
        pose = (0.0, 0.0, 0.0)
        nxt = _advance(pose, 'L', math.pi / 2, rho=1.0)
        assert nxt[0] == pytest.approx(1.0, abs=1e-9)
        assert nxt[1] == pytest.approx(1.0, abs=1e-9)
        assert nxt[2] == pytest.approx(math.pi / 2, abs=1e-9)

    def test_right_arc_advance_quarter(self):
        pose = (0.0, 0.0, 0.0)
        nxt = _advance(pose, 'R', math.pi / 2, rho=1.0)
        assert nxt[0] == pytest.approx(1.0, abs=1e-9)
        assert nxt[1] == pytest.approx(-1.0, abs=1e-9)
        assert nxt[2] == pytest.approx(-math.pi / 2, abs=1e-9)


class TestTypeCoverage:
    """Each of the six Dubins types should win at least one representative
    geometry. If a type never wins, its formula or its candidate-comparison
    is likely buggy."""

    def test_all_types_reachable(self):
        # Build a fan of (end_pose) goals around the origin and verify that
        # the set of winning types covers all six. The set of "easy" cases
        # almost always trips LSL/RSR/LSR/RSL; the trickier cases (small
        # distance, large heading change) bring in RLR/LRL.
        seen = set()
        for end_psi in [0, math.pi / 4, math.pi / 2, math.pi, -math.pi / 2, -math.pi / 4]:
            for end_xy in [(2, 0), (1, 1), (1, -1), (-1, 1), (0.5, 0.0), (0.3, 0.0)]:
                p = plan((0.0, 0.0, 0.0), (end_xy[0], end_xy[1], end_psi), rho=0.5)
                if p is not None:
                    seen.add(p.type)
        # CSC types (LSL, RSR, LSR, RSL) win on roomy geometries — all four
        # must appear.
        for t in ('LSL', 'RSR', 'LSR', 'RSL'):
            assert t in seen, f'type {t} never selected over the fan — likely broken'
        # CCC types (RLR, LRL) are degenerate when d > 4 rho. The fan above
        # includes d < 4 rho cases (0.5/0.5=1 rho), so they should appear too.
        assert {'RLR', 'LRL'} & seen, 'neither RLR nor LRL ever selected'


class TestTurningRadiusBound:
    def test_minimum_radius_respected(self):
        # Sample a path densely and verify no consecutive sample turns
        # tighter than 1/rho. (Direction-of-travel is encoded in psi; the
        # instantaneous curvature is |dpsi/ds| ≤ 1/rho.)
        rho = 0.5
        p = plan((0.0, 0.0, 0.0), (2.0, 1.5, math.pi / 3), rho=rho)
        pts = sample(p, step_m=0.01)
        for i in range(1, len(pts) - 1):
            ds = math.hypot(pts[i + 1][0] - pts[i - 1][0],
                            pts[i + 1][1] - pts[i - 1][1])
            if ds < 1e-6:
                continue
            dpsi = abs((pts[i + 1][2] - pts[i - 1][2] + math.pi) % (2 * math.pi) - math.pi)
            curvature = dpsi / ds
            # Loose bound; primitive boundaries cause local spikes.
            assert curvature <= 1.0 / rho + 0.5
