"""Geographic utility functions for GPS coordinate math."""

from math import radians, degrees, sin, cos, sqrt, atan2, pi

R_EARTH = 6371000.0  # Earth radius in meters


def haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance between two GPS points in meters."""
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return R_EARTH * 2 * atan2(sqrt(a), sqrt(1 - a))


def bearing(lat1, lon1, lat2, lon2):
    """Initial bearing from point 1 to point 2 in radians (0=North, CW positive)."""
    dlon = radians(lon2 - lon1)
    rlat1 = radians(lat1)
    rlat2 = radians(lat2)
    x = sin(dlon) * cos(rlat2)
    y = cos(rlat1) * sin(rlat2) - sin(rlat1) * cos(rlat2) * cos(dlon)
    return atan2(x, y)


def enu_from_gps(lat, lon, ref_lat, ref_lon):
    """Convert GPS (lat, lon) to local East-North-Up (meters) relative to reference point.

    Accurate to ~1cm within 1km of reference point.
    """
    dlat = radians(lat - ref_lat)
    dlon = radians(lon - ref_lon)
    east = dlon * R_EARTH * cos(radians(ref_lat))
    north = dlat * R_EARTH
    return east, north


def gps_from_enu(east, north, ref_lat, ref_lon):
    """Convert local ENU (meters) back to GPS (lat, lon)."""
    lat = ref_lat + degrees(north / R_EARTH)
    lon = ref_lon + degrees(east / (R_EARTH * cos(radians(ref_lat))))
    return lat, lon


def normalize_angle(angle):
    """Wrap angle to [-pi, pi]."""
    while angle > pi:
        angle -= 2 * pi
    while angle < -pi:
        angle += 2 * pi
    return angle
