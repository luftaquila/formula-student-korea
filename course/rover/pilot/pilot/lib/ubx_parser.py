"""u-blox UBX binary protocol parser for ZED-F9P.

Parses NAV-PVT (0x01 0x07), NAV-HPPOSLLH (0x01 0x14), and NAV-DOP (0x01 0x04).
"""

import logging
import struct
from dataclasses import dataclass
from enum import IntEnum

logger = logging.getLogger(__name__)

# UBX sync bytes
SYNC1 = 0xB5
SYNC2 = 0x62

# Message classes and IDs
CLASS_NAV = 0x01
ID_NAV_PVT = 0x07
ID_NAV_HPPOSLLH = 0x14
ID_NAV_DOP = 0x04

# UBX-CFG class
CLASS_CFG = 0x06
ID_CFG_VALSET = 0x8A


class FixType(IntEnum):
    NO_FIX = 0
    DEAD_RECKONING = 1
    FIX_2D = 2
    FIX_3D = 3
    GNSS_DR = 4
    TIME_ONLY = 5


class CarrierSolution(IntEnum):
    NONE = 0
    FLOAT = 1
    FIXED = 2


@dataclass
class NavPVT:
    """UBX-NAV-PVT parsed data."""
    year: int
    month: int
    day: int
    hour: int
    minute: int
    second: int
    fix_type: FixType
    carrier_solution: CarrierSolution
    num_sv: int
    lon: float          # degrees
    lat: float          # degrees
    height: float       # meters above ellipsoid
    h_msl: float        # meters above mean sea level
    h_acc: float        # horizontal accuracy estimate (meters)
    v_acc: float        # vertical accuracy estimate (meters)
    ground_speed: float # m/s
    heading: float      # degrees (heading of motion)
    p_dop: float
    i_tow_ms: int       # GPS time-of-week of the navigation epoch (ms).
                        # Forwarded into telemetry so downstream estimators
                        # can back-date the position correction by USB-CDC
                        # latency rather than time-stamping at receive.


@dataclass
class NavHPPOSLLH:
    """UBX-NAV-HPPOSLLH parsed data (high-precision position)."""
    lon: float      # degrees (high precision)
    lat: float      # degrees (high precision)
    height: float   # meters (high precision)
    h_msl: float    # meters (high precision)
    h_acc: float    # horizontal accuracy (meters)
    v_acc: float    # vertical accuracy (meters)


@dataclass
class NavDOP:
    """UBX-NAV-DOP parsed data (dilution of precision, 0.01 units)."""
    g_dop: float    # geometric DOP
    p_dop: float    # position DOP
    t_dop: float    # time DOP
    v_dop: float    # vertical DOP
    h_dop: float    # horizontal DOP
    n_dop: float    # northing DOP
    e_dop: float    # easting DOP


def checksum(data):
    """Compute UBX Fletcher-8 checksum over class, id, length, and payload."""
    ck_a = 0
    ck_b = 0
    for b in data:
        ck_a = (ck_a + b) & 0xFF
        ck_b = (ck_b + ck_a) & 0xFF
    return ck_a, ck_b


def parse_nav_pvt(payload):
    """Parse NAV-PVT payload (92 bytes) into NavPVT."""
    if len(payload) != 92:
        logger.warning("NAV-PVT payload has unexpected length %d (expected 92)", len(payload))
        return None

    (iTOW, year, month, day, hour, minute, second, valid,
     tAcc, nano, fixType, flags, flags2, numSV,
     lon, lat, height, hMSL, hAcc, vAcc,
     velN, velE, velD, gSpeed, headMot,
     sAcc, headAcc, pDOP) = struct.unpack_from(
        '<IHBBBBBBIiBBBBiiiiIIiiiiiIIH', payload, 0
    )

    carrier = (flags >> 6) & 0x03

    return NavPVT(
        year=year, month=month, day=day,
        hour=hour, minute=minute, second=second,
        fix_type=FixType(fixType),
        carrier_solution=CarrierSolution(carrier),
        num_sv=numSV,
        lon=lon * 1e-7,
        lat=lat * 1e-7,
        height=height * 1e-3,
        h_msl=hMSL * 1e-3,
        h_acc=hAcc * 1e-3,
        v_acc=vAcc * 1e-3,
        ground_speed=gSpeed * 1e-3,
        heading=headMot * 1e-5,
        p_dop=pDOP * 0.01,
        i_tow_ms=iTOW,
    )


def parse_nav_hpposllh(payload):
    """Parse NAV-HPPOSLLH payload (36 bytes) into NavHPPOSLLH."""
    if len(payload) != 36:
        logger.warning("NAV-HPPOSLLH payload has unexpected length %d (expected 36)", len(payload))
        return None

    (version, _reserved,
     flags, iTOW,
     lon, lat, height, hMSL,
     lonHp, latHp, heightHp, hMSLHp,
     hAcc, vAcc) = struct.unpack_from(
        '<BHBIiiiibbbbII', payload, 0
    )

    return NavHPPOSLLH(
        lon=(lon + lonHp * 1e-2) * 1e-7,
        lat=(lat + latHp * 1e-2) * 1e-7,
        height=(height + heightHp * 0.1) * 1e-3,
        h_msl=(hMSL + hMSLHp * 0.1) * 1e-3,
        h_acc=hAcc * 1e-4,
        v_acc=vAcc * 1e-4,
    )


def parse_nav_dop(payload):
    """Parse NAV-DOP payload (18 bytes) into NavDOP. All DOP fields are
    transmitted as U2 in 0.01 units, scaled here back to floats."""
    if len(payload) != 18:
        logger.warning("NAV-DOP payload has unexpected length %d (expected 18)", len(payload))
        return None

    (_iTOW, gDOP, pDOP, tDOP, vDOP, hDOP, nDOP, eDOP) = struct.unpack_from(
        '<IHHHHHHH', payload, 0
    )
    return NavDOP(
        g_dop=gDOP * 0.01,
        p_dop=pDOP * 0.01,
        t_dop=tDOP * 0.01,
        v_dop=vDOP * 0.01,
        h_dop=hDOP * 0.01,
        n_dop=nDOP * 0.01,
        e_dop=eDOP * 0.01,
    )


class UBXParser:
    """Streaming UBX binary protocol parser.

    Feed raw bytes via feed(), receive parsed messages via callbacks or poll.
    """

    def __init__(self):
        self._buf = bytearray()
        self._messages = []

    def feed(self, data):
        """Feed raw bytes into the parser. Returns list of parsed messages."""
        self._buf.extend(data)
        results = []

        while len(self._buf) >= 8:  # minimum UBX frame: 2 sync + 1 class + 1 id + 2 len + 2 cksum
            # Find sync bytes
            idx = self._find_sync()
            if idx < 0:
                # Keep trailing SYNC1 in case SYNC2 hasn't arrived yet
                if self._buf and self._buf[-1] == SYNC1:
                    del self._buf[:-1]
                else:
                    self._buf.clear()
                break
            if idx > 0:
                del self._buf[:idx]

            if len(self._buf) < 6:
                break

            msg_class = self._buf[2]
            msg_id = self._buf[3]
            length = self._buf[4] | (self._buf[5] << 8)

            frame_len = 6 + length + 2  # header(6) + payload + checksum(2)
            if len(self._buf) < frame_len:
                break  # wait for more data

            # Verify checksum
            ck_a, ck_b = checksum(self._buf[2:6 + length])
            if ck_a != self._buf[6 + length] or ck_b != self._buf[6 + length + 1]:
                del self._buf[:2]  # skip bad sync, try again
                continue

            payload = bytes(self._buf[6:6 + length])
            del self._buf[:frame_len]

            msg = self._parse_message(msg_class, msg_id, payload)
            if msg is not None:
                results.append(msg)

        return results

    def _find_sync(self):
        """Find UBX sync bytes in buffer."""
        for i in range(len(self._buf) - 1):
            if self._buf[i] == SYNC1 and self._buf[i + 1] == SYNC2:
                return i
        return -1

    def _parse_message(self, msg_class, msg_id, payload):
        """Parse a UBX message by class and ID."""
        if msg_class == CLASS_NAV:
            if msg_id == ID_NAV_PVT:
                return parse_nav_pvt(payload)
            elif msg_id == ID_NAV_HPPOSLLH:
                return parse_nav_hpposllh(payload)
            elif msg_id == ID_NAV_DOP:
                return parse_nav_dop(payload)
        return None


def build_ubx_message(msg_class, msg_id, payload=b''):
    """Build a complete UBX binary message."""
    length = len(payload)
    header = struct.pack('<BBBBH', SYNC1, SYNC2, msg_class, msg_id, length)
    data = header[2:] + payload  # checksum over class, id, length, payload
    ck_a, ck_b = checksum(data)
    return header + payload + bytes([ck_a, ck_b])


def build_cfg_valset(key_values, layer=0x03):
    """Build UBX-CFG-VALSET message to configure the receiver.

    Args:
        key_values: list of (key_id, value, fmt) tuples
        layer: bitmask — 0x01=RAM, 0x02=BBR, 0x04=Flash (default 0x03=RAM+BBR)
    """
    payload = struct.pack('<BBH', 0x00, layer, 0x0000)  # version, layer, reserved
    for key_id, value, fmt in key_values:
        payload += struct.pack('<I', key_id)
        payload += struct.pack('<' + fmt, value)
    return build_ubx_message(CLASS_CFG, ID_CFG_VALSET, payload)
