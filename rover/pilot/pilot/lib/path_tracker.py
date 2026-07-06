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

K-turn handling for large attitude errors (|eta| > 60°): the minimum
turning radius (1/max_curvature ≈ 0.59 m) dwarfs the cm_capture gate,
so once the antenna is near the target but the chassis points far off
the bearing, the forward law physically cannot arc onto the target —
it must reverse first. The K-turn engages at ANY distance (large eta
close to target is exactly when it's mandatory) and reverses with
saturated κ, then latches straight-line reverse (κ=0, phase B) once
aligned to build a `kturn_exit_dist_m` standoff for the post-K-turn
forward leg.

Two latches keep it robust against the close-range bearing noise that
makes sign(eta) flip tick-to-tick within a few cm of target:
  • the ROTATION DIRECTION (κ sign) is fixed at entry and held through
    phase A, so noisy eta crossing zero can't slam the steering full-lock
    left↔right (the reverse-thrash the operator sees as "조향이 좌우로
    미친듯이 와리가리");
  • the ALIGNMENT latch fires when |eta| enters `kturn_exit_rad` OR eta
    crosses to the far side of the entry direction (the sign-cross clause
    guarantees it fires as the chassis rotates through alignment even if
    noise keeps every sample outside the tight band — a held direction
    with a missed latch would otherwise run away). Once latched, phase B
    holds κ=0 through eta drift, so the standoff build never re-saturates
    the wheel with the opposite sign.

The 'reached' gate fires when antenna→target distance drops below
`cm_capture` (3 cm). The navigator transitions to SETTLING on that
return and runs a `settle_readings`-tick stability check inside
`settle_tolerance` before spraying.
"""

from math import atan2, cos, hypot, sin, tan

from pilot.lib.geo_utils import normalize_angle
from pilot.lib.antenna_calibration import OFFSET_MIN_FORWARD_M


class L1Tracker:
    def __init__(self, params):
        self._cruise_speed = float(params['cruise_speed'])
        self._approach_speed = float(params['approach_speed'])
        self._max_curvature = float(params['max_curvature'])
        self._a_x = float(params['antenna_offset_x'])
        self._a_y = float(params['antenna_offset_y'])
        if self._a_x < OFFSET_MIN_FORWARD_M:
            raise ValueError(
                f'antenna_offset_x must be >= {OFFSET_MIN_FORWARD_M:.2f} m '
                f'for the L1 antenna transform (got {self._a_x:.3f})'
            )

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
        # chassis_ψ. Enter K-turn when |eta| > kturn_enter (60°) at
        # ANY distance; exit when the alignment latch is set (|eta| has
        # dropped below kturn_exit (5°) at some point during the reverse)
        # AND the antenna is at least kturn_exit_dist (50 cm) behind
        # target. The 60°→5°+standoff hysteresis prevents the near-target
        # |eta|≈±π/2 oscillation that flipped cmd v between +approach and
        # -approach at 1 Hz in early field trials.
        self._kturn_enter_rad = float(
            params.get('l1_kturn_enter_rad', 1.047))   # 60°
        self._kturn_exit_rad = float(
            params.get('l1_kturn_exit_rad', 0.0873))   # 5°
        self._kturn_exit_dist_m = float(
            params.get('l1_kturn_exit_dist_m', 0.50))

        self._kturn_active = False
        # Latched once |eta| first drops within kturn_exit during a
        # K-turn; holds phase B (straight reverse) so the standoff build
        # never re-saturates the wheel on eta drift. Cleared on exit,
        # reach, and reset.
        self._kturn_aligned = False
        # Rotation direction (κ sign) latched ONCE at K-turn entry and held
        # through phase A. 0 = not latched. Holding it stops the steering
        # from slamming full-lock left↔right when close-range bearing noise
        # flips sign(eta) tick-to-tick during the reverse. Cleared on exit,
        # reach, and reset.
        self._kturn_dir = 0.0

    def reset(self):
        """Clear latched K-turn state. Called by the navigator on
        segment advance and after stuck-handler intervention.
        """
        self._kturn_active = False
        self._kturn_aligned = False
        self._kturn_dir = 0.0

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
            self._kturn_aligned = False
            self._kturn_dir = 0.0
            return 0.0, 0.0, 'reached'

        # Bearing FROM the antenna. The whole point of the antenna-
        # unicycle transform is that geometry is computed at the
        # controlled point; chassis-frame bearing would flip ±180°
        # the moment chassis crosses target while the antenna is
        # still 36 cm short.
        bearing = atan2(ty - ay, tx - ax)
        eta = normalize_angle(bearing - psi)
        abs_eta = abs(eta)

        # K-turn state machine for large attitude error.
        #
        # Entry: |eta| > enter, at ANY distance. The old distance guard
        # (`target_dist > kturn_min_dist_m`) suppressed entry inside 30 cm
        # for 60° < |eta| ≤ 90°, dropping the chassis into the forward law
        # where v·cos(eta) collapses below the MCU drive deadband while κ
        # stays saturated — wheels cranked hard over, no motion, eta frozen
        # (mission #6: blue "driving" LED on, operator pushing the rover by
        # hand). But that close-in large-eta case is precisely where the
        # forward arc CANNOT close (min radius 0.59 m ≫ target_dist), so
        # the K-turn is mandatory there, not optional. Enter regardless of
        # distance; the 60° enter / 5°+standoff exit hysteresis still keeps
        # forward↔K-turn from chattering.
        #
        # Exit: alignment LATCH set AND standoff reached. Phase A reverses
        # with saturated κ (a rotation direction latched ONCE at entry) until
        # the chassis aligns; phase B then reverses straight (κ=0) to build
        # the standoff.
        #
        # Two latches, both to survive close-range bearing noise (the
        # antenna→target bearing, hence eta, gets very noisy within a few cm
        # of target, so sign(eta) can flip tick-to-tick):
        #   • _kturn_dir  — the κ sign, fixed at entry. Holding it stops the
        #     steering from slamming full-lock left↔right as noisy eta crosses
        #     zero mid-reverse (the "조향이 좌우로 미친듯이 와리가리" thrash).
        #   • _kturn_aligned — set when |eta| enters the exit band OR eta
        #     crosses to the far side of the entry direction. The sign-cross
        #     clause GUARANTEES the latch fires as the chassis rotates through
        #     alignment even if noise keeps every sample outside the tight ±5°
        #     band — without it, a held direction with a missed latch would
        #     keep rotating past 0 and run away. Once latched, phase-B κ=0.
        # This also subsumes the earlier mission-#6 fix: a straight reverse
        # that drifts eta no longer re-saturates the wheel with the opposite
        # sign. The forward leg finishes any residual alignment once it has
        # the standoff to arc in.
        if self._kturn_active:
            if (abs_eta < self._kturn_exit_rad
                    or eta * self._kturn_dir > 0.0):
                self._kturn_aligned = True
            if self._kturn_aligned and target_dist >= self._kturn_exit_dist_m:
                self._kturn_active = False
                self._kturn_aligned = False
                self._kturn_dir = 0.0
        elif abs_eta > self._kturn_enter_rad:
            self._kturn_active = True
            self._kturn_aligned = False
            # κ sign = -sign(eta_entry). eta > 0 → κ < 0 (see below).
            self._kturn_dir = -1.0 if eta > 0 else 1.0

        if self._kturn_active:
            # Phase A (not yet aligned): saturated κ in the entry-latched
            # rotation direction. Sign: eta > 0 means bearing is ahead-and-
            # left of ψ → want ψ̇ > 0 → backward v < 0 needs κ < 0, i.e.
            # κ = -sign(eta_entry)·max. Phase B (aligned): κ=0 straight
            # reverse to build the standoff.
            if self._kturn_aligned:
                kappa_kt = 0.0
            elif self._kturn_dir != 0.0:
                kappa_kt = self._kturn_dir * self._max_curvature
            else:
                # Direction not latched (state set externally, e.g. a unit
                # test poking _kturn_active): fall back to the instantaneous
                # alignment-closing sign.
                kappa_kt = (-self._max_curvature if eta > 0
                            else self._max_curvature)
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
