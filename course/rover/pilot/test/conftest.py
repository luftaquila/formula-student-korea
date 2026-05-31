"""Shared pytest fixtures.

Provides stubs for ROS2 / hardware modules that are not installable in CI.
Tests that exercise node-level logic can rely on these stubs.
"""

import sys
import types


def _install_stub(name, attrs=None):
    if name in sys.modules:
        return sys.modules[name]
    mod = types.ModuleType(name)
    if attrs:
        for k, v in attrs.items():
            setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


class _FakeParam:
    def __init__(self, value):
        self.value = value


class _FakeLogger:
    def info(self, *_a, **_kw): pass
    def warn(self, *_a, **_kw): pass
    def warning(self, *_a, **_kw): pass
    def error(self, *_a, **_kw): pass
    def fatal(self, *_a, **_kw): pass
    def debug(self, *_a, **_kw): pass


class _FakeTimer:
    def __init__(self):
        self._cancelled = False
    def cancel(self):
        if self._cancelled:
            raise RuntimeError("already cancelled")
        self._cancelled = True


class _FakeNode:
    """Mimics the subset of rclpy.Node methods used by rover nodes."""

    def __init__(self, *_a, **_kw):
        self._params = {}
        self._logger = _FakeLogger()
        self._publishers = {}
        self._timers = []
        self._destroyed_timers = []

    def declare_parameter(self, name, default):
        self._params[name] = default

    def get_parameter(self, name):
        return _FakeParam(self._params.get(name))

    def set_parameter_value(self, name, value):
        """Test helper (not in real Node) to adjust params mid-test."""
        self._params[name] = value

    def get_logger(self):
        return self._logger

    def create_publisher(self, *_a, **_kw):
        pub = types.SimpleNamespace(publish=lambda *_a, **_kw: None)
        return pub

    def create_subscription(self, *_a, **_kw):
        return None

    def create_timer(self, _period, _cb, callback_group=None):
        t = _FakeTimer()
        self._timers.append(t)
        return t

    def destroy_timer(self, timer):
        self._destroyed_timers.append(timer)

    def get_clock(self):
        now = types.SimpleNamespace(to_msg=lambda: None)
        return types.SimpleNamespace(now=lambda: now)

    def destroy_node(self):
        pass

    def add_on_set_parameters_callback(self, cb):
        # Tests don't fire param changes through this path; just record
        # the callback so the registration doesn't blow up.
        self._on_param_cbs = getattr(self, '_on_param_cbs', [])
        self._on_param_cbs.append(cb)


def _install_rclpy():
    rclpy = _install_stub("rclpy", {
        "init": lambda *a, **kw: None,
        "spin": lambda *a, **kw: None,
        "shutdown": lambda *a, **kw: None,
        "try_shutdown": lambda *a, **kw: None,
    })
    node_mod = _install_stub("rclpy.node", {"Node": _FakeNode})
    qos_mod = _install_stub("rclpy.qos", {
        "QoSProfile": lambda depth=10, reliability=None: types.SimpleNamespace(depth=depth, reliability=reliability),
        "ReliabilityPolicy": types.SimpleNamespace(RELIABLE="reliable", BEST_EFFORT="best_effort"),
    })
    rclpy.node = node_mod
    rclpy.qos = qos_mod
    return rclpy


def _install_ros_msgs():
    std_msgs_msg = _install_stub("std_msgs.msg", {
        "String": type("String", (), {"__init__": lambda self: setattr(self, "data", "")}),
        "Float32": type("Float32", (), {"__init__": lambda self: setattr(self, "data", 0.0)}),
        "Float64": type("Float64", (), {"__init__": lambda self: setattr(self, "data", 0.0)}),
        "Int32": type("Int32", (), {"__init__": lambda self: setattr(self, "data", 0)}),
        "Empty": type("Empty", (), {"__init__": lambda self: None}),
    })
    _install_stub("std_msgs", {"msg": std_msgs_msg})

    class _Twist:
        def __init__(self):
            self.linear = types.SimpleNamespace(x=0.0, y=0.0, z=0.0)
            self.angular = types.SimpleNamespace(x=0.0, y=0.0, z=0.0)

    geom_msg = _install_stub("geometry_msgs.msg", {"Twist": _Twist})
    _install_stub("geometry_msgs", {"msg": geom_msg})

    class _NavSatFix:
        COVARIANCE_TYPE_DIAGONAL_KNOWN = 2
        def __init__(self):
            self.header = types.SimpleNamespace(stamp=None, frame_id="")
            self.latitude = 0.0
            self.longitude = 0.0
            self.altitude = 0.0
            self.status = types.SimpleNamespace(service=0, status=0)
            self.position_covariance = [0.0] * 9
            self.position_covariance_type = 0

    class _NavSatStatus:
        SERVICE_GPS = 1
        STATUS_GBAS_FIX = 2
        STATUS_FIX = 1
        STATUS_NO_FIX = -1

    sensor_msg = _install_stub("sensor_msgs.msg", {
        "NavSatFix": _NavSatFix,
        "NavSatStatus": _NavSatStatus,
    })
    _install_stub("sensor_msgs", {"msg": sensor_msg})


def _install_hardware():
    class _FakeSerial:
        def __init__(self, *_a, **_kw):
            self.in_waiting = 0
        def read(self, *_a, **_kw): return b""
        def write(self, *_a, **_kw): return 0
        def close(self): pass

    serial_mod = _install_stub("serial", {
        "Serial": _FakeSerial,
        "SerialException": type("SerialException", (Exception,), {}),
    })


def _install_rcl_interfaces():
    class _SetParametersResult:
        def __init__(self, successful=True, reason=""):
            self.successful = successful
            self.reason = reason

    rcl_msg = _install_stub("rcl_interfaces.msg", {
        "SetParametersResult": _SetParametersResult,
    })
    _install_stub("rcl_interfaces", {"msg": rcl_msg})


_install_rclpy()
_install_ros_msgs()
_install_rcl_interfaces()
_install_hardware()
