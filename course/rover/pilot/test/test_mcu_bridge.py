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
        'max_steering_angle': 25.0,
        'wheelbase': 0.38,
        'track_width': 0.30,
        'max_speed': 1.5,
        'accel_limit': 0.5,
        'manual_priority_s': 1.0,
        'command_period_s': 0.05,
        'use_pid': False,
        'pid_kp': 0.6,
        'pid_ki': 1.5,
        'pid_kd': 0.0,
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
    node._cur_left = 0.0
    node._cur_right = 0.0
    node._cur_steer_us = 1500
    node._odom_x = 0.0
    node._odom_y = 0.0
    node._odom_yaw = 0.0
    node._last_telemetry_t = None
    node._line_buf = b''

    # Patches for ROS Node helpers
    node.get_parameter = lambda name: type('P', (), {'value': node._params[name]})()
    node.get_logger = lambda: node._logger

    class _Pub:
        def __init__(self): self.published = []
        def publish(self, msg): self.published.append(msg)
    node._pub_status = _Pub()
    node._pub_battery = _Pub()
    node._pub_odom = _Pub()

    # Battery calibration state — same defaults the real __init__ sets.
    import threading as _t
    node._battery_cal_lock = _t.Lock()
    node._battery_cal = {'gain': 1.0, 'measured_v': None, 'voltage_raw_at_cal': None, 'calibrated_at': None}
    node._last_raw_vbat = None

    return node


def _writes_text(bridge):
    return [w.decode('ascii') for w in bridge._serial.writes]


def test_validate_params_rejects_bad_max_speed(bridge):
    bridge._params['max_speed'] = 0.05
    with pytest.raises(SystemExit):
        bridge._validate_params()


def test_validate_params_rejects_bad_command_period(bridge):
    bridge._params['command_period_s'] = 0.5
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


def test_drive_emits_M_in_raw_mode(bridge):
    bridge._drive(left_pct=50.0, right_pct=50.0, servo_us=1500)
    out = _writes_text(bridge)
    assert any(line.startswith('M ') for line in out)
    line = next(line for line in out if line.startswith('M '))
    parts = line.strip().split()
    # Accel limiter caps a 0->50 jump per single tick.
    assert -1.0 <= float(parts[1]) <= 1.0
    assert int(parts[3]) == 1500


def test_drive_emits_V_when_pid_enabled(bridge):
    bridge._params['use_pid'] = True
    bridge._drive(left_pct=100.0, right_pct=100.0, servo_us=1500)
    out = _writes_text(bridge)
    line = next(line for line in out if line.startswith('V '))
    parts = line.strip().split()
    # Sent in m/s = (pct/100) * max_speed = capped by accel limit
    assert abs(float(parts[1])) <= bridge._params['max_speed']


def test_estop_sends_E_and_clears_state(bridge):
    bridge._cur_left = 50.0
    bridge._cur_right = 50.0
    bridge._on_estop(None)
    assert any(w.strip() == 'E' for w in _writes_text(bridge))
    assert bridge._mode == 'stopped'
    assert bridge._cur_left == 0.0 and bridge._cur_right == 0.0


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


