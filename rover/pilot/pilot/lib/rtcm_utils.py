"""RTCM3 framing helpers (pure, ROS-free).

A ZED-F9P in base-station mode emits RTCM3 correction messages on the same USB
serial stream as any UBX messages we leave enabled for health. To relay the
corrections to the rover we must pull *complete* RTCM3 frames out of that mixed
byte stream. This module does exactly that and nothing else, so both the GPS
receiver agent (rover/gps/gps_register.py) and any rover-side consumer can share
one implementation.

RTCM3 frame layout (RTCM 10403.x):
    byte 0      preamble 0xD3
    bytes 1-2   6 bits reserved (top of byte 1) + 10-bit payload length
    bytes 3..   payload (length bytes)
    last 3      CRC-24Q over preamble+header+payload

The framer validates the CRC so a stray 0xD3 inside UBX/noise can't be mistaken
for a real frame — on a bad CRC it drops a single byte and resyncs to the next
preamble.
"""

RTCM3_PREAMBLE = 0xD3
_RTCM3_MAX_PAYLOAD = 1023  # 10-bit length field

# CRC-24Q (used by RTCM3 / GPS): polynomial 0x1864CFB, init 0, no final xor.
_CRC24Q_POLY = 0x1864CFB
_CRC24Q_TABLE = None


def _crc24q_table():
    global _CRC24Q_TABLE
    if _CRC24Q_TABLE is None:
        table = []
        for i in range(256):
            crc = i << 16
            for _ in range(8):
                crc <<= 1
                if crc & 0x1000000:
                    crc ^= _CRC24Q_POLY
            table.append(crc & 0xFFFFFF)
        _CRC24Q_TABLE = table
    return _CRC24Q_TABLE


def crc24q(data):
    """CRC-24Q over ``data`` (bytes-like). Returns a 24-bit int."""
    table = _crc24q_table()
    crc = 0
    for b in data:
        crc = ((crc << 8) & 0xFFFFFF) ^ table[((crc >> 16) ^ b) & 0xFF]
    return crc


def frame_is_valid(frame):
    """True if ``frame`` is a well-formed RTCM3 message with a matching CRC-24Q."""
    if len(frame) < 6 or frame[0] != RTCM3_PREAMBLE:
        return False
    length = ((frame[1] & 0x03) << 8) | frame[2]
    if len(frame) != 3 + length + 3:
        return False
    calc = crc24q(frame[: 3 + length])
    recv = (frame[-3] << 16) | (frame[-2] << 8) | frame[-1]
    return calc == recv


class RTCM3Framer:
    """Extract complete, CRC-valid RTCM3 frames from a (possibly mixed) stream.

    Feed raw serial bytes with ``feed()``; it returns a list of complete frames
    (each ``bytes``, preamble..CRC inclusive) ready to forward verbatim. Leading
    non-RTCM bytes and CRC-failing false preambles are discarded. Partial trailing
    frames are buffered until the rest arrives.
    """

    def __init__(self, max_buffer=16384):
        self._buf = bytearray()
        self._max_buffer = max_buffer

    def feed(self, data):
        if data:
            self._buf.extend(data)
        frames = []
        while True:
            start = self._buf.find(RTCM3_PREAMBLE)
            if start < 0:
                # No preamble anywhere — nothing to keep.
                self._buf.clear()
                break
            if start > 0:
                del self._buf[:start]  # drop leading non-RTCM bytes
            if len(self._buf) < 3:
                break  # need the length field
            length = ((self._buf[1] & 0x03) << 8) | self._buf[2]
            frame_len = 3 + length + 3
            if len(self._buf) < frame_len:
                break  # frame not fully arrived yet
            candidate = bytes(self._buf[:frame_len])
            if frame_is_valid(candidate):
                frames.append(candidate)
                del self._buf[:frame_len]
            else:
                # False preamble (stray 0xD3) — drop one byte and resync.
                del self._buf[:1]
        # Safety valve: never let a garbage stream grow the buffer unbounded.
        if len(self._buf) > self._max_buffer:
            del self._buf[: len(self._buf) - 3]
        return frames


def build_frame(payload):
    """Build a complete RTCM3 frame around ``payload`` (bytes). Test helper /
    generic encoder — prepends the preamble+length header and appends CRC-24Q."""
    if len(payload) > _RTCM3_MAX_PAYLOAD:
        raise ValueError("RTCM3 payload too long")
    header = bytes([RTCM3_PREAMBLE, (len(payload) >> 8) & 0x03, len(payload) & 0xFF])
    body = header + bytes(payload)
    crc = crc24q(body)
    return body + bytes([(crc >> 16) & 0xFF, (crc >> 8) & 0xFF, crc & 0xFF])
