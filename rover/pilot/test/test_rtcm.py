"""Tests for the RTCM3 framer + CRC-24Q (pilot.lib.rtcm_utils)."""

from pilot.lib.rtcm_utils import (
    RTCM3Framer,
    crc24q,
    frame_is_valid,
    build_frame,
    RTCM3_PREAMBLE,
)


def _crc24q_bitwise(data):
    """Independent bit-by-bit CRC-24Q reference (poly 0x1864CFB, init 0)."""
    crc = 0
    for b in data:
        crc ^= b << 16
        for _ in range(8):
            crc <<= 1
            if crc & 0x1000000:
                crc ^= 0x1864CFB
    return crc & 0xFFFFFF


class TestCrc24q:
    def test_known_value_matches_rtklib_table(self):
        # RTKLIB's tbl_CRC24Q[1] == 0x864CFB; crc of a single 0x01 byte hits it.
        assert crc24q(bytes([0x01])) == 0x864CFB

    def test_zero_byte_is_zero(self):
        assert crc24q(bytes([0x00])) == 0

    def test_matches_independent_bitwise_impl(self):
        for data in (b"", b"\x01", b"\xd3\x00\x13", bytes(range(40)), b"123456789"):
            assert crc24q(data) == _crc24q_bitwise(data)


class TestFrameValidation:
    def test_build_frame_roundtrips(self):
        frame = build_frame(bytes(range(19)))
        assert frame[0] == RTCM3_PREAMBLE
        assert frame_is_valid(frame)

    def test_corrupt_payload_fails_crc(self):
        frame = bytearray(build_frame(b"hello-rtcm-payload"))
        frame[5] ^= 0xFF
        assert not frame_is_valid(bytes(frame))

    def test_truncated_frame_invalid(self):
        frame = build_frame(b"abc")
        assert not frame_is_valid(frame[:-1])


class TestFramer:
    def test_extracts_clean_back_to_back_frames(self):
        a = build_frame(b"frame-a")
        b = build_frame(b"frame-b-longer-payload")
        framer = RTCM3Framer()
        out = framer.feed(a + b)
        assert out == [a, b]

    def test_skips_leading_and_interleaved_noise(self):
        a = build_frame(b"payload-1")
        b = build_frame(b"payload-2")
        # UBX-looking bytes + garbage around real frames.
        stream = b"\xb5\x62\x01\x02noise" + a + b"\x00\x11\x22" + b
        out = RTCM3Framer().feed(stream)
        assert out == [a, b]

    def test_reassembles_frame_split_across_feeds(self):
        frame = build_frame(bytes(range(60)))
        framer = RTCM3Framer()
        assert framer.feed(frame[:5]) == []
        assert framer.feed(frame[5:20]) == []
        assert framer.feed(frame[20:]) == [frame]

    def test_false_preamble_does_not_eat_real_frame(self):
        real = build_frame(b"the-real-one")
        # A stray 0xD3 whose "length" bytes point past a CRC that won't match.
        stream = bytes([RTCM3_PREAMBLE, 0x00, 0x02, 0xAA, 0xBB, 0xCC, 0xDD]) + real
        out = RTCM3Framer().feed(stream)
        assert real in out

    def test_crc_failure_midstream_recovers_next_frame(self):
        # A full-length frame whose PAYLOAD is corrupted (length still parses, CRC
        # fails) must be dropped and the following valid frame still recovered.
        good1 = build_frame(b"first-good-frame")
        bad = bytearray(build_frame(b"corrupted-payload-here"))
        bad[6] ^= 0xFF  # flip a payload byte → length intact, CRC now mismatches
        good2 = build_frame(b"second-good-frame")
        out = RTCM3Framer().feed(good1 + bytes(bad) + good2)
        assert good1 in out and good2 in out
        assert bytes(bad) not in out

    def test_frame_with_preamble_bytes_in_payload(self):
        # A payload full of 0xD3 (the preamble byte) must not desync the framer —
        # it trusts the length field and consumes the whole payload as data.
        frame = build_frame(bytes([RTCM3_PREAMBLE]) * 30)
        other = build_frame(b"after")
        out = RTCM3Framer().feed(frame + other)
        assert out == [frame, other]

    def test_buffer_is_bounded_on_pure_garbage(self):
        framer = RTCM3Framer(max_buffer=4096)
        # A lone 0xD3 with a large length keeps the parser waiting; flood garbage.
        framer.feed(bytes([RTCM3_PREAMBLE, 0x03, 0xFF]))
        for _ in range(100):
            framer.feed(b"\x00" * 512)
        assert len(framer._buf) <= framer._max_buffer + 512

    def test_small_max_buffer_still_recovers_a_max_length_frame(self):
        # Even if a caller passes a tiny max_buffer, the floor must keep the
        # garbage-trim valve from truncating a legitimate max-length frame that
        # simply arrives split across feeds.
        frame = build_frame(bytes(range(256)) * 3 + bytes(range(255)))  # 1023-byte payload
        assert len(frame) == 1029
        framer = RTCM3Framer(max_buffer=512)  # below one frame → floored up
        assert framer.feed(frame[:600]) == []
        assert framer.feed(frame[600:]) == [frame]
