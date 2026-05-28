"""Tests for mcu_bridge_node — param validation, wire protocol, telemetry parse."""

import json
import os

import pytest

from pilot.mcu_bridge_node import (
    BATTERY_CAL_FILENAME,
    LIFEPO4_8S_OCV_SOC,
    McuBridgeNode,
    _battery_cal_path,
    voltage_to_percent_8s,
)


class _RecorderSerial:
    """In-place stand-in for the pyserial port. Captures all writes."""

    def __init__(self):
        self.writes = []
        self._closed = False

    def write(self, data):
        self.writes.append(data)
        return len(data)

    def read(self, _n=0):
        return b''

    def close(self):
        self._closed = True


@pytest.fixture
def bridge():
    node = McuBridgeNode.__new__(McuBridgeNode)
    # Bypass __init__ so we don't need rclpy or a real serial port; instead
    # set up the minimum state the methods under test reach for.
    node._params = {
        'serial_port': '/dev/ttyMCU',
        'baud_rate': 115200,
        'heartbeat_hz': 10.0,
        'reconnect_delay_s': 2.0,
        'servo_center_us': 1500,
        'servo_range_us': 500,
        'steer_min_us': 1000,
        'steer_max_us': 2000,
        'max_steering_angle_deg': 25.0,
        'wheelbase': 0.38,
        'track_width': 0.30,
        'max_speed': 1.5,
        'accel_limit': 0.8,
        'manual_priority_s': 1.0,
        'use_pid': False,
        'pid_kp': 0.6,
        'pid_ki': 1.5,
        'pid_kd': 0.0,
        'brake_pulse_duty': 0.35,
        'brake_pulse_ms': 100.0,
        'brake_fire_above_mps': 0.04,
    }

    class _Logger:
        def info(self, *a, **kw): pass
        def warn(self, *a, **kw): pass
        def warning(self, *a, **kw): pass
        def error(self, *a, **kw): pass
        def fatal(self, *a, **kw): pass
        def debug(self, *a, **kw): pass

    node._logger = _Logger()
    node._serial = _RecorderSerial()

    import threading
    node._serial_lock = threading.Lock()

    # State
    node._mode = 'stopped'
    node._cur_speed = 0.0
    node._last_drive_t = None
    node._cur_left = 0.0
    node._cur_right = 0.0
    node._cur_steer_us = 1500
    node._odom_x = 0.0
    node._odom_y = 0.0
    node._odom_yaw = 0.0
    node._last_telemetry_t = None
    node._line_buf = b''
    node._ack_kwargs_cache = None
    node._last_wdt_reboot = None

    # Patches for ROS Node helpers
    node.get_parameter = lambda name: type('P', (), {'value': node._params[name]})()
    node.get_logger = lambda: node._logger

    class _Pub:
        def __init__(self): self.published = []
        def publish(self, msg): self.published.append(msg)
    node._pub_status = _Pub()
    node._pub_battery = _Pub()
    node._pub_odom = _Pub()
    node._pub_emergency_stop = _Pub()
    node._pub_clear_emergency = _Pub()
    # Combined E-Stop state (software latch OR physical button).
    node._sw_latched = False
    node._hw_pressed = False
    node._estop_synced = False

    # Battery calibration state — same defaults the real __init__ sets.
    import threading as _t
    node._battery_cal_lock = _t.Lock()
    node._battery_cal = {'gain': 1.0, 'measured_v': None, 'voltage_raw_at_cal': None, 'calibrated_at': None}
    node._last_raw_vbat = None
    # Wheel scale calibration state — defaults to (1.0, 1.0) (no scaling).
    node._wheel_cal_lock = _t.Lock()
    node._wheel_scale_l = 1.0
    node._wheel_scale_r = 1.0
    # Steering trim — uncalibrated centre by default.
    node._steering_trim_lock = _t.Lock()
    node._steering_trim_us = 0.0

    return node


def _writes_text(bridge):
    return [w.decode('ascii') for w in bridge._serial.writes]


def test_validate_params_rejects_bad_max_speed(bridge):
    bridge._params['max_speed'] = 0.05
    with pytest.raises(SystemExit):
        bridge._validate_params()


def test_manual_priority_blocks_velocity_during_window(bridge):
    """Velocity callback should ignore /rover/cmd/velocity for manual_priority_s
    after a manual command, so a stale autonomy stream can't override the joystick."""
    import time
    import types

    msg = types.SimpleNamespace(linear=types.SimpleNamespace(x=50.0, y=0.0, z=0.0),
                                angular=types.SimpleNamespace(x=0.0, y=0.0, z=10.0))

    bridge._mode = 'manual'
    bridge._last_manual_t = time.monotonic()  # just got a manual cmd

    bridge._on_velocity(msg)
    out = _writes_text(bridge)
    # No drive frame should have been emitted while the manual lockout holds.
    assert not any(line.startswith(('M ', 'V ')) for line in out)
    assert bridge._mode == 'manual'

    # After the lockout expires, the next velocity callback must drive again.
    bridge._last_manual_t = time.monotonic() - 2.0  # well past 1s window
    bridge._on_velocity(msg)
    out = _writes_text(bridge)
    assert any(line.startswith('M ') for line in out)
    assert bridge._mode == 'autonomous'


def test_velocity_dropped_while_estopped(bridge):
    # While e-stopped the navigator keeps republishing Twist(0,0); we must
    # NOT forward it. Otherwise the host sends 'V/M 0 0 <centre+trim>' every
    # tick while the MCU forces the raw centre — the steering servo buzzes.
    import types
    msg = types.SimpleNamespace(linear=types.SimpleNamespace(x=0.0, y=0.0, z=0.0),
                                angular=types.SimpleNamespace(x=0.0, y=0.0, z=0.0))
    bridge._serial.writes.clear()
    bridge._hw_pressed = True          # hardware button latched
    bridge._on_velocity(msg)
    assert not any(l.startswith(('M ', 'V ')) for l in _writes_text(bridge))

    bridge._hw_pressed = False
    bridge._sw_latched = True           # software latch
    bridge._on_velocity(msg)
    assert not any(l.startswith(('M ', 'V ')) for l in _writes_text(bridge))


def test_manual_dropped_while_estopped(bridge):
    import types
    msg = types.SimpleNamespace(linear=types.SimpleNamespace(x=20.0, y=0.0, z=0.0),
                                angular=types.SimpleNamespace(x=0.0, y=0.0, z=15.0))
    bridge._serial.writes.clear()
    bridge._nav_state = 'IDLE'          # not an autonomous-active state
    bridge._sw_latched = True
    bridge._on_manual(msg)
    assert not any(l.startswith(('M ', 'V ')) for l in _writes_text(bridge))


def test_drive_clamps_left_to_steer_max_us(bridge):
    # Asymmetric chassis clamp: full-left servo_us (2000) must be capped at
    # steer_max_us, while full-right (1000) is untouched by steer_min_us.
    bridge._params['steer_min_us'] = 1000
    bridge._params['steer_max_us'] = 1850
    bridge._drive(left_pct=0.0, right_pct=0.0, servo_us=2000)   # full left
    assert bridge._cur_steer_us == 1850
    bridge._drive(left_pct=0.0, right_pct=0.0, servo_us=1000)   # full right
    assert bridge._cur_steer_us == 1000
    # An in-range command passes through unclamped.
    bridge._drive(left_pct=0.0, right_pct=0.0, servo_us=1700)
    assert bridge._cur_steer_us == 1700


def test_steer_limit_defaults_reproduce_servo_range(bridge):
    # Defaults (1000/2000) must not clip anything inside the servo range.
    assert bridge._params['steer_min_us'] == 1000
    assert bridge._params['steer_max_us'] == 2000
    bridge._drive(left_pct=0.0, right_pct=0.0, servo_us=2000)
    assert bridge._cur_steer_us == 2000


def test_drive_emits_M_in_raw_mode(bridge):
    # _drive is a pure passthrough now — ramping happens upstream in
    # _on_velocity / _on_manual on chassis speed, not on per-wheel duty.
    # Verify the wire format and servo value land unchanged.
    bridge._drive(left_pct=50.0, right_pct=50.0, servo_us=1500)
    out = _writes_text(bridge)
    line = next(line for line in out if line.startswith('M '))
    parts = line.strip().split()
    assert float(parts[1]) == pytest.approx(0.5, abs=1e-6)
    assert float(parts[2]) == pytest.approx(0.5, abs=1e-6)
    assert int(parts[3]) == 1500


def test_drive_emits_V_when_pid_enabled(bridge):
    bridge._params['use_pid'] = True
    bridge._drive(left_pct=100.0, right_pct=100.0, servo_us=1500)
    out = _writes_text(bridge)
    line = next(line for line in out if line.startswith('V '))
    parts = line.strip().split()
    assert abs(float(parts[1])) <= bridge._params['max_speed'] + 1e-9


def test_brake_pulse_params_live_push_K_command(bridge):
    """Changing brake_pulse_* params live-pushes a 'K duty ms fire_above'
    command to the MCU (mirrors PID's 'P'), so the pulse can be tuned
    without re-flashing the firmware. ('B' is the MCU's BOOTSEL command.)"""
    import types
    bridge._serial.writes.clear()
    params = [
        types.SimpleNamespace(name='brake_pulse_duty', value=0.5),
        types.SimpleNamespace(name='brake_pulse_ms', value=120.0),
        types.SimpleNamespace(name='brake_fire_above_mps', value=0.05),
    ]
    res = bridge._on_param_change(params)
    assert res.successful
    line = next(l for l in _writes_text(bridge) if l.startswith('K '))
    parts = line.strip().split()
    assert float(parts[1]) == pytest.approx(0.5)
    assert float(parts[2]) == pytest.approx(120.0)
    assert float(parts[3]) == pytest.approx(0.05)


def test_brake_pulse_arm_emits_A(bridge):
    """The /rover/cmd/brake_pulse subscription forwards to the MCU as a
    bare 'A' command — that's the one-shot arm that gates the next
    deadband-edge pulse. Manual stops never publish here, so they coast."""
    bridge._serial.writes.clear()
    bridge._on_brake_pulse(None)
    out = _writes_text(bridge)
    assert any(l.strip() == 'A' for l in out), out


def test_velocity_ramps_on_chassis_speed_not_duty(bridge):
    """Curvature applies instantly through the steering servo; chassis
    speed ramps to honour accel_limit. The previous implementation ramped
    per-wheel duty which killed the Ackermann differential during the
    first ~1.5 s of every turn."""
    import time
    import types

    # Big jump from 0 to 1.0 m/s with a curvature so we can observe the
    # differential. dt = 50 ms, accel = 0.8 m/s² → max Δv ≈ 0.04 m/s.
    msg = types.SimpleNamespace(
        linear=types.SimpleNamespace(x=1.0, y=0.0, z=0.0),
        angular=types.SimpleNamespace(x=0.0, y=0.0, z=0.5),
    )
    now = time.monotonic()
    bridge._last_drive_t = now - 0.05
    bridge._on_velocity(msg)
    # Ramped speed should be ≈ 0 + 0.04 m/s (plus a μs of test runtime),
    # not 1.0. Loose tolerance because the test thread's monotonic clock
    # advances between _last_drive_t setup and the _on_velocity call.
    assert 0.035 < bridge._cur_speed < 0.060
    # The curvature still produces a differential at the (small) ramped
    # speed — left and right duties should differ even at this first
    # tick. With the old per-wheel ramp, both wheels would have hit the
    # same delta cap and the differential would have been zero here.
    out = _writes_text(bridge)
    line = next(line for line in out if line.startswith('M '))
    parts = line.strip().split()
    assert abs(float(parts[1]) - float(parts[2])) > 0.0


def test_velocity_first_tick_after_estop_clears_with_one_step(bridge):
    """After E-Stop release / startup the very first command must NOT
    pass through unramped (would punch the H-bridge with the full
    cruise-speed step). Instead we allow at most one nominal control
    tick (accel × 0.05 s) to land on the target."""
    import types
    bridge._last_drive_t = None
    bridge._cur_speed = 0.0
    msg = types.SimpleNamespace(
        linear=types.SimpleNamespace(x=1.0, y=0.0, z=0.0),
        angular=types.SimpleNamespace(x=0.0, y=0.0, z=0.0),
    )
    bridge._on_velocity(msg)
    one_tick = bridge._params['accel_limit'] * 0.05
    assert bridge._cur_speed == pytest.approx(one_tick, abs=1e-9)
    # Subsequent normal-tick calls should ramp normally.
    import time as _time
    bridge._last_drive_t = _time.monotonic() - 0.05
    bridge._on_velocity(msg)
    # After two ticks of bounded ramp we should be at ≥ 2 × one_tick.
    assert bridge._cur_speed >= 2 * one_tick - 1e-9


def test_velocity_zero_target_ramps_smoothly(bridge):
    """Twist(0,0) must ramp down at accel_limit, not snap. Hard-snap
    to-zero would make releasing the joystick feel like a hard brake;
    smooth coast comes from navigator continuing to republish Twist(0,0)
    every tick while idle so the ramp keeps decaying."""
    import time as _time
    import types
    bridge._cur_speed = 0.5
    bridge._last_drive_t = _time.monotonic() - 0.05
    msg = types.SimpleNamespace(
        linear=types.SimpleNamespace(x=0.0, y=0.0, z=0.0),
        angular=types.SimpleNamespace(x=0.0, y=0.0, z=0.0),
    )
    bridge._on_velocity(msg)
    # accel_limit = 0.8 m/s²; one ~50 ms tick = ~0.04 m/s decrement.
    # Tolerance covers wallclock jitter between setting last_drive_t and
    # the ramp reading time.monotonic() — we just need to confirm the
    # ramp engaged (not a snap to zero, not a no-op).
    assert 0.45 < bridge._cur_speed < 0.5


def test_drive_applies_steering_trim_and_clamps(bridge):
    """Persisted trim must offset every commanded servo_us, but the
    final pulse must stay inside [steer_min_us, steer_max_us] (defaults
    1000/2000 here) so adding trim near full lock doesn't push the servo
    past its stops."""
    bridge._steering_trim_us = 8.0
    bridge._drive(40.0, 60.0, 1500.0)
    parts = _writes_text(bridge)[-1].strip().split()
    assert int(parts[3]) == 1508
    bridge._serial.writes.clear()
    # At full positive lock (center + range = 2000) and trim = +8 µs,
    # the result must clamp to 2000, not 2008.
    bridge._steering_trim_us = 8.0
    bridge._drive(40.0, 60.0, 2000.0)
    parts = _writes_text(bridge)[-1].strip().split()
    assert int(parts[3]) == 2000
    bridge._serial.writes.clear()
    bridge._steering_trim_us = -8.0
    bridge._drive(40.0, 60.0, 1000.0)
    parts = _writes_text(bridge)[-1].strip().split()
    assert int(parts[3]) == 1000


def test_apply_steering_trim_persists_and_applies(bridge, monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    import json as _json
    import types
    msg = types.SimpleNamespace(data=_json.dumps({
        'trim_us': 6.5, 'radius_m': -120.0, 'rms_residual_m': 0.012,
        'samples': 200, 'drive_distance_m': 10.0,
    }))
    bridge._on_apply_steering_trim(msg)
    assert bridge._steering_trim_us == pytest.approx(6.5, abs=1e-6)
    # The persisted file should round-trip through load_steering_trim.
    from pilot.lib.steering_calibration import load_steering_trim
    trim, _ = load_steering_trim(default=0.0)
    assert trim == pytest.approx(6.5, abs=1e-3)


def test_apply_steering_trim_rejects_out_of_range(bridge, monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    import json as _json
    import types
    bridge._steering_trim_us = 0.0
    msg = types.SimpleNamespace(data=_json.dumps({
        'trim_us': 1000.0, 'radius_m': 1.0, 'rms_residual_m': 0.0,
        'samples': 200, 'drive_distance_m': 10.0,
    }))
    bridge._on_apply_steering_trim(msg)
    # Live trim untouched, file not created.
    assert bridge._steering_trim_us == 0.0
    from pilot.lib.steering_calibration import steering_trim_path
    assert not os.path.exists(steering_trim_path())


def test_sw_estop_sends_E_and_clears_state(bridge):
    bridge._cur_left = 50.0
    bridge._cur_right = 50.0
    bridge._on_sw_estop(None)
    assert any(w.strip() == 'E' for w in _writes_text(bridge))
    assert bridge._mode == 'stopped'
    assert bridge._cur_left == 0.0 and bridge._cur_right == 0.0
    # Navigator / spray are synced via the logical topic too.
    assert len(bridge._pub_emergency_stop.published) == 1


def test_sw_clear_sends_C_and_syncs(bridge):
    bridge._on_sw_estop(None)        # engage first so there is something to clear
    bridge._serial.writes.clear()
    bridge._on_sw_clear(None)
    assert any(w.strip() == 'C' for w in _writes_text(bridge))
    assert len(bridge._pub_clear_emergency.published) == 1


def test_sw_clear_does_not_release_while_button_held(bridge):
    # Physical button latched, THEN a software clear arrives. 'C' must go
    # to the MCU (clears g_tripped) but the navigator must stay stopped —
    # a physical stop is only released by twisting the button open. This
    # is the regression for the "web clear → looks released → juddering"
    # bug: the navigator was being released while the MCU still tripped.
    bridge._handle_telemetry('T 1 0 0 0.0 0.0 25.0 0x80')   # button pressed
    assert len(bridge._pub_emergency_stop.published) == 1
    bridge._serial.writes.clear()
    bridge._on_sw_clear(None)                                # web clear
    assert any(w.strip() == 'C' for w in _writes_text(bridge))   # latch cleared on MCU
    assert len(bridge._pub_clear_emergency.published) == 0       # navigator NOT released
    # Now twist the button open — only this releases the navigator.
    bridge._handle_telemetry('T 2 0 0 0.0 0.0 25.0 0x0')
    assert len(bridge._pub_clear_emergency.published) == 1


def test_button_does_not_release_while_sw_latched(bridge):
    # Symmetric: software stop engaged, then the button is pressed and
    # released. The physical release must NOT release a software latch.
    bridge._on_sw_estop(None)                                # software stop
    assert len(bridge._pub_emergency_stop.published) == 1
    bridge._handle_telemetry('T 1 0 0 0.0 0.0 25.0 0x80')    # button pressed
    bridge._handle_telemetry('T 2 0 0 0.0 0.0 25.0 0x0')     # button released
    assert len(bridge._pub_clear_emergency.published) == 0    # still latched in sw
    bridge._on_sw_clear(None)                                 # software clear
    assert len(bridge._pub_clear_emergency.published) == 1


def test_telemetry_parses_and_publishes_battery_and_odom(bridge):
    bridge._handle_telemetry('T 12345 100 -50 0.500 0.500 25.6 0x10')
    # Battery
    bat = json.loads(bridge._pub_battery.published[0].data)
    assert abs(bat['voltage'] - 25.6) < 1e-3
    assert bat['source'] == 'mcu'
    assert 0 <= bat['percent'] <= 100
    # Odom (first sample only seeds last_telemetry_t — no integration yet)
    odom = json.loads(bridge._pub_odom.published[0].data)
    assert odom['x'] == 0.0 and odom['y'] == 0.0 and odom['yaw'] == 0.0
    assert abs(odom['v_left'] - 0.5) < 1e-3


def test_telemetry_rejects_short_line(bridge):
    bridge._handle_telemetry('T 1 2 3 4 5')
    assert bridge._pub_battery.published == []


def test_voltage_to_percent_8s_endpoints():
    # Above the rest-voltage 100% point (27.20 V) is full; charger surface
    # charge up to 29.2 V also clamps to 100.
    assert voltage_to_percent_8s(29.5) == 100
    assert voltage_to_percent_8s(27.20) == 100
    assert voltage_to_percent_8s(20.0) == 0
    assert voltage_to_percent_8s(19.0) == 0
    assert voltage_to_percent_8s(None) is None


def test_voltage_to_percent_8s_uses_lifepo4_plateau():
    # The whole point of the OCV table: a "halfway" voltage in the linear
    # 20.0–29.2 V map (~24.6 V) is actually deep into the 0–10% knee for
    # LiFePO4. The new mapping must reflect that.
    assert voltage_to_percent_8s(24.6) <= 15
    # Conversely, the flat plateau means 26.16 V (the published 50% point)
    # should report close to 50, not the ~67 the old linear map produced.
    p = voltage_to_percent_8s(26.16)
    assert 45 <= p <= 55
    # And the table breakpoints themselves should round-trip exactly.
    for v, expected in LIFEPO4_8S_OCV_SOC:
        assert voltage_to_percent_8s(v) == expected


def test_battery_cal_path_uses_pilot_state_dir(monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    assert _battery_cal_path() == os.path.join(str(tmp_path), BATTERY_CAL_FILENAME)


def test_load_battery_cal_missing_returns_default(bridge, monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    cal = bridge._load_battery_cal()
    assert cal['gain'] == 1.0
    assert cal['calibrated_at'] is None


def test_load_battery_cal_rejects_out_of_range_gain(bridge, monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    path = tmp_path / BATTERY_CAL_FILENAME
    path.write_text(json.dumps({'gain': 5.0, 'calibrated_at': 1, 'measured_v': 25.0}))
    cal = bridge._load_battery_cal()
    assert cal['gain'] == 1.0  # rejected, fell back to default


def test_load_battery_cal_rejects_corrupt_file(bridge, monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    (tmp_path / BATTERY_CAL_FILENAME).write_text('{not valid json')
    cal = bridge._load_battery_cal()
    assert cal['gain'] == 1.0


def test_calibrate_battery_persists_and_applies_gain(bridge, monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    # Telemetry first to seed _last_raw_vbat with a believable raw reading
    # — the MCU said 25.6 V but the multimeter reads 26.0 V.
    bridge._handle_telemetry('T 1 0 0 0.0 0.0 25.600 0x0')
    assert abs(bridge._last_raw_vbat - 25.6) < 1e-3

    class _Msg:
        def __init__(self, v): self.data = v
    bridge._on_calibrate_battery(_Msg(26.0))

    # Gain saved + applied to subsequent telemetry
    expected_gain = 26.0 / 25.6
    assert abs(bridge._battery_cal['gain'] - expected_gain) < 1e-4
    assert bridge._battery_cal['measured_v'] == 26.0
    assert bridge._battery_cal['calibrated_at'] is not None

    # JSON written
    written = json.loads((tmp_path / BATTERY_CAL_FILENAME).read_text())
    assert abs(written['gain'] - expected_gain) < 1e-4

    # Next telemetry sample reports the corrected voltage
    bridge._pub_battery.published.clear()
    bridge._handle_telemetry('T 2 0 0 0.0 0.0 25.600 0x0')
    bat = json.loads(bridge._pub_battery.published[0].data)
    assert abs(bat['voltage'] - 26.0) < 0.01
    assert abs(bat['voltage_raw'] - 25.6) < 0.01
    assert abs(bat['gain'] - expected_gain) < 1e-4
    assert bat['measured_v'] == 26.0


def test_calibrate_battery_rejects_out_of_range_measurement(bridge, monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    bridge._handle_telemetry('T 1 0 0 0.0 0.0 25.0 0x0')
    class _Msg:
        def __init__(self, v): self.data = v
    bridge._on_calibrate_battery(_Msg(50.0))     # absurdly high
    bridge._on_calibrate_battery(_Msg(5.0))      # absurdly low
    bridge._on_calibrate_battery(_Msg(float('nan')))
    assert bridge._battery_cal['gain'] == 1.0    # never overwritten


def test_calibrate_battery_without_raw_sample_is_ignored(bridge, monkeypatch, tmp_path):
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    # No telemetry yet → no raw sample → must not blow up or save garbage
    class _Msg:
        def __init__(self, v): self.data = v
    bridge._on_calibrate_battery(_Msg(26.0))
    assert bridge._battery_cal['gain'] == 1.0
    assert not (tmp_path / BATTERY_CAL_FILENAME).exists()


def test_heartbeat_sends_H(bridge):
    bridge._heartbeat()
    assert any(w.strip() == 'H' for w in _writes_text(bridge))


def test_odom_integration_advances_when_dt_ok(bridge):
    import time
    bridge._last_telemetry_t = time.monotonic() - 0.1  # 100 ms ago
    bridge._handle_telemetry('T 200 0 0 1.000 1.000 25.0 0x0')
    odom = json.loads(bridge._pub_odom.published[0].data)
    # Forward 1 m/s × 0.1 s ≈ 0.1 m along x (yaw=0)
    assert 0.05 < odom['x'] < 0.2
    assert abs(odom['yaw']) < 1e-6


def test_hardware_estop_press_publishes_emergency_stop(bridge):
    # First telemetry observation: line clear. No edge → no publish.
    bridge._handle_telemetry('T 1 0 0 0.0 0.0 25.0 0x0')
    assert len(bridge._pub_emergency_stop.published) == 0
    # Next tick the latching button is pressed (FLAG_ESTOP_LINE = bit 7).
    bridge._handle_telemetry('T 2 0 0 0.0 0.0 25.0 0x80')
    assert len(bridge._pub_emergency_stop.published) == 1
    assert len(bridge._pub_clear_emergency.published) == 0
    # The physical button must NEVER be relayed to the MCU as 'E' — that
    # would latch g_tripped and deadlock the release (the original bug).
    assert not any(w.strip() == 'E' for w in _writes_text(bridge))


def test_hardware_estop_release_publishes_clear(bridge):
    bridge._handle_telemetry('T 1 0 0 0.0 0.0 25.0 0x80')  # pressed (from rest)
    bridge._handle_telemetry('T 2 0 0 0.0 0.0 25.0 0x0')   # released (twist)
    # A button already pressed at the first tick correctly stops the
    # navigator (safe), and the subsequent release clears it.
    assert len(bridge._pub_emergency_stop.published) == 1
    assert len(bridge._pub_clear_emergency.published) == 1
    # Release is not relayed to the MCU either — the MCU clears the
    # hardware stop on its own line drop, not via 'C'.
    assert not any(w.strip() == 'C' for w in _writes_text(bridge))


def test_hardware_estop_steady_state_no_repeat(bridge):
    bridge._handle_telemetry('T 1 0 0 0.0 0.0 25.0 0x0')
    bridge._handle_telemetry('T 2 0 0 0.0 0.0 25.0 0x80')  # press → publish
    bridge._handle_telemetry('T 3 0 0 0.0 0.0 25.0 0x80')  # held
    bridge._handle_telemetry('T 4 0 0 0.0 0.0 25.0 0x80')  # held
    assert len(bridge._pub_emergency_stop.published) == 1
    assert len(bridge._pub_clear_emergency.published) == 0


def test_software_latch_flag_does_not_trigger_hardware_sync(bridge):
    # FLAG_ESTOP_ACTIVE (bit 0) alone — e.g. a software 'E' latch with the
    # physical line released — must NOT be mistaken for a hardware press.
    # The hardware sync keys off FLAG_ESTOP_LINE (bit 7) only.
    bridge._handle_telemetry('T 1 0 0 0.0 0.0 25.0 0x0')
    bridge._handle_telemetry('T 2 0 0 0.0 0.0 25.0 0x1')
    assert len(bridge._pub_emergency_stop.published) == 0
    assert len(bridge._pub_clear_emergency.published) == 0


