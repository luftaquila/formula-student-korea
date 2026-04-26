"""Tests for mcu_bridge_node — param validation, wire protocol, telemetry parse."""

import json

import pytest

from pilot.mcu_bridge_node import McuBridgeNode, voltage_to_percent_8s


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
        'serial_port': '/dev/ttyACM1',
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
        'command_period_s': 0.02,
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
    assert voltage_to_percent_8s(29.5) == 100
    assert voltage_to_percent_8s(20.0) == 0
    assert voltage_to_percent_8s(None) is None
    mid = voltage_to_percent_8s(24.6)  # halfway
    assert 45 <= mid <= 55


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


