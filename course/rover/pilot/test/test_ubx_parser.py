"""Tests for ubx_parser module."""

import struct
import pytest
from pilot.lib.ubx_parser import (
    UBXParser, NavPVT, NavHPPOSLLH,
    checksum, build_ubx_message, build_cfg_valset,
    FixType, CarrierSolution,
    SYNC1, SYNC2, CLASS_NAV, CLASS_CFG, ID_NAV_PVT, ID_NAV_HPPOSLLH,
    ID_CFG_VALSET,
)


def _build_nav_pvt_payload(lat_deg=35.292, lon_deg=126.574, fix=3,
                            carrier=2, ground_speed_mm=500, heading_deg=45.0,
                            num_sv=15, h_acc_mm=20, v_acc_mm=30):
    """Build a minimal NAV-PVT payload (92 bytes)."""
    lat = int(lat_deg * 1e7)
    lon = int(lon_deg * 1e7)
    flags = (carrier & 0x03) << 6

    payload = struct.pack(
        '<IHBBBBBBIiBBBBiiiiIIiiiiiIIH',
        0,                  # iTOW
        2026,               # year
        3,                  # month
        24,                 # day
        12,                 # hour
        0,                  # minute
        0,                  # second
        0x07,               # valid
        0,                  # tAcc
        0,                  # nano
        fix,                # fixType
        flags,              # flags
        0,                  # flags2
        num_sv,             # numSV
        lon,                # lon (1e-7 deg)
        lat,                # lat (1e-7 deg)
        100000,             # height (mm)
        95000,              # hMSL (mm)
        h_acc_mm,           # hAcc (mm)
        v_acc_mm,           # vAcc (mm)
        0,                  # velN
        0,                  # velE
        0,                  # velD
        ground_speed_mm,    # gSpeed (mm/s)
        int(heading_deg * 1e5),  # headMot (1e-5 deg)
        0,                  # sAcc
        0,                  # headAcc
        200,                # pDOP (0.01)
    )

    # Pad to 92 bytes
    payload += b'\x00' * (92 - len(payload))
    return payload


def _build_nav_hpposllh_payload(lat_deg=35.292, lon_deg=126.574,
                                 lat_hp=50, lon_hp=-30):
    """Build a minimal NAV-HPPOSLLH payload (36 bytes)."""
    lat = int(lat_deg * 1e7)
    lon = int(lon_deg * 1e7)

    payload = struct.pack(
        '<BHBIiiiibbbbII',
        0,          # version
        0,          # reserved (2 bytes)
        0,          # flags
        0,          # iTOW
        lon,        # lon (1e-7 deg)
        lat,        # lat (1e-7 deg)
        100000,     # height (mm)
        95000,      # hMSL (mm)
        lon_hp,     # lonHp (1e-9 deg / 1e-2 of 1e-7 = 1e-9)
        lat_hp,     # latHp
        0,          # heightHp
        0,          # hMSLHp
        15,         # hAcc (0.1mm)
        25,         # vAcc (0.1mm)
    )

    # Pad to 36 bytes
    payload += b'\x00' * (36 - len(payload))
    return payload


class TestChecksum:
    def test_known_checksum(self):
        data = bytes([0x01, 0x07, 0x00, 0x00])
        ck_a, ck_b = checksum(data)
        assert isinstance(ck_a, int)
        assert isinstance(ck_b, int)
        assert 0 <= ck_a <= 255
        assert 0 <= ck_b <= 255

    def test_empty(self):
        ck_a, ck_b = checksum(b'')
        assert ck_a == 0
        assert ck_b == 0


class TestBuildUBXMessage:
    def test_roundtrip(self):
        msg = build_ubx_message(CLASS_NAV, ID_NAV_PVT, b'\x01\x02\x03')
        assert msg[0] == SYNC1
        assert msg[1] == SYNC2
        assert msg[2] == CLASS_NAV
        assert msg[3] == ID_NAV_PVT
        # Length = 3
        assert msg[4] == 3
        assert msg[5] == 0
        # Payload
        assert msg[6:9] == b'\x01\x02\x03'


class TestUBXParser:
    def test_parse_nav_pvt(self):
        payload = _build_nav_pvt_payload()
        frame = build_ubx_message(CLASS_NAV, ID_NAV_PVT, payload)

        parser = UBXParser()
        results = parser.feed(frame)

        assert len(results) == 1
        pvt = results[0]
        assert isinstance(pvt, NavPVT)
        assert abs(pvt.lat - 35.292) < 0.0001
        assert abs(pvt.lon - 126.574) < 0.0001
        assert pvt.fix_type == FixType.FIX_3D
        assert pvt.carrier_solution == CarrierSolution.FIXED
        assert pvt.num_sv == 15
        assert abs(pvt.ground_speed - 0.5) < 0.01
        assert abs(pvt.heading - 45.0) < 0.01

    def test_parse_nav_hpposllh(self):
        payload = _build_nav_hpposllh_payload(lat_hp=50, lon_hp=-30)
        frame = build_ubx_message(CLASS_NAV, ID_NAV_HPPOSLLH, payload)

        parser = UBXParser()
        results = parser.feed(frame)

        assert len(results) == 1
        hp = results[0]
        assert isinstance(hp, NavHPPOSLLH)
        # High-precision: lat = (35.292e7 + 50*1e-2) * 1e-7
        assert abs(hp.lat - 35.292) < 0.0001
        assert abs(hp.lon - 126.574) < 0.0001

    def test_multiple_messages(self):
        pvt_payload = _build_nav_pvt_payload()
        hp_payload = _build_nav_hpposllh_payload()

        frame = (
            build_ubx_message(CLASS_NAV, ID_NAV_PVT, pvt_payload) +
            build_ubx_message(CLASS_NAV, ID_NAV_HPPOSLLH, hp_payload)
        )

        parser = UBXParser()
        results = parser.feed(frame)
        assert len(results) == 2
        assert isinstance(results[0], NavPVT)
        assert isinstance(results[1], NavHPPOSLLH)

    def test_garbage_before_sync(self):
        payload = _build_nav_pvt_payload()
        frame = b'\x00\x01\x02\x03' + build_ubx_message(CLASS_NAV, ID_NAV_PVT, payload)

        parser = UBXParser()
        results = parser.feed(frame)
        assert len(results) == 1
        assert isinstance(results[0], NavPVT)

    def test_partial_message(self):
        payload = _build_nav_pvt_payload()
        frame = build_ubx_message(CLASS_NAV, ID_NAV_PVT, payload)

        parser = UBXParser()

        # Feed first half
        results = parser.feed(frame[:30])
        assert len(results) == 0

        # Feed second half
        results = parser.feed(frame[30:])
        assert len(results) == 1
        assert isinstance(results[0], NavPVT)

    def test_bad_checksum_skipped(self):
        payload = _build_nav_pvt_payload()
        frame = bytearray(build_ubx_message(CLASS_NAV, ID_NAV_PVT, payload))
        frame[-1] ^= 0xFF  # corrupt checksum

        parser = UBXParser()
        results = parser.feed(bytes(frame))
        assert len(results) == 0


class TestPayloadLengthValidation:
    """Exact-length payload validation (3.11)."""

    def test_nav_pvt_short_payload_rejected(self):
        from pilot.lib.ubx_parser import parse_nav_pvt
        assert parse_nav_pvt(b'\x00' * 91) is None

    def test_nav_pvt_long_payload_rejected(self):
        from pilot.lib.ubx_parser import parse_nav_pvt
        assert parse_nav_pvt(b'\x00' * 93) is None

    def test_nav_hpposllh_short_payload_rejected(self):
        from pilot.lib.ubx_parser import parse_nav_hpposllh
        assert parse_nav_hpposllh(b'\x00' * 35) is None

    def test_nav_hpposllh_long_payload_rejected(self):
        from pilot.lib.ubx_parser import parse_nav_hpposllh
        assert parse_nav_hpposllh(b'\x00' * 37) is None


class TestBuildCfgValset:
    """CFG-VALSET payload encoding — used to set F9P measurement rate, output
    streams, etc. The 10 Hz fix rate (CFG-RATE-MEAS = 100 ms) depends on the
    U2 ('H') format encoding being little-endian and exactly 2 bytes."""

    def _decode_frame(self, frame):
        assert frame[0] == SYNC1
        assert frame[1] == SYNC2
        assert frame[2] == CLASS_CFG
        assert frame[3] == ID_CFG_VALSET
        length = struct.unpack('<H', frame[4:6])[0]
        payload = frame[6:6 + length]
        # Last 2 bytes are checksum; verify integrity.
        ck_a, ck_b = checksum(frame[2:6 + length])
        assert frame[6 + length] == ck_a
        assert frame[6 + length + 1] == ck_b
        return payload

    def test_u1_byte_encoding(self):
        # NAV-PVT message-output enable: U1 (B), value 1.
        frame = build_cfg_valset([(0x20910009, 1, 'B')])
        payload = self._decode_frame(frame)
        # 4-byte VALSET header (version, layer, reserved x2) + 4-byte key + 1-byte value.
        assert len(payload) == 4 + 4 + 1
        assert payload[0] == 0x00      # version
        assert payload[1] == 0x03      # layer = RAM | BBR
        assert payload[2:4] == b'\x00\x00'
        assert payload[4:8] == b'\x09\x00\x91\x20'  # key, little-endian
        assert payload[8] == 0x01

    def test_u2_short_encoding_for_rate_meas(self):
        # CFG-RATE-MEAS = 100 ms (10 Hz). The whole point of this commit:
        # H format must encode the value as exactly 2 little-endian bytes,
        # otherwise the F9P silently keeps its 1 Hz default and antenna cal
        # collects ~9 samples instead of 80.
        frame = build_cfg_valset([(0x30210001, 100, 'H')])
        payload = self._decode_frame(frame)
        assert len(payload) == 4 + 4 + 2
        assert payload[4:8] == b'\x01\x00\x21\x30'
        assert payload[8:10] == struct.pack('<H', 100)

    def test_layer_override(self):
        frame = build_cfg_valset([(0x20910009, 1, 'B')], layer=0x07)
        payload = self._decode_frame(frame)
        assert payload[1] == 0x07

    def test_multiple_keys_concat_in_order(self):
        frame = build_cfg_valset([
            (0x30210001, 100, 'H'),
            (0x20910009, 1, 'B'),
        ])
        payload = self._decode_frame(frame)
        # Header (4) + key1 (4) + value1 (2) + key2 (4) + value2 (1) = 15
        assert len(payload) == 15
        assert payload[4:8] == b'\x01\x00\x21\x30'
        assert payload[8:10] == struct.pack('<H', 100)
        assert payload[10:14] == b'\x09\x00\x91\x20'
        assert payload[14] == 0x01
