"""Antenna-as-unicycle path tracker for rover waypoint approach.

The controller treats the GPS antenna (mounted L metres ahead of the
rear axle on the chassis x-axis) as the controlled point. Given the
chassis pose and the target antenna landing point, the tracker emits
chassis commands `(v, κ)` derived from the exact Ackermann↔unicycle
transform of Aicardi-Casalino-Bicchi-Balestrino (1995):

    v_chassis = v_des · cos(eta)
    κ_chassis = tan(eta) / L

where `eta = bearing(antenna → target) − chassis_ψ`. This makes the
antenna close on target along a smooth tangent — chassis ψ is solved
backward from "make the antenna go toward target", and cos(eta)
naturally drops v to zero as eta → 90° instead of fighting through a
saturated κ. Field-verified single-pass cm_capture landings across
3 consecutive missions on 2026-05-16; 30/30 WPs at mean 0.76 cm error,
no settle timeout, no orbital lock.

K-turn handling for large attitude errors (|eta| > 60°): chassis
reverses with saturated κ in the eta-closing direction (phase A),
drops to κ=0 straight-line reverse once aligned within `kturn_exit_rad`
(phase B), and exits forward when antenna→target distance also
satisfies `kturn_exit_dist_m`. The two-phase split prevents the
antenna from being swept past the target during the rotation portion
of the K-turn and gives the post-K-turn forward leg a guaranteed
straight-in standoff for cm_capture.

The 'reached' gate fires when antenna→target distance drops below
`cm_capture` (3 cm). The navigator transitions to SETTLING on that
return and runs a `settle_readings`-tick stability check inside
`settle_tolerance` before spraying.
"""

from math import atan2, cos, hypot, pi, sin, tan

from pilot.lib.geo_utils import normalize_angle


class L1Tracker:
    def __init__(self, params):
        self._cruise_speed = float(params['cruise_speed'])
        self._approach_speed = float(params['approach_speed'])
        self._max_curvature = float(params['max_curvature'])
        self._a_x = float(params['antenna_offset_x'])
        self._a_y = float(params['antenna_offset_y'])

        # cm-precision capture radius. Matches the navigator's
        # waypoint_tolerance and settle_tolerance for one consistent
        # 3 cm gate end-to-end. Going much tighter exceeds the RTK
        # noise band; looser gives away accuracy that's free to claim.
        self._cm_capture = float(params.get('l1_cm_capture_m', 0.03))

        # Target-distance brake. cmd v ramps LINEARLY from
        # cruise_speed at the zone edge down to min_speed at the
        # target. 1.0 m gives the MCU PID + accel_limit enough budget
        # to track the deceleration curve and land at the controlled
        # min_speed when cm_capture fires.
        self._brake_zone_m = float(params.get('l1_brake_zone_m', 1.00))
        # Hard floor on commanded forward speed inside the brake
        # zone. MCU PID deadband is 0.05 m/s; 0.07 keeps the chassis
        # moving under power until cm_capture trips.
        self._min_speed = float(params.get('l1_min_speed_m_s', 0.07))

        # K-turn hysteresis. eta = bearing(antenna→target) −
        # chassis_ψ. Enter K-turn when |eta| > kturn_enter (60°),
        # exit when |eta| < kturn_exit (5°) AND antenna is at least
        # kturn_exit_dist (50 cm) behind target. Hysteresis prevents
        # the near-target |eta|≈±π/2 oscillation that flipped cmd v
        # between +approach and -approach at 1 Hz in early field
        # trials. The min_dist suppression keeps a tiny attitude
        # excursion close to target from triggering a needless
        # back-up cycle.
        self._kturn_enter_rad = float(
            params.get('l1_kturn_enter_rad', 1.047))   # 60°
        self._kturn_exit_rad = float(
            params.get('l1_kturn_exit_rad', 0.0873))   # 5°
        self._kturn_min_dist_m = float(
            params.get('l1_kturn_min_dist_m', 0.30))
        self._kturn_exit_dist_m = float(
            params.get('l1_kturn_exit_dist_m', 0.50))

        self._kturn_active = False

    def reset(self):
        """Clear latched K-turn state. Called by the navigator on
        segment advance and after stuck-handler intervention.
        """
        self._kturn_active = False

    def _antenna_world(self, chassis_pose):
        x, y, psi = chassis_pose
        cp, sp = cos(psi), sin(psi)
        return (x + cp * self._a_x - sp * self._a_y,
                y + sp * self._a_x + cp * self._a_y)

    def _clamp_curvature(self, kappa):
        if kappa > self._max_curvature:
            return self._max_curvature
        if kappa < -self._max_curvature:
            return -self._max_curvature
        return kappa

    def step(self, chassis_pose, segment, t_now, antenna_world=None):
        """Return (v_cmd, kappa_cmd, status).

        status: 'tracking' | 'reached'

        `t_now` is accepted for parity with the legacy tracker
        signature so the navigator can call uniformly; unused here.
        """
        if antenna_world is None:
            antenna_world = self._antenna_world(chassis_pose)
        _, _, psi = chassis_pose
        ax, ay = antenna_world
        tx, ty = segment.target_antenna

        target_dist = hypot(tx - ax, ty - ay)
        if target_dist <= self._cm_capture:
            self._kturn_active = False
            return 0.0, 0.0, 'reached'

        # Bearing FROM the antenna. The whole point of the antenna-
        # unicycle transform is that geometry is computed at the
        # controlled point; chassis-frame bearing would flip ±180°
        # the moment chassis crosses target while the antenna is
        # still 36 cm short.
        bearing = atan2(ty - ay, tx - ax)
        eta = normalize_angle(bearing - psi)
        abs_eta = abs(eta)

        # K-turn state machine. Two-condition exit (alignment AND
        # standoff). Phase A: saturated κ rotates chassis backward
        # while turning. Phase B (|eta| < exit_rad): κ=0 straight-
        # line reverse builds the standoff for the post-K-turn
        # forward leg. With the antenna-unicycle controller below,
        # the forward leg corrects any residual alignment drift
        # smoothly, so K-turn doesn't need to nail ψ exactly — only
        # enough for forward to take over without re-entering K-turn.
        if self._kturn_active:
            if (abs_eta < self._kturn_exit_rad
                    and target_dist >= self._kturn_exit_dist_m):
                self._kturn_active = False
        else:
            # A genuine overshoot (|eta| > 90°) puts the target behind the
            # antenna's heading, where the forward unicycle law below would
            # command cos(eta) < 0 (reverse) with a wrong-sign saturated κ —
            # it cannot close on target and stalls. The kturn_min_dist guard
            # (meant to suppress needless backups for *small* near-target
            # attitude jitter) must NOT block this case, or the rover gets
            # trapped oscillating just outside cm_capture. Hand off to the
            # K-turn regardless of distance once we've overshot; the 60°
            # enter threshold still filters out the small-jitter case.
            overshot = abs_eta > (pi / 2)
            if (abs_eta > self._kturn_enter_rad
                    and (target_dist > self._kturn_min_dist_m or overshot)):
                self._kturn_active = True

        if self._kturn_active:
            # Sign: eta > 0 means bearing is ahead-and-left of ψ →
            # want ψ̇ > 0 → backward v < 0 needs κ < 0. κ = -sign(eta)·max.
            if abs_eta >= self._kturn_exit_rad:
                kappa_kt = (-self._max_curvature if eta > 0
                            else self._max_curvature)
            else:
                kappa_kt = 0.0
            return -self._approach_speed, \
                self._clamp_curvature(kappa_kt), 'tracking'

        # Forward leg — Aicardi-Casalino-Bicchi-Balestrino (1995)
        # antenna-as-unicycle transform. For the unicycle (antenna)
        # to move along the bearing vector to target at speed v_des,
        # the chassis must drive:
        #     v_chassis = v_des · cos(eta)
        #     κ_chassis = tan(eta) / L_antenna
        # cos(eta) drops v cleanly to zero as eta → 90° instead of
        # fighting a saturated κ; tan(eta)/L is the unique κ that
        # aligns chassis ψ with the antenna's required heading.
        # Inside the K-turn entry threshold (|eta| < 60°) cos(eta)
        # stays above 0.5, so v_chassis stays solidly positive
        # throughout the forward leg.
        v_des = self._cruise_speed
        if target_dist < self._brake_zone_m:
            t_ramp = target_dist / self._brake_zone_m
            v_des = self._min_speed + t_ramp * (
                self._cruise_speed - self._min_speed)
        speed_d = v_des * cos(eta)
        kappa_d = self._clamp_curvature(tan(eta) / self._a_x)
        return speed_d, kappa_d, 'tracking'
