"""MCU Bridge Node: USB CDC link to the RP2040 coprocessor.

The MCU owns drive I/O — encoder, motor PWM, steering servo, battery
ADC, E-Stop, watchdog. The mission-specific spray servo stays on Pi
GPIO (see `spray_node`).

Subscribed topics:
    /rover/cmd/velocity        (geometry_msgs/Twist)  speed/curvature
    /rover/cmd/manual_control  (geometry_msgs/Twist)  throttle/steering %
    /rover/cmd/emergency_stop  (std_msgs/Empty)

Published topics:
    /rover/motor/status        (std_msgs/String) JSON
    /rover/battery             (std_msgs/String) JSON
    /rover/odom                (std_msgs/String) JSON {x, y, yaw, v_left, v_right}

Wire protocol: see course/rover/README.md (§ MCU coprocessor).
"""

import json
import math
import os
import tempfile
import threading
import time

import rclpy
import serial
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from geometry_msgs.msg import Twist
from std_msgs.msg import Empty, Float32, String

from pilot.lib.ackermann import ackermann_convert, manual_to_ackermann
from pilot.lib.wheel_calibration import (
    SCALE_BOUND_HI, SCALE_BOUND_LO,
    load_wheel_cal, save_wheel_cal,
)
from pilot.lib.steering_calibration import (
    TRIM_BOUND_US,
    load_steering_trim, save_steering_trim,
)


# 8S LiFePO4 OCV-SOC table (resting voltage, no load).
# Built from per-cell rest voltage × 8. LiFePO4's discharge curve is
# extremely flat between ~20% and ~90% SOC (most cells sit at 3.27–3.32 V),
# so a linear V→% map gives wildly wrong readings in the operating range.
# Each entry is (pack_voltage, percent), sorted ascending by voltage.
# Above 27.2 V we clamp to 100% (charging surface charge, ≤29.2 V on the
# charger, settles to 27.2 V at rest). Below 20.0 V clamp to 0% (cell
# undervolt cutoff).
LIFEPO4_8S_OCV_SOC = (
    (20.00,   0),
    (23.20,   5),
    (24.40,  10),
    (25.28,  15),
    (25.60,  20),
    (25.76,  30),
    (26.00,  40),
    (26.16,  50),
    (26.32,  60),
    (26.40,  70),
    (26.48,  80),
    (26.56,  90),
    (26.72,  95),
    (27.20, 100),
)


def voltage_to_percent_8s(voltage):
    """Map 8S LiFePO4 pack voltage → SOC %, using a piecewise OCV table.

    Returns None if voltage is None. Clamps to 0/100 outside the table.
    Loaded voltages will read low (IR drop) — % is best read at rest.
    """
    if voltage is None:
        return None
    table = LIFEPO4_8S_OCV_SOC
    if voltage <= table[0][0]:
        return 0
    if voltage >= table[-1][0]:
        return 100
    for i in range(1, len(table)):
        v_hi, p_hi = table[i]
        if voltage <= v_hi:
            v_lo, p_lo = table[i - 1]
            frac = (voltage - v_lo) / (v_hi - v_lo)
            return int(round(p_lo + frac * (p_hi - p_lo)))
    return 100


# In-field calibration: a single gain factor (V_real = V_raw × gain) stored
# in $PILOT_STATE_DIR (host bind-mounted /var/lib/pilot in the rover image).
# Captures the dominant ratiometric error sources (resistor divider tolerance
# + ADC Vref drift) which together drift with temperature. Operators re-enter
# the multimeter reading whenever conditions change.
BATTERY_CAL_FILENAME = 'battery_cal.json'
BATTERY_CAL_GAIN_MIN = 0.5
BATTERY_CAL_GAIN_MAX = 2.0
BATTERY_CAL_MEASURED_MIN_V = 15.0
BATTERY_CAL_MEASURED_MAX_V = 32.0


def _battery_cal_path():
    base = os.environ.get('PILOT_STATE_DIR') or tempfile.gettempdir()
    return os.path.join(base, BATTERY_CAL_FILENAME)


class McuBridgeNode(Node):

    def __init__(self):
        super().__init__('mcu_bridge_node')

        # Serial / link
        self.declare_parameter('serial_port', '/dev/ttyMCU')
        self.declare_parameter('baud_rate', 115200)
        self.declare_parameter('heartbeat_hz', 10.0)
        self.declare_parameter('reconnect_delay_s', 2.0)

        # Ackermann + steering servo
        self.declare_parameter('servo_center_us', 1500)
        self.declare_parameter('servo_range_us', 500)
        self.declare_parameter('max_steering_angle', 25.0)
        self.declare_parameter('wheelbase', 0.38)
        self.declare_parameter('track_width', 0.30)
        self.declare_parameter('max_speed', 1.5)
        self.declare_parameter('accel_limit', 0.5)
        self.declare_parameter('manual_priority_s', 1.0)

        # PID closed loop (off by default; raw duty mode is the safe baseline)
        self.declare_parameter('use_pid', False)
        self.declare_parameter('pid_kp', 0.6)
        self.declare_parameter('pid_ki', 1.5)
        self.declare_parameter('pid_kd', 0.0)

        self._validate_params()

        # State
        self._mode = 'stopped'
        self._last_cmd_t = 0.0
        self._last_manual_t = 0.0
        # Chassis longitudinal speed actually being commanded (m/s, signed).
        # The previous implementation ramped left/right duties independently,
        # which preserved the curvature ratio but stalled the *differential*
        # for ~1.5 s while both wheels caught up to their targets — rover
        # turned via front-wheel scrub during the ramp instead of clean
        # Ackermann. We now ramp on chassis (v) and apply curvature (κ)
        # instantaneously, so the differential develops as the wheels spin
        # up rather than after they've equalised.
        self._cur_speed = 0.0
        self._last_drive_t = None
        self._cur_left = 0.0
        self._cur_right = 0.0
        self._cur_steer_us = self.get_parameter('servo_center_us').value

        # Odom
        self._odom_x = 0.0
        self._odom_y = 0.0
        self._odom_yaw = 0.0
        self._last_telemetry_t = None

        # Battery calibration (single-point gain, persisted across reboots).
        self._battery_cal_lock = threading.Lock()
        self._battery_cal = self._load_battery_cal()
        # Last raw (uncorrected) MCU voltage, kept for re-deriving gain when
        # the operator submits a fresh multimeter reading.
        self._last_raw_vbat = None

        # Per-wheel encoder scale calibration. Persisted at
        # $PILOT_STATE_DIR/wheel_cal.json; (1.0, 1.0) until calibrated.
        # Scale is multiplicative on the m/s reading from MCU telemetry,
        # absorbing rolling-radius mismatch between left/right wheels.
        self._wheel_cal_lock = threading.Lock()
        scales, _ = load_wheel_cal(default=(1.0, 1.0))
        self._wheel_scale_l = float(scales[0])
        self._wheel_scale_r = float(scales[1])

        # Steering centre auto-trim. Persisted at
        # $PILOT_STATE_DIR/steering_trim.json; 0.0 until calibrated.
        # Added to every commanded servo_us so the mechanical zero of
        # the steering linkage matches the navigator's κ = 0.
        self._steering_trim_lock = threading.Lock()
        trim, _ = load_steering_trim(default=0.0)
        self._steering_trim_us = float(trim)

        # Serial
        self._serial = None
        self._serial_lock = threading.Lock()
        self._reader_alive = threading.Event()
        self._reader_alive.set()
        self._line_buf = b''

        reliable = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)

        self.create_subscription(Twist, '/rover/cmd/velocity', self._on_velocity, 10)
        self.create_subscription(Twist, '/rover/cmd/manual_control', self._on_manual, 10)
        self.create_subscription(Empty, '/rover/cmd/emergency_stop', self._on_estop, reliable)
        self.create_subscription(Empty, '/rover/cmd/clear_emergency', self._on_clear_estop, reliable)
        self.create_subscription(Float32, '/rover/cmd/calibrate_battery', self._on_calibrate_battery, reliable)
        self.create_subscription(String, '/rover/cmd/apply_wheel_scales', self._on_apply_wheel_scales, reliable)
        self.create_subscription(String, '/rover/cmd/apply_steering_trim', self._on_apply_steering_trim, reliable)

        self._pub_status = self.create_publisher(String, '/rover/motor/status', 10)
        self._pub_battery = self.create_publisher(String, '/rover/battery', 10)
        self._pub_odom = self.create_publisher(String, '/rover/odom', 10)

        self._open_serial()

        hb_period = 1.0 / max(0.1, float(self.get_parameter('heartbeat_hz').value))
        self._heartbeat_timer = self.create_timer(hb_period, self._heartbeat)

        self._reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader_thread.start()

        # Push PID gains + mode at startup so the MCU defaults match params.
        # 'C' clears any stale software E-Stop latch left over from a prior
        # session (the MCU only honours it when the hardware line is also
        # released, so a genuinely-pressed button stays tripped).
        self._send(f'P {self._p("pid_kp")} {self._p("pid_ki")} {self._p("pid_kd")}')
        self._send(f'L {1 if self._p("use_pid") else 0}')
        self._send('C')

        self.get_logger().info('MCU bridge started')

    # ------------------------- helpers

    def _p(self, name):
        return self.get_parameter(name).value

    def _validate_params(self):
        if self._p('max_speed') < 0.1:
            self.get_logger().fatal('max_speed must be >= 0.1 m/s')
            raise SystemExit(1)
        if not (0.0 < self._p('accel_limit') <= self._p('max_speed') * 4.0):
            self.get_logger().fatal('accel_limit out of range')
            raise SystemExit(1)
        if not (500 <= self._p('servo_center_us') <= 2500):
            self.get_logger().fatal('servo_center_us out of range')
            raise SystemExit(1)
        if not (0 <= self._p('servo_range_us') <= 1000):
            self.get_logger().fatal('servo_range_us out of range')
            raise SystemExit(1)

    def _open_serial(self):
        port = self._p('serial_port')
        baud = int(self._p('baud_rate'))
        try:
            self._serial = serial.Serial(port, baud, timeout=0.05, write_timeout=0.1)
            self.get_logger().info(f'Serial open: {port} @ {baud}')
        except Exception as e:  # noqa: BLE001 - serial errors come in many shapes
            self.get_logger().warn(f'Serial open failed ({port}): {e}')
            self._serial = None

    def _send(self, line):
        if self._serial is None:
            return
        try:
            with self._serial_lock:
                self._serial.write((line + '\n').encode('ascii', errors='ignore'))
        except Exception as e:  # noqa: BLE001
            self.get_logger().warn(f'Serial write failed: {e}')
            self._close_serial()

    def _close_serial(self):
        try:
            if self._serial is not None:
                self._serial.close()
        except Exception:
            pass
        self._serial = None

    # ------------------------- accel limit + ackermann

    def _ramp_speed(self, target_speed, dt):
        """Limit how fast the commanded chassis speed can change.

        Ramping happens on chassis longitudinal speed in m/s, NOT on the
        per-wheel duties — applying the limit per wheel killed the
        Ackermann differential during ramp-up and made the rover scrub
        through every turn until both wheels had caught up to their
        targets (~1.5 s on the field). With this in place the steering
        angle follows the command instantaneously, the wheel differential
        develops naturally as v ramps, and acceleration stays bounded.

        First call after E-Stop release (`dt == 0`) is treated as one
        nominal-tick step rather than an unramped pass-through, so a
        commanded cruise speed can't punch through the H-bridge as a
        single torque spike when motors come back online.
        """
        accel = self._p('accel_limit')
        # Explicit stop intent: caller wants zero (state-machine transition,
        # E-Stop release follow-up, end of cal). Ramping it down would let
        # the rover coast 0.5 s after the navigator returns to IDLE because
        # IDLE doesn't keep republishing zero-velocity, and the previous
        # ramp output (~0.45 m/s) would be the last value the MCU ever
        # received. Snap to 0 — there's no torque or scrub concern in
        # decel-to-rest.
        if target_speed == 0.0:
            return 0.0
        if dt > 0.5:
            # Long gap usually means navigator restarted — ramping from
            # stale internal state would just give wrong torque.
            return target_speed
        if dt <= 0.0:
            # First tick after a state reset (E-Stop clear / fresh boot).
            # Allow at most one nominal control tick worth of step rather
            # than letting the full target through in zero time.
            step = accel * 0.05
            diff = target_speed - self._cur_speed
            if abs(diff) <= step:
                return target_speed
            return self._cur_speed + math.copysign(step, diff)
        max_delta = accel * dt
        diff = target_speed - self._cur_speed
        if abs(diff) <= max_delta:
            return target_speed
        return self._cur_speed + math.copysign(max_delta, diff)

    def _ackermann_kwargs(self):
        return dict(
            wheelbase=self._p('wheelbase'),
            track_width=self._p('track_width'),
            max_speed=self._p('max_speed'),
            max_steering_angle_rad=math.radians(self._p('max_steering_angle')),
            servo_center_us=self._p('servo_center_us'),
            servo_range_us=self._p('servo_range_us'),
        )

    # ------------------------- ROS callbacks

    def _on_velocity(self, msg):
        now = time.monotonic()
        if self._mode == 'manual' and (now - self._last_manual_t) < self._p('manual_priority_s'):
            return
        self._mode = 'autonomous'
        self._last_cmd_t = now

        # Ramp on chassis speed; pass the ramped speed + raw curvature into
        # ackermann_convert so the steering servo and wheel differential
        # both reflect the ramped state coherently.
        dt = 0.0 if self._last_drive_t is None else (now - self._last_drive_t)
        self._last_drive_t = now
        speed = self._ramp_speed(float(msg.linear.x), dt)
        self._cur_speed = speed

        left, right, servo_us = ackermann_convert(
            speed=speed,
            curvature=float(msg.angular.z),
            **self._ackermann_kwargs(),
        )
        self._drive(left, right, servo_us)

    def _on_manual(self, msg):
        now = time.monotonic()
        self._last_cmd_t = now
        self._last_manual_t = now
        self._mode = 'manual'

        # Manual joystick goes through the same speed ramp as autonomous
        # by translating throttle % into a target chassis speed, ramping,
        # then re-projecting into duty %. Keeps acceleration bounded
        # regardless of how aggressive the operator is on the stick.
        max_speed = self._p('max_speed')
        target_speed = float(msg.linear.x) / 100.0 * max_speed
        dt = 0.0 if self._last_drive_t is None else (now - self._last_drive_t)
        self._last_drive_t = now
        speed = self._ramp_speed(target_speed, dt)
        self._cur_speed = speed
        throttle_pct = (speed / max_speed * 100.0) if max_speed > 0 else 0.0

        left, right, servo_us = manual_to_ackermann(
            throttle_pct=throttle_pct,
            steering_pct=float(msg.angular.z),
            servo_center_us=self._p('servo_center_us'),
            servo_range_us=self._p('servo_range_us'),
        )
        self._drive(left, right, servo_us)

    def _on_estop(self, _msg):
        self._mode = 'stopped'
        self._cur_speed = 0.0
        self._cur_left = 0.0
        self._cur_right = 0.0
        self._cur_steer_us = self._p('servo_center_us')
        self._last_drive_t = None
        self._send('E')
        self.get_logger().warn('EMERGENCY STOP')

    def _on_clear_estop(self, _msg):
        # Operator-acknowledged release. The MCU still gates the clear
        # on its hardware E-Stop line being released, so a physically-
        # held button keeps the latch on.
        self._send('C')
        self.get_logger().info('Emergency-stop clear sent to MCU')

    # ------------------------- drive

    def _drive(self, left_pct, right_pct, servo_us):
        # left/right percent already came out of ackermann_convert with the
        # ramped speed baked in, and the curvature passed through to the
        # steering servo unchanged. No per-wheel ramp here — that's the
        # whole point of moving the limit upstream.
        self._cur_left = left_pct
        self._cur_right = right_pct
        # Apply persisted steering trim. The trim absorbs the offset
        # between the linkage's mechanical zero and `servo_center_us`;
        # we clamp the final pulse to the configured range so adding
        # trim near full-lock never pushes the servo past its stops.
        with self._steering_trim_lock:
            trim = self._steering_trim_us
        center = self._p('servo_center_us')
        rng = self._p('servo_range_us')
        trimmed = servo_us + trim
        trimmed = max(center - rng, min(center + rng, trimmed))
        self._cur_steer_us = int(round(trimmed))

        if self._p('use_pid'):
            max_speed = self._p('max_speed')
            l_mps = left_pct / 100.0 * max_speed
            r_mps = right_pct / 100.0 * max_speed
            self._send(f'V {l_mps:.3f} {r_mps:.3f} {self._cur_steer_us}')
        else:
            self._send(f'M {left_pct/100.0:.3f} {right_pct/100.0:.3f} {self._cur_steer_us}')

        self._pub_status.publish(self._json_msg({
            'left_duty': round(left_pct, 1),
            'right_duty': round(right_pct, 1),
            'servo_us': self._cur_steer_us,
            'mode': self._mode,
        }))

    # ------------------------- heartbeat

    def _heartbeat(self):
        # Reconnect is owned by the reader loop (rate-limited by
        # `reconnect_delay_s`). _send is a no-op when the port is closed,
        # so the heartbeat tick stays cheap and silent during MCU outages.
        self._send('H')

    # ------------------------- reader

    def _reader_loop(self):
        delay = float(self._p('reconnect_delay_s'))
        while self._reader_alive.is_set():
            if self._serial is None:
                time.sleep(delay)
                self._open_serial()
                continue
            try:
                chunk = self._serial.read(256)
            except Exception as e:  # noqa: BLE001
                self.get_logger().warn(f'Serial read failed: {e}')
                self._close_serial()
                time.sleep(delay)
                continue

            if not chunk:
                continue
            self._line_buf += chunk
            # Cap the buffer at a generous multiple of the MCU's LINE_MAX
            # (96 bytes) so a corrupted MCU stream that drops newlines
            # can't grow the buffer unbounded. Discard the partial line
            # rather than block the reader.
            if len(self._line_buf) > 4096:
                self.get_logger().warn(
                    f'line buffer overflow ({len(self._line_buf)} bytes without LF) — discarding'
                )
                self._line_buf = b''
                continue
            while b'\n' in self._line_buf:
                line, _, self._line_buf = self._line_buf.partition(b'\n')
                self._dispatch_line(line.strip().decode('ascii', errors='ignore'))

    def _dispatch_line(self, line):
        if not line:
            return
        if line[0] == 'T':
            self._handle_telemetry(line)
        elif line[0] == '!':
            self.get_logger().warn(f'MCU event: {line[1:].strip()}')

    def _handle_telemetry(self, line):
        # T <ms> <enc_l> <enc_r> <vel_l> <vel_r> <vbat> <flags>
        parts = line.split()
        if len(parts) != 8:
            return
        try:
            _ms = int(parts[1])
            _enc_l = int(parts[2])
            _enc_r = int(parts[3])
            vl_raw = float(parts[4])
            vr_raw = float(parts[5])
            vbat = float(parts[6])
            flags = int(parts[7], 0)
        except ValueError:
            return

        # Apply per-wheel scale calibration. Snapshot the live values
        # so a calibrate-wheels callback firing mid-line can't tear the
        # pair (left and right must always be applied as a coherent set).
        with self._wheel_cal_lock:
            sl = self._wheel_scale_l
            sr = self._wheel_scale_r
        vl = vl_raw * sl
        vr = vr_raw * sr

        # Apply field-calibrated gain (V_real = V_raw * gain) before mapping
        # to SOC. The gain absorbs the dominant ratiometric error sources
        # (resistor divider tolerance, ADC Vref drift), which both shift
        # with temperature — hence the in-field re-cal workflow.
        with self._battery_cal_lock:
            cal = dict(self._battery_cal)
        gain = cal.get('gain', 1.0)
        self._last_raw_vbat = vbat
        vbat_corrected = vbat * gain

        battery_payload = {
            'voltage': round(vbat_corrected, 3),
            'voltage_raw': round(vbat, 3),
            'percent': voltage_to_percent_8s(vbat_corrected),
            'source': 'mcu',
            'flags': flags,
            'gain': round(gain, 6),
        }
        if cal.get('calibrated_at') is not None:
            battery_payload['calibrated_at'] = cal['calibrated_at']
        if cal.get('measured_v') is not None:
            battery_payload['measured_v'] = round(cal['measured_v'], 3)
        self._pub_battery.publish(self._json_msg(battery_payload))

        # Odometry — integrate (vl, vr) into a 2D pose.
        now_t = time.monotonic()
        if self._last_telemetry_t is None:
            dt = 0.0
        else:
            dt = now_t - self._last_telemetry_t
        self._last_telemetry_t = now_t

        if 0.0 < dt < 0.5:
            track = self._p('track_width')
            v = (vl + vr) * 0.5
            w = (vr - vl) / max(track, 1e-3)
            self._odom_yaw += w * dt
            self._odom_x += v * math.cos(self._odom_yaw) * dt
            self._odom_y += v * math.sin(self._odom_yaw) * dt

        self._pub_odom.publish(self._json_msg({
            'x': round(self._odom_x, 3),
            'y': round(self._odom_y, 3),
            'yaw': round(self._odom_yaw, 4),
            'v_left': round(vl, 3),
            'v_right': round(vr, 3),
            # Pre-scale velocities exposed for the wheel-scale calibration
            # routine in navigator. Every other consumer must read v_left/
            # v_right (the scaled versions) so the rest of the stack sees
            # a single coherent encoder model.
            'v_left_raw': round(vl_raw, 3),
            'v_right_raw': round(vr_raw, 3),
            'wheel_scale_l': round(sl, 5),
            'wheel_scale_r': round(sr, 5),
        }))

    def _json_msg(self, payload):
        msg = String()
        msg.data = json.dumps(payload)
        return msg

    # ------------------------- battery calibration

    def _load_battery_cal(self):
        """Read the persisted gain from $PILOT_STATE_DIR. Defaults to gain=1.0.

        Tolerates missing file, missing fields, and out-of-range gains —
        a corrupt calibration must never block the rover from booting.
        """
        path = _battery_cal_path()
        default = {'gain': 1.0, 'measured_v': None, 'voltage_raw_at_cal': None, 'calibrated_at': None}
        try:
            with open(path, 'r') as f:
                data = json.load(f)
        except FileNotFoundError:
            return default
        except (OSError, json.JSONDecodeError) as e:
            self.get_logger().warn(f'battery cal load failed ({path}): {e}; using gain=1.0')
            return default
        gain = data.get('gain')
        if not isinstance(gain, (int, float)) or not (BATTERY_CAL_GAIN_MIN <= gain <= BATTERY_CAL_GAIN_MAX):
            self.get_logger().warn(f'battery cal gain out of range ({gain}); using gain=1.0')
            return default
        return {
            'gain': float(gain),
            'measured_v': data.get('measured_v'),
            'voltage_raw_at_cal': data.get('voltage_raw_at_cal'),
            'calibrated_at': data.get('calibrated_at'),
        }

    def _save_battery_cal(self, cal):
        """Atomically persist the calibration JSON ($PILOT_STATE_DIR/battery_cal.json)."""
        path = _battery_cal_path()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = f'{path}.tmp'
            with open(tmp, 'w') as f:
                json.dump(cal, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except OSError as e:
            self.get_logger().error(f'battery cal save failed ({path}): {e}')

    def _on_calibrate_battery(self, msg):
        """Accept a multimeter reading, derive gain = measured / raw, persist.

        The raw voltage used here is the most recent uncorrected ADC sample
        (`_last_raw_vbat`), so the operator's workflow is: read voltage on
        a multimeter → enter into UI → submit. We do not require the rover
        to be at rest — the user is asserting "right now, V_real = X".
        """
        try:
            measured_v = float(msg.data)
        except (TypeError, ValueError):
            self.get_logger().warn('calibrate_battery: non-numeric value ignored')
            return
        if not (BATTERY_CAL_MEASURED_MIN_V <= measured_v <= BATTERY_CAL_MEASURED_MAX_V):
            self.get_logger().warn(
                f'calibrate_battery: measured_v {measured_v} V out of '
                f'[{BATTERY_CAL_MEASURED_MIN_V}, {BATTERY_CAL_MEASURED_MAX_V}] V — ignored'
            )
            return
        raw = self._last_raw_vbat
        if raw is None or raw <= 0.5:
            self.get_logger().warn('calibrate_battery: no raw sample yet — ignored')
            return
        gain = measured_v / raw
        if not (BATTERY_CAL_GAIN_MIN <= gain <= BATTERY_CAL_GAIN_MAX):
            self.get_logger().warn(
                f'calibrate_battery: derived gain {gain:.4f} out of '
                f'[{BATTERY_CAL_GAIN_MIN}, {BATTERY_CAL_GAIN_MAX}] — refusing to save'
            )
            return
        cal = {
            'gain': round(gain, 6),
            'measured_v': round(measured_v, 3),
            'voltage_raw_at_cal': round(raw, 3),
            'calibrated_at': int(time.time() * 1000),
        }
        with self._battery_cal_lock:
            self._battery_cal = cal
        self._save_battery_cal(cal)
        self.get_logger().info(
            f'battery calibrated: measured={measured_v:.3f}V raw={raw:.3f}V gain={gain:.4f}'
        )

    # ------------------------- wheel scale calibration

    def _on_apply_wheel_scales(self, msg):
        """Adopt and persist a (scale_l, scale_r) pair from the navigator.

        Payload is JSON: {"scale_l": float, "scale_r": float,
                          "gps_distance_m": float, "encoder_left_m": float,
                          "encoder_right_m": float, "samples": int}.
        Out-of-range values are rejected and logged; the live scale stays
        at its previous (presumably good) value.
        """
        try:
            data = json.loads(msg.data)
        except (json.JSONDecodeError, AttributeError, TypeError):
            self.get_logger().warn('apply_wheel_scales: invalid JSON, ignored')
            return
        if not isinstance(data, dict):
            return
        try:
            sl = float(data.get('scale_l'))
            sr = float(data.get('scale_r'))
        except (TypeError, ValueError):
            self.get_logger().warn('apply_wheel_scales: non-numeric scales')
            return
        if not (SCALE_BOUND_LO <= sl <= SCALE_BOUND_HI
                and SCALE_BOUND_LO <= sr <= SCALE_BOUND_HI):
            self.get_logger().warn(
                f'apply_wheel_scales: ({sl:.3f}, {sr:.3f}) outside '
                f'[{SCALE_BOUND_LO}, {SCALE_BOUND_HI}] — ignored'
            )
            return
        try:
            save_wheel_cal(
                sl, sr,
                gps_distance_m=float(data.get('gps_distance_m', 0.0)),
                encoder_left_m=float(data.get('encoder_left_m', 0.0)),
                encoder_right_m=float(data.get('encoder_right_m', 0.0)),
                samples=int(data.get('samples', 0)),
            )
        except (OSError, ValueError) as exc:
            self.get_logger().warn(f'apply_wheel_scales: persist failed: {exc}')
            return
        with self._wheel_cal_lock:
            self._wheel_scale_l = sl
            self._wheel_scale_r = sr
        self.get_logger().info(
            f'wheel scales applied: L={sl:.4f} R={sr:.4f}'
        )

    def _on_apply_steering_trim(self, msg):
        """Adopt and persist the steering centre trim from the navigator.

        Payload is JSON: {"trim_us": float, "radius_m": float|null,
                          "rms_residual_m": float, "samples": int,
                          "drive_distance_m": float}.
        Out-of-range trims are rejected — applying a 100 µs offset would
        push the servo past its configured ±servo_range_us when the
        operator commands the same direction at full lock.
        """
        try:
            data = json.loads(msg.data)
        except (json.JSONDecodeError, AttributeError, TypeError):
            self.get_logger().warn('apply_steering_trim: invalid JSON, ignored')
            return
        if not isinstance(data, dict):
            return
        try:
            trim = float(data.get('trim_us'))
        except (TypeError, ValueError):
            self.get_logger().warn('apply_steering_trim: non-numeric trim_us')
            return
        if not (-TRIM_BOUND_US <= trim <= TRIM_BOUND_US):
            self.get_logger().warn(
                f'apply_steering_trim: {trim:.1f} µs outside '
                f'±{TRIM_BOUND_US:.0f} µs — ignored'
            )
            return
        try:
            radius = data.get('radius_m')
            radius_f = float(radius) if isinstance(radius, (int, float)) else float('inf')
            save_steering_trim(
                trim,
                radius_m=radius_f,
                rms_residual_m=float(data.get('rms_residual_m', 0.0)),
                samples=int(data.get('samples', 0)),
                drive_distance_m=float(data.get('drive_distance_m', 0.0)),
            )
        except (OSError, ValueError) as exc:
            self.get_logger().warn(f'apply_steering_trim: persist failed: {exc}')
            return
        with self._steering_trim_lock:
            self._steering_trim_us = trim
        self.get_logger().info(f'steering trim applied: {trim:+.1f} µs')

    # ------------------------- shutdown

    def destroy_node(self):
        # Don't send 'E' on shutdown — that would latch g_tripped on the
        # MCU and outlive the service restart. Heartbeats stopping naturally
        # trips the MCU's Pi-link WDT (500 ms) and motors stop on their
        # own; the latch isn't needed and is hard to clear.
        self._reader_alive.clear()
        self._close_serial()
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = McuBridgeNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
