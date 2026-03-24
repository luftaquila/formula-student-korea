"""Tests for geo_utils module."""

import pytest
from math import pi, radians, isclose
from fsk_rover.lib.geo_utils import (
    haversine, bearing, enu_from_gps, gps_from_enu, normalize_angle,
)


class TestHaversine:
    def test_same_point(self):
        assert haversine(35.0, 126.0, 35.0, 126.0) == 0.0

    def test_known_distance(self):
        # Seoul (37.5665, 126.978) to Busan (35.1796, 129.0756) ≈ 325km
        d = haversine(37.5665, 126.978, 35.1796, 129.0756)
        assert 320_000 < d < 330_000

    def test_short_distance(self):
        # Two points ~111m apart (0.001 degrees latitude)
        d = haversine(35.0, 126.0, 35.001, 126.0)
        assert 110 < d < 112

    def test_symmetry(self):
        d1 = haversine(35.0, 126.0, 35.1, 126.1)
        d2 = haversine(35.1, 126.1, 35.0, 126.0)
        assert isclose(d1, d2, rel_tol=1e-10)


class TestBearing:
    def test_north(self):
        b = bearing(35.0, 126.0, 36.0, 126.0)
        assert isclose(b, 0.0, abs_tol=0.01)

    def test_east(self):
        b = bearing(35.0, 126.0, 35.0, 127.0)
        assert isclose(b, pi / 2, abs_tol=0.02)

    def test_south(self):
        b = bearing(36.0, 126.0, 35.0, 126.0)
        assert isclose(abs(b), pi, abs_tol=0.01)

    def test_west(self):
        b = bearing(35.0, 127.0, 35.0, 126.0)
        assert isclose(b, -pi / 2, abs_tol=0.02)


class TestENU:
    def test_origin(self):
        e, n = enu_from_gps(35.0, 126.0, 35.0, 126.0)
        assert isclose(e, 0.0, abs_tol=0.001)
        assert isclose(n, 0.0, abs_tol=0.001)

    def test_north_1m(self):
        # ~1m north = ~9e-6 degrees
        ref_lat, ref_lon = 35.0, 126.0
        delta_lat = 1.0 / 111320  # ~1m in latitude degrees
        e, n = enu_from_gps(ref_lat + delta_lat, ref_lon, ref_lat, ref_lon)
        assert isclose(n, 1.0, abs_tol=0.01)
        assert isclose(e, 0.0, abs_tol=0.01)

    def test_roundtrip(self):
        ref_lat, ref_lon = 35.292, 126.574
        test_lat, test_lon = 35.293, 126.575
        e, n = enu_from_gps(test_lat, test_lon, ref_lat, ref_lon)
        lat, lon = gps_from_enu(e, n, ref_lat, ref_lon)
        assert isclose(lat, test_lat, abs_tol=1e-7)
        assert isclose(lon, test_lon, abs_tol=1e-7)

    def test_small_displacement(self):
        # 10cm displacement
        ref_lat, ref_lon = 35.292, 126.574
        e, n = 0.0, 0.1  # 10cm north
        lat, lon = gps_from_enu(e, n, ref_lat, ref_lon)
        e2, n2 = enu_from_gps(lat, lon, ref_lat, ref_lon)
        assert isclose(e2, e, abs_tol=0.001)
        assert isclose(n2, n, abs_tol=0.001)


class TestNormalizeAngle:
    def test_zero(self):
        assert normalize_angle(0.0) == 0.0

    def test_positive_wrap(self):
        assert isclose(normalize_angle(3 * pi), pi, abs_tol=1e-10)

    def test_negative_wrap(self):
        assert isclose(normalize_angle(-3 * pi), -pi, abs_tol=1e-10)

    def test_within_range(self):
        assert isclose(normalize_angle(1.5), 1.5, abs_tol=1e-10)

    def test_pi(self):
        result = normalize_angle(pi)
        assert isclose(result, pi, abs_tol=1e-10) or isclose(result, -pi, abs_tol=1e-10)
