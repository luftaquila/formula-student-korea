"""Tests for CruiseTracker and DockTracker.

The trackers are the layer where the figure-8 instability used to live, so
the tests pin the specific behaviours that prevent re-introduction:

  - Cruise PP must clamp curvature, slow on heading error, and damp dα/dt.
  - Dock state-feedback must send curvature in the correct sign for both
    lateral and heading errors and reverse cleanly on along-track overshoot.
"""

from math import cos, sin, pi, isclose

import pytest

from pilot.lib.path_planner import PathSegment
from pilot.lib.path_tracker import CruiseTracker, DockTracker


_PARAMS = {
    'cruise_speed': 1.0,
    'approach_speed': 0.4,
    'creep_speed': 0.18,
    'cruise_done_tolerance': 0.20,
    'cruise_done_heading_max_rad': 0.26,
    'cruise_pass_through_m': 0.30,
    'cruise_k_heading': 1.5,
    'cruise_min_speed_fraction': 0.40,
    'dock_k_y': 1.4,
    'dock_k_psi': 1.6,                # tests pin to 1.6 for the legacy
                                       # P-only assertions; production yaml
                                       # uses 5.0 alongside the new I-term.
    'dock_k_i': 0.0,                  # disable I-term in the P-only tests
                                       # below; the I-term-specific test
                                       # constructs its own params dict.
    'dock_integral_limit': 0.5,
    'approach_tolerance': 0.10,
    'creep_zone': 0.40,
    'max_curvature': 1.2,
    'wheelbase': 0.38,
    'max_steering_angle_rad': 0.4363,
    'antenna_offset_x': 0.30,
    'antenna_offset_y': 0.00,
}


def _seg(kind, start, end, target=(0.0, 0.0), idx=0, direction=1):
    return PathSegment(kind, start, end, target, idx, direction=direction)


class TestCruiseTracker:
    """Heading-only goal-seeking P-controller. Pins the behaviours that
    distinguish it from the prior Stanley line follower:

      - κ depends ONLY on (bearing-to-goal − chassis_ψ), never on a
        lateral offset.
      - On a straight stretch with chassis pointed at the goal, κ = 0.
      - On a turn, κ saturates and decays smoothly as the chassis aligns
        (no sign flip, no overshoot).
      - Done = position close AND heading aligned with end_pose.psi
        (= ψ_dock at handoff).
      - Past-end fail-safe declares done regardless of heading if the
        chassis has overshot the start→end bearing by pass_through_m.
    """

    def test_aligned_with_goal_zero_curvature(self):
        # Chassis at origin facing +x, goal 5 m ahead on +x: bearing =
        # chassis_ψ, e_psi = 0 → κ = 0.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        v, kappa, done = t.step((0.0, 0.0, 0.0), seg, t_now=100.0)
        assert not done
        assert v == pytest.approx(_PARAMS['cruise_speed'], abs=1e-9)
        assert abs(kappa) < 1e-9

    def test_done_within_position_and_heading(self):
        # Within cruise_done_tolerance AND chassis heading matches
        # end_pose.psi → done.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        v, kappa, done = t.step((4.95, 0.0, 0.0), seg, t_now=100.0)
        assert done
        assert v == 0.0 and kappa == 0.0

    def test_done_requires_heading_aligned(self):
        # Within position tolerance but chassis heading 45° off ψ_dock
        # → NOT done (dock would open with stale heading residual).
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        _, _, done = t.step((4.95, 0.0, pi / 4), seg, t_now=100.0)
        assert not done

    def test_goal_to_the_left_commands_left_turn(self):
        # Chassis at origin facing +x; goal at (5, 5) — bearing = +45°.
        # desired_psi − chassis_psi = +45° > 0 → κ > 0 (left turn under
        # math-frame Ackermann: ψ̇ = v·κ, positive κ = CCW).
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 5.0, 0.0))
        _, kappa, _ = t.step((0.0, 0.0, 0.0), seg, t_now=100.0)
        assert kappa > 0.0

    def test_goal_to_the_right_commands_right_turn(self):
        # Mirror: goal at (5, -5) → bearing = -45° → κ < 0 (right turn).
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, -5.0, 0.0))
        _, kappa, _ = t.step((0.0, 0.0, 0.0), seg, t_now=100.0)
        assert kappa < 0.0

    def test_curvature_clamped_to_max(self):
        # Goal at 90° to chassis facing → e_psi = π/2 → unclamped κ
        # would be k_heading × π/2 ≈ 2.36, which exceeds max_curvature.
        # The clamp must bind.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (0.0, 5.0, 0.0))
        _, kappa, _ = t.step((0.0, 0.0, 0.0), seg, t_now=100.0)
        assert abs(kappa) <= _PARAMS['max_curvature'] + 1e-9
        # And it should be the positive (left) clamp because the goal is
        # to the left.
        assert kappa == pytest.approx(_PARAMS['max_curvature'], abs=1e-9)

    def test_speed_scales_with_heading_error(self):
        # Chassis facing 180° away from goal → cos(π) = −1. The speed
        # scale floors at cruise_min_speed_fraction × cruise_speed.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        v, _, _ = t.step((0.0, 0.0, pi), seg, t_now=100.0)
        expected = _PARAMS['cruise_speed'] * _PARAMS['cruise_min_speed_fraction']
        assert v == pytest.approx(expected, abs=1e-9)

    def test_speed_at_aligned_is_full_cruise(self):
        # When the chassis is pointed at the goal, the cos(e_psi) factor
        # is 1, so commanded speed is exactly cruise_speed. There is no
        # remaining-distance taper (that was a Reed-Shepp-era knob — the
        # DockTracker handles approach-speed transition).
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        # 0.30 m from the end, perfectly aligned.
        v, _, done = t.step((4.70, 0.0, 0.0), seg, t_now=100.0)
        assert not done
        assert v == pytest.approx(_PARAMS['cruise_speed'], abs=1e-9)

    def test_no_response_to_lateral_offset_alone(self):
        # Chassis off the start→end line laterally but facing the goal:
        # the new tracker computes bearing-to-goal, which simply points
        # back at the goal, so e_psi against chassis_psi may be small.
        # Specifically, with chassis at (2, 0.5) facing the goal at
        # (5, 0), bearing = atan2(-0.5, 3) ≈ -9.5°. So κ is the heading
        # error to point at the goal, NOT a Stanley lateral-correction.
        # The key behaviour: |κ| is small because the chassis can simply
        # re-aim at the goal.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        # Chassis facing the goal direction directly (atan2(-0.5,3)≈-0.166).
        from math import atan2 as _atan2
        face = _atan2(-0.5, 3.0)
        _, kappa, _ = t.step((2.0, 0.5, face), seg, t_now=100.0)
        # Already pointed at the goal → κ ≈ 0.
        assert abs(kappa) < 1e-6

    def test_pass_through_safety_net(self):
        # Chassis past the end pose along the start→end bearing by more
        # than cruise_pass_through_m → forced done regardless of heading.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        _, _, done = t.step((5.40, 0.0, pi / 4), seg, t_now=100.0)
        assert done

    def test_chassis_v_arg_ignored(self):
        # The signature accepts chassis_v for navigator-side backward
        # compat; the tracker must not use it. Passing wildly different
        # chassis_v must not change v or κ.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 5.0, 0.0))
        v_a, k_a, _ = t.step((0.0, 0.0, 0.0), seg, t_now=100.0, chassis_v=0.0)
        v_b, k_b, _ = t.step((0.0, 0.0, 0.0), seg, t_now=100.0, chassis_v=10.0)
        assert v_a == v_b
        assert k_a == k_b


class TestDockTracker:
    def _dock_seg(self, target=(5.0, 0.0)):
        # Dock corridor running East along y=0.
        # Start of corridor is dock_distance behind the dock pose so the
        # tracker has a real along-track to project against.
        target_e, target_n = target
        antenna_offset = (_PARAMS['antenna_offset_x'], _PARAMS['antenna_offset_y'])
        a_x, a_y = antenna_offset
        cp, sp = cos(0.0), sin(0.0)
        dock_x = target_e - (cp * a_x - sp * a_y)
        dock_y = target_n - (sp * a_x + cp * a_y)
        entry_x = dock_x - 1.5
        entry_y = dock_y
        return _seg(
            'dock',
            (entry_x, entry_y, 0.0),
            (dock_x, dock_y, 0.0),
            target=(target_e, target_n),
            idx=0,
        )

    def test_on_corridor_zero_curvature(self):
        t = DockTracker(_PARAMS)
        seg = self._dock_seg()
        # Chassis on the corridor centreline, heading aligned, far from end.
        chassis = (1.0, 0.0, 0.0)
        v, kappa, status = t.step(chassis, seg, t_now=100.0)
        assert status == 'tracking'
        # No lateral or heading error → κ ≈ 0.
        assert abs(kappa) < 1e-9
        # Far from target → approach speed.
        assert v == pytest.approx(_PARAMS['approach_speed'], abs=1e-9)

    def test_lateral_left_commands_right_turn(self):
        t = DockTracker(_PARAMS)
        seg = self._dock_seg()
        # Antenna would land 0.2 m LEFT of corridor (positive y) → e_y > 0.
        # State feedback κ = -k_y · e_y → κ < 0 → right turn.
        chassis = (1.0, 0.2, 0.0)
        _, kappa, _ = t.step(chassis, seg, t_now=100.0)
        assert kappa < 0.0

    def test_lateral_right_commands_left_turn(self):
        t = DockTracker(_PARAMS)
        seg = self._dock_seg()
        chassis = (1.0, -0.2, 0.0)
        _, kappa, _ = t.step(chassis, seg, t_now=100.0)
        assert kappa > 0.0

    def test_heading_off_path_corrects_back(self):
        t = DockTracker(_PARAMS)
        seg = self._dock_seg()
        # Chassis on corridor but rotated CCW (psi > 0) → e_ψ > 0 → κ < 0
        # (turn right to bring heading back toward 0).
        chassis = (1.0, 0.0, 0.3)
        _, kappa, _ = t.step(chassis, seg, t_now=100.0)
        assert kappa < 0.0

    def test_creep_zone_drops_speed(self):
        t = DockTracker(_PARAMS)
        seg = self._dock_seg()
        # Antenna ~0.2 m from target → inside creep_zone.
        # antenna offset is 0.3 m forward, so chassis at (4.5, 0, 0)
        # gives antenna at (4.8, 0) = 0.2 m short of target (5.0, 0).
        chassis = (4.5, 0.0, 0.0)
        v, _, status = t.step(chassis, seg, t_now=100.0)
        assert status == 'tracking'
        assert v == pytest.approx(_PARAMS['creep_speed'], abs=1e-9)

    def test_reached_status_when_antenna_on_target(self):
        t = DockTracker(_PARAMS)
        seg = self._dock_seg()
        # Antenna exactly on the target: chassis at (target - offset) for
        # psi=0.
        chassis = (5.0 - _PARAMS['antenna_offset_x'], 0.0, 0.0)
        _, _, status = t.step(chassis, seg, t_now=100.0)
        assert status == 'reached'

    def test_integral_term_grows_with_lateral_error(self):
        # I-term gain wired in: feeding a constant lateral error over many
        # ticks must accumulate the integral up to the configured limit
        # and add a κ contribution beyond what -k_y · e_y alone gives.
        params = dict(_PARAMS)
        params['dock_k_i'] = 0.4
        t = DockTracker(params)
        seg = self._dock_seg()
        chassis = (1.0, 0.10, 0.0)  # 10 cm to the LEFT of corridor
        # First call seeds the timer; integrator stays zero.
        _, kappa0, _ = t.step(chassis, seg, t_now=0.0)
        # Subsequent ticks at 50 ms accumulate.
        for k in range(20):
            _, kappa_k, _ = t.step(chassis, seg, t_now=0.05 * (k + 1))
        # Kappa with I-term must be MORE negative (sharper right turn)
        # than the P-only first call.
        assert kappa_k < kappa0
        # Integral must NOT exceed its anti-windup limit.
        assert abs(t._integral) <= params['dock_integral_limit'] + 1e-9

    def test_integral_resets_on_reset(self):
        params = dict(_PARAMS)
        params['dock_k_i'] = 0.4
        t = DockTracker(params)
        seg = self._dock_seg()
        chassis = (1.0, 0.10, 0.0)
        t.step(chassis, seg, t_now=0.0)
        for k in range(10):
            t.step(chassis, seg, t_now=0.05 * (k + 1))
        assert abs(t._integral) > 0.0
        t.reset()
        assert t._integral == 0.0
        assert t._prev_t is None

    def test_overshoot_reverses_straight(self):
        # Antenna 0.25 m past target — outside 2*approach_tolerance
        # (0.20 m, the new overshoot-but-close reach gate) so 'reached'
        # doesn't trigger, but well within the reverse-recovery window.
        # Dock must back up at the latched κ from forward state feedback
        # (no integral); with chassis on the corridor centreline and
        # heading aligned, kappa_p = 0 → latched -kappa_p = 0.
        t = DockTracker(_PARAMS)
        seg = self._dock_seg()
        chassis = (5.25 - _PARAMS['antenna_offset_x'], 0.0, 0.0)
        v, kappa, status = t.step(chassis, seg, t_now=100.0)
        assert status == 'tracking'
        assert v < 0.0
        assert abs(kappa) < 1e-9
