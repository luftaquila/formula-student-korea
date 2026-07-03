"""Bridge Node: SSE/REST bridge between ROS2 and the course server.

Connects to the course server SSE stream to receive commands and
sends rover position updates via REST.

Published topics:
    /rover/cmd/execute_path (std_msgs/String) - JSON waypoints from server
    /rover/cmd/sw_estop (std_msgs/Empty) - Software emergency stop from server
    /rover/cmd/sw_clear (std_msgs/Empty) - Software emergency-stop release from server
    /rover/cmd/pause (std_msgs/Empty) - Soft mission pause from server
    /rover/cmd/resume (std_msgs/Empty) - Mission resume from server
    /rover/cmd/manual_control (geometry_msgs/Twist) - Manual joystick from server
    /rover/cmd/request_position (std_msgs/Empty) - Position request from server

Subscribed topics:
    /rover/gps/position (sensor_msgs/NavSatFix) - GPS position to report to server
    /rover/gps/fix_status (std_msgs/String) - Fix status for telemetry
    /rover/nav/state (std_msgs/String) - Navigation state for logging
    /rover/ntrip/status (std_msgs/String) - NTRIP client JSON status (optional)
"""

import collections
import json
import os
import queue
import threading
import time
import requests
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import NavSatFix
from geometry_msgs.msg import Twist
from std_msgs.msg import Empty, Float32, Int32, String

try:
    from rcl_interfaces.msg import Log as _RosoutLog  # noqa: F401
    HAS_ROSOUT = True
except ImportError:
    HAS_ROSOUT = False

from pilot.lib.protocol_utils import assemble_sse_data
from pilot.lib.antenna_calibration import load_antenna_offset
from pilot.lib.wheel_calibration import load_wheel_cal
from pilot.lib.steering_calibration import load_steering_trim

LOG_BUFFER_MAXLEN = 500
LOG_LEVEL_LABEL = {10: "DEBUG", 20: "INFO", 30: "WARN", 40: "ERROR", 50: "FATAL"}


class BridgeNode(Node):

    def __init__(self):
        super().__init__('bridge_node')

        # Parameters
        self.declare_parameter('server_url', '')
        self.declare_parameter('position_report_interval', 1.0)
        self.declare_parameter('sse_reconnect_delay', 3.0)
        # Emergency escape hatch for Tailscale-internal HTTP use; default off.
        self.declare_parameter('server_url_allow_http', False)

        # INTERNAL_SECRET is read from env only — never from ros params, to keep
        # it off the `ros2 param get` surface for anyone on the same ROS domain.
        self._internal_secret = os.environ.get('INTERNAL_SECRET', '')

        url = self.get_parameter('server_url').value
        allow_http = self.get_parameter('server_url_allow_http').value
        if url and not url.startswith('https://') and not allow_http:
            self.get_logger().fatal(
                f'server_url must start with https:// (got: {url!r}). '
                "Set server_url_allow_http=true to override for trusted internal networks."
            )
            raise SystemExit(1)

        # Publishers
        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self._pub_execute = self.create_publisher(String, '/rover/cmd/execute_path', reliable_qos)
        # Software-originated E-Stop goes to the dedicated sw_* topics so
        # the MCU bridge relays them to the MCU as 'E'/'C'. The bridge in
        # turn republishes /rover/cmd/{emergency_stop,clear_emergency} for
        # the navigator/spray. Publishing those logical topics directly
        # from here would bypass the MCU software latch.
        self._pub_estop = self.create_publisher(Empty, '/rover/cmd/sw_estop', reliable_qos)
        self._pub_clear_estop = self.create_publisher(Empty, '/rover/cmd/sw_clear', reliable_qos)
        # Soft pause/resume (NOT E-Stop): holds the mission while still allowing
        # manual control, then resumes from the current waypoint.
        self._pub_pause = self.create_publisher(Empty, '/rover/cmd/pause', reliable_qos)
        self._pub_resume = self.create_publisher(Empty, '/rover/cmd/resume', reliable_qos)
        self._pub_manual = self.create_publisher(Twist, '/rover/cmd/manual_control', 10)
        self._pub_request_pos = self.create_publisher(Empty, '/rover/cmd/request_position', reliable_qos)
        self._pub_calibrate_battery = self.create_publisher(Float32, '/rover/cmd/calibrate_battery', reliable_qos)
        self._pub_calibrate_antenna = self.create_publisher(Empty, '/rover/cmd/calibrate_antenna', reliable_qos)
        self._pub_set_antenna_offset = self.create_publisher(String, '/rover/cmd/set_antenna_offset', reliable_qos)
        self._pub_calibrate_wheels = self.create_publisher(Empty, '/rover/cmd/calibrate_wheels', reliable_qos)
        self._pub_reset_wheel_cal = self.create_publisher(Empty, '/rover/cmd/reset_wheel_cal', reliable_qos)
        self._pub_pump_set = self.create_publisher(Int32, '/rover/cmd/pump_set', reliable_qos)
        self._pub_pump_duration = self.create_publisher(Float32, '/rover/cmd/pump_duration', reliable_qos)
        self._pub_nav_lights = self.create_publisher(Int32, '/rover/cmd/nav_lights', reliable_qos)
        self._pub_led_brightness = self.create_publisher(Int32, '/rover/cmd/led_brightness', reliable_qos)

        # Subscribers
        self.create_subscription(NavSatFix, '/rover/gps/position', self._on_gps_position, 10)
        self.create_subscription(String, '/rover/nav/state', self._on_nav_state, 10)
        self.create_subscription(String, '/rover/gps/fix_status', self._on_fix_status, 10)
        self.create_subscription(String, '/rover/ntrip/status', self._on_ntrip_status, 10)
        self.create_subscription(Int32, '/rover/nav/waypoint_reached', self._on_waypoint_reached, reliable_qos)
        self.create_subscription(String, '/rover/spray/result', self._on_spray_result, reliable_qos)
        self.create_subscription(String, '/rover/battery', self._on_battery, 10)
        self.create_subscription(String, '/rover/gps/metrics', self._on_gps_metrics, 10)
        self.create_subscription(String, '/rover/cal/antenna_result', self._on_cal_antenna_result, reliable_qos)
        self.create_subscription(String, '/rover/cal/wheel_result', self._on_cal_wheels_result, reliable_qos)

        # State
        self._last_position = None
        self._last_report_time = 0.0
        self._position_requested = False
        self._nav_state = 'IDLE'
        self._sse_connected = False
        self._fix_status = None
        # Default to False (not None) so the very first telemetry POST
        # explicitly tells the server "no NTRIP this session". The server
        # uses that signal to clear any stale ntrip detail it cached from
        # a previous boot — without it the UI keeps showing the old
        # mountpoint and "보정 N s 전" until something else updates it.
        self._ntrip_connected = False
        self._ntrip_detail = None

        # Battery telemetry
        self._battery = None  # { voltage, percent, source }

        # Latest GPS metrics: { h_acc, v_acc, altitude, speed, heading, num_sv, pdop, tdop }
        self._gps_metrics = None

        # Request IDs from server-initiated position requests. Echoing one
        # ID on the next explicit position POST lets the server correlate
        # replies and ignore unrelated periodic position reports.
        # Bounded: if requests pile up while position is unavailable, drop the
        # oldest (it would have timed out on the server's 5 s race anyway).
        self._pending_position_request_ids = collections.deque(maxlen=32)

        # /rosout log buffer (aggregated across all nodes in the domain)
        self._log_buffer = collections.deque(maxlen=LOG_BUFFER_MAXLEN)
        self._log_upload_in_flight = False
        if HAS_ROSOUT:
            from rcl_interfaces.msg import Log as RosoutLog
            self.create_subscription(RosoutLog, '/rosout', self._on_rosout, 10)

        # Single async-POST worker. The previous implementation spawned a
        # fresh thread + TCP connection per spray_result / waypoint_reached
        # callback; bursts during a multi-cone mission piled up dozens of
        # threads and request sockets. A bounded queue + Session reuses
        # the connection and back-pressures bursts cleanly.
        self._running = True
        self._post_queue = queue.Queue(maxsize=64)
        self._post_session = requests.Session()
        self._post_thread = threading.Thread(target=self._post_loop, daemon=True)
        self._post_thread.start()

        # Start network threads after all shared queues/sessions exist.
        self._sse_thread = threading.Thread(target=self._sse_loop, daemon=True)
        self._sse_thread.start()

        # Periodic telemetry thread (every 3s)
        self._telemetry_thread = threading.Thread(target=self._telemetry_loop, daemon=True)
        self._telemetry_thread.start()

        self.get_logger().info('Bridge node started')

    def _get_headers(self):
        """Build request headers with internal service auth."""
        headers = {'Content-Type': 'application/json'}
        if self._internal_secret:
            headers['X-Internal-Service'] = self._internal_secret
        return headers

    def _on_gps_position(self, msg):
        """Handle GPS position update."""
        # msg.altitude is MSL height (gps_node sets it from NAV-PVT h_msl), same
        # datum as the gps-register rover — keep it bound to this fix so the cone
        # gets lat/lng/alt from a single GPS solution.
        self._last_position = {'lat': msg.latitude, 'lng': msg.longitude, 'alt': msg.altitude}

        # If position was explicitly requested, send immediately
        if self._position_requested:
            self._position_requested = False
            self._report_position(explicit_request=True)
            return

        # Periodic reporting — always, regardless of nav_state. The map needs
        # to track the rover even when it's parked/IDLE; gating on a driving
        # state means the marker freezes the moment a mission ends.
        interval = self.get_parameter('position_report_interval').value
        now = time.monotonic()
        if (now - self._last_report_time) >= interval:
            self._report_position()

    def _on_nav_state(self, msg):
        """Track navigation state for position reporting."""
        self._nav_state = msg.data

    def _on_fix_status(self, msg):
        """Track fix status for telemetry."""
        self._fix_status = msg.data

    def _on_gps_metrics(self, msg):
        """Track GPS accuracy/speed/heading JSON for telemetry."""
        try:
            data = json.loads(msg.data)
            if isinstance(data, dict):
                self._gps_metrics = data
        except (json.JSONDecodeError, AttributeError, TypeError):
            pass

    def _on_ntrip_status(self, msg):
        """Track NTRIP client status payload (JSON) for telemetry."""
        try:
            data = json.loads(msg.data)
            self._ntrip_connected = bool(data.get('connected'))
            # Cache full detail (caster, fail_count, last_error, last_correction_at)
            # so the UI can tell "NTRIP off because DNS failed" from "connected,
            # last correction 30s ago".
            if isinstance(data, dict):
                self._ntrip_detail = {
                    'host': data.get('host'),
                    'port': data.get('port'),
                    'mountpoint': data.get('mountpoint'),
                    'fail_count': data.get('fail_count'),
                    'last_error': data.get('last_error'),
                    'last_correction_at': data.get('last_correction_at'),
                    'bytes_received': data.get('bytes_received'),
                }
        except (json.JSONDecodeError, AttributeError, TypeError):
            pass

    def _post_async(self, path, payload, label):
        """Enqueue a POST for the single async worker.

        The ROS executor is single-threaded; a blocking HTTP call here
        would stall every other subscription until the request returns.
        We hand the work to a long-lived worker thread that drains a
        bounded queue using a shared requests.Session for connection
        reuse. Drops on full queue rather than blocking the executor.
        """
        url = self.get_parameter('server_url').value
        if not url:
            return
        try:
            self._post_queue.put_nowait((path, payload, label))
        except queue.Full:
            self.get_logger().warn(
                f'{label}: post queue full ({self._post_queue.maxsize}), dropping'
            )

    def _post_loop(self):
        """Worker that drains the queue and posts via the shared Session."""
        while self._running:
            try:
                item = self._post_queue.get(timeout=1.0)
            except queue.Empty:
                continue
            if item is None:  # shutdown sentinel
                break
            path, payload, label = item
            url = self.get_parameter('server_url').value
            if not url:
                continue
            try:
                self._post_session.post(
                    f'{url}{path}',
                    json=payload,
                    headers=self._get_headers(),
                    timeout=5.0,
                )
            except requests.RequestException as e:
                self.get_logger().warn(f'{label} POST error: {e}')

    def _on_waypoint_reached(self, msg):
        """Forward reached waypoint index to the course server."""
        self._post_async(
            '/api/rover/waypoint_reached',
            {'index': int(msg.data)},
            'waypoint_reached',
        )

    def _on_battery(self, msg):
        """Cache battery status for the periodic telemetry POST."""
        try:
            self._battery = json.loads(msg.data)
        except (json.JSONDecodeError, AttributeError):
            pass

    def _on_rosout(self, msg):
        """Buffer log records from every node in the ROS 2 domain."""
        try:
            t_msg = msg.stamp
            t_ms = int(t_msg.sec) * 1000 + int(t_msg.nanosec) // 1_000_000
        except AttributeError:
            t_ms = int(time.time() * 1000)
        self._log_buffer.append({
            't': t_ms,
            'level': LOG_LEVEL_LABEL.get(int(msg.level), str(msg.level)),
            'node': getattr(msg, 'name', ''),
            'msg': getattr(msg, 'msg', ''),
        })

    def _upload_logs(self):
        """Upload the current log buffer to the course server."""
        url = self.get_parameter('server_url').value
        if not url:
            self._log_upload_in_flight = False
            return
        try:
            entries = list(self._log_buffer)
            requests.post(
                f'{url}/api/rover/logs',
                json={'entries': entries},
                headers=self._get_headers(),
                timeout=10.0,
            )
        except requests.RequestException as e:
            self.get_logger().warn(f'log upload error: {e}')
        finally:
            self._log_upload_in_flight = False

    def _on_spray_result(self, msg):
        """Forward spray outcome JSON to the course server."""
        try:
            payload = json.loads(msg.data)
        except json.JSONDecodeError:
            self.get_logger().warn(f'Invalid spray result JSON: {msg.data}')
            return
        self._post_async('/api/rover/spray_result', payload, 'spray_result')

    def _on_cal_antenna_result(self, msg):
        """Forward antenna-cal outcome JSON to the course server."""
        try:
            payload = json.loads(msg.data)
        except json.JSONDecodeError:
            self.get_logger().warn(f'Invalid antenna cal result JSON: {msg.data}')
            return
        self._post_async('/api/rover/antenna_calibration_result', payload,
                         'antenna_calibration_result')

    def _on_cal_wheels_result(self, msg):
        """Forward wheel-cal outcome JSON to the course server."""
        try:
            payload = json.loads(msg.data)
        except json.JSONDecodeError:
            self.get_logger().warn(f'Invalid wheel cal result JSON: {msg.data}')
            return
        self._post_async('/api/rover/wheel_calibration_result', payload,
                         'wheel_calibration_result')

    def _telemetry_loop(self):
        """Periodically POST telemetry to the course server."""
        while self._running:
            time.sleep(3.0)
            url = self.get_parameter('server_url').value
            if not url:
                continue
            payload = {
                'nav_state': self._nav_state,
                'fix_status': self._fix_status,
                'ntrip_connected': self._ntrip_connected,
            }
            if self._ntrip_detail is not None:
                payload['ntrip'] = self._ntrip_detail
            if self._battery is not None:
                payload['battery'] = self._battery
            if self._gps_metrics is not None:
                payload['gps'] = self._gps_metrics
            try:
                requests.post(
                    f'{url}/api/rover/telemetry',
                    json=payload,
                    headers=self._get_headers(),
                    timeout=5.0,
                )
            except requests.RequestException as e:
                self.get_logger().warn(f'Telemetry POST error: {e}')

    def _report_persisted_cal_state(self):
        """Push the rover's persisted calibration to the server on connect.

        roverState.{antenna_calibration,wheel_calibration} on the server only
        gets populated when the navigator finishes a cal run and posts the
        result. After a rover reboot the values are still loaded into the
        navigator/mcu_bridge from JSON, but the server (and therefore the
        GUI) has no knowledge of them — the cal modal shows '—' even
        though the rover is calibrated. Re-emitting the persisted payload
        on every SSE connect fixes that without changing the result
        endpoints' shape.
        """
        _, antenna_payload = load_antenna_offset()
        if isinstance(antenna_payload, dict):
            self._post_async(
                '/api/rover/antenna_calibration_result',
                {
                    'ok': True,
                    'a_x': antenna_payload.get('a_x'),
                    'a_y': antenna_payload.get('a_y'),
                    'rms_residual_m': antenna_payload.get('rms_residual_m'),
                    'samples': antenna_payload.get('samples'),
                    'drive_distance_m': antenna_payload.get('drive_distance_m'),
                    'calibrated_at': antenna_payload.get('calibrated_at'),
                    'source': antenna_payload.get('source'),
                },
                'antenna_calibration_result(boot)',
            )

        _, wheel_payload = load_wheel_cal()
        _, trim_payload = load_steering_trim()
        if isinstance(wheel_payload, dict) or isinstance(trim_payload, dict):
            wheel_payload = wheel_payload if isinstance(wheel_payload, dict) else {}
            trim_payload = trim_payload if isinstance(trim_payload, dict) else {}
            self._post_async(
                '/api/rover/wheel_calibration_result',
                {
                    'ok': True,
                    'scale_l': wheel_payload.get('scale_l'),
                    'scale_r': wheel_payload.get('scale_r'),
                    'gps_distance_m': wheel_payload.get('gps_distance_m'),
                    'encoder_left_m': wheel_payload.get('encoder_left_m'),
                    'encoder_right_m': wheel_payload.get('encoder_right_m'),
                    'samples': wheel_payload.get('samples'),
                    'trim_us': trim_payload.get('trim_us'),
                    'radius_m': trim_payload.get('radius_m'),
                    'steering_rms_m': trim_payload.get('rms_residual_m'),
                    'steering_reason': None,
                },
                'wheel_calibration_result(boot)',
            )

    def _report_position(self, explicit_request=False):
        """POST current position to the course server."""
        if not self._last_position:
            return

        url = self.get_parameter('server_url').value
        if not url:
            return

        request_ids = []
        if explicit_request and self._pending_position_request_ids:
            request_ids = list(self._pending_position_request_ids)
            self._pending_position_request_ids.clear()
        payload = dict(self._last_position)
        if request_ids:
            payload['request_id'] = request_ids[0]
            payload['request_ids'] = request_ids

        try:
            resp = requests.post(
                f'{url}/api/rover/position',
                json=payload,
                headers=self._get_headers(),
                timeout=5.0,
            )
            self._last_report_time = time.monotonic()
            if resp.status_code != 200:
                self.get_logger().warn(f'Position report failed: {resp.status_code}')
        except requests.RequestException as e:
            self.get_logger().warn(f'Position report error: {e}')

    def _sse_loop(self):
        """Main SSE connection loop with reconnection."""
        reconnect_delay = self.get_parameter('sse_reconnect_delay').value
        current_delay = reconnect_delay

        while self._running:
            try:
                connection_succeeded, had_events = self._connect_sse()
                # Reset backoff on a successful HTTP handshake, even if no
                # events arrived before disconnect — otherwise a 401 fix
                # makes the operator wait 30 s for the first reconnect
                # because the previous burst of failures pinned the cap.
                if connection_succeeded or had_events:
                    current_delay = reconnect_delay
            except Exception as e:
                self.get_logger().warn(f'SSE connection error: {e}')

            self._sse_connected = False
            if self._running:
                self.get_logger().info(f'SSE reconnecting in {current_delay:.0f}s...')
                time.sleep(current_delay)
                current_delay = min(current_delay * 2, 30.0)  # Exponential backoff, max 30s

    def _connect_sse(self):
        """Connect to server SSE stream and process events.

        Returns (connection_succeeded, had_events). connection_succeeded
        is True once the HTTP handshake passes raise_for_status — used
        to reset the reconnect backoff so a transient 401 doesn't pin
        operator-visible delay at the 30 s cap after auth is fixed.
        """
        url = self.get_parameter('server_url').value
        if not url:
            self.get_logger().warn('No server_url configured')
            time.sleep(5.0)
            return False, False

        event_count = 0
        connection_succeeded = False

        headers = self._get_headers()
        headers['Accept'] = 'text/event-stream'
        headers['Cache-Control'] = 'no-cache'

        resp = requests.get(
            f'{url}/api/rover/stream',
            headers=headers,
            stream=True,
            # connect timeout, read timeout. Server heartbeat is 10s, so a 25s
            # read timeout tolerates two missed beats before declaring the
            # socket dead. Was (10, 90): a Wi-Fi drop (no FIN/RST) left the
            # rover blocked on the dead socket up to 90s before reconnecting,
            # so the command channel (E-Stop, execute) lagged ~1.5 min.
            timeout=(5.0, 25.0),
        )
        resp.raise_for_status()
        connection_succeeded = True

        self._sse_connected = True
        self.get_logger().info('SSE connected to server')
        # Re-emit persisted cal state so the GUI doesn't show '—' after a
        # rover reboot (or after the server side was restarted and cleared
        # roverState in memory).
        self._report_persisted_cal_state()

        event_name = None
        event_data_lines = []

        for line in resp.iter_lines(decode_unicode=True):
            if not self._running:
                break

            if line is None:
                continue

            # SSE parsing
            if line.startswith('event: '):
                event_name = line[7:]
                event_data_lines = []
            elif line.startswith('data: '):
                event_data_lines.append(line[6:])
            elif line == 'data:':
                event_data_lines.append('')
            elif line.startswith(':'):
                # Comment/heartbeat - just keep alive
                continue
            elif line == '':
                # Empty line = end of event
                event_data = assemble_sse_data(event_data_lines)
                if event_name:
                    self._handle_sse_event(event_name, event_data)
                    event_count += 1
                event_name = None
                event_data_lines = []

        resp.close()
        return connection_succeeded, event_count > 0

    def _handle_sse_event(self, event, data):
        """Process a single SSE event."""
        try:
            payload = json.loads(data) if data else {}
        except json.JSONDecodeError:
            self.get_logger().warn(f'Invalid SSE JSON: {data}')
            return

        if event == 'connected':
            self.get_logger().info('SSE handshake complete')

        elif event == 'request-position':
            request_id = payload.get('request_id')
            if isinstance(request_id, str) and request_id:
                self._pending_position_request_ids.append(request_id[:64])
            self._position_requested = True
            self._pub_request_pos.publish(Empty())

        elif event == 'execute-path':
            waypoints = payload.get('waypoints', [])
            self.get_logger().info(f'Received path: {len(waypoints)} waypoints')
            msg = String()
            msg.data = json.dumps(waypoints)
            self._pub_execute.publish(msg)

        elif event == 'emergency-stop':
            self.get_logger().warn('Emergency stop received from server')
            self._pub_estop.publish(Empty())

        elif event == 'clear-emergency':
            self.get_logger().info('Emergency-stop release received from server')
            self._pub_clear_estop.publish(Empty())

        elif event == 'pause-mission':
            self.get_logger().info('Mission pause received from server')
            self._pub_pause.publish(Empty())

        elif event == 'resume-mission':
            self.get_logger().info('Mission resume received from server')
            self._pub_resume.publish(Empty())

        elif event == 'manual-control':
            msg = Twist()
            msg.linear.x = float(payload.get('throttle', 0))
            msg.angular.z = float(payload.get('steering', 0))
            self._pub_manual.publish(msg)

        elif event == 'pump-set':
            on = payload.get('on')
            if not isinstance(on, bool):
                self.get_logger().warn(
                    f'pump-set: bad payload {payload!r}'
                )
                return
            msg = Int32()
            msg.data = 1 if on else 0
            self._pub_pump_set.publish(msg)

        elif event == 'pump-duration':
            try:
                seconds = float(payload.get('seconds'))
            except (TypeError, ValueError):
                self.get_logger().warn(f'pump-duration: invalid payload {payload!r}')
                return
            if not (0.0 < seconds <= 10.0):
                self.get_logger().warn(f'pump-duration: out-of-range {seconds}')
                return
            msg = Float32()
            msg.data = seconds
            self._pub_pump_duration.publish(msg)

        elif event == 'nav-lights':
            try:
                mode = int(payload.get('mode'))
            except (TypeError, ValueError):
                self.get_logger().warn(f'nav-lights: invalid payload {payload!r}')
                return
            if not (0 <= mode < 5):
                self.get_logger().warn(f'nav-lights: out-of-range mode {mode}')
                return
            msg = Int32()
            msg.data = mode
            self._pub_nav_lights.publish(msg)

        elif event == 'led-brightness':
            try:
                brightness = int(payload.get('brightness'))
            except (TypeError, ValueError):
                self.get_logger().warn(f'led-brightness: invalid payload {payload!r}')
                return
            if not (0 <= brightness <= 255):
                self.get_logger().warn(f'led-brightness: out-of-range {brightness}')
                return
            msg = Int32()
            msg.data = brightness
            self._pub_led_brightness.publish(msg)

        elif event == 'fetch-logs':
            # Upload on a worker thread so the SSE reader loop stays responsive.
            # Skip if a previous upload is still in flight — the operator mashing
            # the button should not spawn an unbounded pile of threads.
            if self._log_upload_in_flight:
                return
            self._log_upload_in_flight = True
            threading.Thread(target=self._upload_logs, daemon=True).start()

        elif event == 'calibrate-battery':
            try:
                measured_v = float(payload.get('measured_v'))
            except (TypeError, ValueError):
                self.get_logger().warn(f'calibrate-battery: invalid payload {payload!r}')
                return
            self.get_logger().info(f'Battery calibration request: measured={measured_v:.3f} V')
            msg = Float32()
            msg.data = measured_v
            self._pub_calibrate_battery.publish(msg)

        elif event == 'calibrate-antenna':
            self.get_logger().info('Antenna offset calibration requested by server')
            self._pub_calibrate_antenna.publish(Empty())

        elif event == 'set-antenna-offset':
            try:
                a_x = float(payload.get('a_x'))
                a_y = float(payload.get('a_y'))
            except (TypeError, ValueError):
                self.get_logger().warn(f'set-antenna-offset: invalid payload {payload!r}')
                return
            self.get_logger().info(
                f'Manual antenna offset received: a_x={a_x:.3f}, a_y={a_y:.3f}'
            )
            msg = String()
            msg.data = json.dumps({'a_x': a_x, 'a_y': a_y})
            self._pub_set_antenna_offset.publish(msg)

        elif event == 'calibrate-wheels':
            self.get_logger().info('Wheel scale calibration requested by server')
            self._pub_calibrate_wheels.publish(Empty())

        elif event == 'reset-wheel-cal':
            self.get_logger().warn('Wheel/steering calibration reset requested by server')
            self._pub_reset_wheel_cal.publish(Empty())

    def destroy_node(self):
        self._running = False
        if self._sse_thread:
            self._sse_thread.join(timeout=5.0)
        if getattr(self, '_telemetry_thread', None):
            self._telemetry_thread.join(timeout=5.0)
        post_thread = getattr(self, '_post_thread', None)
        if post_thread is not None:
            try:
                self._post_queue.put_nowait(None)
            except queue.Full:
                pass
            post_thread.join(timeout=5.0)
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = BridgeNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
