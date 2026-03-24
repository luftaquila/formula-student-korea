"""Bridge Node: SSE/REST bridge between ROS2 and the course server.

Connects to the course server SSE stream to receive commands and
sends rover position updates via REST.

Published topics:
    /rover/cmd/execute_path (std_msgs/String) - JSON waypoints from server
    /rover/cmd/emergency_stop (std_msgs/Empty) - Emergency stop from server
    /rover/cmd/manual_control (geometry_msgs/Twist) - Manual joystick from server
    /rover/cmd/request_position (std_msgs/Empty) - Position request from server

Subscribed topics:
    /rover/gps/position (sensor_msgs/NavSatFix) - GPS position to report to server
    /rover/nav/state (std_msgs/String) - Navigation state for logging
"""

import json
import threading
import time
import requests
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import NavSatFix
from geometry_msgs.msg import Twist
from std_msgs.msg import Empty, String


class BridgeNode(Node):

    def __init__(self):
        super().__init__('bridge_node')

        # Parameters
        self.declare_parameter('server_url', '')
        self.declare_parameter('internal_secret', '')
        self.declare_parameter('position_report_interval', 1.0)
        self.declare_parameter('sse_reconnect_delay', 3.0)

        # Publishers
        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self._pub_execute = self.create_publisher(String, '/rover/cmd/execute_path', reliable_qos)
        self._pub_estop = self.create_publisher(Empty, '/rover/cmd/emergency_stop', reliable_qos)
        self._pub_manual = self.create_publisher(Twist, '/rover/cmd/manual_control', 10)
        self._pub_request_pos = self.create_publisher(Empty, '/rover/cmd/request_position', reliable_qos)

        # Subscribers
        self.create_subscription(NavSatFix, '/rover/gps/position', self._on_gps_position, 10)
        self.create_subscription(String, '/rover/nav/state', self._on_nav_state, 10)

        # State
        self._last_position = None
        self._last_report_time = 0.0
        self._position_requested = False
        self._nav_state = 'IDLE'
        self._sse_connected = False

        # Start SSE listener thread
        self._running = True
        self._sse_thread = threading.Thread(target=self._sse_loop, daemon=True)
        self._sse_thread.start()

        self.get_logger().info('Bridge node started')

    def _get_headers(self):
        """Build request headers with internal service auth."""
        secret = self.get_parameter('internal_secret').value
        headers = {'Content-Type': 'application/json'}
        if secret:
            headers['X-Internal-Service'] = secret
        return headers

    def _on_gps_position(self, msg):
        """Handle GPS position update."""
        self._last_position = {'lat': msg.latitude, 'lng': msg.longitude}

        # If position was explicitly requested, send immediately
        if self._position_requested:
            self._position_requested = False
            self._report_position()
            return

        # Periodic reporting during navigation
        interval = self.get_parameter('position_report_interval').value
        now = time.monotonic()
        if self._nav_state in ('CALIBRATING', 'NAVIGATING', 'RETURNING') and \
           (now - self._last_report_time) >= interval:
            self._report_position()

    def _on_nav_state(self, msg):
        """Track navigation state for position reporting."""
        self._nav_state = msg.data

    def _report_position(self):
        """POST current position to the course server."""
        if not self._last_position:
            return

        url = self.get_parameter('server_url').value
        if not url:
            return

        try:
            resp = requests.post(
                f'{url}/api/rover/position',
                json=self._last_position,
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
                had_events = self._connect_sse()
                if had_events:
                    current_delay = reconnect_delay  # Reset only if connection actually worked
            except Exception as e:
                self.get_logger().warn(f'SSE connection error: {e}')

            self._sse_connected = False
            if self._running:
                self.get_logger().info(f'SSE reconnecting in {current_delay:.0f}s...')
                time.sleep(current_delay)
                current_delay = min(current_delay * 2, 30.0)  # Exponential backoff, max 30s

    def _connect_sse(self):
        """Connect to server SSE stream and process events.

        Returns True if at least one event was processed (connection was healthy).
        """
        url = self.get_parameter('server_url').value
        if not url:
            self.get_logger().warn('No server_url configured')
            time.sleep(5.0)
            return False

        event_count = 0

        headers = self._get_headers()
        headers['Accept'] = 'text/event-stream'
        headers['Cache-Control'] = 'no-cache'

        resp = requests.get(
            f'{url}/api/rover/stream',
            headers=headers,
            stream=True,
            timeout=(10.0, 90.0),  # connect timeout, read timeout (heartbeat is 30s)
        )
        resp.raise_for_status()

        self._sse_connected = True
        self.get_logger().info('SSE connected to server')

        event_name = None
        event_data = ''

        for line in resp.iter_lines(decode_unicode=True):
            if not self._running:
                break

            if line is None:
                continue

            # SSE parsing
            if line.startswith('event: '):
                event_name = line[7:]
                event_data = ''
            elif line.startswith('data: '):
                event_data = line[6:]
            elif line.startswith(':'):
                # Comment/heartbeat - just keep alive
                continue
            elif line == '':
                # Empty line = end of event
                if event_name and event_data:
                    self._handle_sse_event(event_name, event_data)
                    event_count += 1
                event_name = None
                event_data = ''

        resp.close()
        return event_count > 0

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

        elif event == 'manual-control':
            msg = Twist()
            msg.linear.x = float(payload.get('throttle', 0))
            msg.angular.z = float(payload.get('steering', 0))
            self._pub_manual.publish(msg)

    def destroy_node(self):
        self._running = False
        if self._sse_thread:
            self._sse_thread.join(timeout=5.0)
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
