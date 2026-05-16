"""Tests for geo_utils module."""

from math import pi, isclose

from pilot.lib.geo_utils import (
    haversine, enu_from_gps, gps_from_enu, normalize_angle,
    compass_to_math, math_to_compass, fit_chord_heading,
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


class TestFrameConversions:
    def test_compass_north_is_math_pi_over_two(self):
        # 0 compass = North = +y axis = π/2 in math frame
        assert isclose(compass_to_math(0.0), pi / 2, abs_tol=1e-10)

    def test_compass_east_is_math_zero(self):
        # π/2 compass = East = +x axis = 0 in math frame
        assert isclose(compass_to_math(pi / 2), 0.0, abs_tol=1e-10)

    def test_compass_south_is_math_minus_pi_over_two(self):
        m = compass_to_math(pi)
        # π/2 - π = -π/2 (already inside [-π, π])
        assert isclose(m, -pi / 2, abs_tol=1e-10)

    def test_round_trip(self):
        for c in (-2.0, -0.5, 0.0, 0.4, 1.7, 2.9):
            assert isclose(compass_to_math(math_to_compass(c)), c, abs_tol=1e-10)


class TestFitChordHeading:
    def test_clean_eastward_line(self):
        pts = [(i * 0.5, 0.0) for i in range(10)]
        heading, rms, chord = fit_chord_heading(pts)
        assert isclose(heading, 0.0, abs_tol=1e-9)
        assert rms < 1e-9
        assert isclose(chord, 4.5, abs_tol=1e-9)

    def test_recovers_45deg(self):
        pts = [(i * 0.5, i * 0.5) for i in range(10)]
        heading, rms, _ = fit_chord_heading(pts)
        assert isclose(heading, pi / 4, abs_tol=1e-9)
        assert rms < 1e-9

    def test_robust_to_jitter(self):
        # Points along +x with cm-level jitter — heading should still be ~0,
        # residual RMS should reflect the noise, chord should be the full
        # length. This is the canonical "did calibration sample reliably"
        # case the navigator uses.
        import random
        random.seed(42)
        pts = [(i * 0.25, random.gauss(0.0, 0.02)) for i in range(15)]
        heading, rms, chord = fit_chord_heading(pts)
        assert abs(heading) < 0.05
        assert 0.005 < rms < 0.05
        assert chord > 3.4  # 14 * 0.25 minus jitter

    def test_picks_first_to_last_direction(self):
        # Reverse-ordered points must NOT come back as the 180°-flipped
        # heading — calibration regresses motion direction, not just an
        # axis. (Without this guard the chassis would face the wrong way.)
        pts = [(0.0, 0.0), (-1.0, 0.0), (-2.0, 0.0)]
        heading, _, _ = fit_chord_heading(pts)
        assert isclose(heading, pi, abs_tol=1e-9) or isclose(heading, -pi, abs_tol=1e-9)

    def test_too_few_points_returns_zero_chord(self):
        h, rms, chord = fit_chord_heading([(0.0, 0.0)])
        assert chord == 0.0
