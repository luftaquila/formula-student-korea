"""NTRIP v2.0 client for receiving RTCM3 correction data.

Connects to an NTRIP caster, authenticates, and streams RTCM3 corrections
which are then written to the GPS receiver serial port.
"""

import base64
import socket
import threading
import time
import logging

_default_logger = logging.getLogger(__name__)

GGA_TEMPLATE = (
    "$GPGGA,{time},{lat},{lat_dir},{lon},{lon_dir},1,12,1.0,0.0,M,0.0,M,,"
)


def _format_gga(lat, lon):
    """Build a GGA sentence from decimal degree coordinates."""
    t = time.strftime("%H%M%S.00", time.gmtime())

    lat_dir = 'N' if lat >= 0 else 'S'
    lat = abs(lat)
    lat_deg = int(lat)
    lat_min = (lat - lat_deg) * 60
    lat_str = f"{lat_deg:02d}{lat_min:010.7f}"

    lon_dir = 'E' if lon >= 0 else 'W'
    lon = abs(lon)
    lon_deg = int(lon)
    lon_min = (lon - lon_deg) * 60
    lon_str = f"{lon_deg:03d}{lon_min:010.7f}"

    body = GGA_TEMPLATE.format(
        time=t, lat=lat_str, lat_dir=lat_dir, lon=lon_str, lon_dir=lon_dir,
    )

    # NMEA checksum
    cksum = 0
    for ch in body[1:]:  # skip leading $
        cksum ^= ord(ch)

    return f"{body}*{cksum:02X}\r\n"


class NTRIPClient:
    """NTRIP client that streams RTCM3 corrections to a serial port."""

    def __init__(self, host, port, mountpoint, username, password,
                 serial_port, lat=0.0, lon=0.0, logger=None):
        """Initialize NTRIP client.

        Args:
            host: NTRIP caster hostname
            port: NTRIP caster port
            mountpoint: NTRIP mountpoint name
            username: NTRIP auth username
            password: NTRIP auth password
            serial_port: pyserial Serial object to write RTCM3 data to
            lat: approximate latitude for initial GGA
            lon: approximate longitude for initial GGA
            logger: optional logger (ROS2 logger or stdlib). Falls back to module logger.
        """
        self._host = host
        self._port = port
        self._mountpoint = mountpoint
        self._username = username
        self._password = password
        self._serial = serial_port
        self._lat = lat
        self._lon = lon
        self._running = False
        self._thread = None
        self._sock = None
        self._bytes_received = 0
        self._connected = False
        self._fail_count = 0
        self._last_error = None
        self._logger = logger or _default_logger
        self._gga_interval = 10.0  # seconds, override via attribute

    @property
    def connected(self):
        return self._connected

    @property
    def bytes_received(self):
        return self._bytes_received

    @property
    def fail_count(self):
        return self._fail_count

    @property
    def last_error(self):
        return self._last_error

    def _log_info(self, msg):
        """Log an info message via whichever logger we were given."""
        if hasattr(self._logger, 'info'):
            self._logger.info(msg)

    def _log_warn(self, msg):
        """Log a warning. ROS2 loggers use warn(), stdlib uses warning()."""
        if hasattr(self._logger, 'warn'):
            self._logger.warn(msg)
        elif hasattr(self._logger, 'warning'):
            self._logger.warning(msg)

    def update_position(self, lat, lon):
        """Update position for GGA reports (thread-safe)."""
        self._lat = lat
        self._lon = lon

    def start(self):
        """Start NTRIP client in a background thread."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        """Stop the NTRIP client."""
        self._running = False
        self._connected = False
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=5.0)
            self._thread = None

    def _connect(self):
        """Establish connection to NTRIP caster."""
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.settimeout(10.0)
        self._sock.connect((self._host, self._port))

        # Build HTTP request
        auth = base64.b64encode(f"{self._username}:{self._password}".encode()).decode()
        gga = _format_gga(self._lat, self._lon)

        request = (
            f"GET /{self._mountpoint} HTTP/1.1\r\n"
            f"Host: {self._host}\r\n"
            f"Ntrip-Version: Ntrip/2.0\r\n"
            f"User-Agent: NTRIP FSKRover/1.0\r\n"
            f"Authorization: Basic {auth}\r\n"
            f"Ntrip-GGA: {gga.strip()}\r\n"
            f"\r\n"
        )

        self._sock.sendall(request.encode())

        # Read response header
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise ConnectionError("Connection closed during handshake")
            response += chunk

        header = response.split(b"\r\n\r\n")[0].decode(errors='replace')
        if "200" not in header.split("\r\n")[0]:
            raise ConnectionError(f"NTRIP caster rejected: {header.split(chr(13))[0]}")

        # Any data after the header is RTCM3
        remainder = response.split(b"\r\n\r\n", 1)[1]
        if remainder:
            self._serial.write(remainder)
            self._bytes_received += len(remainder)

        self._sock.settimeout(30.0)
        self._connected = True
        self._fail_count = 0
        self._last_error = None
        self._log_info(f"Connected to NTRIP {self._host}:{self._port}/{self._mountpoint}")

    def _run(self):
        """Main loop: connect, receive RTCM3, reconnect on failure.

        Reconnect uses exponential backoff: 5s, 10s, 20s, ... capped at 300s.
        Successful handshake resets the counter.
        """
        while self._running:
            gga_interval = self._gga_interval
            try:
                self._connect()
                last_gga = time.monotonic()

                while self._running:
                    try:
                        data = self._sock.recv(4096)
                    except socket.timeout:
                        data = None

                    if data:
                        self._serial.write(data)
                        self._bytes_received += len(data)

                    # Send GGA position update at the configured cadence
                    now = time.monotonic()
                    if now - last_gga > gga_interval:
                        try:
                            gga = _format_gga(self._lat, self._lon)
                            self._sock.sendall(gga.encode())
                            last_gga = now
                        except Exception as exc:
                            self._last_error = f"gga_send: {exc}"
                            break

                    if data == b"":
                        break  # connection closed

            except Exception as e:
                self._last_error = str(e)
                self._fail_count += 1
                self._log_warn(f"NTRIP connection error (fail_count={self._fail_count}): {e}")
            finally:
                self._connected = False
                if self._sock:
                    try:
                        self._sock.close()
                    except Exception:
                        pass
                    self._sock = None

            if self._running:
                # Exponential backoff: 5s * 2^(fail_count-1), capped at 300s
                base = 5.0
                delay = min(base * (2 ** max(0, min(self._fail_count - 1, 6))), 300.0)
                self._log_info(f"NTRIP reconnecting in {delay:.0f}s (fail={self._fail_count})")
                time.sleep(delay)
