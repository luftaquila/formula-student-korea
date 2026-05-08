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


def _seg(kind, start, end, target=(0.0, 0.0), idx=0):
    return PathSegment(kind, start, end, target, idx)


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

    def test_curvature_sign_target_to_left(self):
        t = CruiseTracker(_PARAMS)
        # Chassis facing East at origin; target due North → α = +π/2 →
        # PP wants to turn LEFT → κ > 0 (math/CCW convention).
        seg = _seg('cruise', (0.0, 0.0, 0.0), (0.0, 5.0, pi / 2))
        _, kappa, _ = t.step((0.0, 0.0, 0.0), seg, t_now=100.0)
        assert kappa > 0.0

    def test_curvature_sign_target_to_right(self):
        t = CruiseTracker(_PARAMS)
        # Target due South → α = -π/2 → turn RIGHT → κ < 0.
        seg = _seg('cruise', (0.0, 0.0, 0.0), (0.0, -5.0, -pi / 2))
        _, kappa, _ = t.step((0.0, 0.0, 0.0), seg, t_now=100.0)
        assert kappa < 0.0

    def test_curvature_clamped_to_max(self):
        t = CruiseTracker(_PARAMS)
        # Target slightly off-axis but very close — would explode without
        # the max_curvature clamp.
        seg = _seg('cruise', (0.0, 0.0, 0.0), (0.05, 0.05, pi / 4))
        _, kappa, _ = t.step((0.0, 0.0, 0.0), seg, t_now=100.0)
        assert abs(kappa) <= _PARAMS['max_curvature'] + 1e-9

    def test_speed_scales_with_heading_error(self):
        t = CruiseTracker(_PARAMS)
        # Target 90° to the side: speed should drop noticeably from cruise.
        seg = _seg('cruise', (0.0, 0.0, 0.0), (0.0, 5.0, pi / 2))
        v, _, _ = t.step((0.0, 0.0, 0.0), seg, t_now=100.0)
        # cos(π/2) = 0 → clamped to min_speed_fraction × cruise.
        assert v == pytest.approx(_PARAMS['cruise_speed'] * 0.35, abs=1e-9)

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

    def test_d_term_damps_when_chassis_converges_on_target(self):
        # Convergence: α > 0 with dα/dt < 0. P-only κ > 0 (turning left).
        # Damping κ += damping·dα/dt adds a NEGATIVE contribution → κ_damped
        # is signed-smaller than κ_p_only (less left turn, possibly even
        # turning right to brake). Earlier sign was anti-damping.
        # Use a small off-axis target so neither κ saturates at max_curvature.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.3, 0.0))
        # Pose A: chassis at origin, target slightly left → small +α.
        _, _, _ = t.step((0.0, 0.0, 0.0), seg, t_now=100.0)
        # Pose B: chassis rotated +0.04 rad toward target → α reduced.
        t_p_only = CruiseTracker(_PARAMS)
        _, kappa_p_only, _ = t_p_only.step((0.0, 0.0, 0.04), seg, t_now=200.0)
        _, kappa_damped, _ = t.step((0.0, 0.0, 0.04), seg, t_now=100.05)
        # Both unsaturated since target is small-angle off-axis.
        assert abs(kappa_p_only) < _PARAMS['max_curvature'] - 1e-9
        # Damping must reduce SIGNED κ (less turn in the convergence direction).
        # P-term has α > 0 → κ_p > 0; damping contribution is negative.
        assert kappa_damped < kappa_p_only, (
            f'D-term should reduce signed κ on convergence: '
            f'κ_damped={kappa_damped:.4f} must be < κ_p_only={kappa_p_only:.4f}'
        )

    def test_d_term_boosts_when_chassis_diverges_from_target(self):
        # Divergence: α > 0 with dα/dt > 0 (chassis turning AWAY from target).
        # P-only κ > 0; damping adds a POSITIVE contribution → κ_damped >
        # κ_p_only, correcting harder against the diverging heading.
        t = CruiseTracker(_PARAMS)
        seg = _seg('cruise', (0.0, 0.0, 0.0), (5.0, 0.3, 0.0))
        # Pose A: chassis already pointing partly toward target.
        _, _, _ = t.step((0.0, 0.0, 0.04), seg, t_now=100.0)
        # Pose B: chassis rotated AWAY (psi smaller) → α grew.
        t_p_only = CruiseTracker(_PARAMS)
        _, kappa_p_only, _ = t_p_only.step((0.0, 0.0, 0.0), seg, t_now=200.0)
        _, kappa_damped, _ = t.step((0.0, 0.0, 0.0), seg, t_now=100.05)
        assert kappa_damped > kappa_p_only - 1e-9, (
            f'D-term should boost κ on divergence: '
            f'κ_damped={kappa_damped:.4f} vs κ_p_only={kappa_p_only:.4f}'
        )


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
        # Antenna 0.15 m past target — outside approach_tolerance (0.10)
        # so 'reached' doesn't trigger, but well within the 0.20 m reverse-
        # recovery window. Dock must back up at creep speed with κ ≈ 0
        # (Ackermann steering inverts in reverse and interacts poorly with
        # the linearised gains).
        t = DockTracker(_PARAMS)
        seg = self._dock_seg()
        chassis = (5.15 - _PARAMS['antenna_offset_x'], 0.0, 0.0)
        v, kappa, status = t.step(chassis, seg, t_now=100.0)
        assert status == 'tracking'
        assert v < 0.0
        assert abs(kappa) < 1e-9
