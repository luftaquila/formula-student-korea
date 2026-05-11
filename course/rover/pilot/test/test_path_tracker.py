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
    'pp_lookahead_min': 0.6,
    'pp_lookahead_gain': 0.6,
    'pp_damping': 0.18,
    'cruise_done_tolerance': 0.20,
    'pp_min_speed_fraction': 0.35,  # tests pin to 0.35 for the legacy
                                     # heading-error speed-scale assertion;
                                     # production yaml uses 0.25.
    'pp_handoff_blend_distance': 1.0,
    'dock_k_y': 1.4,
    'dock_k_psi': 1.6,                # tests pin to 1.6 for the legacy
                                       # P-only assertions; production yaml
                                       # uses 2.4 alongside the new I-term.
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
    def test_straight_target_zero_curvature(self):
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        v, kappa, done = t.step((0.0, 0.0, 0.0), seg, t_now=100.0)
        assert not done
        assert v == pytest.approx(_PARAMS['cruise_speed'], abs=1e-9)
        assert abs(kappa) < 1e-9

    def test_done_within_tolerance(self):
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        # Chassis already at the cruise endpoint (within tolerance).
        v, kappa, done = t.step((4.95, 0.0, 0.0), seg, t_now=100.0)
        assert done
        assert v == 0.0 and kappa == 0.0

    def test_chassis_left_of_corridor_turns_right(self):
        t = CruiseTracker(_PARAMS)
        # Corridor along East (psi_path=0). Chassis 0.2 m LEFT of corridor
        # (positive y), heading aligned. Stanley: e_y > 0 → desired_offset
        # > 0 → desired_psi < psi_path → e_psi_corrected > 0 → κ < 0
        # (right turn) to head back onto the corridor.
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        _, kappa, _ = t.step((1.0, 0.2, 0.0), seg, t_now=100.0)
        assert kappa < 0.0

    def test_chassis_right_of_corridor_turns_left(self):
        t = CruiseTracker(_PARAMS)
        # Mirror of above: chassis below corridor → κ > 0 (left turn).
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        _, kappa, _ = t.step((1.0, -0.2, 0.0), seg, t_now=100.0)
        assert kappa > 0.0

    def test_curvature_clamped_to_max(self):
        t = CruiseTracker(_PARAMS)
        # Large lateral error at cruise speed would push Stanley's
        # heading regulator past the chassis curvature limit; clamp must
        # bind.
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        _, kappa, _ = t.step((1.0, 5.0, 0.0), seg, t_now=100.0)
        assert abs(kappa) <= _PARAMS['max_curvature'] + 1e-9

    def test_speed_scales_with_heading_error(self):
        t = CruiseTracker(_PARAMS)
        # Chassis on corridor centreline but heading 90° off corridor.
        # Stanley's e_psi_corrected = pi/2 → cos = 0 → speed clamped to
        # min_speed_fraction × cruise.
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        v, _, _ = t.step((1.0, 0.0, pi / 2), seg, t_now=100.0)
        assert v == pytest.approx(
            _PARAMS['cruise_speed'] * _PARAMS['pp_min_speed_fraction'], abs=1e-9)

    def test_speed_blends_to_approach_near_end_of_cruise(self):
        # Within pp_handoff_blend_distance metres of the end pose, the
        # commanded speed must linearly taper from cruise_speed toward
        # approach_speed so the chassis reaches the dock corridor at the
        # speed DockTracker's gains were tuned for. With α=0 the cos()
        # speed_scale is 1.0 so we observe the blend directly.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        # 0.30 m from the end → well inside the 1.0 m blend.
        v, _, done = t.step((4.70, 0.0, 0.0), seg, t_now=100.0)
        assert not done
        # Linearly between approach_speed and cruise_speed:
        # blend = (0.30 - 0.20) / (1.0 - 0.20) = 0.125
        # target = 0.4 + 0.125 × (1.0 − 0.4) = 0.475
        assert v == pytest.approx(0.475, abs=1e-6)

    def test_speed_blend_inactive_far_from_end(self):
        # Past pp_handoff_blend_distance, target is the full cruise_speed.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (10.0, 0.0, 0.0))
        v, _, done = t.step((0.0, 0.0, 0.0), seg, t_now=100.0)
        assert not done
        assert v == pytest.approx(_PARAMS['cruise_speed'], abs=1e-9)

    def test_done_requires_heading_aligned(self):
        # Within cruise_done_tolerance of end but chassis heading 45° off
        # corridor → not done (would hand off a bad heading to dock).
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        _, _, done = t.step((4.95, 0.0, pi / 4), seg, t_now=100.0)
        assert not done

    def test_pass_through_safety_net(self):
        # Chassis past the end pose along corridor by more than
        # cruise_pass_through_m → forced done regardless of heading.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0))
        _, _, done = t.step((5.40, 0.0, pi / 4), seg, t_now=100.0)
        assert done


class TestCruiseReverse:
    """Reverse cruise sub-segments come out of the Reed-Shepp planner
    when the goal sits inside the chassis turning circle. The tracker
    must emit negative speed and flip kappa so the chassis backs along
    the segment in the right direction."""

    def test_reverse_segment_emits_negative_speed(self):
        # Reverse along +x: chord direction = 0, chassis facing −x
        # (psi = pi) is the canonical orientation for reversing along
        # the chord. Tracker must command v < 0.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0), direction=-1)
        v, _, _ = t.step((0.0, 0.0, pi), seg, t_now=100.0)
        assert v < 0.0

    def test_reverse_chassis_aligned_zero_curvature(self):
        # Chassis facing pi (motion direction is +x along the chord),
        # exactly on the corridor with no lateral error: kappa must be
        # ≈ 0 (Stanley sees no error, motion is aligned).
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0), direction=-1)
        _, kappa, _ = t.step((1.0, 0.0, pi), seg, t_now=100.0)
        assert abs(kappa) < 1e-6

    def test_reverse_lateral_error_drives_correct_kappa_sign(self):
        # Chassis above the corridor (e_y > 0), motion direction is the
        # chord (+x). For *forward* cruise the tracker emits kappa < 0
        # to turn the chassis right (toward the corridor). For reverse
        # cruise the tracker must emit the OPPOSITE sign kappa so the
        # same world-frame wheel angle still rotates the chassis toward
        # the corridor under Ackermann reverse kinematics.
        t = CruiseTracker(_PARAMS)
        seg_fwd = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0), direction=1)
        seg_rev = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.0, 0.0), direction=-1)
        # Forward: chassis facing +x (along corridor), 0.2 m left.
        _, kappa_fwd, _ = t.step((1.0, 0.2, 0.0), seg_fwd, t_now=100.0)
        # Reverse: chassis facing -x (so motion direction = +x), same
        # lateral offset.
        _, kappa_rev, _ = t.step((1.0, 0.2, pi), seg_rev, t_now=101.0)
        # Forward sign: e_y > 0 → desired_offset > 0 → e_psi_corrected
        # > 0 → kappa < 0.
        assert kappa_fwd < 0
        # Reverse sign: flipped.
        assert kappa_rev > 0


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
