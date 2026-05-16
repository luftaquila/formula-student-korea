"""Tests for L1Tracker (antenna-as-unicycle direct-to-target controller).

The tracker treats the GPS antenna as the controlled point and uses the
Aicardi-Casalino-Bicchi-Balestrino (1995) Ackermann↔unicycle transform
on the forward leg:

    v_chassis = v_des · cos(eta)
    κ_chassis = tan(eta) / L_antenna

where `eta = bearing(antenna → target) − chassis_ψ`. K-turn handles
|eta| > 60° with two-phase backward (saturated κ alignment, then κ=0
straight reverse to build the standoff). Field-verified on the rover:
30/30 single-pass cm_capture landings across 3 missions on 2026-05-16.

Tests pin the behaviours that the field failures led us to:
  - cm_capture gate fires exactly at antenna→target distance.
  - Forward transform: aligned chassis → straight; off-axis chassis →
    cos(eta)·v + tan(eta)/L · κ closes both speed and heading in a
    smooth tangent arc.
  - brake_zone ramp: cmd v scales linearly from cruise_speed at the
    zone edge down to min_speed at target.
  - K-turn enter at |eta|>60° AND dist>kturn_min_dist (close-target
    suppression).
  - K-turn exit requires BOTH alignment (|eta|<5°) AND standoff
    (dist>=50 cm). Either alone keeps the chassis in K-turn.
  - K-turn phase A (saturated κ) vs phase B (κ=0) split: phase B
    only kicks in once aligned.
  - Curvature clamp at ±max_curvature.
"""

from math import cos, sin, tan, hypot, radians, degrees, pi

import pytest

from pilot.lib.path_planner import PathSegment
from pilot.lib.path_tracker import L1Tracker


_PARAMS = {
    'cruise_speed': 1.0,
    'approach_speed': 0.4,
    'max_curvature': 1.7,
    'wheelbase': 0.33,
    'max_steering_angle_rad': radians(30.5),
    'antenna_offset_x': 0.30,
    'antenna_offset_y': 0.00,
    'l1_cm_capture_m': 0.03,
    'l1_brake_zone_m': 1.00,
    'l1_min_speed_m_s': 0.07,
    'l1_kturn_enter_rad': 1.047,   # 60°
    'l1_kturn_exit_rad': 0.0873,   # 5°
    'l1_kturn_min_dist_m': 0.30,
    'l1_kturn_exit_dist_m': 0.50,
}


def _seg(target=(0.0, 0.0), idx=0):
    """Build a minimal PathSegment for a tracker step.

    L1Tracker only reads `target_antenna`; `end_pose` is for the
    navigator's stuck-detection progress check.
    """
    return PathSegment(
        end_pose=target + (0.0,),
        target_antenna=target,
        waypoint_index=idx,
    )


def _antenna_world_from_pose(pose, a_x=0.30, a_y=0.0):
    x, y, psi = pose
    return (x + cos(psi) * a_x - sin(psi) * a_y,
            y + sin(psi) * a_x + cos(psi) * a_y)


def _chassis_for_antenna_at(ax, ay, psi, a_x=0.30, a_y=0.0):
    """Inverse of _antenna_world_from_pose — chassis pose so the
    antenna lands exactly at (ax, ay) for a given heading."""
    x = ax - (cos(psi) * a_x - sin(psi) * a_y)
    y = ay - (sin(psi) * a_x + cos(psi) * a_y)
    return (x, y, psi)


class TestReached:
    def test_reached_at_cm_capture(self):
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(1.0, 0.0))
        # Antenna 2 cm short of target along +x. cm_capture = 3 cm.
        antenna = (0.98, 0.0)
        chassis = _chassis_for_antenna_at(*antenna, psi=0.0)
        v, kappa, status = t.step(chassis, seg, t_now=0.0,
                                  antenna_world=antenna)
        assert status == 'reached'
        assert v == 0.0 and kappa == 0.0

    def test_not_reached_just_outside_cm_capture(self):
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(1.0, 0.0))
        # Antenna 3.5 cm short — outside cm_capture.
        antenna = (0.965, 0.0)
        chassis = _chassis_for_antenna_at(*antenna, psi=0.0)
        _, _, status = t.step(chassis, seg, t_now=0.0,
                              antenna_world=antenna)
        assert status == 'tracking'

    def test_reached_clears_kturn_latch(self):
        """A 'reached' return should clear _kturn_active so the next
        segment doesn't inherit stale K-turn state."""
        t = L1Tracker(_PARAMS)
        t._kturn_active = True
        seg = _seg(target=(1.0, 0.0))
        antenna = (1.01, 0.0)
        chassis = _chassis_for_antenna_at(*antenna, psi=0.0)
        t.step(chassis, seg, t_now=0.0, antenna_world=antenna)
        assert t._kturn_active is False


class TestForwardUnicycleTransform:
    def test_aligned_chassis_drives_straight(self):
        """Chassis ψ exactly aligned with antenna→target bearing →
        eta = 0 → κ = tan(0)/L = 0, straight forward."""
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(3.0, 0.0))
        antenna = (1.0, 0.0)
        chassis = _chassis_for_antenna_at(*antenna, psi=0.0)
        v, kappa, status = t.step(chassis, seg, t_now=0.0,
                                  antenna_world=antenna)
        assert status == 'tracking'
        assert kappa == pytest.approx(0.0, abs=1e-9)
        # 2 m to target, brake_zone = 1 m → outside zone, full cruise.
        assert v == pytest.approx(_PARAMS['cruise_speed'], abs=1e-9)

    def test_kappa_sign_matches_eta_sign(self):
        """eta > 0 (target ahead-and-left of chassis) → κ > 0 (left
        turn). eta < 0 → κ < 0."""
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(2.0, 0.0))
        antenna = (1.0, 0.0)
        # Chassis pointed +20° (north-east-ish). Target is dead east →
        # bearing = 0, eta = -20° < 0 → κ < 0 (right turn).
        chassis = _chassis_for_antenna_at(*antenna, psi=radians(20))
        _, kappa_left, _ = t.step(chassis, seg, t_now=0.0,
                                  antenna_world=antenna)
        assert kappa_left < 0.0

        # Mirror: chassis pointed -20° → eta = +20° > 0 → κ > 0.
        chassis = _chassis_for_antenna_at(*antenna, psi=radians(-20))
        _, kappa_right, _ = t.step(chassis, seg, t_now=0.0,
                                   antenna_world=antenna)
        assert kappa_right > 0.0
        # Symmetric magnitude.
        assert kappa_left == pytest.approx(-kappa_right, abs=1e-9)

    def test_kappa_matches_aicardi_formula(self):
        """κ_chassis = tan(eta) / L_antenna exactly."""
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(2.0, 0.0))
        antenna = (1.0, 0.0)
        for psi_deg in (-30, -10, 0, 5, 25, 45):
            psi = radians(psi_deg)
            chassis = _chassis_for_antenna_at(*antenna, psi=psi)
            _, kappa, _ = t.step(chassis, seg, t_now=0.0,
                                 antenna_world=antenna)
            expected = tan(0.0 - psi) / _PARAMS['antenna_offset_x']
            # Clamped to ±max_curvature.
            mx = _PARAMS['max_curvature']
            expected_clamped = max(-mx, min(mx, expected))
            assert kappa == pytest.approx(expected_clamped, abs=1e-9)

    def test_v_scales_with_cos_eta(self):
        """v_chassis = v_des · cos(eta). At eta=60° (just inside
        K-turn enter), v drops to v_des/2."""
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(3.0, 0.0))  # 2 m → outside brake_zone
        antenna = (1.0, 0.0)
        chassis = _chassis_for_antenna_at(*antenna, psi=radians(59))
        v, _, _ = t.step(chassis, seg, t_now=0.0, antenna_world=antenna)
        expected = _PARAMS['cruise_speed'] * cos(radians(59))
        assert v == pytest.approx(expected, abs=1e-6)


class TestBrakeZone:
    def test_outside_brake_zone_full_cruise(self):
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(2.0, 0.0))
        # Antenna 1.5 m from target (zone is 1.0 m) → full cruise_speed.
        antenna = (0.5, 0.0)
        chassis = _chassis_for_antenna_at(*antenna, psi=0.0)
        v, _, _ = t.step(chassis, seg, t_now=0.0, antenna_world=antenna)
        assert v == pytest.approx(_PARAMS['cruise_speed'], abs=1e-9)

    def test_brake_ramp_linear_in_zone(self):
        """Inside brake_zone, v_des = min_speed + t·(cruise − min)
        where t = dist/brake_zone. Verify at the midpoint."""
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(0.5, 0.0))
        # Antenna 0.5 m from target, brake_zone 1.0 m → t = 0.5.
        antenna = (0.0, 0.0)
        chassis = _chassis_for_antenna_at(*antenna, psi=0.0)
        v, _, _ = t.step(chassis, seg, t_now=0.0, antenna_world=antenna)
        expected = (_PARAMS['l1_min_speed_m_s']
                    + 0.5 * (_PARAMS['cruise_speed']
                             - _PARAMS['l1_min_speed_m_s']))
        # eta is 0 (aligned), so cos(eta)=1 — v_cmd == v_des.
        assert v == pytest.approx(expected, abs=1e-9)

    def test_brake_floor_at_min_speed(self):
        """Right at cm_capture+ε the ramp should hit min_speed."""
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(1.0, 0.0))
        # Antenna 4 cm from target → reach gate doesn't fire, but
        # very inside the brake zone.
        antenna = (0.96, 0.0)
        chassis = _chassis_for_antenna_at(*antenna, psi=0.0)
        v, _, _ = t.step(chassis, seg, t_now=0.0, antenna_world=antenna)
        # t = 0.04, v_des = 0.07 + 0.04·0.93 ≈ 0.107.
        assert 0.07 < v < 0.12


class TestKturnEnter:
    def test_enters_kturn_when_eta_above_threshold_and_far(self):
        """|eta| > 60° AND dist > kturn_min_dist → enter. v negative,
        κ saturated in alignment-closing direction."""
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(1.0, 0.0))
        antenna = (0.0, 0.0)  # 1 m from target — well past 30 cm.
        # ψ = 90° → bearing(0°) − ψ = −90° → |eta|=90° > 60°.
        chassis = _chassis_for_antenna_at(*antenna, psi=radians(90))
        v, kappa, status = t.step(chassis, seg, t_now=0.0,
                                  antenna_world=antenna)
        assert status == 'tracking'
        assert v == -_PARAMS['approach_speed']
        # eta < 0 → kappa = +max
        assert kappa == _PARAMS['max_curvature']
        assert t._kturn_active

    def test_no_kturn_inside_min_dist(self):
        """Within kturn_min_dist of target, K-turn is suppressed even
        on a large eta — chassis takes the small forward arc
        through the antenna-unicycle transform instead."""
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(1.0, 0.0))
        # Antenna 20 cm from target, ψ off by 90°.
        antenna = (0.80, 0.0)
        chassis = _chassis_for_antenna_at(*antenna, psi=radians(90))
        v, kappa, _ = t.step(chassis, seg, t_now=0.0,
                             antenna_world=antenna)
        assert not t._kturn_active
        # Forward branch: cos(-90°)·v_des ≈ 0, tan(-90°)/L → clamped κ.
        # v should be small (cos≈0) but non-negative direction.
        assert v == pytest.approx(0.0, abs=1e-6)


class TestKturnExit:
    def test_exit_requires_both_alignment_and_standoff(self):
        """In K-turn: alignment alone (small eta but dist still
        small) should NOT exit. Tracker should hold K-turn."""
        t = L1Tracker(_PARAMS)
        t._kturn_active = True
        seg = _seg(target=(0.0, 0.0))
        # Antenna 20 cm from target, well aligned → alignment OK
        # but dist (0.20) < kturn_exit_dist (0.50). Stay in K-turn.
        antenna = (-0.20, 0.0)
        chassis = _chassis_for_antenna_at(*antenna, psi=0.0)
        v, kappa, _ = t.step(chassis, seg, t_now=0.0,
                             antenna_world=antenna)
        assert t._kturn_active  # still latched
        # Phase B: aligned → κ=0, v negative.
        assert kappa == 0.0
        assert v == -_PARAMS['approach_speed']

    def test_exit_when_both_satisfied(self):
        """Both |eta|<5° and dist>=50cm → exit to forward."""
        t = L1Tracker(_PARAMS)
        t._kturn_active = True
        seg = _seg(target=(0.0, 0.0))
        antenna = (-0.60, 0.0)  # 60 cm behind target, aligned
        chassis = _chassis_for_antenna_at(*antenna, psi=0.0)
        v, kappa, _ = t.step(chassis, seg, t_now=0.0,
                             antenna_world=antenna)
        assert not t._kturn_active
        # Forward: antenna→target bearing = 0, eta = 0 → κ=0, v=v_des>0.
        assert kappa == pytest.approx(0.0, abs=1e-9)
        assert v > 0.0

    def test_phase_a_saturated_kappa_while_misaligned(self):
        """K-turn with |eta| > kturn_exit (5°) gives saturated κ in
        the alignment-closing direction (sign = -sign(eta))."""
        t = L1Tracker(_PARAMS)
        t._kturn_active = True
        seg = _seg(target=(0.0, 0.0))
        antenna = (-0.40, 0.0)
        # eta = 0 − 20° = −20° → |eta|>5° → phase A, κ=+max.
        chassis = _chassis_for_antenna_at(*antenna, psi=radians(20))
        _, kappa, _ = t.step(chassis, seg, t_now=0.0,
                             antenna_world=antenna)
        assert kappa == _PARAMS['max_curvature']


class TestCurvatureClamp:
    def test_forward_kappa_clamped_to_max(self):
        """At eta close to ±90° (just inside K-turn entry), the raw
        tan(eta)/L blows up; the clamp keeps it at ±max_curvature."""
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(1.0, 0.0))
        antenna = (0.0, 0.0)
        # ψ = -59° → eta = 0 - (-59°) = +59° (just under enter
        # threshold of 60°). tan(59°)/0.30 ≈ 5.55 — clamped to 1.7.
        chassis = _chassis_for_antenna_at(*antenna, psi=radians(-59))
        _, kappa, _ = t.step(chassis, seg, t_now=0.0,
                             antenna_world=antenna)
        assert kappa == _PARAMS['max_curvature']


class TestAntennaWorldDefault:
    def test_antenna_world_computed_when_not_passed(self):
        """If antenna_world is None, the tracker should derive it
        from chassis_pose using antenna_offset_x/y."""
        t = L1Tracker(_PARAMS)
        seg = _seg(target=(1.0, 0.0))
        # Chassis at origin pointing +x; expected antenna at (0.30,0).
        chassis = (0.0, 0.0, 0.0)
        v1, k1, _ = t.step(chassis, seg, t_now=0.0)
        v2, k2, _ = t.step(chassis, seg, t_now=0.0,
                           antenna_world=(0.30, 0.0))
        assert v1 == pytest.approx(v2, abs=1e-9)
        assert k1 == pytest.approx(k2, abs=1e-9)


class TestReset:
    def test_reset_clears_kturn_state(self):
        t = L1Tracker(_PARAMS)
        t._kturn_active = True
        t.reset()
        assert t._kturn_active is False
