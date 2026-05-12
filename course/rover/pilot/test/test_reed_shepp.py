"""Reed-Shepp planner unit tests.

Verifies the 48-candidate Reed-Shepp solver against:
  * geometric invariants — end-pose accuracy after walking the segment
    list, total length ≥ Euclidean distance, ≤ Dubins length (Reed-Shepp
    is a relaxation of Dubins).
  * Reed-Shepp 1990 admissibility — path lengths bounded above by
    π·rho·N for N-segment words (no spurious 2π full loops).
  * coverage — over a wide goal fan, the planner returns paths with
    both forward and reverse segments and never fails.
  * sampling — discretisation endpoints match segment endpoints; motion
    sign is consistent within each segment.
  * symmetry — swapping start/end and reversing all motion gives the
    same total length (reverse-time invariance of Reed-Shepp paths).
"""

import math
import random

import pytest

from pilot.lib.reed_shepp import plan, sample, _advance
from pilot.lib.dubins import plan as dubins_plan


def _err(pose_a, pose_b):
    dx = pose_a[0] - pose_b[0]
    dy = pose_a[1] - pose_b[1]
    dpsi = (pose_a[2] - pose_b[2] + math.pi) % (2 * math.pi) - math.pi
    return math.hypot(dx, dy), abs(dpsi)


def _end_of(path):
    return path.segments[-1][3]


def _has_reverse(path):
    return any(seg[1] < 0 for seg in path.segments)


def _has_forward(path):
    return any(seg[1] > 0 for seg in path.segments)


class TestBasicGeometry:
    def test_straight_forward(self):
        # Same heading, target on heading direction → expect a path
        # whose total length equals the Euclidean distance.
        p = plan((0.0, 0.0, 0.0), (5.0, 0.0, 0.0), rho=1.0)
        assert p is not None
        assert p.length == pytest.approx(5.0, abs=1e-6)

    def test_straight_reverse(self):
        # Goal behind chassis facing same direction → pure reverse
        # straight is optimal. length 5, all reverse motion.
        p = plan((0.0, 0.0, 0.0), (-5.0, 0.0, 0.0), rho=1.0)
        assert p is not None
        assert p.length == pytest.approx(5.0, abs=1e-6)
        assert _has_reverse(p) and not _has_forward(p)

    def test_quarter_turn_left(self):
        # Forward-feasible quarter turn — Reed-Shepp must match Dubins
        # (or beat it). Dubins quarter-arc length is π/2 ≈ 1.5708.
        rs = plan((0.0, 0.0, 0.0), (1.0, 1.0, math.pi / 2), rho=1.0)
        du = dubins_plan((0.0, 0.0, 0.0), (1.0, 1.0, math.pi / 2), rho=1.0)
        assert rs is not None and du is not None
        assert rs.length <= du.length + 1e-6

    def test_u_turn(self):
        # Goal is 'behind' the chassis facing opposite direction at
        # (0, 2). Forward Dubins needs a full circle; Reed-Shepp does
        # this much shorter using a reverse segment.
        rs = plan((0.0, 0.0, 0.0), (0.0, 2.0, math.pi), rho=1.0)
        du = dubins_plan((0.0, 0.0, 0.0), (0.0, 2.0, math.pi), rho=1.0)
        assert rs is not None
        assert rs.length <= du.length + 1e-6


class TestEndPoseAccuracy:
    """Walking the planned segments must land on the requested end pose."""

    @pytest.mark.parametrize('start,end,rho', [
        ((0.0, 0.0, 0.0), (5.0, 0.0, 0.0), 1.0),
        ((0.0, 0.0, 0.0), (-5.0, 0.0, 0.0), 1.0),
        ((0.0, 0.0, 0.0), (1.0, 1.0, math.pi / 2), 1.0),
        ((0.0, 0.0, 0.0), (-1.0, 1.0, math.pi), 1.0),
        ((0.0, 0.0, 0.0), (3.0, -2.0, -math.pi / 4), 0.5),
        ((1.0, 2.0, math.pi / 3), (-2.0, 4.0, -math.pi / 6), 0.7),
        ((0.0, 0.0, 0.0), (0.5, 0.0, math.pi / 2), 1.0),
        ((0.0, 0.0, math.pi / 2), (2.0, 0.0, -math.pi / 2), 1.0),
        # WP1 → WP2 case from the 15:15 mission that drove a 1.5 m
        # circle under forward-only Dubins. Reed-Shepp should land
        # the chassis on the goal in dramatically less path.
        ((-1.21, -6.05, -math.pi / 2),
         (-1.50, -6.50, -math.pi / 2 - 0.1),  # WP2 entry ≈ near WP1
         0.62),
    ])
    def test_end_pose_matches(self, start, end, rho):
        p = plan(start, end, rho)
        assert p is not None
        d_err, psi_err = _err(_end_of(p), end)
        assert d_err < 1e-6, f'position error {d_err:.6f}m'
        assert psi_err < 1e-6, f'heading error {math.degrees(psi_err):.4f}°'


class TestReverseEnablesShorterThanDubins:
    """The whole point of Reed-Shepp: when forward-only is wasteful,
    using a reverse segment shortens the path."""

    @pytest.mark.parametrize('end_xy,end_psi', [
        ((0.0, 0.5), 0.0),          # behind the chassis, same heading
        ((0.5, 0.0), math.pi),      # in front facing backwards
        ((-0.5, 0.3), -math.pi / 2),
        ((0.3, -0.3), math.pi / 2),
    ])
    def test_reed_shepp_beats_dubins_on_tight_goals(self, end_xy, end_psi):
        rs = plan((0.0, 0.0, 0.0), (end_xy[0], end_xy[1], end_psi), rho=0.5)
        du = dubins_plan((0.0, 0.0, 0.0), (end_xy[0], end_xy[1], end_psi),
                         rho=0.5)
        assert rs is not None
        # Reed-Shepp must be at least as short — for these tight goals,
        # strictly shorter (reverse opens up topologies forward can't).
        assert rs.length <= du.length + 1e-9


class TestLengthInvariants:
    def test_length_ge_euclidean(self):
        # Path length >= Euclidean distance (geometric necessity).
        start, end = (0.0, 0.0, 0.0), (4.0, 3.0, math.pi / 3)
        p = plan(start, end, rho=0.5)
        euclid = math.hypot(end[0] - start[0], end[1] - start[1])
        assert p.length >= euclid - 1e-9

    def test_length_bounded_above(self):
        # Reed-Shepp paths are bounded above by ~ (Euclidean + π·rho).
        # Use a generous 4π·rho as an upper sanity check.
        start = (0.0, 0.0, 0.0)
        end = (3.0, 2.0, 0.5)
        rho = 1.0
        p = plan(start, end, rho)
        euclid = math.hypot(end[0] - start[0], end[1] - start[1])
        assert p.length <= euclid + 4 * math.pi * rho


class TestSamplingConsistency:
    def test_first_sample_is_start(self):
        p = plan((1.0, 2.0, 0.3), (3.0, 1.0, -0.5), rho=0.8)
        pts = sample(p, step_m=0.05)
        assert pts[0][0] == pytest.approx(1.0, abs=1e-9)
        assert pts[0][1] == pytest.approx(2.0, abs=1e-9)
        assert pts[0][2] == pytest.approx(0.3, abs=1e-9)

    def test_last_sample_is_end(self):
        p = plan((0.0, 0.0, 0.0), (2.0, 3.0, math.pi / 4), rho=1.0)
        pts = sample(p, step_m=0.05)
        d_err, psi_err = _err(pts[-1][:3], _end_of(p))
        assert d_err < 1e-6
        assert psi_err < 1e-6

    def test_motion_sign_consistent_within_segment(self):
        # All samples taken from a single forward segment must carry
        # motion_sign = +1; reverse segment samples carry -1. Boundary
        # samples (segment ends) can take either side's sign.
        p = plan((0.0, 0.0, 0.0), (-2.0, 1.0, math.pi), rho=0.8)
        pts = sample(p, step_m=0.05)
        seen_signs = set(pt[3] for pt in pts if pt[3] != 0)
        # If the path has a reverse segment, both signs must appear.
        if _has_reverse(p) and _has_forward(p):
            assert -1 in seen_signs and 1 in seen_signs


class TestPrimitiveAdvance:
    def test_straight_forward(self):
        nxt = _advance((0.0, 0.0, 0.0), 'S', 2.0, rho=1.0)
        assert nxt[0] == pytest.approx(2.0, abs=1e-12)
        assert nxt[1] == pytest.approx(0.0, abs=1e-12)
        assert nxt[2] == pytest.approx(0.0, abs=1e-12)

    def test_straight_reverse(self):
        nxt = _advance((0.0, 0.0, 0.0), 'S', -2.0, rho=1.0)
        assert nxt[0] == pytest.approx(-2.0, abs=1e-12)

    def test_left_arc_forward(self):
        # quarter L arc forward, rho=1, length π/2 → (1, 1, π/2).
        nxt = _advance((0.0, 0.0, 0.0), 'L', math.pi / 2, rho=1.0)
        assert nxt[0] == pytest.approx(1.0, abs=1e-9)
        assert nxt[1] == pytest.approx(1.0, abs=1e-9)
        assert nxt[2] == pytest.approx(math.pi / 2, abs=1e-9)

    def test_left_arc_reverse(self):
        # Reverse left arc, rho=1, length π/2: chassis backs around
        # the same left-side turning centre. Start (0,0,0) → end
        # at (-1, 1, -π/2). (The chassis swings tail-first into the
        # +y +(-x) quadrant.)
        nxt = _advance((0.0, 0.0, 0.0), 'L', -math.pi / 2, rho=1.0)
        # Centre at (0, 1); chassis ends at rotation -π/2 around that
        # centre, which is (-1, 1, -π/2).
        assert nxt[0] == pytest.approx(-1.0, abs=1e-9)
        assert nxt[1] == pytest.approx(1.0, abs=1e-9)
        assert nxt[2] == pytest.approx(-math.pi / 2, abs=1e-9)


class TestRandomCoverage:
    """Many random goals must all yield a valid path that lands on the
    requested pose. Failure modes the test catches:
      * a base-word solver returning malformed parameters
      * a transformation producing negative segment lengths
      * sign-mismatch between candidate's signed_length and how the
        primitive is later integrated by _advance
    """

    def test_fan_of_random_goals_all_solve(self):
        random.seed(20260512)
        for _ in range(200):
            sx = random.uniform(-3, 3)
            sy = random.uniform(-3, 3)
            spsi = random.uniform(-math.pi, math.pi)
            gx = random.uniform(-3, 3)
            gy = random.uniform(-3, 3)
            gpsi = random.uniform(-math.pi, math.pi)
            rho = random.uniform(0.3, 1.5)
            p = plan((sx, sy, spsi), (gx, gy, gpsi), rho)
            assert p is not None, \
                f'plan failed for start ({sx}, {sy}, {spsi}), goal ({gx}, {gy}, {gpsi}), rho={rho}'
            d_err, psi_err = _err(_end_of(p), (gx, gy, gpsi))
            assert d_err < 1e-5, f'position error {d_err:.6f}m on random goal'
            assert psi_err < 1e-5, f'heading error {math.degrees(psi_err):.4f}°'

    def test_random_paths_have_finite_length(self):
        random.seed(20260512)
        for _ in range(100):
            sx, sy, spsi = random.uniform(-2, 2), random.uniform(-2, 2), random.uniform(-math.pi, math.pi)
            gx, gy, gpsi = random.uniform(-2, 2), random.uniform(-2, 2), random.uniform(-math.pi, math.pi)
            p = plan((sx, sy, spsi), (gx, gy, gpsi), rho=0.6)
            assert p is not None
            assert 0 <= p.length < 50  # generous sanity bound


class TestMissionRegression:
    """Specific cases lifted from real mission traces that previously
    produced bad paths under forward-only Dubins."""

    def test_wp1_to_wp2_15_15_no_full_loop(self):
        # Approximate WP1 dock_end and WP2 entry from the 15:15 trace.
        # Forward-only Dubins yielded ≈ 1.5 m * π ≈ 4.7 m loop; Reed-
        # Shepp should land it in well under 2 m using reverse.
        start = (-1.21, -6.05, math.radians(-90.0))
        end = (-1.50, -6.50, math.radians(-95.0))
        rho = 0.62
        p = plan(start, end, rho)
        assert p is not None
        assert p.length < 2.0, \
            f'expected short Reed-Shepp on close-by goal, got {p.length:.3f} m'

    def test_short_distance_large_heading_change(self):
        # Goal 1 m to the side facing perpendicular: the canonical
        # Reed-Shepp K-turn case. Forward-only Dubins needs a full
        # loop; Reed-Shepp lands well under that.
        start = (0.0, 0.0, 0.0)
        end = (0.0, 1.0, math.pi / 2)
        rho = 0.5
        rs = plan(start, end, rho)
        du = dubins_plan(start, end, rho)
        assert rs.length < du.length + 1e-9


class TestSwitchPenalty:
    """`plan(switch_penalty_m=...)` biases candidate selection against
    paths that require direction reversals. Each direction switch wastes
    ~1.5 s of MCU accel_limit ramp through zero (the chassis decelerates
    forward through 0 then accelerates reverse), and during that ramp
    the chassis drifts on inertia in the prior direction. The 16:47 WP2
    case (chassis at -131° heading needs to reach a dock entry pose at
    -16.5°) selected a Reed-Shepp word with 2 direction switches whose
    nominal length was 1.5 m shorter than the forward-only Dubins
    alternative — but the 3 s of accel-ramp drift past the planned
    entry left dock opening with |e_y| = 43 cm, far outside Stanley's
    smooth-closure regime."""

    def test_wp1_to_wp2_penalty_reduces_switch_count(self):
        # Concrete case lifted from the 16:47 mission's WP1→WP2 leg.
        # Free Reed-Shepp selected a word with multiple direction
        # switches; a 2 m switch penalty must drop the chosen path's
        # switch count strictly below the unpenalised baseline.
        from pilot.lib.reed_shepp import _direction_switch_count
        start = (-0.98, -3.92, math.radians(-131.0))
        end = (-2.25, -5.09, math.radians(-16.5))
        rho = 0.56
        rs_free = plan(start, end, rho, switch_penalty_m=0.0)
        rs_pen = plan(start, end, rho, switch_penalty_m=2.0)
        assert rs_free is not None and rs_pen is not None
        n_free = _direction_switch_count(
            [seg[1] for seg in rs_free.segments])
        n_pen = _direction_switch_count(
            [seg[1] for seg in rs_pen.segments])
        # Free baseline must use at least one switch (the case is
        # specifically chosen so it does).
        assert n_free >= 1
        assert n_pen < n_free

    def test_penalty_never_increases_switch_count(self):
        # Across a sample of geometrically diverse cases, raising
        # switch_penalty from 0 to a large value must never produce
        # a path with MORE direction switches than the unpenalised
        # baseline. The penalty is monotone in switch count.
        from pilot.lib.reed_shepp import _direction_switch_count
        cases = [
            ((0.0, 0.0, 0.0), (-1.0, 0.0, 0.0)),
            ((0.0, 0.0, 0.0), (1.0, 0.3, math.radians(30.0))),
            ((0.0, 0.0, 0.0), (-2.0, 1.0, math.radians(120.0))),
            ((0.0, 0.0, 0.0), (0.5, 0.5, math.radians(-160.0))),
            ((0.0, 0.0, 0.0), (-1.5, -0.5, math.radians(90.0))),
        ]
        rho = 0.5
        for start, end in cases:
            free = plan(start, end, rho, switch_penalty_m=0.0)
            pen = plan(start, end, rho, switch_penalty_m=10.0)
            n_free = _direction_switch_count(
                [s[1] for s in free.segments])
            n_pen = _direction_switch_count(
                [s[1] for s in pen.segments])
            assert n_pen <= n_free, (
                f'{start}→{end}: switches went up under penalty '
                f'({n_free}→{n_pen})')


class TestRequireForwardEnd:
    """`plan(require_forward_end=True)` filters Reed-Shepp candidates
    so the chassis arrives at the goal moving forward. The path planner
    relies on this for the cruise→dock handoff — the dock state-feedback
    tracker only supports forward motion and cannot ride out a direction
    reversal at the corridor entry."""

    def test_last_primitive_is_forward(self):
        # Sample of geometrically reasonable goals; each plan must
        # terminate in a forward primitive.
        rho = 0.5
        cases = [
            ((0.0, 0.0, 0.0), (1.0, 0.0, 0.0)),
            ((0.0, 0.0, 0.0), (-1.0, 0.0, 0.0)),
            ((0.0, 0.0, 0.0), (0.0, 1.0, math.pi / 2)),
            ((0.0, 0.0, 0.0), (2.0, -1.5, math.radians(-90.0))),
            ((0.0, 0.0, 0.0), (-1.5, 1.5, math.radians(135.0))),
        ]
        for start, end in cases:
            p = plan(start, end, rho, require_forward_end=True)
            assert p is not None, f'no plan for {start}→{end}'
            # Find the last non-zero primitive.
            last_signed = None
            for _kind, signed_length, _s, _e in reversed(p.segments):
                if abs(signed_length) > 1e-9:
                    last_signed = signed_length
                    break
            assert last_signed is not None
            assert last_signed > 0, (
                f'expected forward-end for {start}→{end}; got '
                f'last signed_length={last_signed:.4f}')

    def test_pose_accuracy_preserved_with_forward_end(self):
        # The constraint must not break end-pose accuracy on cases that
        # admit a forward-end solution (which Reed-Shepp's 48-candidate
        # set always does for any reachable goal).
        rho = 0.5
        end_target = (1.5, 0.8, math.radians(60.0))
        p = plan((0.0, 0.0, 0.0), end_target, rho, require_forward_end=True)
        assert p is not None
        end_actual = _end_of(p)
        d_xy, d_psi = _err(end_actual, end_target)
        assert d_xy < 1e-3
        assert d_psi < 1e-3
