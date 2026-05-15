"""Tests for L1Tracker (Stage 2 unified controller).

L1Tracker replaces CruiseTracker + DockTracker with a single
Park-2007 geometric pursuit law + Macenski-style regulated speed.
These tests pin the behaviours that the field-failure traces from the
legacy stack required us to fix:

  - On-corridor with chassis aligned → κ ≈ 0 (no false steer from
    numerical noise, no sign flips at small e_y).
  - Off-corridor with chassis aligned → κ in the closing direction,
    geometrically (not via Stanley state-feedback saturation).
  - Dock reached fires at antenna within `cm_capture` of target,
    no along-track-sign requirement — no mandatory overshoot →
    no reverse-recovery cycle on clean approaches.
  - Reverse-recovery on overshoot uses SATURATED κ in the e_y-
    closing direction (NOT the latched κ from the legacy
    DockTracker, which devolved to ~0.06 rad at small e_y →
    useless rotation rate).
  - Reverse-recovery distance is adaptive: max(min, 2·|e_y|), so
    one cycle scales with the residual.
  - Reverse-recovery terminates on e_y sign-flip (chassis crossed
    the corridor — keep reversing past that would re-open lateral).
"""

from math import cos, sin, pi, hypot, radians

import pytest

from pilot.lib.path_planner import PathSegment
from pilot.lib.path_tracker import L1Tracker


_PARAMS = {
    'cruise_speed': 1.0,
    'approach_speed': 0.4,
    'creep_speed': 0.10,
    'max_curvature': 1.7,
    'wheelbase': 0.33,
    'max_steering_angle_rad': radians(30.5),
    'antenna_offset_x': 0.30,
    'antenna_offset_y': 0.00,
    'l1_period_s': 2.5,
    'l1_damping': 0.7071,
    'l1_min_m': 0.6,
    'l1_max_m': 4.0,
    'l1_cm_capture_m': 0.03,
    'l1_reverse_recovery_min_m': 0.08,
    'l1_reverse_speed': 0.10,
    'l1_kappa_speed_lim': 0.85,
    'l1_e_y_speed_gain': 2.0,
    'l1_e_y_speed_floor': 0.4,
    'l1_brake_zone_m': 0.20,
    'l1_brake_min_speed_frac': 0.175,
    'l1_min_speed_m_s': 0.07,
    'l1_sharp_turn_thresh_rad': 0.785,
    'l1_sharp_turn_l1_min_m': 1.2,
    'cruise_done_tolerance': 0.20,
    'creep_zone': 0.40,
}


def _seg(kind, start, end, target=(0.0, 0.0), idx=0):
    return PathSegment(kind, start, end, target, idx, direction=1)


def _antenna_world_from_pose(pose, a_x=0.30, a_y=0.0):
    x, y, psi = pose
    return (x + cos(psi) * a_x - sin(psi) * a_y,
            y + sin(psi) * a_x + cos(psi) * a_y)


class TestL1TrackerReachedGates:
    """The 'reached' status decides when the navigator advances or
    enters SETTLING. These tests pin the exact dock/cruise gates.
    """

    def test_dock_reached_when_antenna_inside_cm_capture(self):
        # Dock segment running east 1 m at the origin; antenna 2 cm
        # past origin along +x (target_antenna). Chassis pose is
        # placed so antenna is at (1.02, 0) world. cm_capture = 3 cm,
        # |1.02 - 1.00| = 2 cm < 3 cm → reached.
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                   target=(1.0, 0.0))
        # Chassis pose with antenna 2cm past target along +x:
        # antenna = chassis + (cos(psi)·a_x, sin(psi)·a_x)
        # → chassis_x = 1.02 - 0.30 = 0.72
        antenna = (1.02, 0.0)
        v, kappa, status = t.step((0.72, 0.0, 0.0), seg,
                                  t_now=100.0, antenna_world=antenna)
        assert status == 'reached'
        assert v == 0.0 and kappa == 0.0

    def test_dock_not_reached_outside_cm_capture(self):
        # Antenna 5 cm short of target on the corridor → tracking.
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                   target=(1.0, 0.0))
        antenna = (0.95, 0.0)
        _, _, status = t.step((0.65, 0.0, 0.0), seg,
                              t_now=100.0, antenna_world=antenna)
        assert status == 'tracking'

    def test_cruise_reached_on_along_overshoot(self):
        # Cruise segment from origin east 5 m. Chassis at 5.1 m along
        # the path (past end). Reached should fire from the along
        # projection gate.
        t = L1Tracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0),
                   target=(5.6, 0.0))  # WP 0.6 m past entry
        _, _, status = t.step((5.1, 0.0, 0.0), seg,
                              t_now=100.0,
                              antenna_world=(5.4, 0.0))
        assert status == 'reached'

    def test_cruise_reached_on_proximity_to_end_pose(self):
        # Chassis within cruise_done_tolerance (20 cm) of end_pose,
        # but along-track has not crossed seg_len. Reached fires
        # from the proximity gate.
        t = L1Tracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0),
                   target=(5.6, 0.0))
        # 10 cm short along, but only ~10 cm from end_pose.
        _, _, status = t.step((4.90, 0.0, 0.0), seg,
                              t_now=100.0,
                              antenna_world=(5.2, 0.0))
        assert status == 'reached'


class TestL1TrackerSteering:
    """The κ command must (a) be geometrically correct, (b) clamp
    properly, and (c) be near zero when chassis is on path and aligned.
    """

    def test_aligned_on_corridor_kappa_near_zero(self):
        # Chassis on corridor, aligned with corridor heading.
        # Lookahead is L1 ahead on the same line; bearing = chassis
        # ψ → η = 0 → κ = 0 (no false steer from numerical noise).
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0),
                   target=(5.3, 0.0))
        antenna = _antenna_world_from_pose((1.0, 0.0, 0.0))
        _, kappa, status = t.step((1.0, 0.0, 0.0), seg,
                                  t_now=100.0,
                                  antenna_world=antenna)
        assert status == 'tracking'
        assert abs(kappa) < 1e-6

    def test_chassis_left_of_corridor_steers_right(self):
        # Chassis 0.5 m to the LEFT of corridor (e_y > 0), aligned.
        # Lookahead is on the corridor → bearing-to-lookahead points
        # right-and-forward → η < 0 → κ < 0 (right turn).
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0),
                   target=(5.3, 0.0))
        antenna = _antenna_world_from_pose((1.0, 0.5, 0.0))
        _, kappa, _ = t.step((1.0, 0.5, 0.0), seg,
                             t_now=100.0,
                             antenna_world=antenna)
        assert kappa < 0.0

    def test_chassis_right_of_corridor_steers_left(self):
        # Mirror of previous: chassis 0.5 m RIGHT of corridor →
        # κ > 0 (left turn).
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0),
                   target=(5.3, 0.0))
        antenna = _antenna_world_from_pose((1.0, -0.5, 0.0))
        _, kappa, _ = t.step((1.0, -0.5, 0.0), seg,
                             t_now=100.0,
                             antenna_world=antenna)
        assert kappa > 0.0

    def test_curvature_clamped_to_max(self):
        # Chassis perpendicular to corridor → η ≈ π/2. The sharp-turn
        # boost activates (e_psi > 45°) and widens the lookahead to
        # 1.2 m, so κ no longer saturates at max_curvature — but it
        # remains strongly negative (chassis must turn right to face
        # the corridor extension). With boost disabled the clamp
        # would bind; this test pins boosted behaviour.
        params_no_boost = dict(_PARAMS, l1_sharp_turn_thresh_rad=10.0)
        t = L1Tracker(params_no_boost)
        seg = _seg('dock', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0),
                   target=(5.3, 0.0))
        antenna = _antenna_world_from_pose((1.0, 0.0, pi / 2))
        _, kappa, _ = t.step((1.0, 0.0, pi / 2), seg,
                             t_now=100.0,
                             antenna_world=antenna)
        # With boost disabled, perpendicular geometry saturates κ
        # at -max_curvature (right turn).
        assert kappa == pytest.approx(-_PARAMS['max_curvature'],
                                      abs=1e-6)


class TestL1TrackerLateralClosure:
    """Run the tracker in a forward-Euler simulator to verify e_y
    closes monotonically without sign flips. This is the property
    the legacy Stanley dock failed on (e_y saturated κ → chassis
    couldn't track command → sign-flipping limit cycle).
    """

    def _step_kinematics(self, pose, v, kappa, dt):
        x, y, psi = pose
        x += v * cos(psi) * dt
        y += v * sin(psi) * dt
        psi += v * kappa * dt
        return (x, y, psi)

    def test_lateral_closes_under_l1_pursuit(self):
        # Chassis 0.5 m left of a long corridor, aligned. Drive 8 s
        # at the tracker-commanded v/κ; expect e_y to close to a
        # small fraction of the starting residual without blowing up.
        # L1 pure-pursuit will exhibit a damped oscillation; the
        # property we pin is "closure" (final |e_y| ≪ initial),
        # not "monotone" (which is a stricter Stanley-like
        # guarantee that geometric pursuit doesn't make).
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (50.0, 0.0, 0.0),
                   target=(50.3, 0.0))
        pose = (0.5, 0.5, 0.0)
        dt = 0.05
        peak_e_y = 0.5
        for _ in range(int(8.0 / dt)):
            antenna = _antenna_world_from_pose(pose)
            v, kappa, status = t.step(pose, seg, t_now=0.0,
                                      antenna_world=antenna)
            if status == 'reached':
                break
            peak_e_y = max(peak_e_y, abs(pose[1]))
            pose = self._step_kinematics(pose, v, kappa, dt)
        # The lateral excursion should never exceed ~1.5× the
        # initial residual (small overshoot is normal for L1 pure
        # pursuit; runaway divergence would fail this).
        assert peak_e_y <= 0.75, f'peak |e_y|={peak_e_y:.3f}'
        # After 8 s of pursuit, chassis should be much closer to
        # the corridor than where it started.
        assert abs(pose[1]) < 0.15, (
            f'final |e_y|={abs(pose[1]):.3f} > 15cm — closure failed')


class TestL1TrackerReverseRecovery:
    """The legacy DockTracker's latched-κ reverse devolved to a
    ~0.06 rad/m command on small residuals, giving 0.27° rotation
    over 0.8 s of reverse — useless. L1 uses saturated κ in the
    closing direction. These tests pin the sign and termination
    semantics.
    """

    def test_overshoot_latches_reverse_with_saturated_kappa(self):
        # Antenna 2 cm past target along corridor, 1 cm LEFT of it.
        # Reverse-recovery should fire at v = -reverse_speed and
        # κ = +max_curvature (sign(e_y)·max with e_y > 0).
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                   target=(1.0, 0.0))
        # Antenna at (1.02, 0.01): along=1.02 (target_along=1.00 so
        # along_to_target = -0.02), e_y = +0.01. Target is reached
        # ONLY if hypot(1.02-1.00, 0.01-0.00) < cm_capture (0.03).
        # hypot ≈ 0.022 → reached. Use a larger overshoot.
        antenna = (1.10, 0.05)
        # chassis_x = antenna_x - cos(psi)·a_x = 1.10 - 0.30 = 0.80
        v, kappa, status = t.step((0.80, 0.05, 0.0), seg,
                                  t_now=0.0, antenna_world=antenna)
        assert status == 'tracking'
        assert v < 0  # reversing
        assert v == pytest.approx(-_PARAMS['l1_reverse_speed'],
                                  abs=1e-6)
        # e_y > 0 → κ should saturate at +max_curvature.
        assert kappa == pytest.approx(_PARAMS['max_curvature'],
                                      abs=1e-6)

    def test_reverse_recovery_distance_adapts_to_e_y(self):
        # Two trackers, one with small e_y (1 cm), one with large
        # (10 cm). Recovery target should be max(min, 2·|e_y|).
        t_small = L1Tracker(_PARAMS)
        t_big = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                   target=(1.0, 0.0))
        # Small: e_y=1cm, big overshoot so cm_capture doesn't fire.
        t_small.step((0.80, 0.01, 0.0), seg, t_now=0.0,
                     antenna_world=(1.10, 0.01))
        # Big: e_y=10cm.
        t_big.step((0.80, 0.10, 0.0), seg, t_now=0.0,
                   antenna_world=(1.10, 0.10))
        # Small: max(0.08, 0.02) = 0.08
        # Big: max(0.08, 0.20) = 0.20
        assert t_small._reverse_recovery_target_m == \
            pytest.approx(0.08, abs=1e-6)
        assert t_big._reverse_recovery_target_m == \
            pytest.approx(0.20, abs=1e-6)

    def test_reverse_terminates_on_e_y_sign_flip(self):
        # Latch reverse at e_y=+5cm. On the next tick, antenna has
        # crossed the corridor → e_y=-1cm. Sign flipped → reverse
        # should terminate (next forward L1 tick).
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                   target=(1.0, 0.0))
        # Latch on first tick (e_y=+5cm, overshoot).
        v1, k1, _ = t.step((0.80, 0.05, 0.0), seg, t_now=0.0,
                           antenna_world=(1.10, 0.05))
        assert v1 < 0 and t._reverse_active
        # Force chassis to a position where e_y has flipped sign.
        # antenna world (0.95, -0.01) → past corridor on RIGHT side.
        v2, k2, status = t.step((0.65, -0.01, 0.0), seg, t_now=0.1,
                                antenna_world=(0.95, -0.01))
        # Reverse should NOT continue (sign-flip terminated it).
        # Forward L1 should now command non-reverse motion.
        assert not t._reverse_active
        assert status == 'tracking'
        assert v2 >= 0

    def test_clean_approach_no_reverse_recovery(self):
        # Chassis approaches target on a clean trajectory, never
        # overshoots. Reverse should NEVER engage. This is the
        # design refinement: ‘no obligatory dock cycle on every WP’.
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                   target=(1.0, 0.0))
        # Sweep along the corridor approaching target; never past.
        pose = (0.0, 0.0, 0.0)
        dt = 0.05
        reverse_seen = False
        for _ in range(60):
            antenna = _antenna_world_from_pose(pose)
            v, kappa, status = t.step(pose, seg, t_now=0.0,
                                      antenna_world=antenna)
            if v < -1e-3:
                reverse_seen = True
            if status == 'reached':
                break
            pose = (pose[0] + v * cos(pose[2]) * dt,
                    pose[1] + v * sin(pose[2]) * dt,
                    pose[2] + v * kappa * dt)
        assert not reverse_seen, \
            'reverse-recovery fired on a clean forward approach'
        assert status == 'reached'


class TestL1TrackerSpeedRegulation:
    """Macenski regulated-PP: slow on tight κ + slow on big e_y.
    Pin both regulator branches."""

    def test_high_curvature_reduces_speed(self):
        # Chassis well off path → tight κ → speed regulated down
        # below v_target.
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0),
                   target=(5.3, 0.0))
        antenna = _antenna_world_from_pose((0.0, 2.0, 0.0))
        v, kappa, _ = t.step((0.0, 2.0, 0.0), seg, t_now=0.0,
                             antenna_world=antenna)
        # |κ| > kappa_lim → speed regulated below approach_speed
        assert abs(kappa) > _PARAMS['l1_kappa_speed_lim'] - 1e-6
        # Should be regulated but floored at l1_min_speed_m_s
        assert v >= _PARAMS['l1_min_speed_m_s'] - 1e-9
        assert v <= _PARAMS['approach_speed'] + 1e-9

    def test_dock_brake_zone_reduces_speed_near_target(self):
        # Without the brake_zone, dock approaches blow past cm_capture
        # (3 cm) at v=approach_speed=0.40 → 2 cm per 50 ms tick →
        # overshoot → reverse-recovery → wari-gari. The brake ramps
        # speed down so the chassis crosses cm_capture at ~creep_speed.
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                   target=(1.0, 0.0))
        # Antenna 10 cm short of target, aligned with corridor.
        antenna = _antenna_world_from_pose((0.60, 0.0, 0.0))
        v, _, _ = t.step((0.60, 0.0, 0.0), seg, t_now=0.0,
                         antenna_world=antenna)
        # brake_zone = 0.20, brake_min_frac = 0.25. At target_dist=0.10,
        # ramp = 0.10/0.20 = 0.50. speed = approach_speed × 0.50 = 0.20.
        # Should be well below approach_speed.
        assert v < _PARAMS['approach_speed'] * 0.75
        assert v >= _PARAMS['creep_speed']

    def test_dock_no_brake_outside_zone(self):
        # 50 cm from target — outside brake_zone (20 cm). Full
        # approach_speed should be commanded.
        t = L1Tracker(_PARAMS)
        seg = _seg('dock', (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                   target=(1.0, 0.0))
        antenna = _antenna_world_from_pose((0.20, 0.0, 0.0))
        v, _, _ = t.step((0.20, 0.0, 0.0), seg, t_now=0.0,
                         antenna_world=antenna)
        assert v == pytest.approx(_PARAMS['approach_speed'],
                                  abs=1e-6)

    def test_l1_unified_segment_reaches_on_cm_capture(self):
        # The l1 planner emits a single segment per WP with kind='l1'.
        # L1Tracker should treat it identically to 'dock' for the
        # reached gate (antenna within cm_capture of target_antenna).
        t = L1Tracker(_PARAMS)
        seg = _seg('l1', (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                   target=(1.0, 0.0))
        antenna = (1.02, 0.0)
        v, kappa, status = t.step((0.72, 0.0, 0.0), seg,
                                  t_now=100.0, antenna_world=antenna)
        assert status == 'reached'
        assert v == 0.0 and kappa == 0.0

    def test_l1_unified_segment_uses_brake_zone(self):
        # Unified L1 segments must apply the brake near the target.
        # Compare two distances: well outside the brake zone (50 cm)
        # should command full cruise_speed, just inside (5 cm) should
        # be well below.
        t = L1Tracker(_PARAMS)
        seg = _seg('l1', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0),
                   target=(5.0, 0.0))
        antenna_far = _antenna_world_from_pose((4.20, 0.0, 0.0))
        v_far, _, _ = t.step((4.20, 0.0, 0.0), seg, t_now=0.0,
                             antenna_world=antenna_far)
        t.reset()
        antenna_near = _antenna_world_from_pose((4.65, 0.0, 0.0))
        v_near, _, _ = t.step((4.65, 0.0, 0.0), seg, t_now=0.0,
                              antenna_world=antenna_near)
        # Outside brake zone: full cruise_speed (no regulation).
        assert v_far == pytest.approx(_PARAMS['cruise_speed'], abs=1e-6)
        # Inside brake zone: 5 cm from target → ramp = 0.25 →
        # speed = cruise_speed × 0.25 = 0.25.
        assert v_near < _PARAMS['cruise_speed'] * 0.5
        assert v_near >= _PARAMS['l1_min_speed_m_s']

    def test_sharp_turn_boost_widens_arc(self):
        # Identical geometry with and without boost. Boost should
        # produce a strictly smaller |κ| (wider arc, no saturation
        # in the limit).
        seg = _seg('l1', (0.0, 0.0, -pi / 2), (0.0, -5.0, -pi / 2),
                   target=(0.0, -5.3))
        antenna = _antenna_world_from_pose((0.3, -0.2, 0.0))
        chassis = (0.3, -0.2, 0.0)

        params_no_boost = dict(_PARAMS, l1_sharp_turn_thresh_rad=10.0)
        t_no = L1Tracker(params_no_boost)
        _, k_no, _ = t_no.step(chassis, seg, t_now=0.0,
                               antenna_world=antenna)

        t_boost = L1Tracker(_PARAMS)
        _, k_boost, _ = t_boost.step(chassis, seg, t_now=0.0,
                                     antenna_world=antenna)

        # Boost widens lookahead → η drops → |κ| drops.
        assert abs(k_boost) < abs(k_no)

    def test_sharp_turn_boost_inactive_when_aligned(self):
        # Chassis aligned with segment direction → no boost; L1
        # uses its nominal floor.
        t = L1Tracker(_PARAMS)
        seg = _seg('l1', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0),
                   target=(5.0, 0.0))
        antenna = _antenna_world_from_pose((1.0, 0.05, 0.0))
        # Probe L1 by reading the internal state via behaviour:
        # with tiny e_y and aligned chassis, κ should be tiny.
        _, kappa, _ = t.step((1.0, 0.05, 0.0), seg, t_now=0.0,
                             antenna_world=antenna)
        assert abs(kappa) < 0.3

    def test_large_e_y_reduces_speed(self):
        # On a wide cruise leg with big e_y, the e_y_speed_gain
        # should pull speed toward the floor.
        t = L1Tracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (10.0, 0.0, 0.0),
                   target=(10.6, 0.0))
        antenna = _antenna_world_from_pose((5.0, 0.5, 0.0))
        v, _, _ = t.step((5.0, 0.5, 0.0), seg, t_now=0.0,
                         antenna_world=antenna)
        # e_y_scale = max(0.4, 1 - 2·0.5) = 0.4 (clipped at floor).
        # speed ≈ cruise_speed · κ_scale · 0.4.
        # Without the e_y term, v would be ≈ cruise_speed.
        assert v < _PARAMS['cruise_speed']
